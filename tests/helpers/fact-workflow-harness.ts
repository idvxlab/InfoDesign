/** B5 工作流离线回归辅助：真实 Pi SDK + 本地模拟网关（SYNTHETIC SSE，非真实模型）。
 *  提供最小双事实合成夹具、可脚本化的 evidence/review 处理器，以及工作流场景驱动。
 *  只验证程序编排与受控决策；不代表真实模型质量。 */
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { CommonCheckType } from '../../packages/contracts/generated/common.ts';
import type { EvidenceInput, EvidenceOutput } from '../../packages/contracts/generated/index.ts';
import type { EvidenceSnapshot } from '../../packages/contracts/generated/evidence-snapshot.ts';
import type { ReviewOutput } from '../../packages/contracts/generated/review-output.ts';
import type { ReviewReport } from '../../packages/contracts/generated/review-report.ts';
import { textFingerprint } from '../../packages/contracts/src/fingerprint.ts';
import { registry } from './fixtures.ts';
import { readModelConfig } from '../../apps/server/src/config/env.ts';
import { EVIDENCE_LIMITS, REVIEW_LIMITS } from '../../apps/server/src/runtime/pi/execution-limits.ts';
import { runFactWorkflow, type FactWorkflowOptions, type FactWorkflowResult } from '../../apps/server/src/orchestration/fact-workflow.ts';
import { MemoryCandidateStore } from '../../apps/server/src/domain/evidence.service.ts';
import { MemoryReviewStore } from '../../apps/server/src/domain/review.service.ts';
import { MemoryFactRunStore, type FactRunStore } from '../../apps/server/src/domain/fact-run.service.ts';
import type { RequestSpendBudget } from '../../apps/server/src/runtime/pi/spend-budget.ts';
import type { SourceBundle } from '../../apps/server/src/domain/source-bundle.ts';

export const PROJECT = 'project_repair';
export const DOC = 'doc_repair';
export const DOCV = 'docv_repair_1';
export const SOURCE_TEXT_RD = '截至 2025 年，公司研发人员 60 人。';
export const SOURCE_TEXT_FOUNDED = '公司成立于 2018 年。';

export { registry };

export interface Envelope {
  snapshotId: string;
  snapshotVersionId: string;
  createdAt: string;
  producedBy: EvidenceOutput['producedBy'];
  basedOnSnapshotVersionId?: string;
}

export interface CandidateValues { rd: number; founded: number; }

export function makeEvidenceInput(): EvidenceInput {
  return {
    protocolVersion: '1.0', taskId: 'task_repair', attemptId: 'attempt_repair', projectId: PROJECT,
    taskType: 'generate', stage: 'facts',
    scope: {
      projectId: PROJECT,
      documentRefs: [{ documentId: DOC, documentVersionId: DOCV }],
      allowedOperations: ['read_document', 'read_evidence', 'submit_candidate'],
    },
    constraints: {
      preserveFacts: true,
      forbiddenNewFacts: true,
      notes: '提取全部明确事实；核对研发人员数与成立年份，资料未披露则登记缺失。',
    },
    executionPolicyRef: 'policy_facts_v1',
    documents: [{
      protocolVersion: '1.0', documentId: DOC, documentVersionId: DOCV, projectId: PROJECT, version: 1,
      contentHash: textFingerprint(SOURCE_TEXT_RD + SOURCE_TEXT_FOUNDED),
      mimeType: 'text/plain', sourceName: 'repair-source.txt', language: 'zh-CN', createdAt: '2025-01-10T08:00:00Z',
      blocks: [
        { blockId: 'b001', index: 0, type: 'paragraph', text: SOURCE_TEXT_RD, location: { kind: 'paragraph', paragraphIndex: 0 } },
        { blockId: 'b002', index: 1, type: 'paragraph', text: SOURCE_TEXT_FOUNDED, location: { kind: 'paragraph', paragraphIndex: 1 } },
      ],
      parseInfo: { parser: 'synthetic_fixture', quality: 'complete' },
    }],
  };
}

export const READ_REQS = [
  { documentId: DOC, documentVersionId: DOCV, blockId: 'b001' },
  { documentId: DOC, documentVersionId: DOCV, blockId: 'b002' },
];

export function makeCandidate(
  env: Envelope,
  values: CandidateValues,
  status: EvidenceOutput['status'] = 'completed',
  missing = false,
): EvidenceOutput {
  const snapshot: EvidenceOutput['candidateSnapshot'] = {
    protocolVersion: '1.0',
    snapshotId: env.snapshotId,
    snapshotVersionId: env.snapshotVersionId,
    projectId: PROJECT, taskId: 'task_repair', attemptId: 'attempt_repair',
    ...(env.basedOnSnapshotVersionId !== undefined ? { basedOnSnapshotVersionId: env.basedOnSnapshotVersionId } : {}),
    entities: [
      { entityId: 'ent_company', entityType: 'organization', label: '公司' },
    ],
    claims: [
      {
        claimId: 'claim_rd', claimVersionId: 'claimv_rd_1', entityId: 'ent_company', predicate: 'rd_headcount',
        value: { type: 'quantity', normalized: values.rd, unit: '人', raw: values.rd + ' 人' },
        qualifiers: { time: { year: 2025 }, basis: '截至2025年' },
        supportStatus: 'supported', reviewStatus: 'pending', evidenceRefs: ['ev_rd'],
      },
      {
        claimId: 'claim_founded', claimVersionId: 'claimv_founded_1', entityId: 'ent_company', predicate: 'founded_year',
        value: { type: 'number', normalized: values.founded, unit: '年', raw: values.founded + ' 年' },
        supportStatus: 'supported', reviewStatus: 'pending', evidenceRefs: ['ev_founded'],
      },
    ],
    evidence: [
      { evidenceId: 'ev_rd', documentId: DOC, documentVersionId: DOCV, blockId: 'b001', locator: { kind: 'paragraph', paragraphIndex: 0 }, excerpt: SOURCE_TEXT_RD },
      { evidenceId: 'ev_founded', documentId: DOC, documentVersionId: DOCV, blockId: 'b002', locator: { kind: 'paragraph', paragraphIndex: 1 }, excerpt: SOURCE_TEXT_FOUNDED },
    ],
    conflicts: [],
    missing: missing
      ? [{ missingId: 'missing_revenue', expectedPredicate: 'annual_revenue', entityId: 'ent_company', description: '未找到营业收入。', severity: 'warning' }]
      : [],
    coverage: { documentsProcessed: [{ documentId: DOC, documentVersionId: DOCV, blockIds: ['b001', 'b002'] }], unsupported: [] },
    reviewStatus: 'pending',
    producedBy: env.producedBy,
    createdAt: env.createdAt,
  };
  const effectiveStatus: EvidenceOutput['status'] = missing && status === 'completed' ? 'needs_information' : status;
  return {
    protocolVersion: '1.0', taskId: 'task_repair', attemptId: 'attempt_repair', projectId: PROJECT,
    status: effectiveStatus, candidateSnapshot: snapshot, producedBy: env.producedBy,
  };
}

/** 从任意 prompt 的候选快照读取当前事实值。 */
export function valuesOf(snapshot: EvidenceSnapshot): CandidateValues {
  const rd = snapshot.claims.find(c => c.claimId === 'claim_rd')?.value as { normalized?: number } | undefined;
  const founded = snapshot.claims.find(c => c.claimId === 'claim_founded')?.value as { normalized?: number } | undefined;
  return { rd: Number(rd?.normalized ?? 60), founded: Number(founded?.normalized ?? 2018) };
}

export interface IssueSpec {
  category: CommonCheckType;
  claimId?: string;
  expected?: string;
  actual?: string;
  severity?: 'error' | 'critical' | 'warning' | 'info';
  description?: string;
}

export interface ReportSpec {
  verdict: 'pass' | 'revise' | 'needs_input';
  issues?: IssueSpec[];
}

/** 依审查 prompt 生成合法 ReviewOutput：checks 覆盖 10 类，issues 与 verdict 由 spec 决定。 */
export function makeReportOutput(prompt: ReviewPrompt, spec: ReportSpec): ReviewOutput {
  const env = prompt.envelope;
  const snapshot = prompt.candidateSnapshot;
  const reviewedBy = { ...env.reviewedBy } as NonNullable<ReviewOutput['producedBy']>;
  const claimIds = snapshot.claims.map(c => c.claimId);
  const evidenceIds = [...new Set(snapshot.claims.flatMap(c => c.evidenceRefs))];
  const issues = spec.issues ?? [];
  const failedClaimCategories = new Set(issues.filter(i => i.claimId !== undefined).map(i => i.category));
  const failedGlobalCategories = new Set(issues.filter(i => i.claimId === undefined).map(i => i.category));
  const types: CommonCheckType[] = ['support', 'entity_match', 'value', 'unit', 'time', 'basis', 'source_locator', 'missing', 'conflict', 'traceability'];
  const checks: ReviewReport['checks'] = types.map(checkType => {
    const isGlobal = checkType === 'missing' || checkType === 'conflict';
    const failed = isGlobal ? failedGlobalCategories.has(checkType) : failedClaimCategories.has(checkType);
    return {
      checkId: 'check_' + checkType, checkType, status: failed ? 'fail' : 'pass',
      finding: failed ? '发现问题。' : '已核对候选快照与原始资料。',
      severity: failed ? 'error' : 'info',
      claimRefs: isGlobal ? [] : claimIds,
      evidenceRefs: isGlobal ? [] : evidenceIds,
    };
  });
  const reportIssues: ReviewReport['issues'] = issues.map((issue, index) => {
    const claim = snapshot.claims.find(c => c.claimId === issue.claimId);
    return {
      issueId: 'issue_' + index, severity: issue.severity ?? 'error', category: issue.category,
      ...(issue.claimId !== undefined ? { claimId: issue.claimId } : {}),
      ...(claim ? { evidenceRefs: claim.evidenceRefs } : (issue.claimId === undefined ? {} : {})),
      description: issue.description ?? '候选与原始资料不一致。',
      ...(issue.expected !== undefined ? { expected: issue.expected } : {}),
      ...(issue.actual !== undefined ? { actual: issue.actual } : {}),
    };
  });
  const report: ReviewOutput['report'] = {
    protocolVersion: '1.0',
    reportId: env.reportId, reportVersionId: env.reportVersionId,
    projectId: prompt.task.projectId, taskId: prompt.task.taskId, attemptId: prompt.task.attemptId,
    reviewMode: 'fact', subject: prompt.subject, verdict: spec.verdict,
    checks, issues: reportIssues, summary: spec.verdict === 'pass' ? '候选与原始资料逐条核对通过。' : '候选存在需修订的问题。',
    executionStatus: 'completed', reviewedBy, createdAt: env.createdAt,
  };
  return {
    protocolVersion: '1.0', projectId: prompt.task.projectId, taskId: prompt.task.taskId, attemptId: prompt.task.attemptId,
    status: 'completed', report, producedBy: reviewedBy,
  };
}

export interface EvidencePrompt {
  envelope: Envelope;
  catalog: unknown;
  repair?: {
    round: number;
    parentVersionId: string;
    allowedChangeClaimIds: string[];
    mustPreserveClaimIds: string[];
    issues: unknown[];
  };
  currentCandidate?: { candidateSnapshot: EvidenceSnapshot };
  [key: string]: unknown;
}
export interface ReviewPrompt {
  role: 'review';
  envelope: { reportId: string; reportVersionId: string; createdAt: string; reviewedBy: ReviewOutput['producedBy'] };
  subject: ReviewReport['subject'];
  candidateSnapshot: EvidenceSnapshot;
  task: { projectId: string; taskId: string; attemptId: string };
  [key: string]: unknown;
}

type Body = {
  messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
  tools: Array<{ function: { name: string } }>;
};

export function promptOf(body: Body): unknown {
  const content = body.messages.findLast(m => m.role === 'user')!.content;
  return JSON.parse(typeof content === 'string' ? content : content.map(c => c.text ?? '').join(''));
}
function afterTool(body: Body): boolean {
  return body.messages.some(m => m.role === 'tool');
}

function complete(res: ServerResponse, data: unknown, finishReason = 'stop') {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (delta: unknown, finish_reason: string | null) => res.write('data: ' + JSON.stringify({ id: 'synthetic_b5', object: 'chat.completion.chunk', model: 'synthetic-model', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
  if (Array.isArray(data)) {
    chunk({ role: 'assistant', tool_calls: data.map((args, index) => ({ index, id: 'read_' + index, type: 'function', function: { name: 'read_document', arguments: JSON.stringify(args) } })) }, null);
    chunk({}, 'tool_calls');
  } else {
    chunk({ role: 'assistant', content: typeof data === 'string' ? data : JSON.stringify(data) }, null);
    chunk({}, finishReason);
  }
  res.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
}

export function defaultScript(overrides: Partial<FactScript> = {}): FactScript {
  const base: FactScript = {
    evidence: () => ({ values: { rd: 60, founded: 2018 } }),
    repair: (prompt) => valuesOf(prompt.currentCandidate!.candidateSnapshot),
    review: (prompt) => {
      const issues: IssueSpec[] = [];
      const { rd, founded } = valuesOf(prompt.candidateSnapshot);
      if (rd !== 60) issues.push({ category: 'value', claimId: 'claim_rd', expected: '60 人', actual: `${rd} 人` });
      if (founded !== 2018) issues.push({ category: 'value', claimId: 'claim_founded', expected: '2018 年', actual: `${founded} 年` });
      return issues.length ? { verdict: 'revise', issues } : { verdict: 'pass' };
    },
  };
  return { ...base, ...overrides };
}

export interface FactScript {
  /** 首次提取/结构修正：给定当前 prompt 返回候选值。 */
  evidence: (prompt: EvidencePrompt, call: number) => { values: CandidateValues; status?: EvidenceOutput['status']; missing?: boolean };
  /** 语义返修：给定当前候选返回新候选值。 */
  repair: (prompt: EvidencePrompt, call: number) => CandidateValues;
  /** 独立审查：给定当前候选返回报告规格。 */
  review: (prompt: ReviewPrompt, call: number) => ReportSpec;
}

export interface ScenarioOptions {
  script: FactScript;
  maxRepairRounds?: number;
  spendBudget?: RequestSpendBudget;
  signal?: AbortSignal;
  evidenceLimits?: FactWorkflowOptions['evidenceLimits'];
  reviewLimits?: FactWorkflowOptions['reviewLimits'];
  sourceBundles?: SourceBundle[];
  /** 若设置，evidence 首次请求将不返回响应，用于超时测试。 */
  hangEvidence?: boolean;
  /** 覆盖审查输出（用于制造格式/引用/版本错误）。 */
  reviewOverride?: (output: ReviewOutput, prompt: ReviewPrompt) => unknown;
  /**
   * 覆盖合成提取/返修候选输出（仅 makeCandidate 结果）。
   * 仅用于测试编程控制；默认不变，不影响真实分支选择。
   */
  candidateOverride?: (output: EvidenceOutput, prompt: EvidencePrompt) => EvidenceOutput;
  input?: EvidenceInput;
  /** 仅限受信评估：显式合成的夹具候选（EvidenceOutput）。仅在提供时透传给 runFactWorkflow。 */
  evaluationSeed?: EvidenceOutput;
  /** 可选注入的运行记录存储（如文件系统存储）；默认 MemoryFactRunStore。 */
  runStore?: FactRunStore;
}

export interface ScenarioHandle {
  result: FactWorkflowResult;
  requests: Body[];
  candidateStore: MemoryCandidateStore;
  reviewStore: MemoryReviewStore;
  runStore: FactRunStore;
  counts: { evidence: number; review: number };
}

export async function runFactScenario(options: ScenarioOptions): Promise<ScenarioHandle> {
  const input = options.input ?? makeEvidenceInput();
  const before = readdirSync(tmpdir()).filter(n => n.startsWith('tju-evidence-session-') || n.startsWith('tju-review-session-')).sort();
  const requests: Body[] = [];
  const candidateStore = new MemoryCandidateStore();
  const reviewStore = new MemoryReviewStore();
  const runStore = options.runStore ?? new MemoryFactRunStore();
  const counts = { evidence: 0, review: 0 };
  let evidenceCalls = 0, reviewCalls = 0;

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Body;
    requests.push(body);
    const prompt = promptOf(body) as EvidencePrompt & { role?: string };
    if (prompt.role === 'review') {
      if (!afterTool(body)) return complete(res, READ_REQS);
      reviewCalls++;
      const reviewPrompt = prompt as unknown as ReviewPrompt;
      const output = makeReportOutput(reviewPrompt, options.script.review(reviewPrompt, reviewCalls));
      complete(res, options.reviewOverride ? options.reviewOverride(output, reviewPrompt) : output);
    } else {
      if (options.hangEvidence && evidenceCalls === 0) return;
      if (!afterTool(body)) return complete(res, READ_REQS);
      evidenceCalls++;
      counts.evidence = evidenceCalls;
      const spec = prompt.repair
        ? { values: options.script.repair(prompt, evidenceCalls), status: 'completed' as const, missing: false }
        : options.script.evidence(prompt, evidenceCalls);
      const produced = makeCandidate(prompt.envelope, spec.values, spec.status ?? 'completed', spec.missing ?? false);
      complete(res, options.candidateOverride ? options.candidateOverride(produced, prompt) : produced);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const config = readModelConfig({
    APP_MODEL_PROVIDER: 'b5-test', APP_MODEL_ID: 'synthetic-model',
    APP_MODEL_BASE_URL: 'http://127.0.0.1:' + address.port + '/v1', APP_MODEL_API_KEY: 'b5-synthetic-secret',
  }, { allowLoopbackHttp: true });
  try {
    const result = await runFactWorkflow({
      input, config, registry, candidateStore, reviewStore, runStore,
      maxRepairRounds: options.maxRepairRounds ?? 2,
      ...(options.spendBudget ? { spendBudget: options.spendBudget } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      evidenceLimits: options.evidenceLimits ?? { ...EVIDENCE_LIMITS, timeoutMs: 5000 },
      reviewLimits: options.reviewLimits ?? { ...REVIEW_LIMITS, timeoutMs: 5000 },
      ...(options.sourceBundles ? { sourceBundles: options.sourceBundles } : {}),
      ...(options.evaluationSeed ? { evaluationSeed: options.evaluationSeed } : {}),
    });
    counts.review = reviewCalls;
    assert.equal(JSON.stringify(result).includes('b5-synthetic-secret'), false);
    assert.deepEqual(
      readdirSync(tmpdir()).filter(n => n.startsWith('tju-evidence-session-') || n.startsWith('tju-review-session-')).sort(),
      before, '会话临时目录应清理',
    );
    return { result, requests, candidateStore, reviewStore, runStore, counts };
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}