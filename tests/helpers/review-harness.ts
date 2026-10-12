/** B4 程序回归辅助：真实 Pi SDK + 本地模拟网关（SYNTHETIC SSE，非真实模型）。
 *  导出合成夹具与场景驱动，不代表真实模型评审质量。 */
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
import { loadFixture, registry } from './fixtures.ts';

const rawInput = loadFixture<ReviewInput>('review-input.json');
const rawSnapshot = loadFixture<EvidenceSnapshot>('snapshot.json');

/** 小快照克隆：仅保留 claim_rd_60 / ev_rd_60 / ent_rd，清空冲突/缺失/可选集合，reviewStatus 保持 pending。 */
export function baseSnapshot(): EvidenceSnapshot {
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
export function makeInput(snapshot: EvidenceSnapshot): ReviewInput {
  const input = structuredClone(rawInput);
  const doc = input.documents.find(d => d.documentId === 'doc_profile')!;
  input.documents = [doc];
  input.scope.documentRefs = input.scope.documentRefs.filter(r => r.documentId === 'doc_profile');
  snapshot.coverage.documentsProcessed = [{ documentId: 'doc_profile', documentVersionId: 'docv_profile_1', blockIds: doc.blocks.map(b => b.blockId) }];
  input.subject.contentHash = fingerprint(snapshot);
  return input;
}

export function checkInput(input: ReviewInput, snapshot: EvidenceSnapshot): void {
  assert.ok(input.subject.subjectType === 'evidence_snapshot');
  const result = checkReviewInput(input as unknown as Record<string, unknown>, snapshot as unknown as Record<string, unknown>, registry);
  assert.ok(result.ok === true, 'fixture schema/checkReviewInput 应通过：' + JSON.stringify(result.issues));
}

type Req = { documentId: string; documentVersionId: string; blockId: string };
export const READ_REQS: Req[] = [
  { documentId: 'doc_profile', documentVersionId: 'docv_profile_1', blockId: 'b004' },
  { documentId: 'doc_profile', documentVersionId: 'docv_profile_1', blockId: 'b003' },
  { documentId: 'doc_profile', documentVersionId: 'docv_profile_1', blockId: 'b001' },
];

export type Body = { messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>; tools: Array<{ function: { name: string } }> };
export function promptJson(body: Body): { envelope: ReviewEnvelope; subject: ReviewInput['subject']; task: { projectId: string; taskId: string; attemptId: string } } {
  const content = body.messages.findLast(m => m.role === 'user')!.content;
  return JSON.parse(typeof content === 'string' ? content : content.map(c => c.text ?? '').join(''));
}

/** 依据 fixture 生成一份合法报告，注入本次请求实际 prompt 的 envelope/subject/task 字段。 */
export function makeReportOutput(body: Body, verdict: 'pass' | 'revise', mode: 'rd60' | 'rd600'): ReviewOutput {
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

export type Handler = (body: Body, res: ServerResponse, index: number, state: { final: boolean; readIds: string[] }) => void;

export function complete(res: ServerResponse, data: string | Req[], finishReason = 'stop', toolName: 'read_document' | 'read_source' = 'read_document', usage = { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250 }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (delta: unknown, finish_reason: string | null) => res.write('data: ' + JSON.stringify({ id: 'synthetic_b4', object: 'chat.completion.chunk', model: 'synthetic-model', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
  if (Array.isArray(data)) {
    chunk({ role: 'assistant', tool_calls: data.map((args, index) => ({ index, id: 'read_' + index, type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } })) }, null);
    chunk({}, 'tool_calls');
  } else { chunk({ role: 'assistant', content: data }, null); chunk({}, finishReason); }
  res.write('data: ' + JSON.stringify({ choices: [], usage }) + '\n\n');
  res.end('data: [DONE]\n\n');
}

export async function scenario(
  handler: Handler,
  taskInput: ReviewInput,
  candidateSnapshot: EvidenceSnapshot,
  options: Partial<Pick<Parameters<typeof runReviewAgent>[0], 'limits' | 'signal' | 'store' | 'sourceBundles'>> = {},
): Promise<{ outcome: ReviewOutcome; requests: Body[]; records: ReviewRecord[]; store: MemoryReviewStore; state: { final: boolean; readIds: string[] } }> {
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
    const outcome = await runReviewAgent({ input: taskInput, candidateSnapshot, config, store, registry, limits: { ...REVIEW_LIMITS, timeoutMs: 5000 }, ...options });
    assert.equal(JSON.stringify(outcome).includes('b4-synthetic-secret'), false);
    assert.deepEqual(readdirSync(tmpdir()).filter(n => n.startsWith('tju-review-session-')).sort(), before, '会话临时目录应清理');
    return { outcome, requests, records: store.list(), store, state };
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
