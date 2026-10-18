/** B5 受控事实工作流（提取 → 独立审查 → 有条件返修 → 再审查）程序回归。
 *  真实 Pi SDK + 本地模拟网关（SYNTHETIC SSE，非真实模型）。
 *  覆盖：首版通过、一次返修成功、返修改坏正确事实被再审查发现、缺失/冲突转等待、
 *  返修上限、无实质修改、重复问题、审查格式/引用/版本错误、预算/超时/取消、
 *  历史可读/运行隔离/候选不自动采纳，以及 expected/actual 相同的回归守卫。
 *  夹具为合成数据，只验证程序编排与受控决策，不代表真实模型质量。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReviewOutput } from '../../packages/contracts/generated/review-output.ts';
import type { EvidenceOutput, EvidenceOutputClaimChange } from '../../packages/contracts/generated/evidence-output.ts';
import type { WithdrawalPermit } from '../../apps/server/src/domain/review-decision.ts';
import { RequestSpendBudget } from '../../apps/server/src/runtime/pi/spend-budget.ts';
import { EVIDENCE_LIMITS } from '../../apps/server/src/runtime/pi/execution-limits.ts';
import { evaluateReviewReport } from '../../apps/server/src/domain/review-decision.ts';
import {
  runFactScenario, defaultScript, makeCandidate, valuesOf,
  type CandidateValues, type Envelope, type ReportSpec,
} from '../helpers/fact-workflow-harness.ts';
import { FileSystemFactRunStore } from '../../apps/server/src/domain/fact-run.service.ts';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* APPENDED TESTS MARKER */

/* ---------- 纯函数回归：expected/actual 不得错误地相同 ---------- */

const provenance = { role: 'review', protocolVersion: '1.0', model: 'synthetic', sessionId: 'session_x', promptVersion: 'review_b4_v12' } as const;

function reviewOutputFor(snapshot: ReturnType<typeof makeCandidate>['candidateSnapshot'], issues: Array<Record<string, unknown>>, verdict: 'pass' | 'revise' | 'needs_input'): ReviewOutput {
  return {
    protocolVersion: '1.0', projectId: 'project_repair', taskId: 'task_repair', attemptId: 'attempt_repair', status: 'completed',
    report: {
      protocolVersion: '1.0', reportId: 'report_x', reportVersionId: 'reportv_x',
      projectId: 'project_repair', taskId: 'task_repair', attemptId: 'attempt_repair', reviewMode: 'fact',
      subject: { subjectType: 'evidence_snapshot', snapshotId: snapshot.snapshotId, snapshotVersionId: snapshot.snapshotVersionId, contentHash: 'sha256:x' },
      verdict, checks: [], issues: issues as never, summary: 's', executionStatus: 'completed', reviewedBy: provenance, createdAt: '2025-01-10T08:00:00Z',
    },
    producedBy: provenance,
  };
}
test('B5 回归：证据值与候选值不同时 expected/actual 相同属无效结论，不放行也不返修', () => {
  const envelope: Envelope = { snapshotId: 'snap_x', snapshotVersionId: 'snapv_x_1', createdAt: '2025-01-10T08:00:00Z', producedBy: { role: 'evidence', protocolVersion: '1.0' } as Envelope['producedBy'] };
  const snapshot = makeCandidate(envelope, { rd: 600, founded: 2018 }).candidateSnapshot;
  const output = reviewOutputFor(snapshot, [{ issueId: 'i1', claimId: 'claim_rd', severity: 'error', category: 'value', description: '值不一致', expected: '600 人', actual: '600 人' }], 'revise');
  const evaluation = evaluateReviewReport(output, snapshot);
  assert.equal(evaluation.decision.kind, 'stop');
  assert.ok(evaluation.consistency.includes('report.expected_actual_identical'));
});
test('B5 回归：报告已核对出取值差异却判 pass 属无效结论', () => {
  const envelope: Envelope = { snapshotId: 'snap_y', snapshotVersionId: 'snapv_y_1', createdAt: '2025-01-10T08:00:00Z', producedBy: { role: 'evidence', protocolVersion: '1.0' } as Envelope['producedBy'] };
  const snapshot = makeCandidate(envelope, { rd: 60, founded: 2018 }).candidateSnapshot;
  const output = reviewOutputFor(snapshot, [{ issueId: 'i1', claimId: 'claim_rd', severity: 'error', category: 'value', description: '值不一致', expected: '60 人', actual: '600 人' }], 'pass');
  const evaluation = evaluateReviewReport(output, snapshot);
  assert.equal(evaluation.decision.kind, 'stop');
  assert.ok(evaluation.consistency.includes('report.pass_with_unresolved_mismatch') || evaluation.consistency.includes('report.pass_with_blocking_issue'));
});

/* ---------- 工作流场景 ---------- */

function mismatchSpec(values: CandidateValues, only?: 'rd' | 'founded'): ReportSpec {
  const issues: ReportSpec['issues'] = [];
  if (only !== 'founded' && values.rd !== 60) issues.push({ category: 'value', claimId: 'claim_rd', expected: '60 人', actual: `${values.rd} 人` });
  if (only !== 'rd' && values.founded !== 2018) issues.push({ category: 'value', claimId: 'claim_founded', expected: '2018 年', actual: `${values.founded} 年` });
  return issues.length ? { verdict: 'revise', issues } : { verdict: 'pass' };
}

test('B5 ①正确候选首次审查通过，不触发返修', async () => {
  const h = await runFactScenario({ script: defaultScript() });
  assert.equal(h.result.status, 'passed');
  assert.equal(h.result.passed, true);
  assert.equal(h.result.stopReason, 'passed_all_checks');
  assert.equal(h.result.repairRounds, 0);
  assert.equal(h.result.candidateVersions.length, 1);
  assert.equal(h.counts.evidence, 1);
  assert.equal(h.counts.review, 1);
  assert.ok(h.result.evidenceRefs.includes('ev_rd') && h.result.evidenceRefs.includes('ev_founded'));
});

test('B5 ②数值错误返修一次后通过，旧版本保留且不被覆盖', async () => {
  const h = await runFactScenario({
    script: defaultScript({
      evidence: () => ({ values: { rd: 600, founded: 2018 } }),
      repair: () => ({ rd: 60, founded: 2018 }),
    }),
  });
  assert.equal(h.result.status, 'passed');
  assert.equal(h.result.repairRounds, 1);
  assert.equal(h.result.candidateVersions.length, 2);
  assert.equal(h.counts.review, 2);
  const records = h.candidateStore.list();
  const first = records.find(r => r.snapshotVersionId === h.result.candidateVersions[0]);
  const second = records.find(r => r.snapshotVersionId === h.result.candidateVersions[1]);
  assert.ok(first && second);
  const firstRd = valuesOf(first.output!.candidateSnapshot).rd;
  const secondRd = valuesOf(second.output!.candidateSnapshot).rd;
  assert.equal(firstRd, 600, '旧版本保留原始错误值');
  assert.equal(secondRd, 60);
  assert.equal(first!.state, 'pending_review');
  assert.equal(second!.state, 'pending_review');
  assert.equal(second!.output!.candidateSnapshot.basedOnSnapshotVersionId, h.result.candidateVersions[0]);
  assert.equal(h.result.record!.rounds[0].decision, 'repair');
  // changes 描述“本候选由哪次返修产生”：rounds[0] 是首版（无差异），rounds[1] 承载 v2 的返修差异。
  assert.ok(h.result.record!.rounds[1].changes.some(c => c.kind === 'claim' && c.id === 'claim_rd'));
});

test('B5 ③返修改坏正确事实能被下一轮独立审查发现', async () => {
  const h = await runFactScenario({
    script: defaultScript({
      evidence: () => ({ values: { rd: 600, founded: 2018 } }),
      repair: () => ({ rd: 60, founded: 2019 }), // 修好 rd 却改坏 founded
    }),
  });
  assert.equal(h.counts.review, 2);
  assert.ok(h.result.record!.rounds[1].issues.some(i => i.claimId === 'claim_founded'), '第二轮审查应发现被改坏的 founded');
  assert.notEqual(h.result.status, 'passed');
});

test('B5 ④资料缺失或来源冲突转等待用户，不返修', async () => {
  for (const category of ['missing', 'conflict'] as const) {
    const h = await runFactScenario({
      script: defaultScript({ review: () => ({ verdict: 'needs_input', issues: [{ category, description: category === 'missing' ? '缺少营业收入。' : '来源冲突无法消解。' }] }) }),
    });
    assert.equal(h.result.status, 'waiting_for_input', category);
    assert.equal(h.result.stopReason, 'needs_user_input', category);
    assert.equal(h.result.repairRounds, 0, category);
    assert.equal(h.counts.evidence, 1, '不得发起返修调用');
  }
});

test('B5 ⑤连续两轮返修仍不通过即停止，绝不自动转通过', async () => {
  let round = 0;
  const h = await runFactScenario({
    script: defaultScript({
      evidence: () => ({ values: { rd: 600, founded: 2018 } }),
      repair: () => { round++; return { rd: 600 + round * 100, founded: 2018 }; },
    }),
  });
  assert.equal(h.result.repairRounds, 2);
  assert.equal(h.result.status, 'not_passed');
  assert.equal(h.result.stopReason, 'repair_limit_reached');
  assert.equal(h.result.passed, false);
  assert.equal(h.counts.review, 3);
});

test('B5 ⑥a返修无实质修改则停止，不标通过', async () => {
  const h = await runFactScenario({
    script: defaultScript({
      evidence: () => ({ values: { rd: 600, founded: 2018 } }),
      repair: () => ({ rd: 600, founded: 2018 }),
    }),
  });
  assert.equal(h.result.stopReason, 'no_substantive_change');
  assert.equal(h.result.status, 'not_passed');
  assert.equal(h.result.repairRounds, 1);
});
test('B5 ⑥b同一问题持续存在且无实质修正则停止', async () => {
  const h = await runFactScenario({
    script: defaultScript({
      evidence: () => ({ values: { rd: 600, founded: 2018 } }),
      // 只改动未被点名的 founded（实质差异），但被点名的 rd 问题原样保留。
      repair: (prompt) => { const v = valuesOf(prompt.currentCandidate!.candidateSnapshot); return { rd: v.rd, founded: v.founded + 1 }; },
      review: (prompt) => mismatchSpec(valuesOf(prompt.candidateSnapshot), 'rd'),
    }),
  });
  assert.equal(h.result.stopReason, 'repeated_issue');
  assert.equal(h.result.status, 'not_passed');
});

test('B5 ⑦a审查输出格式非法不当作有效结论', async () => {
  const h = await runFactScenario({
    script: defaultScript(),
    reviewOverride: () => ({ status: 'completed', report: { nonsense: true } }),
  });
  assert.equal(h.result.status, 'failed');
  assert.equal(h.result.stopReason, 'review_execution_failed');
  assert.equal(h.result.repairRounds, 0);
});
test('B5 ⑦b审查报告引用不存在的候选事实不当作有效结论', async () => {
  const h = await runFactScenario({
    script: defaultScript({ review: () => ({ verdict: 'revise', issues: [{ category: 'value', claimId: 'claim_missing', expected: 'x', actual: 'y' }] }) }),
  });
  assert.equal(h.result.stopReason, 'review_execution_failed');
  assert.equal(h.result.repairRounds, 0);
});
test('B5 ⑦c审查报告绑定错误候选版本不当作有效结论', async () => {
  const h = await runFactScenario({
    script: defaultScript(),
    reviewOverride: (output) => {
      const copy = structuredClone(output);
      copy.report.subject.snapshotVersionId = 'snapv_forged_9';
      return copy;
    },
  });
  assert.equal(h.result.stopReason, 'review_execution_failed');
  assert.equal(h.result.repairRounds, 0);
});

test('B5 ⑧预算不足时不再发起任何模型调用', async () => {
  const spendBudget = new RequestSpendBudget(
    { limitMicros: 100, safetyMicros: 0, inputCnyPerMillion: 2, outputCnyPerMillion: 8, inputTokensPerByte: 2, inputTokenOverhead: 8192 },
    () => {},
  );
  const h = await runFactScenario({ script: defaultScript(), spendBudget });
  assert.equal(h.result.status, 'failed');
  assert.equal(h.result.stopReason, 'budget_exhausted');
  assert.equal(h.requests.length, 0);
  assert.equal(spendBudget.reservedMicros, 0);
});
test('B5 ⑧取消后不再发起模型调用', async () => {
  const h = await runFactScenario({ script: defaultScript(), signal: AbortSignal.abort() });
  assert.equal(h.result.status, 'cancelled');
  assert.equal(h.result.stopReason, 'cancelled');
  assert.equal(h.requests.length, 0);
});
test('B5 ⑧超时后不再发起新的模型调用', async () => {
  const h = await runFactScenario({ script: defaultScript(), hangEvidence: true, evidenceLimits: { ...EVIDENCE_LIMITS, timeoutMs: 300 } });
  assert.equal(h.result.status, 'failed');
  assert.equal(h.result.stopReason, 'timeout');
  assert.equal(h.requests.length, 1, '只允许已发出的那一次调用，超时后不得重发');
  assert.equal(h.counts.review, 0);
});

test('B5 ⑨历史可读、运行隔离、候选不自动采纳', async () => {
  const first = await runFactScenario({ script: defaultScript() });
  const second = await runFactScenario({ script: defaultScript() });
  assert.notEqual(first.result.runId, second.result.runId);
  const history = first.runStore.list();
  assert.equal(history.length, 1);
  assert.equal(history[0].runId, first.result.runId);
  assert.equal(history[0].passed, true);
  assert.equal(history[0].rounds.length, 1);
  assert.ok(history[0].candidateVersions.length >= 1);
  // 运行隔离：第二次运行的存储不包含第一次运行的记录。
  assert.equal(second.runStore.list().length, 1);
  assert.equal(second.runStore.list()[0].runId, second.result.runId);
  assert.equal(first.candidateStore.list().some(r => second.candidateStore.list().some(s => s.snapshotVersionId === r.snapshotVersionId)), false);
  // 候选不自动采纳：审查通过不等于正式采纳，仍为待审候选。
  assert.ok(first.candidateStore.list().every(r => r.state === 'pending_review'));
  assert.ok(first.runStore.list().every(r => r.rounds.every(rd => rd.candidateVersionId !== undefined)));
});/* ---------- 文件系统运行记录存储：跨进程回读、隔离、防篡改 ---------- */

const NODE_BIN = process.execPath;
const REPO = join(import.meta.dirname, '..', '..');

/** 在独立 Node 进程中回读 FileSystemFactRunStore，证明记录真正跨进程落盘。 */
function readInChild(rootDir: string, projectId: string, runId: string): Record<string, unknown> {
  const script = [
    "import { pathToFileURL } from 'node:url';",
    `const mod = await import(pathToFileURL(${JSON.stringify(join(REPO, 'apps/server/src/domain/fact-run.service.ts'))}).href);`,
    `const store = new mod.FileSystemFactRunStore(${JSON.stringify(rootDir)}, ${JSON.stringify(projectId)});`,
    `const rec = store.get(${JSON.stringify(runId)});`,
    'process.stdout.write(JSON.stringify({ rec, listed: store.list().map(r => r.runId) }));',
  ].join('\n');
  const child = spawnSync(NODE_BIN, ['--input-type=module', '-e', script], {
    cwd: REPO, encoding: 'utf8', env: process.env,
  });
  assert.equal(child.status, 0, '子进程回读失败: ' + child.stderr);
  return JSON.parse(child.stdout) as Record<string, unknown>;
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'tju-factrun-'));
}

test('B5 ⑩文件系统存储跨进程可回读完整工件、来源与决策', async () => {
  const root = tempRoot();
  try {
    const store = new FileSystemFactRunStore(root, 'project_repair');
    const h = await runFactScenario({ script: defaultScript(), runStore: store });
    assert.equal(h.result.status, 'passed');
    const record = h.result.record!;
    // 本进程内可回读
    const local = store.get(h.result.runId)!;
    assert.equal(local.passed, true);
    assert.equal(local.stopReason, 'passed_all_checks');
    assert.ok(local.rounds.length >= 1);
    assert.ok(local.evidenceRefs.includes('ev_rd') && local.evidenceRefs.includes('ev_founded'));
    assert.ok(local.candidateVersions.length >= 1);
    assert.ok(local.artifacts && local.artifacts.length >= 1);
    const candidateArtifact = local.artifacts!.find(a => a.kind === 'candidate');
    assert.ok(candidateArtifact && candidateArtifact.rawOutput.length > 0);
    // 独立进程回读同一记录，验证真实落盘而非内存缓存
    const child = readInChild(root, 'project_repair', h.result.runId);
    const reread = child.rec as Record<string, unknown>;
    assert.ok(reread, '子进程应能回读记录');
    assert.equal(reread.runId, h.result.runId);
    assert.equal(reread.passed, true);
    assert.equal(reread.stopReason, 'passed_all_checks');
    assert.deepEqual(reread.candidateVersions, record.candidateVersions);
    assert.deepEqual(reread.reportVersions, record.reportVersions);
    assert.deepEqual(child.listed, [h.result.runId]);
    const childArtifacts = reread.artifacts as Array<Record<string, unknown>>;
    assert.ok(childArtifacts.some(a => a.kind === 'candidate' && String(a.rawOutput).length > 0));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('B5 ⑩a同一项目两次运行记录互相隔离且都可回读', async () => {
  const root = tempRoot();
  try {
    const first = await runFactScenario({ script: defaultScript(), runStore: new FileSystemFactRunStore(root, 'project_repair') });
    const second = await runFactScenario({ script: defaultScript(), runStore: new FileSystemFactRunStore(root, 'project_repair') });
    assert.notEqual(first.result.runId, second.result.runId);
    const store = new FileSystemFactRunStore(root, 'project_repair');
    const listed = store.list().map(r => r.runId).sort();
    assert.deepEqual(listed, [first.result.runId, second.result.runId].sort());
    assert.equal(store.get(first.result.runId)!.runId, first.result.runId);
    assert.equal(store.get(second.result.runId)!.runId, second.result.runId);
    const child = readInChild(root, 'project_repair', second.result.runId);
    assert.equal((child.rec as Record<string, unknown>).runId, second.result.runId);
    assert.deepEqual(child.listed, [first.result.runId, second.result.runId].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('B5 ⑩b不同项目根目录隔离，互不可见', async () => {
  const rootA = tempRoot();
  const rootB = tempRoot();
  try {
    const a = await runFactScenario({ script: defaultScript(), runStore: new FileSystemFactRunStore(rootA, 'project_repair') });
    const storeB = new FileSystemFactRunStore(rootB, 'project_repair');
    assert.equal(storeB.get(a.result.runId), undefined);
    assert.deepEqual(storeB.list(), []);
    const child = readInChild(rootB, 'project_repair', a.result.runId);
    assert.equal(child.rec, undefined);
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test('B5 ⑩c相同记录幂等重存允许，改写历史或状态被拒绝', async () => {
  const root = tempRoot();
  try {
    const h = await runFactScenario({ script: defaultScript(), runStore: new FileSystemFactRunStore(root, 'project_repair') });
    const store = new FileSystemFactRunStore(root, 'project_repair');
    const original = store.get(h.result.runId)!;
    // 幂等重存：逐字相同，允许。
    assert.doesNotThrow(() => store.save(structuredClone(original)));
    // 状态改写被拒绝。
    const tamperedStatus = structuredClone(original);
    tamperedStatus.status = 'not_passed';
  tamperedStatus.passed = false;
  tamperedStatus.stopReason = 'repair_limit_reached';
    assert.throws(() => store.save(tamperedStatus), (error: unknown) =>
      (error as { code?: string }).code === 'history_rewrite_rejected');
    // 内容改写被拒绝，且原记录未被覆盖。
    const tamperedContent = structuredClone(original);
    tamperedContent.passed = false;
    assert.throws(() => store.save(tamperedContent), (error: unknown) =>
      (error as { code?: string }).code === 'history_rewrite_rejected');
    const after = store.get(h.result.runId)!;
    assert.equal(after.passed, true);
    assert.equal(after.status, original.status);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('B5 ⑩d损坏、截断、哈希不符与不安全标识均被拒绝', async () => {
  const root = tempRoot();
  try {
    const h = await runFactScenario({ script: defaultScript(), runStore: new FileSystemFactRunStore(root, 'project_repair') });
    const runId = h.result.runId;
    const projectDir = join(root, 'project_repair');
    const file = join(projectDir, runId + '.json');
    const good = readFileSync(file, 'utf8');
    const store = new FileSystemFactRunStore(root, 'project_repair');

    // 截断：非法 JSON。
    writeFileSync(file, good.slice(0, Math.floor(good.length / 2)));
    assert.throws(() => store.get(runId), (error: unknown) =>
      (error as { code?: string }).code === 'malformed_record');
    // 哈希不符：解析合法但内容被改。
    const parsed = JSON.parse(good) as Record<string, unknown>;
    const recordObj = parsed.record as Record<string, unknown>;
    recordObj.passed = !recordObj.passed;
    writeFileSync(file, JSON.stringify(parsed));
    assert.throws(() => store.get(runId), (error: unknown) =>
      (error as { code?: string }).code === 'content_hash_mismatch');
    // 恢复文件，测试不安全标识。
    writeFileSync(file, good);
    for (const bad of ['../escape', 'a/b', '', '.', '..', 'x'.repeat(129)]) {
      assert.throws(() => store.get(bad), (error: unknown) =>
        (error as { code?: string }).code === 'unsafe_run_id', bad);
    }
    assert.throws(() => new FileSystemFactRunStore(root, 'bad/project'), (error: unknown) =>
      (error as { code?: string }).code === 'unsafe_project_id');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('B5 ⑩e符号链接与宽松权限被拒绝，私有权限正常', async () => {
  const root = tempRoot();
  const outside = tempRoot();
  try {
    const h = await runFactScenario({ script: defaultScript(), runStore: new FileSystemFactRunStore(root, 'project_repair') });
    const runId = h.result.runId;
    const projectDir = join(root, 'project_repair');
    const file = join(projectDir, runId + '.json');
    const store = new FileSystemFactRunStore(root, 'project_repair');
    // 正常私有权限下可回读。
    assert.equal(store.get(runId)!.runId, runId);
    // 文件为符号链接：拒绝穿越。
    const linkFile = join(projectDir, 'run_evil_link.json');
    symlinkSync(join(outside, 'target.json'), linkFile);
    assert.throws(() => store.get('run_evil_link'), (error: unknown) =>
      ['symlink_rejected', 'symlink_rejected:ancestor'].includes((error as { code?: string }).code ?? ''));
    // 目录权限被放宽：拒绝。
    chmodSync(projectDir, 0o777);
    assert.throws(() => store.get(runId), (error: unknown) =>
      String((error as { code?: string }).code).startsWith('insecure_project'));
    chmodSync(projectDir, 0o700);
    assert.equal(store.get(runId)!.runId, runId);
  } finally {
    chmodSync(join(root, 'project_repair'), 0o700);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('B5 ⑩f注入保存失败使工作流拒绝返回已通过记录', async () => {
  const root = tempRoot();
  try {
    const real = new FileSystemFactRunStore(root, 'project_repair');
    let saved = false;
    const failing: import('../../apps/server/src/domain/fact-run.service.ts').FactRunStore = {
      save: () => { saved = true; throw new Error('injected_persist_failure'); },
      get: (runId) => real.get(runId),
      list: () => real.list(),
    };
    await assert.rejects(
      () => runFactScenario({ script: defaultScript(), runStore: failing }),
      (error: unknown) => (error as Error).message === 'injected_persist_failure',
      '持久化失败必须抛出，绝不返回 passed',
    );
    assert.equal(saved, true, '应确实尝试过保存');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});/* ---------- 纯函数回归：撤下保留校验（repair-validator） ---------- */

test('repair preservation: withdrawal permits are optional and evidence is never removable', async () => {
  const { validateRepairPreservation } = await import('../../apps/server/src/domain/repair-validator.ts');
  type AnyRecord = Record<string, unknown>;
  const clone = <T>(value: T): T => structuredClone(value);

  const envelope: Envelope = {
    snapshotId: 'snap_repair',
    snapshotVersionId: 'snapshot_v1',
    createdAt: '2025-01-10T08:00:00Z',
    producedBy: { role: 'evidence', protocolVersion: '1.0' } as Envelope['producedBy'],
  };

  // 既有辅助是唯一真源：makeCandidate(Envelope, CandidateValues) -> EvidenceOutput。
  const previous: EvidenceOutput = makeCandidate(envelope, { rd: 60, founded: 2018 });
  const parentVersionId = previous.candidateSnapshot.snapshotVersionId;
  const snapshotVersionId = 'snapshot_v2';

  const nextOutput = (): EvidenceOutput => {
    const next = clone(previous);
    next.candidateSnapshot.snapshotVersionId = snapshotVersionId;
    next.candidateSnapshot.basedOnSnapshotVersionId = parentVersionId;
    return next;
  };

  const removeClaim = (snapshot: EvidenceOutput['candidateSnapshot'], claimId: string): void => {
    const index = snapshot.claims.findIndex((claim) => claim.claimId === claimId);
    if (index >= 0) snapshot.claims.splice(index, 1);
  };
  const removeEvidence = (snapshot: EvidenceOutput['candidateSnapshot'], evidenceId: string): void => {
    const index = snapshot.evidence.findIndex((entry) => entry.evidenceId === evidenceId);
    if (index >= 0) snapshot.evidence.splice(index, 1);
  };

  const permit = (overrides: Partial<WithdrawalPermit> = {}): WithdrawalPermit => ({
    parentVersionId,
    reportVersionId: 'report_v1',
    claimId: 'claim_founded',
    issueIds: ['issue_1'],
    evidenceRefs: ['ev_founded'],
    reason: 'review named this fact as unsupported',
    ...overrides,
  });

  const removedChange: EvidenceOutputClaimChange = { changeId: 'change_1', changeType: 'removed', claimId: 'claim_founded', description: 'withdraw unsupported fact' };

  // 变更位于 OUTPUT 顶层（不是 candidateSnapshot 内）。
  const candidate = (mutate: (snapshot: EvidenceOutput['candidateSnapshot']) => void, changes?: EvidenceOutputClaimChange[]): EvidenceOutput => {

    const next = nextOutput();
    mutate(next.candidateSnapshot);
    return changes === undefined ? next : { ...next, changes };
  };
  /** 生成 v2：撤下 claim_founded（可选再撤下额外事实 claimId）。 */
  const withdrawn = (extraClaimId?: string): EvidenceOutput => candidate((snapshot) => {
    removeClaim(snapshot, 'claim_founded');
    if (extraClaimId !== undefined) removeClaim(snapshot, extraClaimId);
  }, [removedChange]);

  const run = (raw: unknown, permits: WithdrawalPermit[] = []) =>
    validateRepairPreservation(raw, previous, parentVersionId, ['claim_founded'], permits);

  const codes = (raw: unknown, permits: WithdrawalPermit[] = []) => run(raw, permits).issues.map((issue) => issue.code);

  // 合法场景：带显式 removed 声明 + 有效可信许可 → 允许撤下，既有证据全部保留。
  const permittedResult = run(withdrawn(), [permit()]);
  assert.equal(permittedResult.ok, true, JSON.stringify(permittedResult.issues));

  // 合法场景：被允许的 claim 仍保留且无 removed 声明 → 许可只是可选权限，成功。
  const retained = run(candidate(() => {}), [permit()]);
  assert.equal(retained.ok, true, JSON.stringify(retained.issues));

  const cases: Array<[string, EvidenceOutput, WithdrawalPermit[], string]> = [
    ['no permit', withdrawn(), [], 'repair.removed_fact'],
    ['no declaration', candidate((snapshot) => removeClaim(snapshot, 'claim_founded')), [permit()], 'repair.withdrawal_undeclared'],
    ['unrelated deletion', withdrawn('claim_rd'), [permit()], 'repair.removed_fact'],
    ['blank reason', candidate((snapshot) => removeClaim(snapshot, 'claim_founded'), [{ ...removedChange, description: '   ' }]), [permit()], 'repair.withdrawal_reason_missing'],
    ['duplicate declaration', candidate((snapshot) => removeClaim(snapshot, 'claim_founded'), [removedChange, { ...removedChange, changeId: 'change_2' }]), [permit()], 'repair.withdrawal_duplicate_declaration'],
    ['stale parent', withdrawn(), [permit({ parentVersionId: 'snapshot_v0' })], 'repair.removed_fact'],
    ['blank report version', withdrawn(), [permit({ reportVersionId: ' ' })], 'repair.removed_fact'],
    ['empty issue ids', withdrawn(), [permit({ issueIds: [] })], 'repair.removed_fact'],
    ['nonexistent evidence in permit', withdrawn(), [permit({ evidenceRefs: ['ev_missing'] })], 'repair.removed_fact'],
    ['deleted evidence', candidate((snapshot) => { removeClaim(snapshot, 'claim_founded'); removeEvidence(snapshot, 'ev_founded'); }, [removedChange]), [permit()], 'repair.removed_evidence'],
  ];
  for (const [label, raw, permits, expected] of cases) {
    assert.ok(codes(raw, permits).includes(expected), label);
  }

  // 冲突引用：被撤下事实仍被未解决冲突引用 → 拒绝隐藏冲突。
  const conflicts: EvidenceOutput['candidateSnapshot']['conflicts'] = [{
    conflictId: 'conflict_1', resolutionStatus: 'open', claimRefs: ['claim_founded'], description: 'open conflict',
  }];
  const conflictPrevious = clone(previous);
  conflictPrevious.candidateSnapshot.conflicts = clone(conflicts);
  const conflictNext = withdrawn();
  conflictNext.candidateSnapshot.conflicts = clone(conflicts);
  const conflictResult = validateRepairPreservation(conflictNext, conflictPrevious, parentVersionId, ['claim_founded'], [permit()]);
  assert.ok(conflictResult.issues.some((issue) => issue.code === 'repair.withdrawal_hides_conflict'), JSON.stringify(conflictResult.issues));
});/* ---------- 完整合成 SDK 返修分支：撤下许可、修改项与真实会话身份 ---------- */

test('B5 SDK 返修分支：许可、修改项、会话身份与最终绑定', async () => {
  const script = defaultScript({
    review: (prompt, call: number): ReportSpec => {
      if (call === 1) {
        return {
          verdict: 'revise',
          issues: [{
            category: 'support', claimId: 'claim_founded', severity: 'error',
            expected: '有来源支撑的成立年份', actual: '主张未被来源充分支撑',
            description: '成立年份主张缺少来源支撑，需返修核验。',
          }],
        };
      }
      return { verdict: 'pass' };
    },
    repair: () => ({ rd: 60, founded: 2018 }),
  });

  const handle = await runFactScenario({
    script,
    candidateOverride: (output, prompt) => {
      if (!prompt.repair) return output;
      const cloned = structuredClone(output);
      const foundIndex = cloned.candidateSnapshot.claims.findIndex(c => c.claimId === 'claim_founded');
      if (foundIndex >= 0) cloned.candidateSnapshot.claims.splice(foundIndex, 1);
      cloned.changes = [{
        changeId: 'change_founded_removed',
        changeType: 'removed',
        claimId: 'claim_founded',
        description: '移除未被来源支撑的成立年份主张。',
      }] as EvidenceOutput['changes'];
      return cloned;
    },
  });

  const { result, candidateStore, reviewStore, counts } = handle;
  assert.equal(result.passed, true, '第二审查应通过');
  assert.equal(counts.review, 2, '应恰有两次审查调用');
  assert.equal(result.repairRounds, 1, '应恰有一次返修');

  // 旧候选仍保留 claim_founded；新候选移除之但保留同一来源证据。
  assert.equal(result.candidateVersions.length, 2);
  const [oldVersionId, newVersionId] = result.candidateVersions;
  const oldRecord = candidateStore.list().find(r => r.snapshotVersionId === oldVersionId);
  const newRecord = candidateStore.list().find(r => r.snapshotVersionId === newVersionId);
  assert.ok(oldRecord && newRecord, '两个候选记录均应存在');
  assert.ok(oldRecord.output && newRecord.output, '两个候选输出均应存在');
  const oldSnapshot = oldRecord.output.candidateSnapshot;
  const newSnapshot = newRecord.output.candidateSnapshot;
  assert.ok(oldSnapshot.claims.some(c => c.claimId === 'claim_founded'), '旧候选仍含 claim_founded');
  assert.equal(newSnapshot.claims.some(c => c.claimId === 'claim_founded'), false, '新候选应移除 claim_founded');
  assert.deepEqual(
    [...newSnapshot.evidence.map(e => e.evidenceId)].sort(),
    [...oldSnapshot.evidence.map(e => e.evidenceId)].sort(),
    '新候选应保留相同来源证据',
  );

  // 父绑定：新候选基于旧版本。
  assert.equal(newSnapshot.basedOnSnapshotVersionId, oldSnapshot.snapshotVersionId, '新候选应绑定父版本');

  // 最终报告主题绑定当前（新）候选。
  const record = result.record;
  assert.ok(record, '应存在运行记录');
  assert.equal(record.currentVersionId, newVersionId, '当前版本应为新候选');
  const finalRound = record.rounds.at(-1);
  assert.ok(finalRound, '应有最终审查轮');
  const finalReportId = finalRound.reportVersionId;
  assert.ok(finalReportId, '最终轮应有报告版本');
  const finalReview = reviewStore.list().find(r => r.reportVersionId === finalReportId);
  assert.ok(finalReview && finalReview.output, '最终报告输出应存在');
  assert.equal(finalReview.output.report.subject.snapshotVersionId, newVersionId, '最终报告主题应绑定新候选');

  // 首轮：精确检验许可字段。
  const firstRound = record.rounds[0];
  assert.ok(firstRound.withdrawalPermits, '首轮应有撤下许可');
  assert.equal(firstRound.withdrawalPermits.length, 1, '应有恰一条撤下许可');
  const permit = firstRound.withdrawalPermits[0];
  assert.equal(permit.claimId, 'claim_founded');
  assert.equal(permit.parentVersionId, oldSnapshot.snapshotVersionId, '许可绑定父候选');
  assert.equal(permit.reportVersionId, firstRound.reportVersionId, '许可绑定报告');
  assert.ok(permit.issueIds.includes('issue_0'), '许可绑定问题');
  assert.deepEqual(
    [...permit.evidenceRefs].sort(),
    [...oldSnapshot.claims.find(c => c.claimId === 'claim_founded')!.evidenceRefs].sort(),
    '许可绑定问题来源证据',
  );
  assert.equal(typeof permit.reason, 'string');
  assert.ok(permit.reason.length > 0, '许可应带理由');

  // 所有候选仍为 pending（不自动采纳）。
  for (const rec of candidateStore.list()) {
    assert.equal(rec.state, 'pending_review', '候选应保持待审查');
  }

  // 四个互不相同的真实会话身份：旧提取、返修、两次报告。
  const sessionIds = [
    oldSnapshot.producedBy.sessionId,
    newSnapshot.producedBy.sessionId,
  ];
  for (const rec of reviewStore.list()) {
    assert.ok(rec.output, '报告输出应存在');
    sessionIds.push(rec.output.report.reviewedBy.sessionId);
  }
  assert.equal(sessionIds.length, 4, '应有四个产出身份');
  assert.equal(new Set(sessionIds).size, 4, '四个会话身份应互不相同');
});/* ---------- 执行终态契约：status 与 executionStatus 映射真值表 ---------- */

test('B5 执行终态映射：已处理业务停止为 succeeded 且 passed 仍为 false', async () => {
  const { executionStatusFor } = await import('../../apps/server/src/orchestration/state.ts');

  // passed → succeeded
  assert.equal(executionStatusFor('passed', 'passed_all_checks'), 'succeeded');

  // 已处理业务停止（status=not_passed）→ succeeded，但 passed 必须保持 false。
  for (const reason of ['repair_limit_reached', 'no_substantive_change', 'repeated_issue', 'review_unactionable'] as const) {
    assert.equal(executionStatusFor('not_passed', reason), 'succeeded', reason);
  }

  // waiting_for_input 保持 waiting_for_input。
  assert.equal(executionStatusFor('waiting_for_input', 'needs_user_input'), 'waiting_for_input');

  // 非法候选 schema/来源/版本与返修执行失败属技术失败 → failed，不构成有效事实拒绝。
  for (const reason of ['candidate_invalid', 'repair_failed'] as const) {
    assert.equal(executionStatusFor('not_passed', reason), 'failed', reason);
  }
});

test('B5 执行终态映射：畸形候选/审查失败/预算/超时永不通过，取消独立', async () => {
  const { executionStatusFor, isPassed } = await import('../../apps/server/src/orchestration/state.ts');

  const neverPassStatuses = ['failed'] as const;
  for (const status of neverPassStatuses) {
    assert.equal(isPassed(status), false, status);
    assert.equal(executionStatusFor(status, 'candidate_invalid'), 'failed', status);
    assert.equal(executionStatusFor(status, 'review_execution_failed'), 'failed', status);
    assert.equal(executionStatusFor(status, 'budget_exhausted'), 'failed', status);
    assert.equal(executionStatusFor(status, 'timeout'), 'failed', status);
    assert.equal(executionStatusFor(status, 'evidence_failed'), 'failed', status);
    assert.equal(executionStatusFor(status, 'review_inconsistent'), 'failed', status);
  }

  // 取消是独立终态，既不 succeeded 也不 failed。
  assert.equal(executionStatusFor('cancelled', 'cancelled'), 'cancelled');
  assert.notEqual(executionStatusFor('cancelled', 'cancelled'), 'succeeded');
  assert.notEqual(executionStatusFor('cancelled', 'cancelled'), 'failed');

  // 任何会派生出 succeeded 的路径都不得表示“通过/采纳”。
  assert.equal(isPassed('not_passed'), false);
  assert.equal(executionStatusFor('not_passed', 'repair_limit_reached') === 'succeeded' && isPassed('not_passed'), false);
});

/* ---------- 工作流级：返修上限校验先于任何 Agent 调用 ---------- */

test('B5 maxRepairRounds 校验：3/负数/小数/NaN 在发起请求前拒绝，默认 2', async () => {
  const script = defaultScript({});
  for (const invalid of [3, -1, 1.5, Number.NaN]) {
    await assert.rejects(
      () => runFactScenario({ script: defaultScript({}), maxRepairRounds: invalid }),
      (error: Error) => error.message === 'invalid_repair_rounds',
      'maxRepairRounds=' + String(invalid) + ' 应在任何请求前拒绝',
    );
  }
  // 合法取值范围 0/1/2 与默认值应可运行。
  const ok = await runFactScenario({ script, maxRepairRounds: 2 });
  assert.equal(typeof ok.result.executionStatus, 'string');
  assert.equal(typeof ok.result.status, 'string');
});

/* ---------- 工作流级：非法候选属技术失败，不构成业务批准 ---------- */

test('B5 candidateOverride 产出非法候选 → executionStatus failed 且不通过', async () => {
  const handle = await runFactScenario({
    script: defaultScript({ review: () => ({ verdict: 'pass' }) }),
    // 破坏候选快照的必需字段（非法 projectId），使其在 schema/归属校验中判定为非法。
    candidateOverride: (output, prompt) => {
      if (prompt.repair) return output;
      const cloned = structuredClone(output);
      cloned.candidateSnapshot.projectId = '';
      return cloned;
    },
  });

  assert.equal(handle.result.passed, false, '非法候选不得通过');
  assert.equal(handle.result.executionStatus, 'failed', '非法候选应为技术失败');
  assert.equal(handle.result.status, 'failed', '业务状态应为 failed 而非 not_passed');
});

/* ---------- 文件系统运行记录存储：成功一次返修 + 隔离/不可改写 + expected/actual 回归 ---------- */

const FIXTURE_TEXT_A = '公司成立于 2018 年。';
const FIXTURE_TEXT_B = '截至 2025 年，公司研发人员 60 人。';

test('文件系统存储：一次返修成功的运行，历史工件/来源/尝试可完整回读', async () => {
  const root = tempRoot();
  try {
    const store = new FileSystemFactRunStore(root, 'project_repair');
    const script = defaultScript({
      evidence: () => ({ values: { rd: 600, founded: 2018 } }),
      repair: () => ({ rd: 60, founded: 2018 }),
    });
    const { result } = await runFactScenario({ runStore: store, script });

    assert.ok(result.record);
    assert.equal(result.record.passed, true);
    assert.equal(result.record.repairRounds, 1);

    const readBack = store.get(result.record.runId);
    assert.ok(readBack, '运行记录应存在');

    const child = readInChild(root, 'project_repair', result.record.runId);
    assert.deepEqual(child.rec, result.record);

    const kinds = result.record.attempts.map((attempt) => attempt.kind);
    assert.deepEqual(kinds, ['extract', 'review', 'repair', 'review']);

    const sessionIds = result.record.attempts
      .map((attempt) => attempt.sessionId)
      .filter((id): id is string => typeof id === 'string');
    assert.equal(sessionIds.length, 4);
    assert.equal(new Set(sessionIds).size, 4);

    for (const attempt of result.record.attempts) {
      assert.ok(attempt.modelCalls > 0, 'modelCalls 应为正');
      assert.ok(attempt.successfulReads > 0, 'successfulReads 应为正');
      assert.equal(attempt.resourcesDisposed, true);
    }

    const snapshot = result.record.inputSnapshot;
    assert.ok(snapshot, '应保留原始输入快照');
    const snapshotText = snapshot.documents[0].blocks.map((b) => b.text ?? '').join('\n');
    assert.ok(snapshotText.includes(FIXTURE_TEXT_A));
    assert.ok(snapshotText.includes(FIXTURE_TEXT_B));
    assert.ok(snapshot.documents[0].documentVersionId.length > 0);

    const artifacts = result.record.artifacts ?? [];
    const candidates = artifacts.filter((artifact) => artifact.kind === 'candidate');
    const reports = artifacts.filter((artifact) => artifact.kind === 'report');
    assert.equal(candidates.length, 2);
    assert.equal(reports.length, 2);
    for (const artifact of [...candidates, ...reports]) {
      assert.ok(artifact.output, '工件应带校验输出');
    }

    assert.equal(result.record.budget, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('文件系统存储：不同 projectId 相互隔离，且历史记录不可改写', async () => {
  const root = tempRoot();
  try {
    const script = defaultScript({
      evidence: () => ({ values: { rd: 600, founded: 2018 } }),
      repair: () => ({ rd: 60, founded: 2018 }),
    });
    const firstStore = new FileSystemFactRunStore(root, 'project_repair');
    const { result: first } = await runFactScenario({ runStore: firstStore, script });
    assert.ok(first.record);
    const firstRunId = first.record.runId;
    const firstRecord = first.record;
    assert.ok(firstRecord.artifacts && firstRecord.artifacts.length > 0);

    const otherStore = new FileSystemFactRunStore(root, 'project_other');
    assert.equal(otherStore.get(firstRunId), undefined);
    assert.throws(() => otherStore.save(firstRecord));

    const clone = firstStore.get(firstRunId);
    assert.ok(clone, '应能读回本项目的记录');
    assert.ok(clone.artifacts && clone.artifacts.length > 0);
    clone.artifacts[0].rawOutput = clone.artifacts[0].rawOutput + ' ';
    assert.throws(() => firstStore.save(clone));

    const after = readInChild(root, 'project_repair', firstRunId).rec;
    assert.deepEqual(after, firstRecord);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('expected/actual 仅空白差异不得判定为不同（回归守卫）', () => {
  const env: Envelope = {
    snapshotId: 'snap_trim',
    snapshotVersionId: 'snapv_trim_1',
    createdAt: '2025-01-10T08:00:00Z',
    producedBy: { role: 'evidence', protocolVersion: '1.0' },
  };
  const { candidateSnapshot } = makeCandidate(env, { rd: 600, founded: 2018 });
  const report = reviewOutputFor(
    candidateSnapshot,
    [{ issueId: 'i_trim', claimId: 'claim_rd', category: 'value', severity: 'error', description: 'mismatch', expected: ' 600 人 ', actual: '600 人' }],
    'revise',
  );
  const evaluation = evaluateReviewReport(report, candidateSnapshot);
  assert.equal(evaluation.decision.kind, 'stop');
  assert.ok(evaluation.consistency.includes('report.expected_actual_identical'));
});/* ---------- B5 评估种子（seeded evaluation）回归 ----------
 * 直连 harness 的 runFactScenario：仅在提供 evaluationSeed 时透传给 runFactWorkflow。
 * 种子是显式手工构造的合成候选（EvidenceOutput），交由 prepareEvidenceInput /
 * validateEvidenceCandidate 走与生产完全相同的校验路径；任何来源/版本/引用损坏
 * 必须在模型调用之前拒绝。 */

test('seeded600：种子错误事实经一次返修修正，发起 review/repair/review', async () => {
  const { makeB5Case } = await import('../../evals/fixtures/b5-cases.ts');
  const fixture = makeB5Case('seeded-repair');

  const evidence = await runFactScenario({
    script: defaultScript({ repair: () => ({ rd: 60, founded: 2018 }) }),
    evaluationSeed: fixture.seed,
    input: fixture.input,
  });
  const { result, candidateStore, requests } = evidence;

  assert.equal(result.status, 'passed');
  assert.equal(result.passed, true);
  assert.equal(result.repairRounds, 1);

  // 尝试序列：首次直连评估跳过真实提取，但走 review → repair → review。
  const attempts = result.record!.attempts;
  assert.deepEqual(
    attempts.map(a => a.kind),
    ['review', 'repair', 'review'],
  );
  const kinds = attempts.map(a => a.kind);
  assert.equal(kinds.filter(k => k === 'review').length, 2);
  assert.equal(kinds.filter(k => k === 'repair').length, 1);

  // 三个 attempt 均有真实请求支撑与唯一会话 ID，且实际成功读取来源。
  assert.equal(
    requests.length,
    attempts.reduce((sum, attempt) => sum + attempt.modelCalls, 0),
  );
  assert.ok(requests.length >= 6);
  const sessionIds = attempts.map(a => a.sessionId);
  assert.equal(sessionIds.every(id => typeof id === 'string' && id.length > 0), true);
  assert.equal(new Set(sessionIds).size, 3);
  assert.equal(attempts.every(a => a.successfulReads > 0), true);

  // 种子旧版本 600 未被篡改，最终候选为 60。
  const seedRecord = candidateStore.list().find(r => r.snapshotVersionId === 'snapv_b5_seed_1');
  assert.ok(seedRecord?.output);
  assert.deepEqual(valuesOf(seedRecord.output.candidateSnapshot), { rd: 600, founded: 2018 });
  const finalVersionId = result.currentVersionId!;
  const finalRecord = candidateStore.list().find(r => r.snapshotVersionId === finalVersionId);
  assert.ok(finalRecord?.output);
  assert.deepEqual(valuesOf(finalRecord.output.candidateSnapshot), { rd: 60, founded: 2018 });

  // 全部候选待审、不自动采纳；种子保持手工来源标记。
  assert.equal(candidateStore.list().every(r => r.state === 'pending_review'), true);
  assert.equal(seedRecord.output.candidateSnapshot.producedBy.model, 'synthetic_fixture');
  assert.equal(seedRecord.output.candidateSnapshot.producedBy.promptVersion, 'b5_seed_v1');
});

test('seed 破坏 model 来源 → candidate_invalid 且零请求', async () => {
  const { makeB5Case } = await import('../../evals/fixtures/b5-cases.ts');
  const fixture = makeB5Case('seeded-repair');
  const seed = structuredClone(fixture.seed!);
  seed.candidateSnapshot.producedBy.model = 'real_model';
  seed.producedBy = { ...seed.producedBy, model: 'real_model' };

  const handle = await runFactScenario({
    script: defaultScript(),
    evaluationSeed: seed,
    input: fixture.input,
  });
  const { result, requests } = handle;

  assert.equal(result.status, 'failed');
  assert.equal(result.stopReason, 'candidate_invalid');
  assert.equal(requests.length, 0);
});

test('seed 引用不存在的证据/文档版本/定位 → HTTP 前 candidate_invalid 且零请求', async () => {
  const { makeB5Case } = await import('../../evals/fixtures/b5-cases.ts');
  const fixture = makeB5Case('seeded-repair');
  const seed = structuredClone(fixture.seed!);
  const evidence = seed.candidateSnapshot.evidence;

  seed.candidateSnapshot.evidence = evidence.map(e => ({ ...e, documentVersionId: 'docv_repair_9' }));
  for (const claim of seed.candidateSnapshot.claims) {
    claim.evidenceRefs = ['ev_missing'];
  }

  const handle = await runFactScenario({
    script: defaultScript(),
    evaluationSeed: seed,
    input: fixture.input,
  });
  const { result, requests } = handle;

  assert.equal(result.status, 'failed');
  assert.equal(result.stopReason, 'candidate_invalid');
  assert.equal(requests.length, 0);
});/* ---------- B5 CLI 离线验收守卫（不发 HTTP、不调用模型、不读真实凭据） ---------- */

/** 把合成 R5 账本写入临时目录，返回路径；全部数值与外部预算代理的授权策略精确一致。 */
function writeSyntheticLedgers(dir: string, opts?: { policyMismatch?: boolean; historyMismatch?: boolean; extraKey?: boolean }) {
  const policy = {
    limitMicros: 550_000_000,
    safetyMicros: 10_000_000,
    inputCnyPerMillion: 2,
    outputCnyPerMillion: 8,
    inputTokensPerByte: 2,
    inputTokenOverhead: 8192,
  };
  const authorizationId = 'test-b5';

  // 通过真实 RequestSpendBudget 产生一条真实预留记录（noop persist），再用 list() 取回。
  const budget = new RequestSpendBudget(policy, () => {}, []);
  budget.reserve(100, 64);
  const records = budget.list();

  const taskPolicy = opts?.policyMismatch ? { ...policy, limitMicros: policy.limitMicros - 1 } : policy;
  const taskRecords = records;
  const taskReserved = records.reduce((n, r) => n + r.reservedMicros, 0);

  const task: Record<string, unknown> = {
    startedAt: Date.now(),
    deadline: Date.now() + 60_000,
    policy: taskPolicy,
    maxCalls: 18,
    maxOutputTokens: 8192,
    maxBodyBytes: 224_000,
    minRequestIntervalMs: 0,
    toolProfile: 'business',
    records: taskRecords,
    reservedMicros: opts?.historyMismatch ? taskReserved + 1 : taskReserved,
    attempts: [],
    stopReason: null,
  };
  if (opts?.extraKey) task.extraKey = 1;

  const total = {
    authorizationId,
    policy,
    records,
    reservedMicros: taskReserved,
  };

  const taskPath = join(dir, 'task-ledger.json');
  const totalPath = join(dir, 'total-ledger.json');
  writeFileSync(taskPath, JSON.stringify(task));
  writeFileSync(totalPath, JSON.stringify(total));
  return { taskPath, totalPath, authorizationId };
}

const STUB_CONFIG = {
  provider: 'company-gateway' as const,
  modelId: 'deepseek-v4.1-flash',
  baseUrl: 'http://127.0.0.1:8787/v1',
  apiKey: 'synthetic_guard_canary',
};

test('B5 CLI 双开关：缺少 --live 或 APP_RUN_LIVE_EVAL 时退出 2 且不写报告、不触发金丝雀', () => {
  const entry = join(process.cwd(), 'apps/server/src/entrypoints/b5-fact-workflow.ts');
  const cases: ReadonlyArray<{ name: string; args: string[]; liveEnv: string | undefined }> = [
    { name: 'no --live, env 0', args: ['--case', 'correct', '--budget-loopback'], liveEnv: '0' },
    { name: '--live, env 0', args: ['--live', '--case', 'correct', '--budget-loopback'], liveEnv: '0' },
    { name: 'no --live, env 1', args: ['--case', 'correct', '--budget-loopback'], liveEnv: '1' },
  ];

  for (const combo of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'b5-off-'));
    try {
      const reportPath = join(dir, 'report.json');
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        APP_MODEL_API_KEY: 'canary',
        APP_RUN_LIVE_EVAL: combo.liveEnv,
        APP_B5_REPORT_PATH: reportPath,
        APP_B5_RUN_DIR: join(dir, 'runs'),
        APP_B5_TASK_LEDGER_PATH: join(dir, 'task.json'),
        APP_B5_TOTAL_LEDGER_PATH: join(dir, 'total.json'),
        APP_B5_AUTHORIZATION_ID: 'test-b5',
      };
      const res = spawnSync(process.execPath, [entry, ...combo.args], {
        cwd: process.cwd(),
        timeout: 5_000,
        encoding: 'utf8',
        env,
      });
      assert.equal(res.status, 2, combo.name + ' 应退出 2，got ' + String(res.status));
      assert.equal(res.stdout.includes('canary'), false, combo.name + ' 不得回显金丝雀');
      assert.equal(res.stderr.includes('canary'), false, combo.name + ' 不得回显金丝雀');
      let reportExists = true;
      try { readFileSync(reportPath); } catch { reportExists = false; }
      assert.equal(reportExists, false, combo.name + ' 不得创建报告');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('B5 外部预算代理：合法合成账本通过 before/after 预检且只读（不读取全局原始账本）', async () => {
  const { readExternalBudgetGate } = await import('../../apps/server/src/runtime/pi/external-budget-gate.ts');
  const dir = mkdtempSync(join(tmpdir(), 'b5-gate-'));
  try {
    const { taskPath, totalPath, authorizationId } = writeSyntheticLedgers(dir, {});
    const taskBytes = readFileSync(taskPath);
    const totalBytes = readFileSync(totalPath);

    const before = readExternalBudgetGate({
      config: STUB_CONFIG,
      authorizationId,
      taskLedgerPath: taskPath,
      totalLedgerPath: totalPath,
      phase: 'before',
    });
    assert.equal(before.authorizationId, authorizationId);
    assert.equal(before.attemptCount, 0);
    assert.equal(before.stopReason, null);
    assert.equal(before.maxCalls, 18);
    assert.equal(before.maxOutputTokens, 8192);
    assert.equal(before.recordCount, 1);
    assert.equal(before.currency, 'CNY');

    const after = readExternalBudgetGate({
      config: STUB_CONFIG,
      authorizationId,
      taskLedgerPath: taskPath,
      totalLedgerPath: totalPath,
      phase: 'after',
    });
    assert.equal(after.recordCount, 1);
    assert.equal(after.reservedMicros, before.reservedMicros);

    // 账本字节必须完全不变。
    assert.deepEqual(readFileSync(taskPath), taskBytes);
    assert.deepEqual(readFileSync(totalPath), totalBytes);

    // 直连网关（非回环）必须被拒绝。
    assert.throws(() => readExternalBudgetGate({
      config: { ...STUB_CONFIG, baseUrl: 'https://gateway.example.com/v1' },
      authorizationId,
      taskLedgerPath: taskPath,
      totalLedgerPath: totalPath,
      phase: 'before',
    }));
    // 非回环 HTTP 主机也拒绝。
    assert.throws(() => readExternalBudgetGate({
      config: { ...STUB_CONFIG, baseUrl: 'http://10.0.0.5:8787/v1' },
      authorizationId,
      taskLedgerPath: taskPath,
      totalLedgerPath: totalPath,
      phase: 'before',
    }));
    // 策略不匹配。
    {
      const bad = mkdtempSync(join(tmpdir(), 'b5-gate-policy-'));
      try {
        const p = writeSyntheticLedgers(bad, { policyMismatch: true });
        assert.throws(() => readExternalBudgetGate({
          config: STUB_CONFIG, authorizationId: p.authorizationId,
          taskLedgerPath: p.taskPath, totalLedgerPath: p.totalPath, phase: 'before',
        }));
      } finally { rmSync(bad, { recursive: true, force: true }); }
    }
    // 历史/预留额不一致。
    {
      const bad = mkdtempSync(join(tmpdir(), 'b5-gate-history-'));
      try {
        const p = writeSyntheticLedgers(bad, { historyMismatch: true });
        assert.throws(() => readExternalBudgetGate({
          config: STUB_CONFIG, authorizationId: p.authorizationId,
          taskLedgerPath: p.taskPath, totalLedgerPath: p.totalPath, phase: 'before',
        }));
      } finally { rmSync(bad, { recursive: true, force: true }); }
    }
    // 多余键。
    {
      const bad = mkdtempSync(join(tmpdir(), 'b5-gate-keys-'));
      try {
        const p = writeSyntheticLedgers(bad, { extraKey: true });
        assert.throws(() => readExternalBudgetGate({
          config: STUB_CONFIG, authorizationId: p.authorizationId,
          taskLedgerPath: p.taskPath, totalLedgerPath: p.totalPath, phase: 'before',
        }));
      } finally { rmSync(bad, { recursive: true, force: true }); }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B5 CLI 全启用但缺少账本文件：退出 1、无报告、无金丝雀', () => {
  const entry = join(process.cwd(), 'apps/server/src/entrypoints/b5-fact-workflow.ts');
  const dir = mkdtempSync(join(tmpdir(), 'b5-missing-'));
  try {
    const reportPath = join(dir, 'report.json');
    const res = spawnSync(process.execPath, [entry, '--live', '--case', 'correct', '--budget-loopback'], {
      cwd: process.cwd(),
      timeout: 5_000,
      encoding: 'utf8',
      env: {
        ...process.env,
        APP_MODEL_API_KEY: 'canary',
        APP_MODEL_PROVIDER: 'company-gateway',
        APP_MODEL_ID: 'deepseek-v4.1-flash',
        APP_MODEL_BASE_URL: 'http://127.0.0.1:8787/v1',
        APP_RUN_LIVE_EVAL: '1',
        APP_B5_REPORT_PATH: reportPath,
        APP_B5_RUN_DIR: join(dir, 'runs'),
        APP_B5_TASK_LEDGER_PATH: join(dir, 'does-not-exist-task.json'),
        APP_B5_TOTAL_LEDGER_PATH: join(dir, 'does-not-exist-total.json'),
        APP_B5_AUTHORIZATION_ID: 'test-b5',
      },
    });
    assert.equal(res.status, 1, '缺少账本应退出 1，got ' + String(res.status));
    assert.equal(res.stdout.includes('canary'), false);
    assert.equal(res.stderr.includes('canary'), false);
    let reportExists = true;
    try { readFileSync(reportPath); } catch { reportExists = false; }
    assert.equal(reportExists, false, '缺少账本不得创建报告');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B5 CLI 全启用但直连 HTTPS 网关 + 合法合成账本：退出 1、无报告、无金丝雀', () => {
  const entry = join(process.cwd(), 'apps/server/src/entrypoints/b5-fact-workflow.ts');
  const dir = mkdtempSync(join(tmpdir(), 'b5-direct-'));
  try {
    const { taskPath, totalPath, authorizationId } = writeSyntheticLedgers(dir, {});
    const reportPath = join(dir, 'report.json');
    const res = spawnSync(process.execPath, [entry, '--live', '--case', 'correct', '--budget-loopback'], {
      cwd: process.cwd(),
      timeout: 5_000,
      encoding: 'utf8',
      env: {
        ...process.env,
        APP_MODEL_API_KEY: 'canary',
        APP_MODEL_PROVIDER: 'company-gateway',
        APP_MODEL_ID: 'deepseek-v4.1-flash',
        APP_RUN_LIVE_EVAL: '1',
        APP_MODEL_BASE_URL: 'https://gateway.example.com/v1',
        APP_B5_REPORT_PATH: reportPath,
        APP_B5_RUN_DIR: join(dir, 'runs'),
        APP_B5_TASK_LEDGER_PATH: taskPath,
        APP_B5_TOTAL_LEDGER_PATH: totalPath,
        APP_B5_AUTHORIZATION_ID: authorizationId,
      },
    });
    assert.equal(res.status, 1, '直连 HTTPS 网关应退出 1，got ' + String(res.status));
    assert.equal(res.stdout.includes('canary'), false);
    assert.equal(res.stderr.includes('canary'), false);
    let reportExists = true;
    try { readFileSync(reportPath); } catch { reportExists = false; }
    assert.equal(reportExists, false, '直连网关不得创建报告');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- 纯函数：seeded 分支必须零抽取、且 firstReview < firstRepair < lastReview ---------- */

test('B5 分级纯函数：seeded 零抽取通过，出现抽取或顺序错误即失败', async () => {
  const { gradeAcceptance } = await import('../../apps/server/src/entrypoints/b5-fact-workflow.ts');
  const { makeB5Case } = await import('../../evals/fixtures/b5-cases.ts');

  const seeded = makeB5Case('seeded-repair');
  const mk = (kind: string, sessionId: string) => ({
    kind, sessionId, successfulReads: 1, modelCalls: 1, resourcesDisposed: true,
  });
  const seededResult = { status: 'passed', repairRounds: 1 } as unknown as Parameters<typeof gradeAcceptance>[0]['result'];
  const candidates = ['pending_review'] as const;

  // 合法 seeded：review -> repair -> review，零抽取。import 不得触发 main()。
  const ok = gradeAcceptance({
    fixture: seeded,
    result: seededResult,
    attempts: [mk('review', 's1'), mk('repair', 's2'), mk('review', 's3')],
    candidateStates: [...candidates],
  });
  assert.equal(ok.passed, true);

  // 出现抽取即失败。
  const withExtract = gradeAcceptance({
    fixture: seeded,
    result: seededResult,
    attempts: [mk('extract', 's0'), mk('review', 's1'), mk('repair', 's2'), mk('review', 's3')],
    candidateStates: [...candidates],
  });
  assert.equal(withExtract.passed, false);

  // 顺序错误：最后一次审查不在返修之后。
  const badOrder = gradeAcceptance({
    fixture: seeded,
    result: seededResult,
    attempts: [mk('review', 's1'), mk('review', 's3'), mk('repair', 's2')],
    candidateStates: [...candidates],
  });
  assert.equal(badOrder.passed, false);

  // 重复会话 ID 即失败。
  const dupSession = gradeAcceptance({
    fixture: seeded,
    result: seededResult,
    attempts: [mk('review', 's1'), mk('repair', 's1'), mk('review', 's3')],
    candidateStates: [...candidates],
  });
  assert.equal(dupSession.passed, false);
});/* ---------- 授权修复回归：聚合网关与提取上限 16384（审查、探测及其他限制不变） ---------- */

/** 仅克隆合成任务账本并覆盖 maxOutputTokens，用于 16384 合法值与非法值探测。 */
function writeLedgersWithOutputTokens(dir: string, maxOutputTokens: unknown) {
  const base = mkdtempSync(join(tmpdir(), 'b5-ot-base-'));
  try {
    writeSyntheticLedgers(base, {});
    const task = JSON.parse(readFileSync(join(base, 'task-ledger.json'), 'utf8')) as Record<string, unknown>;
    const total = readFileSync(join(base, 'total-ledger.json'), 'utf8');
    task.maxOutputTokens = maxOutputTokens;
    const taskPath = join(dir, 'task-ledger.json');
    const totalPath = join(dir, 'total-ledger.json');
    writeFileSync(taskPath, JSON.stringify(task));
    writeFileSync(totalPath, total);
    return { taskPath, totalPath, authorizationId: 'test-b5' };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test('网关上限修复：maxOutputTokens=16384 通过 before/after 且账本字节不变', async () => {
  const { readExternalBudgetGate } = await import('../../apps/server/src/runtime/pi/external-budget-gate.ts');
  const dir = mkdtempSync(join(tmpdir(), 'b5-gate-16384-'));
  try {
    const { taskPath, totalPath, authorizationId } = writeLedgersWithOutputTokens(dir, 16384);
    const taskBytes = readFileSync(taskPath);
    const totalBytes = readFileSync(totalPath);

    const before = readExternalBudgetGate({
      config: STUB_CONFIG, authorizationId, taskLedgerPath: taskPath, totalLedgerPath: totalPath, phase: 'before',
    });
    assert.equal(before.maxOutputTokens, 16384);
    assert.equal(before.limitMicros, 550_000_000);
    assert.equal(before.safetyMicros, 10_000_000);

    const after = readExternalBudgetGate({
      config: STUB_CONFIG, authorizationId, taskLedgerPath: taskPath, totalLedgerPath: totalPath, phase: 'after',
    });
    assert.equal(after.maxOutputTokens, 16384);
    assert.equal(after.reservedMicros, before.reservedMicros);
    assert.equal(after.recordCount, before.recordCount);

    assert.deepEqual(readFileSync(taskPath), taskBytes);
    assert.deepEqual(readFileSync(totalPath), totalBytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('网关上限修复：非法 maxOutputTokens 在 before/after 均抛 gate_phase_state 且不写账本', async () => {
  const { readExternalBudgetGate } = await import('../../apps/server/src/runtime/pi/external-budget-gate.ts');
  const invalid: ReadonlyArray<unknown> = [16385, 16384.5, 0, -1, '16384', null];
  for (const value of invalid) {
    const dir = mkdtempSync(join(tmpdir(), 'b5-gate-invalid-'));
    try {
      const { taskPath, totalPath, authorizationId } = writeLedgersWithOutputTokens(dir, value);
      const taskBytes = readFileSync(taskPath);
      const totalBytes = readFileSync(totalPath);
      for (const phase of ['before', 'after'] as const) {
        assert.throws(
          () => readExternalBudgetGate({
            config: STUB_CONFIG, authorizationId, taskLedgerPath: taskPath, totalLedgerPath: totalPath, phase,
          }),
          (error: unknown) => (error as { code?: string }).code === 'gate_phase_state',
          `value=${String(value)} phase=${phase} 应抛 gate_phase_state`,
        );
      }
      assert.deepEqual(readFileSync(taskPath), taskBytes);
      assert.deepEqual(readFileSync(totalPath), totalBytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('角色上限不变：EVIDENCE 16384 / REVIEW 8192 / B2 1024，其余边界未改', async () => {
  const { EVIDENCE_LIMITS, REVIEW_LIMITS, B2_LIMITS, validateLimits } = await import('../../apps/server/src/runtime/pi/execution-limits.ts');
  assert.equal(EVIDENCE_LIMITS.maxOutputTokens, 16384);
  assert.equal(REVIEW_LIMITS.maxOutputTokens, 8192);
  assert.equal(B2_LIMITS.maxOutputTokens, 1024);

  assert.equal(EVIDENCE_LIMITS.timeoutMs, 120_000);
  assert.equal(EVIDENCE_LIMITS.maxModelCalls, 6);
  assert.equal(EVIDENCE_LIMITS.maxToolCalls, 12);
  assert.equal(EVIDENCE_LIMITS.maxContextBytes, 128_000);
  assert.equal(REVIEW_LIMITS.timeoutMs, 180_000);
  assert.equal(REVIEW_LIMITS.maxModelCalls, 6);
  assert.equal(REVIEW_LIMITS.maxToolCalls, 16);
  assert.equal(REVIEW_LIMITS.maxContextBytes, 128_000);
  assert.equal(B2_LIMITS.timeoutMs, 90_000);
  assert.equal(B2_LIMITS.maxModelCalls, 3);
  assert.equal(B2_LIMITS.maxToolCalls, 2);
  assert.equal(B2_LIMITS.maxContextBytes, 12_000);

  // 审查角色上限不接受 16384。
  assert.throws(() => validateLimits({ ...REVIEW_LIMITS, maxOutputTokens: 16384 }, 'review'));
  // 审查角色自身边界仍合法。
  validateLimits({ ...REVIEW_LIMITS }, 'review');
});