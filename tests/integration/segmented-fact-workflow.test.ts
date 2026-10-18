/**
 * 分段事实工作流集成测试（SYNTHETIC 网络）。
 *
 * 使用真实 Pi SDK，经本地 127.0.0.1 合成 SSE 网关响应；不调用真实模型，
 * 不注入假 runFactWorkflow，不使用 evaluationSeed，也不改动既有测试。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';

import { readModelConfig } from '../../apps/server/src/config/env.ts';
import {
  EVIDENCE_LIMITS,
  REVIEW_LIMITS,
} from '../../apps/server/src/runtime/pi/execution-limits.ts';
import {
  READ_REQS,
  makeCandidate,
  makeEvidenceInput,
  makeReportOutput,
  promptOf,
  registry,
  type EvidencePrompt,
  type ReviewPrompt,
} from '../helpers/fact-workflow-harness.ts';
import type { EvidenceInput } from '../../packages/contracts/generated/index.ts';
import { fingerprint } from '../../packages/contracts/src/fingerprint.ts';
import {
  hashEvidenceInput,
  mergeReviewedSegments,
  runSegmentedFactWorkflow,
  verifySegment,
  type SegmentRecord,
  type SegmentTask,
} from '../../apps/server/src/orchestration/segmented-fact-workflow.ts';

type Body = {
  messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
  tools: Array<{ function: { name: string } }>;
};

interface Gateway {
  baseUrl: string;
  close: () => Promise<void>;
  requests: () => number;
}

/** 合成 SSE 网关：先工具读取，之后才输出 candidate/report。 */
async function startGateway(): Promise<Gateway> {
  let count = 0;
  const server = createServer((req, res) => {
    count += 1;
    let raw = '';
    req.on('data', (chunk) => {
      raw += String(chunk);
    });
    req.on('end', () => {
      const body = JSON.parse(raw) as Body;
      const prompt = promptOf(body) as EvidencePrompt & { role?: string };
      const afterTool = body.messages.some((m) => m.role === 'tool');
      if (prompt.role === 'review') {
        const reviewPrompt = prompt as unknown as ReviewPrompt;
        if (!afterTool) {
          complete(res, READ_REQS);
          return;
        }
        complete(res, makeReportOutput(reviewPrompt, { verdict: 'pass' }));
        return;
      }
      if (!afterTool) {
        complete(res, READ_REQS);
        return;
      }
      complete(res, makeCandidate(prompt.envelope, { rd: 60, founded: 2018 }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: 'http://127.0.0.1:' + address.port + '/v1',
    requests: () => count,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

function complete(res: import('node:http').ServerResponse, data: unknown): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (delta: unknown, finish: string | null) =>
    res.write(
      'data: ' +
        JSON.stringify({
          id: 'synthetic_seg',
          object: 'chat.completion.chunk',
          model: 'synthetic-model',
          choices: [{ index: 0, delta, finish_reason: finish }],
        }) +
        '\n\n',
    );
  if (Array.isArray(data)) {
    chunk(
      {
        role: 'assistant',
        tool_calls: data.map((args, index) => ({
          index,
          id: 'read_' + index,
          type: 'function',
          function: { name: 'read_document', arguments: JSON.stringify(args) },
        })),
      },
      null,
    );
    chunk({}, 'tool_calls');
  } else {
    chunk({ role: 'assistant', content: JSON.stringify(data) }, null);
    chunk({}, 'stop');
  }
  res.write(
    'data: ' +
      JSON.stringify({ choices: [], usage: { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250 } }) +
      '\n\n',
  );
  res.end('data: [DONE]\n\n');
}

interface Ctx {
  gateway: Gateway;
  config: ReturnType<typeof readModelConfig>;
  evidenceLimits: typeof EVIDENCE_LIMITS;
  reviewLimits: typeof REVIEW_LIMITS;
}

async function withGateway(run: (ctx: Ctx) => Promise<void>): Promise<void> {
  const gateway = await startGateway();
  try {
    const config = readModelConfig(
      {
        APP_MODEL_PROVIDER: 'b5-test',
        APP_MODEL_ID: 'synthetic-model',
        APP_MODEL_BASE_URL: gateway.baseUrl,
        APP_MODEL_API_KEY: 'b5-synthetic-secret',
      },
      { allowLoopbackHttp: true },
    );
    await run({
      gateway,
      config,
      evidenceLimits: { ...EVIDENCE_LIMITS, timeoutMs: 5000 },
      reviewLimits: { ...REVIEW_LIMITS, timeoutMs: 5000 },
    });
  } finally {
    await gateway.close();
  }
}

function plan(): SegmentTask[] {
  return [
    { id: 'seg_a', input: makeEvidenceInput() },
    { id: 'seg_b', input: makeEvidenceInput() },
  ];
}

function candidateOf(record: SegmentRecord) {
  const versionId = record.result!.currentVersionId!;
  const candidate = record.candidates.find((c) => c.snapshotVersionId === versionId)!;
  const review = record.reviews.find((r) => r.reportVersionId === record.result!.reportVersions.at(-1))!;
  return { versionId, candidate, review, snapshot: candidate.output!.candidateSnapshot };
}

test('SYNTHETIC 网络：两段顺序执行、四个独立 session、去重后两 claims 各两来源且全文通过', async () => {
  await withGateway(async (ctx) => {
    const segments = plan();
    const result = await runSegmentedFactWorkflow({
      segments,
      config: ctx.config,
      registry,
      evidenceLimits: ctx.evidenceLimits,
      reviewLimits: ctx.reviewLimits,
    });

    assert.equal(result.status, 'completed');
    assert.deepEqual(result.blockers, []);
    assert.equal(result.passed, true);

    const sessions: string[] = [];
    assert.equal(result.segmentRecords.length, 2);
    for (const record of result.segmentRecords) {
      const { versionId, candidate, review, snapshot } = candidateOf(record);
      assert.equal(record.result!.passed, true);
      assert.ok(record.result!.candidateVersions.includes(versionId));
      assert.equal(candidate.state, 'pending_review');
      assert.deepEqual(candidate.issues, []);
      assert.equal(snapshot.snapshotVersionId, versionId);
      assert.equal(snapshot.projectId, record.input.projectId);
      assert.equal(snapshot.taskId, record.input.taskId);
      assert.equal(snapshot.attemptId, record.input.attemptId);
      assert.ok(snapshot.claims.length > 0);
      assert.ok(snapshot.evidence.length > 0);
      for (const claim of snapshot.claims) {
        assert.ok(snapshot.entities.some((e) => e.entityId === claim.entityId));
        assert.ok(claim.evidenceRefs.length > 0);
        for (const ref of claim.evidenceRefs) {
          assert.ok(snapshot.evidence.some((e) => e.evidenceId === ref));
        }
      }
      assert.equal(review.state, 'reviewed');
      assert.deepEqual(review.issues, []);
      assert.equal(review.output!.status, 'completed');
      const report = review.output!.report;
      assert.equal(report.verdict, 'pass');
      assert.equal(report.reviewMode, 'fact');
      assert.equal(report.executionStatus, 'completed');
      assert.ok(record.result!.reportVersions.includes(report.reportVersionId));
      assert.equal(report.subject.snapshotId, snapshot.snapshotId);
      assert.equal(report.subject.snapshotVersionId, snapshot.snapshotVersionId);
      assert.equal(report.subject.contentHash, fingerprint(snapshot));
      assert.equal(report.checks.length, 10);
      assert.deepEqual(
        [...new Set(report.checks.map((c) => c.checkType))].sort(),
        ['basis', 'conflict', 'entity_match', 'missing', 'source_locator', 'support', 'time', 'traceability', 'unit', 'value'],
      );
      assert.ok(report.checks.every((c) => c.status === 'pass'));
      assert.ok(!report.issues.some((i) => i.severity === 'error' || i.severity === 'critical'));
      // 保留原始输入与完整记录（聚合视图不替换原始记录）。
      assert.equal(record.inputHash, hashEvidenceInput(record.input));
      sessions.push(candidate.output!.producedBy!.sessionId!, report.reviewedBy.sessionId!);
    }

    assert.equal(new Set(sessions).size, 4);

    // 版本绑定：两段各自绑定自身版本，互不串用。
    const [first, second] = result.segmentRecords as [SegmentRecord, SegmentRecord];
    assert.notEqual(first.result!.currentVersionId, second.result!.currentVersionId);

    assert.equal(result.aggregate.claimCount, 2);
    for (const claim of result.aggregate.claims) {
      assert.equal(claim.sources.length, 2);
      assert.deepEqual(
        [...new Set(claim.sources.map((s) => s.segmentId))].sort(),
        ['seg_a', 'seg_b'],
      );
      for (const source of claim.sources) {
        assert.ok(source.snapshotVersionId.length > 0);
        assert.ok(source.claimId.length > 0);
        assert.ok(source.evidenceRefs.length > 0);
      }
    }
    assert.deepEqual(result.aggregate.conflicts, []);
    // 原始 snapshot 内容保留在记录与视图中，未被删除。
    assert.equal(result.aggregate.missing.length, 0);
    assert.equal(result.aggregate.rawConflicts.length, 0);
    assert.equal(ctx.gateway.requests(), 8, 'two evidence/review sessions each read then answer');
  });
});

test('SYNTHETIC 网络：空计划与重复 ID 直接失败且不发起请求', async () => {
  await withGateway(async (ctx) => {
    const empty = await runSegmentedFactWorkflow({
      segments: [],
      config: ctx.config,
      registry,
      evidenceLimits: ctx.evidenceLimits,
      reviewLimits: ctx.reviewLimits,
    });
    assert.equal(empty.passed, false);
    assert.equal(empty.status, 'failed');
    assert.ok(empty.blockers.some((b) => b.code === 'empty_plan'));

    const duplicated = await runSegmentedFactWorkflow({
      segments: [
        { id: 'seg_a', input: makeEvidenceInput() },
        { id: 'seg_a', input: makeEvidenceInput() },
      ],
      config: ctx.config,
      registry,
      evidenceLimits: ctx.evidenceLimits,
      reviewLimits: ctx.reviewLimits,
    });
    assert.equal(duplicated.passed, false);
    assert.ok(duplicated.blockers.some((b) => b.code === 'duplicate_segment_id'));
    assert.ok(duplicated.segmentRecords.every((r) => r.candidates.length === 0 && r.reviews.length === 0));
    assert.equal(ctx.gateway.requests(), 0);
  });
});

test('SYNTHETIC 网络：已取消信号不启动任何段且零请求', async () => {
  await withGateway(async (ctx) => {
    const controller = new AbortController();
    controller.abort();
    const result = await runSegmentedFactWorkflow({
      segments: plan(),
      config: ctx.config,
      registry,
      evidenceLimits: ctx.evidenceLimits,
      reviewLimits: ctx.reviewLimits,
      signal: controller.signal,
    });
    assert.equal(result.passed, false);
    assert.equal(result.status, 'aborted');
    assert.ok(result.blockers.some((b) => b.code === 'aborted'));
    assert.ok(result.segmentRecords.every((r) => r.result === undefined));
    assert.ok(result.segmentRecords.every((r) => r.candidates.length === 0 && r.reviews.length === 0));
    assert.equal(ctx.gateway.requests(), 0);
  });
});

test('SYNTHETIC 网络：缺段、陈旧哈希、空 claims、空 review 均不能全文通过', async () => {
  await withGateway(async (ctx) => {
    const result = await runSegmentedFactWorkflow({
      segments: plan(),
      config: ctx.config,
      registry,
      evidenceLimits: ctx.evidenceLimits,
      reviewLimits: ctx.reviewLimits,
    });
    assert.equal(result.passed, true);

    const [first] = result.segmentRecords as [SegmentRecord, SegmentRecord];

    // 缺段：聚合时只提供一段。
    const missingSegment = mergeReviewedSegments(plan(), [first]);
    assert.equal(missingSegment.passed, false);
    assert.equal(missingSegment.status, 'failed');
    assert.ok(missingSegment.blockers.some(b => b.code === 'missing_segment'));
    assert.equal(missingSegment.aggregate.claimCount, 2);
    for (const claim of missingSegment.aggregate.claims) assert.equal(claim.sources.length, 1);

    const clone = (): SegmentRecord => structuredClone(first) as SegmentRecord;

    const stale = clone();
    stale.inputHash = fingerprint({ notTheInput: true });
    const staleRun = await runSegmentedFactWorkflow({
      segments: plan(),
      config: ctx.config,
      registry,
      evidenceLimits: ctx.evidenceLimits,
      reviewLimits: ctx.reviewLimits,
    });
    staleRun.segmentRecords[0]!.inputHash = stale.inputHash;
    const staleBlockers = verifyViaRun(staleRun, 'stale_input_hash');
    assert.ok(staleBlockers);

    // 空 claims：同步保持 report subject 哈希一致，聚焦语义而非哈希误差。
    const emptyClaims = clone();
    const emptyCandidate = emptyClaims.candidates.find(
      (c) => c.snapshotVersionId === emptyClaims.result!.currentVersionId,
    )!;
    const emptyReview = emptyClaims.reviews.find(
      (r) => r.reportVersionId === emptyClaims.result!.reportVersions.at(-1),
    )!;
    emptyCandidate.output!.candidateSnapshot.claims = [];
    const emptyHash = snapshotContentHash(emptyClaims);
    emptyReview.output!.report.subject.contentHash = emptyHash;
    const emptyBlockers = verifyRecord(emptyClaims);
    assert.ok(emptyBlockers.some((b) => b.code === 'candidate_claims_empty'));
    assert.ok(!emptyBlockers.some((b) => b.code === 'review_subject_mismatch'));
    assert.equal(mergeReviewedSegments(plan(), [emptyClaims, result.segmentRecords[1]!]).passed, false);

    // 空 review：报告 checks 与 issues 清空，仍需显式失败。
    const emptyReviewRecord = clone();
    const clearedReview = emptyReviewRecord.reviews.find(
      (r) => r.reportVersionId === emptyReviewRecord.result!.reportVersions.at(-1),
    )!;
    clearedReview.output!.report.checks = [];
    clearedReview.output!.report.issues = [];
    const clearedBlockers = verifyRecord(emptyReviewRecord);
    assert.ok(clearedBlockers.some((b) => b.code === 'review_checks_empty'));
    assert.equal(mergeReviewedSegments(plan(), [emptyReviewRecord, result.segmentRecords[1]!]).passed, false);
  });
});

test('SYNTHETIC 网络：错误 subject 哈希与跨段不同值冲突均显式失败', async () => {
  await withGateway(async (ctx) => {
    const result = await runSegmentedFactWorkflow({
      segments: plan(),
      config: ctx.config,
      registry,
      evidenceLimits: ctx.evidenceLimits,
      reviewLimits: ctx.reviewLimits,
    });
    const [first, second] = result.segmentRecords as [SegmentRecord, SegmentRecord];

    // 错误 subject 哈希：仍保持合法 shape，只改 contentHash。
    const wrongSubject = structuredClone(first) as SegmentRecord;
    const wrongReview = wrongSubject.reviews.find(
      (r) => r.reportVersionId === wrongSubject.result!.reportVersions.at(-1),
    )!;
    wrongReview.output!.report.subject.contentHash = fingerprint({ tampered: true });
    const subjectBlockers = verifyRecord(wrongSubject);
    assert.ok(subjectBlockers.some((b) => b.code === 'review_subject_mismatch'));

    // 跨段不同值：第二段改变 fact 取值并同步 subject 哈希，产生显式 conflict。
    const conflictSecond = structuredClone(second) as SegmentRecord;
    const conflictCandidate = conflictSecond.candidates.find(
      (c) => c.snapshotVersionId === conflictSecond.result!.currentVersionId,
    )!;
    const conflictReview = conflictSecond.reviews.find(
      (r) => r.reportVersionId === conflictSecond.result!.reportVersions.at(-1),
    )!;
    const rdClaim = conflictCandidate.output!.candidateSnapshot.claims.find(
      (c) => c.claimId === 'claim_rd',
    )!;
    (rdClaim.value as { normalized: number }).normalized = 61;
    conflictReview.output!.report.subject.contentHash = snapshotContentHash(conflictSecond);

    const conflictBlockers = verifyRecord(conflictSecond);
    assert.ok(!conflictBlockers.some((b) => b.code === 'review_subject_mismatch'));

    const aggregate = mergeReviewedSegments(plan(), [first, conflictSecond]);
    assert.equal(aggregate.passed, false);
    assert.equal(aggregate.status, 'failed');
    assert.equal(aggregate.aggregate.conflicts.length, 1);
    assert.deepEqual(aggregate.aggregate.conflicts[0]!.values.length, 2);
    assert.ok(aggregate.aggregate.conflicts[0]!.segmentIds.includes('seg_a'));
    assert.ok(aggregate.aggregate.conflicts[0]!.segmentIds.includes('seg_b'));

    // 冲突使全文不通过（显式断言 passed=false，而非依赖 TypeError）。
    const conflictRun = await runSegmentedFactWorkflow({
      segments: plan(),
      config: ctx.config,
      registry,
      evidenceLimits: ctx.evidenceLimits,
      reviewLimits: ctx.reviewLimits,
    });
    conflictRun.segmentRecords[1] = conflictSecond;
    const merged = mergeReviewedSegments(plan(), conflictRun.segmentRecords);
    assert.equal(merged.aggregate.conflicts.length, 1);
    assert.equal(merged.passed, false);
    assert.ok(merged.blockers.some(b => b.code === 'claim_value_conflict'));
  });
});

// --- 测试内辅助：直接针对已产出的合法记录做语义断言 -----------------------

function snapshotContentHash(record: SegmentRecord): string {
  const candidate = record.candidates.find(
    (c) => c.snapshotVersionId === record.result!.currentVersionId,
  )!;
  const snapshot = candidate.output!.candidateSnapshot;
  return fingerprint(snapshot);
}

function verifyRecord(record: SegmentRecord): Array<{ code: string }> {
  return verifySegment(record);
}

function verifyViaRun(
  run: Awaited<ReturnType<typeof runSegmentedFactWorkflow>>,
  code: string,
): boolean {
  const checked = mergeReviewedSegments(plan(), run.segmentRecords);
  assert.equal(checked.passed, false);
  return checked.blockers.some((b) => b.code === code);
}

test('纯函数：mergeReviewedSegments 对缺段与额外段不通过聚合复制', () => {
  const base = plan();
  const emptyView = mergeReviewedSegments(base, []);
  assert.equal(emptyView.passed, false);
  assert.ok(emptyView.blockers.some(b => b.code === 'missing_segment'));
  assert.equal(emptyView.aggregate.claimCount, 0);
  assert.deepEqual(emptyView.aggregate.claims, []);
  assert.deepEqual(emptyView.aggregate.conflicts, []);

  const fake: SegmentRecord = {
    id: 'seg_extra',
    inputHash: hashEvidenceInput(makeEvidenceInput()),
    input: makeEvidenceInput(),
    candidates: [],
    reviews: [],
  };
  const extraView = mergeReviewedSegments(base, [fake]);
  assert.equal(extraView.aggregate.claimCount, 0);
  assert.equal(extraView.passed, false);
  assert.ok(extraView.blockers.some(b => b.code === 'unexpected_segment'));
});

test('纯函数：输入哈希对同内容稳定，对差异输入变化', () => {
  const a: EvidenceInput = makeEvidenceInput();
  const b: EvidenceInput = makeEvidenceInput();
  assert.equal(hashEvidenceInput(a), hashEvidenceInput(b));
  const changed = structuredClone(a);
  changed.taskId = 'task_other';
  assert.notEqual(hashEvidenceInput(a), hashEvidenceInput(changed));
});

test('SYNTHETIC：生产合并门禁拒绝无效记录、身份、版本、来源和未决问题', async t => {
  await withGateway(async ctx => {
    const base = await runSegmentedFactWorkflow({ segments: plan(), registry, config: ctx.config,
      evidenceLimits: ctx.evidenceLimits, reviewLimits: ctx.reviewLimits });
    assert.equal(base.passed, true);
    const cases: Array<[string, string, (record: SegmentRecord) => void]> = [
      ['failed status', 'segment_status_not_passed', r => { r.result!.status = 'failed'; }],
      ['passed flag false', 'segment_not_passed', r => { r.result!.passed = false; }],
      ['missing current version binding', 'current_version_unbound', r => { r.result!.candidateVersions = []; }],
      ['invalid candidate state', 'candidate_state_unexpected', r => { candidateOf(r).candidate.state = 'invalid'; }],
      ['absent candidate output', 'candidate_output_missing', r => { delete candidateOf(r).candidate.output; }],
      ['empty evidence', 'candidate_evidence_empty', r => { candidateOf(r).snapshot.evidence = []; rebind(r); }],
      ['missing entity', 'claim_entity_missing', r => { candidateOf(r).snapshot.entities = []; rebind(r); }],
      ['missing evidence reference', 'claim_evidence_ref_missing', r => { candidateOf(r).snapshot.claims[0]!.evidenceRefs = ['ev_absent']; rebind(r); }],
      ['empty evidence references', 'claim_evidence_empty', r => { candidateOf(r).snapshot.claims[0]!.evidenceRefs = []; rebind(r); }],
      ['missing report', 'review_record_missing', r => { r.reviews = []; }],
      ['report version not in run', 'review_record_missing', r => { r.result!.reportVersions = []; }],
      ['old subject version', 'review_record_missing', r => { candidateOf(r).review.output!.report.subject.snapshotVersionId = 'snapshot_old'; }],
      ['wrong content hash', 'review_subject_mismatch', r => { candidateOf(r).review.output!.report.subject.contentHash = fingerprint({ wrong: true }); }],
      ['invalid report state', 'review_state_unexpected', r => { candidateOf(r).review.state = 'invalid'; }],
      ['wrong review output identity', 'review_output_identity_mismatch', r => { candidateOf(r).review.output!.taskId = 'task_other'; }],
      ['wrong report identity', 'review_identity_mismatch', r => { candidateOf(r).review.output!.report.projectId = 'project_other'; }],
      ['failed report execution', 'review_execution_not_completed', r => { candidateOf(r).review.output!.report.executionStatus = 'failed'; }],
      ['non-pass verdict', 'review_verdict_not_pass', r => { candidateOf(r).review.output!.report.verdict = 'revise'; }],
      ['missing check category', 'review_checks_incomplete', r => { candidateOf(r).review.output!.report.checks.pop(); }],
      ['failed check', 'review_check_not_pass', r => { candidateOf(r).review.output!.report.checks[0]!.status = 'fail'; }],
      ['blocking review issue', 'review_blocking_issues', r => { candidateOf(r).review.output!.report.issues.push({ issueId: 'issue_block', severity: 'error', category: 'support', description: 'Synthetic blocker' }); }],
      ['same role sessions', 'session_not_independent', r => { const { snapshot, review } = candidateOf(r); review.output!.report.reviewedBy.sessionId = snapshot.producedBy.sessionId; }],
      ['missing role session', 'session_not_independent', r => { delete candidateOf(r).review.output!.report.reviewedBy.sessionId; }],
      ['open conflict', 'candidate_open_conflict', r => { candidateOf(r).snapshot.conflicts.push({ conflictId: 'conflict_open', claimRefs: ['claim_rd'], description: 'Synthetic', resolutionStatus: 'open' }); rebind(r); }],
      ['deferred conflict', 'candidate_open_conflict', r => { candidateOf(r).snapshot.conflicts.push({ conflictId: 'conflict_deferred', claimRefs: ['claim_rd'], description: 'Synthetic', resolutionStatus: 'deferred' }); rebind(r); }],
      ['critical missing', 'candidate_critical_missing', r => { candidateOf(r).snapshot.missing.push({ missingId: 'missing_critical', description: 'Synthetic', severity: 'critical' }); rebind(r); }],
      ['duplicate candidate version', 'duplicate_candidate_version', r => { r.candidates.push(structuredClone(candidateOf(r).candidate)); }],
      ['duplicate report version', 'duplicate_report_version', r => { r.reviews.push(structuredClone(candidateOf(r).review)); }],
      ['recorded exception', 'segment_execution_failed', r => { r.error = { code: 'segment_execution_failed', message: 'Synthetic exception', fatal: true }; }],
    ];
    for (const [name, code, mutate] of cases) {
      await t.test(name, () => {
        const records = structuredClone(base.segmentRecords);
        mutate(records[0]!);
        const checked = mergeReviewedSegments(plan(), records);
        assert.equal(checked.passed, false);
        assert.equal(checked.status, 'failed');
        assert.ok(checked.blockers.some(b => b.code === code), JSON.stringify(checked.blockers));
        assert.deepEqual(checked.segmentRecords, records, 'failed inputs and records are retained');
      });
    }
  });
});

/** Test-data rebinding only: assertions always invoke production verification/merge. */
function rebind(record: SegmentRecord): void {
  const { snapshot, review } = candidateOf(record);
  review.output!.report.subject.contentHash = fingerprint(snapshot);
}

test('SYNTHETIC：选择当前候选的最新报告，不能倒退复用旧 pass', async () => {
  await withGateway(async ctx => {
    const base = await runSegmentedFactWorkflow({ segments: plan(), registry, config: ctx.config });
    assert.equal(base.passed, true);
    const records = structuredClone(base.segmentRecords);
    const current = records[0]!;
    const old = structuredClone(candidateOf(records[1]!).review);
    old.output!.report.verdict = 'revise';
    current.reviews.unshift(old);
    current.result!.reportVersions.unshift(old.reportVersionId);
    assert.deepEqual(verifySegment(current), []);
    assert.equal(mergeReviewedSegments(plan(), records).passed, true);
    // A later report for this same current candidate wins, even if an earlier pass exists.
    const later = structuredClone(candidateOf(current).review);
    later.reportVersionId = 'reportv_later';
    later.output!.report.reportVersionId = later.reportVersionId;
    later.output!.report.verdict = 'revise';
    current.reviews.push(later);
    current.result!.reportVersions.push(later.reportVersionId);
    let checked = mergeReviewedSegments(plan(), records);
    assert.equal(checked.passed, false);
    assert.ok(checked.blockers.some(b => b.code === 'review_verdict_not_pass'));
    later.output!.report.verdict = 'pass';
    later.output!.report.subject.contentHash = fingerprint({ wrong: true });
    checked = mergeReviewedSegments(plan(), records);
    assert.equal(checked.passed, false);
    assert.ok(checked.blockers.some(b => b.code === 'review_subject_mismatch'));
  });
});

test('SYNTHETIC：计划覆盖、陈旧版本、跨段会话与聚合来源保全', async () => {
  await withGateway(async ctx => {
    const base = await runSegmentedFactWorkflow({ segments: plan(), registry, config: ctx.config });
    assert.equal(base.passed, true);
    const records = base.segmentRecords;
    let checked = mergeReviewedSegments(plan(), [...records, records[0]!]);
    assert.equal(checked.passed, false);
    assert.ok(checked.blockers.some(b => b.code === 'duplicate_segment_result'));
    const stalePlan = plan();
    stalePlan[0]!.input.documents[0]!.blocks[0]!.text += 'Changed source.';
    checked = mergeReviewedSegments(stalePlan, records);
    assert.equal(checked.passed, false);
    assert.ok(checked.blockers.some(b => b.code === 'planned_input_mismatch'));
    const reused = structuredClone(records);
    candidateOf(reused[1]!).snapshot.producedBy.sessionId = candidateOf(reused[0]!).snapshot.producedBy.sessionId;
    rebind(reused[1]!);
    checked = mergeReviewedSegments(plan(), reused);
    assert.equal(checked.passed, false);
    assert.ok(checked.blockers.some(b => b.code === 'session_reused'));
    const distinctScope = structuredClone(records);
    const snapshot = candidateOf(distinctScope[1]!).snapshot;
    snapshot.claims[0]!.qualifiers = { time: { year: 2026 } };
    snapshot.relations = [{ relationId: 'relation_self', fromEntityId: 'ent_company', toEntityId: 'ent_company', relationType: 'related', evidenceRefs: ['ev_rd'] }];
    snapshot.events = [{ eventId: 'event_rd', entityId: 'ent_company', eventType: 'rd', description: 'Synthetic', evidenceRefs: ['ev_rd'] }];
    snapshot.assets = [{ assetId: 'asset_rd', documentId: 'doc_repair', documentVersionId: 'docv_repair_1', blockId: 'b001', location: { kind: 'paragraph', paragraphIndex: 0 }, description: 'Synthetic' }];
    snapshot.missing = [{ missingId: 'missing_optional', severity: 'warning', description: 'Optional synthetic gap' }];
    snapshot.conflicts = [{ conflictId: 'conflict_resolved', claimRefs: ['claim_rd'], resolutionStatus: 'resolved', description: 'Resolved synthetic history' }];
    rebind(distinctScope[1]!);
    const before = fingerprint({ plan: plan(), records: distinctScope });
    checked = mergeReviewedSegments(plan(), distinctScope);
    assert.equal(checked.passed, true);
    assert.equal(checked.aggregate.claimCount, 3, 'different qualifiers must not merge or conflict');
    assert.deepEqual(checked.aggregate.conflicts, []);
    for (const key of ['relations', 'events', 'assets', 'missing', 'rawConflicts'] as const) assert.equal(checked.aggregate[key].length, 1);
    assert.equal(fingerprint({ plan: plan(), records: distinctScope }), before, 'pure merge does not mutate input');
    checked.segmentRecords[0]!.input.taskId = 'changed_after_return';
    assert.equal(distinctScope[0]!.input.taskId, 'task_repair', 'returned records are detached audit copies');
  });
});

test('SYNTHETIC：非法计划与执行异常均保留失败，零模型请求', async () => {
  await withGateway(async ctx => {
    for (const segments of [
      [{ id: ' ', input: makeEvidenceInput() }],
      [{ id: 'seg_a', input: makeEvidenceInput() }, { id: 'seg_b', input: { ...makeEvidenceInput(), projectId: 'project_other' } }],
    ]) {
      const result = await runSegmentedFactWorkflow({ segments, registry, config: ctx.config });
      assert.equal(result.passed, false);
      assert.equal(result.status, 'failed');
      assert.ok(result.segmentRecords.every(r => r.result === undefined));
    }
    const result = await runSegmentedFactWorkflow({ segments: plan(), registry, config: ctx.config, maxRepairRounds: 3 });
    assert.equal(result.passed, false);
    assert.equal(result.segmentRecords.length, 2);
    assert.ok(result.segmentRecords.every(r => r.error?.code === 'segment_execution_failed'));
    assert.equal(ctx.gateway.requests(), 0);
  });
});
