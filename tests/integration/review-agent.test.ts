/** B4 程序回归：真实 Pi SDK + 本地模拟网关（SYNTHETIC SSE，非真实模型）。
 *  四个核心场景：合成夹具，不代表真实模型评审质量。生产已知缺陷须使断言失败。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { ReviewInput, ReviewReport } from '../../packages/contracts/generated/index.ts';
import type { ReviewOutput } from '../../packages/contracts/generated/review-output.ts';
import type { ReviewEnvelope } from '../../apps/server/src/agents/review/context.ts';
import type { EvidenceSnapshot } from '../../packages/contracts/generated/evidence-snapshot.ts';
import { checkReviewInput } from '../../packages/contracts/src/service-checks.ts';
import { MemoryReviewStore, type ReviewRecord } from '../../apps/server/src/domain/review.service.ts';
import { readModelConfig } from '../../apps/server/src/config/env.ts';
import { runReviewAgent } from '../../apps/server/src/agents/review/agent.ts';
import type { ReviewOutcome } from '../../apps/server/src/agents/review/agent.ts';
import { REVIEW_LIMITS } from '../../apps/server/src/runtime/pi/execution-limits.ts';
import { fingerprint } from '../../packages/contracts/src/fingerprint.ts';
import { loadFixture, registry } from '../helpers/fixtures.ts';

const rawInput = loadFixture<ReviewInput>('review-input.json');
const rawSnapshot = loadFixture<EvidenceSnapshot>('snapshot.json');

/** 小快照克隆：仅保留 claim_rd_60 / ev_rd_60 / ent_rd，清空冲突/缺失/可选集合，reviewStatus 保持 pending。 */
function baseSnapshot(): EvidenceSnapshot {
  const snap = structuredClone(rawSnapshot);
  snap.entities = snap.entities.filter(e => e.entityId === 'ent_rd');
  snap.claims = snap.claims.filter(c => c.claimId === 'claim_rd_60');
  snap.evidence = snap.evidence.filter(e => e.evidenceId === 'ev_rd_60');
  snap.conflicts = [];
  snap.missing = [];
  delete (snap as { relations?: unknown }).relations;
  delete (snap as { events?: unknown }).events;
  delete (snap as { assets?: unknown }).assets;
  for (const c of snap.claims) c.reviewStatus = 'pending';
  snap.reviewStatus = 'pending';
  snap.coverage = {
    ...snap.coverage,
    documentsProcessed: [{ documentId: 'doc_profile', documentVersionId: 'docv_profile_1', blockIds: ['b001', 'b002', 'b003', 'b004'] }],
  };
  return snap;
}

/** 合法输入：documents/scope/coverage 限定 doc_profile，保留 block 文本与 hash；用 fingerprint(snapshot) 重算 subject.contentHash。 */
function makeInput(snapshot: EvidenceSnapshot): ReviewInput {
  const input = structuredClone(rawInput);
  const doc = input.documents.find(d => d.documentId === 'doc_profile')!;
  input.documents = [doc];
  input.scope.documentRefs = input.scope.documentRefs.filter(r => r.documentId === 'doc_profile');
  snapshot.coverage.documentsProcessed = [{ documentId: 'doc_profile', documentVersionId: 'docv_profile_1', blockIds: doc.blocks.map(b => b.blockId) }];
  input.subject.contentHash = fingerprint(snapshot);
  return input;
}

function checkInput(input: ReviewInput, snapshot: EvidenceSnapshot): void {
  assert.ok(input.subject.subjectType === 'evidence_snapshot');
  const result = checkReviewInput(input as unknown as Record<string, unknown>, snapshot as unknown as Record<string, unknown>, registry);
  assert.ok(result.ok === true, 'fixture schema/checkReviewInput 应通过：' + JSON.stringify(result.issues));
}

type Req = { documentId: string; documentVersionId: string; blockId: string };
const READ_REQS: Req[] = [
  { documentId: 'doc_profile', documentVersionId: 'docv_profile_1', blockId: 'b004' },
  { documentId: 'doc_profile', documentVersionId: 'docv_profile_1', blockId: 'b003' },
  { documentId: 'doc_profile', documentVersionId: 'docv_profile_1', blockId: 'b001' },
];

type Body = { messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>; tools: Array<{ function: { name: string } }>; response_format?: { type: string } };
function promptJson(body: Body): { envelope: ReviewEnvelope; subject: ReviewInput['subject']; task: { projectId: string; taskId: string; attemptId: string } } {
  const content = body.messages.findLast(m => m.role === 'user')!.content;
  return JSON.parse(typeof content === 'string' ? content : content.map(c => c.text ?? '').join(''));
}

/** 依据 fixture 生成一份合法报告，注入本次请求实际 prompt 的 envelope/subject/task 字段。 */
function makeReportOutput(body: Body, verdict: 'pass' | 'revise', mode: 'rd60' | 'rd600'): ReviewOutput {
  const prompt = promptJson(body);
  const env = prompt.envelope;
  const reviewedBy = { ...env.reviewedBy, role: 'review' } as const;
  type CheckTuple = [ReviewReport['checks'][number]['checkType'], 'pass' | 'fail', string, string[], string[]];
  const types: CheckTuple[] = [
    ['support', 'pass', '已按 support 规则核对候选快照与原始资料。', ['claim_rd_60'], ['ev_rd_60']],
    ['entity_match', 'pass', '已按 entity_match 规则核对候选快照与原始资料。', ['claim_rd_60'], ['ev_rd_60']],
    ['value', mode === 'rd600' ? 'fail' : 'pass', mode === 'rd600' ? '候选数值 600 与原始资料 60 不一致。' : '已按 value 规则核对候选快照与原始资料。', ['claim_rd_60'], ['ev_rd_60']],
    ['unit', 'pass', '已按 unit 规则核对候选快照与原始资料。', ['claim_rd_60'], ['ev_rd_60']],
    ['time', 'pass', '已按 time 规则核对候选快照与原始资料。', ['claim_rd_60'], ['ev_rd_60']],
    ['basis', 'pass', '已按 basis 规则核对候选快照与原始资料。', ['claim_rd_60'], ['ev_rd_60']],
    ['source_locator', 'pass', '已按 source_locator 规则核对候选快照与原始资料。', ['claim_rd_60'], ['ev_rd_60']],
    ['missing', 'pass', '无缺失。', [], []],
    ['conflict', 'pass', '无冲突。', [], []],
    ['traceability', 'pass', '已按 traceability 规则核对候选快照与原始资料。', ['claim_rd_60'], ['ev_rd_60']],
  ];
  const checks: ReviewReport['checks'] = types.map(([checkType, status, finding, claimRefs, evidenceRefs]) => ({
    checkId: 'check_' + checkType, checkType, status, finding, severity: status === 'fail' ? 'error' : 'info', claimRefs, evidenceRefs,
  }));
  const issues: ReviewReport['issues'] = mode === 'rd600'
    ? [{ issueId: 'issue_value_rd', claimId: 'claim_rd_60', evidenceRefs: ['ev_rd_60'], severity: 'error', category: 'value', description: '数值与原始资料不一致。', expected: '60 人', actual: '600 人', suggestedStage: 'needs_input' }]
    : [];
  const report: ReviewOutput['report'] = {
    protocolVersion: '1.0',
    reportId: env.reportId, reportVersionId: env.reportVersionId,
    projectId: prompt.task.projectId, taskId: prompt.task.taskId, attemptId: prompt.task.attemptId, reviewMode: 'fact',
    subject: prompt.subject,
    verdict, checks, issues,
    summary: mode === 'rd600' ? '抽取阶段通过，数值核对不通过，需人工修订。' : '候选快照与原始资料逐条核对，提取阶段通过。',
    executionStatus: 'completed', reviewedBy, createdAt: env.createdAt,
  };
  return { protocolVersion: '1.0', projectId: prompt.task.projectId, taskId: prompt.task.taskId, attemptId: prompt.task.attemptId, status: 'completed', report, producedBy: reviewedBy };
}

type Handler = (body: Body, res: ServerResponse, index: number, state: { final: boolean; readIds: string[] }) => void;

function complete(res: ServerResponse, data: string | Req[], finishReason = 'stop', usage = { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250 }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (delta: unknown, finish_reason: string | null) => res.write('data: ' + JSON.stringify({ id: 'synthetic_b4', object: 'chat.completion.chunk', model: 'synthetic-model', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
  if (Array.isArray(data)) {
    chunk({ role: 'assistant', tool_calls: data.map((args, index) => ({ index, id: 'read_' + index, type: 'function', function: { name: 'read_document', arguments: JSON.stringify(args) } })) }, null);
    chunk({}, 'tool_calls');
  } else { chunk({ role: 'assistant', content: data }, null); chunk({}, finishReason); }
  res.write('data: ' + JSON.stringify({ choices: [], usage }) + '\n\n');
  res.end('data: [DONE]\n\n');
}

async function scenario(handler: Handler, taskInput: ReviewInput, candidateSnapshot: EvidenceSnapshot): Promise<{ outcome: ReviewOutcome; requests: Body[]; records: ReviewRecord[]; state: { final: boolean; readIds: string[] } }> {
  const before = readdirSync(tmpdir()).filter(n => n.startsWith('tju-review-session-')).sort();
  const requests: Body[] = [];
  const store = new MemoryReviewStore();
  const state = { final: false, readIds: [] as string[] };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Body;
    requests.push(body);
    handler(body, res, requests.length, state);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const config = readModelConfig({ APP_MODEL_PROVIDER: 'b4-test', APP_MODEL_ID: 'synthetic-model', APP_MODEL_BASE_URL: 'http://127.0.0.1:' + address.port + '/v1', APP_MODEL_API_KEY: 'b4-synthetic-secret' }, { allowLoopbackHttp: true });
  try {
    const outcome = await runReviewAgent({ input: taskInput, candidateSnapshot, config, store, registry, limits: { ...REVIEW_LIMITS, timeoutMs: 5000 } });
    assert.equal(JSON.stringify(outcome).includes('b4-synthetic-secret'), false);
    assert.deepEqual(readdirSync(tmpdir()).filter(n => n.startsWith('tju-review-session-')).sort(), before, '会话临时目录应清理');
    return { outcome, requests, records: store.list(), state };
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

/** 审查报告含合法 pass 检查 + 一次 tool read 收据。 */
function assignReviewed(outcome: ReviewOutcome, records: ReviewRecord[], state: { readIds: string[] }): ReviewReport {
  assert.equal(outcome.status, 'completed', '结果应为 completed：' + JSON.stringify(outcome).slice(0, 400));
  assert.equal(outcome.successfulReads, READ_REQS.length, '报告须收到受控工具 read 收据');
  const record = records[0];
  assert.ok(record, '应存储一条 reviewed 记录');
  assert.equal(record.state, 'reviewed');
  assert.ok(record.output, 'reviewed 记录应携带公开报告');
  const report = record.output.report;
  assert.equal(report.reportVersionId, outcome.reportVersionId);
  assert.equal(report.executionStatus, 'completed');
  assert.equal(report.reviewedBy?.role, 'review');
  assert.equal(outcome.resourcesDisposed, true);
  return report;
}

test('review(1) 正确读原始资料后合法单 claim 通过 -> completed/pass, 快照 pending 不变, reviewed report 存储', async () => {
  const snapshot = baseSnapshot();
  const input = makeInput(snapshot);
  checkInput(input, snapshot);
  const { outcome, requests, records, state } = await scenario((body, res, i, st) => {
    if (i === 1) { complete(res, READ_REQS); return; }
    st.final = true; complete(res, JSON.stringify(makeReportOutput(body, 'pass', 'rd60')));
  }, input, snapshot);
  assert.equal(requests.length >= 2, true, '至少一次 read + 最终 JSON');
  assert.equal(requests.length >= 2, true, '至少一次 read + 最终 JSON');
  for (const r of requests) assert.deepEqual(r.response_format, { type: 'json_object' });
  assert.equal(outcome.status, 'completed');
  const report = assignReviewed(outcome, records, state);
  assert.equal(report.verdict, 'pass');
  assert.equal(report.checks.length, 10);
  for (const c of report.checks) assert.equal(c.status, 'pass');
  assert.equal(snapshot.claims.find(c => c.claimId === 'claim_rd_60')!.reviewStatus, 'pending');
  assert.equal(records.length, 1, '应存储一条 reviewed 记录');
  assert.equal(records[0].state, 'reviewed');
});

test('review(2) 值突变 60->600，保持来源并重算指纹；reviewer 读来源返回 completed/revise，value 校验失败', async () => {
  const snapshot = baseSnapshot();
  snapshot.claims.find(c => c.claimId === 'claim_rd_60')!.value = { type: 'quantity', normalized: 600, unit: '人', raw: '600 人' };
  const input = makeInput(snapshot);
  checkInput(input, snapshot);
  const { outcome, records, state } = await scenario((body, res, i, st) => {
    if (i === 1) { complete(res, READ_REQS); return; }
    st.final = true; complete(res, JSON.stringify(makeReportOutput(body, 'revise', 'rd600')));
  }, input, snapshot);
  assert.equal(outcome.status, 'completed');
  const report = assignReviewed(outcome, records, state);
  assert.equal(report.verdict, 'revise');
  const value = report.checks.find(c => c.checkType === 'value')!;
  assert.equal(value.status, 'fail');
  const issue = report.issues.find(x => x.category === 'value')!;
  assert.equal(issue.severity, 'error');
  assert.equal(issue.claimId, 'claim_rd_60');
  assert.deepEqual(issue.evidenceRefs, ['ev_rd_60']);
  assert.equal(issue.expected, '60 人');
  assert.equal(issue.actual, '600 人');
  assert.equal(report.executionStatus, 'completed');
  assert.equal(records[0].state, 'reviewed');
  const finalValue = snapshot.claims.find(c => c.claimId === 'claim_rd_60')!.value;
  assert.equal(finalValue.type, 'quantity');
  assert.equal(finalValue.type === 'quantity' ? finalValue.normalized : undefined, 600);
});

test('review(3) 无 read 但其余合法 pass -> 必须作为 failed/invalid_report 拒绝', async () => {
  const snapshot = baseSnapshot();
  const input = makeInput(snapshot);
  checkInput(input, snapshot);
  const { outcome, records } = await scenario((body, res, i, st) => {
    st.final = true; complete(res, JSON.stringify(makeReportOutput(body, 'pass', 'rd60')));
  }, input, snapshot);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.reason, 'invalid_report');
  assert.equal(outcome.reportVersionId, undefined);
  assert.equal(records.length, 1);
  assert.equal(records[0].state, 'invalid');
  assert.equal(records[0].output, undefined, '失败时不得暴露公开成功报告');
});

test('review(4) subject 哈希陈旧 -> 任何 HTTP 之前拒绝', async () => {
  const snapshot = baseSnapshot();
  const input = makeInput(snapshot);
  checkInput(input, snapshot);
  input.subject.contentHash = 'sha256:0000000000000000000000000000000000000000000000000000000000000000' as never;
  let hits = 0;
  const { outcome, records } = await scenario((_body, res) => { hits++; res.writeHead(500); res.end(); }, input, snapshot);
  assert.equal(hits, 0, '陈旧 subject 哈希须在发出 HTTP 之前拒绝');
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.reason, 'invalid_input');
  assert.equal(outcome.reportVersionId, undefined);
  assert.equal(records.length, 0);
  assert.equal(outcome.resourcesDisposed, true);
});