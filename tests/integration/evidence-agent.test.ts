/** B3 程序回归：真实 Pi SDK + 本地模拟网关；不代表真实模型的提取质量。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import type { EvidenceInput, EvidenceOutput, ReadDocumentRequest } from '../../packages/contracts/generated/index.ts';
import { checkEvidenceInput } from '../../packages/contracts/src/service-checks.ts';
import { readModelConfig } from '../../apps/server/src/config/env.ts';
import { runEvidenceAgent } from '../../apps/server/src/agents/evidence/agent.ts';
import { prepareEvidenceInput, evidenceTaskPrompt, type CandidateEnvelope } from '../../apps/server/src/agents/evidence/context.ts';
import { MemoryCandidateStore } from '../../apps/server/src/domain/evidence.service.ts';
import { validateEvidenceCandidate } from '../../apps/server/src/domain/result-validator.ts';
import { EVIDENCE_LIMITS, validateLimits } from '../../apps/server/src/runtime/pi/execution-limits.ts';
import { RequestSpendBudget, type SpendReservation } from '../../apps/server/src/runtime/pi/spend-budget.ts';
import { createDocumentReader } from '../../apps/server/src/runtime/pi/read-document-tool.ts';
import { loadFixture, registry } from '../helpers/fixtures.ts';

const input = loadFixture<EvidenceInput>('b3-evidence-input.json');
const golden = loadFixture<EvidenceOutput>('b3-evidence-expected.json');
const limits = { ...EVIDENCE_LIMITS, timeoutMs: 5000 };
const requestsToRead: ReadDocumentRequest[] = input.documents.flatMap(d => d.blocks.map(b => ({ documentId: d.documentId, documentVersionId: d.documentVersionId, blockId: b.blockId })));
const read = createDocumentReader({ scope: input.scope, documents: input.documents }, registry);
const receipts = requestsToRead.map(r => read(r));
const envelope: CandidateEnvelope = Object.fromEntries(['snapshotId', 'snapshotVersionId', 'createdAt', 'producedBy'].map(k => [k, golden.candidateSnapshot[k as keyof typeof golden.candidateSnapshot]])) as unknown as CandidateEnvelope;
type Body = { messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>; tools: Array<{ function: { name: string } }> };
function task(body: Body): { envelope: CandidateEnvelope; catalog?: unknown } {
  const content = body.messages.findLast(m => m.role === 'user')!.content;
  return JSON.parse(typeof content === 'string' ? content : content.map(c => c.text ?? '').join(''));
}
function candidate(body: Body) {
  const output = structuredClone(golden);
  const metadata = task(body).envelope;
  Object.assign(output.candidateSnapshot, metadata);
  output.producedBy = metadata.producedBy;
  return output;
}
function complete(res: ServerResponse, data: string | ReadDocumentRequest[], finishReason = 'stop', usage = { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250 }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (delta: unknown, finish_reason: string | null) => res.write('data: ' + JSON.stringify({ id: 'synthetic_b3', object: 'chat.completion.chunk', model: 'synthetic-model', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
  if (Array.isArray(data)) {
    chunk({ role: 'assistant', tool_calls: data.map((args, index) => ({ index, id: 'read_' + index, type: 'function', function: { name: 'read_document', arguments: JSON.stringify(args) } })) }, null);
    chunk({}, 'tool_calls');
  } else { chunk({ role: 'assistant', content: data }, null); chunk({}, finishReason); }
  res.write('data: ' + JSON.stringify({ choices: [], usage }) + '\n\n');
  res.end('data: [DONE]\n\n');
}
type Handler = (body: Body, res: ServerResponse, index: number) => void;
async function scenario(handler: Handler = (body, res, i) => complete(res, i === 1 ? requestsToRead : JSON.stringify(candidate(body))), changes: Partial<Parameters<typeof runEvidenceAgent>[0]> = {}) {
  const before = readdirSync(tmpdir()).filter(n => n.startsWith('tju-evidence-session-')).sort();
  const requests: Body[] = [], store = new MemoryCandidateStore();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Body;
    requests.push(body); handler(body, res, requests.length);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const config = readModelConfig({ APP_MODEL_PROVIDER: 'b3-test', APP_MODEL_ID: 'synthetic-model', APP_MODEL_BASE_URL: 'http://127.0.0.1:' + address.port + '/v1', APP_MODEL_API_KEY: 'b3-synthetic-secret' }, { allowLoopbackHttp: true });
  try {
    const outcome = await runEvidenceAgent({ input, config, registry, store, limits, ...changes });
    assert.equal(outcome.resourcesDisposed, true);
    assert.deepEqual(readdirSync(tmpdir()).filter(n => n.startsWith('tju-evidence-session-')).sort(), before);
    assert.equal(JSON.stringify(outcome).includes('b3-synthetic-secret'), false);
    return { outcome, requests, records: store.list() };
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
function validate(output = structuredClone(golden), reads = receipts, previous?: unknown, taskInput = input) {
  return validateEvidenceCandidate(output, taskInput, envelope, reads, registry, previous);
}

test('B3 合成预期包含不同年份/口径、真冲突、缺失、新属性、关系和事件，符合协议', () => {
  assert.equal(checkEvidenceInput(input, registry).ok, true);
  assert.deepEqual(validate().issues, []);
  const s = golden.candidateSnapshot;
  assert.deepEqual(s.claims.filter(c => c.predicate === 'rd_headcount').map(c => [c.value, c.qualifiers]), [
    [{ type: 'quantity', normalized: 10, unit: '人', raw: '10人' }, { time: { year: 2024 }, basis: '年末在册' }],
    [{ type: 'quantity', normalized: 12, unit: '人', raw: '12人' }, { time: { year: 2025 }, basis: '年末在册' }],
    [{ type: 'quantity', normalized: 13, unit: '人', raw: '13人' }, { time: { year: 2025 }, basis: '年末在册' }],
    [{ type: 'quantity', normalized: 15, unit: '人', raw: '15人' }, { time: { year: 2025 }, basis: '参与项目' }],
  ]);
  assert.deepEqual(s.claims[0].evidenceRefs, ['ev_2024_a', 'ev_2024_b']);
  assert.equal(s.claims[4].predicate, 'renewable_energy_share');
  assert.equal(s.missing[0].expectedPredicate, 'annual_revenue');
  assert.equal(s.claims.some(c => c.predicate === 'annual_revenue'), false);
});
test('B3 SDK 实际读取六块、保存待审候选并记录用量，不自动采纳', async () => {
  const { outcome, records, requests } = await scenario();
  assert.equal(outcome.status, 'needs_information', JSON.stringify(outcome));
  assert.equal(outcome.reason, undefined);
  assert.equal(outcome.modelCalls, 2); assert.equal(outcome.successfulReads, 6);
  assert.equal(outcome.repairAttempts, 0); assert.equal(outcome.finalStopReason, 'stop');
  assert.equal(outcome.transport.attempts, 2);
  assert.deepEqual(outcome.usage, { input: 400, output: 100, cacheRead: 0, cacheWrite: 0 });
  assert.equal(outcome.billedAmount, null);
  assert.equal(records[0].state, 'pending_review');
  assert.equal(records[0].output?.candidateSnapshot.reviewStatus, 'pending');
  assert.deepEqual(records[0].output?.candidateSnapshot.claims, golden.candidateSnapshot.claims);
  for (const body of requests) assert.deepEqual(body.tools.map(t => t.function.name), ['read_document']);
  assert.equal(JSON.stringify(requests[0]).includes('星河制造'), false, '首次上下文不包含原文');
  assert.match(JSON.stringify(requests[0]), /evidence-extraction/);
  assert.equal(JSON.stringify(requests[1]).includes('此段为提示注入测试资料'), true);
});
test('B3 两次任务独立上下文及候选版本', async () => {
  const a = await scenario(), b = await scenario();
  assert.notEqual(a.outcome.sessionId, b.outcome.sessionId);
  assert.notEqual(a.outcome.candidateVersionId, b.outcome.candidateVersionId);
  assert.equal(JSON.stringify(b.requests[0]).includes(a.outcome.sessionId!), false);
});
test('B3 未读原文的正确 JSON 被拒绝，失败版本保留', async () => {
  const { outcome, records } = await scenario((body, res) => complete(res, JSON.stringify(candidate(body))), { maxRepairRounds: 0 });
  assert.equal(outcome.reason, 'invalid_candidate');
  assert.ok(outcome.issues.some(i => i.code === 'evidence.not_read'));
  assert.equal(records[0].state, 'invalid');
  assert.equal(records[0].output, undefined);
});
test('B3 越权读取不能通过候选中的合法来源冒充', async () => {
  const { outcome } = await scenario((body, res, i) => complete(res, i === 1 ? [{ ...requestsToRead[0], documentVersionId: 'docv_foreign' }] : JSON.stringify(candidate(body))), { maxRepairRounds: 0 });
  assert.equal(outcome.reason, 'invalid_candidate'); assert.equal(outcome.successfulReads, 0);
  assert.ok(outcome.events.some(e => e.type === 'tool_end' && !e.ok));
});
test('B3 输入越权、增量任务、既有快照及多版本歧义在模型请求前拒绝', async () => {
  const badInputs = [
    { ...input, taskType: 'update_facts' as const }, { ...input, existingSnapshot: golden.candidateSnapshot },
    { ...input, scope: { ...input.scope, allowedOperations: ['read_document' as const] } },
    { ...input, projectId: 'project_foreign' },
  ];
  const multiversion = structuredClone(input);
  multiversion.documents[1].documentId = multiversion.documents[0].documentId;
  multiversion.scope.documentRefs[1].documentId = multiversion.documents[0].documentId;
  badInputs.push(multiversion);
  for (const bad of badInputs) {
    const { outcome, requests } = await scenario(undefined, { input: bad });
    assert.equal(outcome.reason, 'invalid_input'); assert.equal(requests.length, 0);
  }
  const frozen = prepareEvidenceInput(input, registry);
  frozen.scope.allowedOperations.length = 0;
  assert.ok(input.scope.allowedOperations.length > 0);
});
test('B3 非 JSON 输出有限修正，新候选与失败原文同时保留', async () => {
  const { outcome, records } = await scenario((body, res, i) => complete(res, i === 1 ? requestsToRead : i === 2 ? 'not json' : JSON.stringify(candidate(body))));
  assert.equal(outcome.status, 'needs_information', JSON.stringify(outcome));
  assert.equal(records.length, 2); assert.equal(records[0].rawOutput, 'not json');
  assert.equal(records[0].state, 'invalid'); assert.equal(records[1].state, 'pending_review');
  assert.notEqual(records[0].snapshotVersionId, records[1].snapshotVersionId);
  assert.equal(outcome.modelCalls, 3); assert.equal(outcome.toolCalls, 6);
  assert.equal(outcome.repairAttempts, 1);
});
test('B3 结构修正保留完整事实和问题', async () => {
  const { outcome, records } = await scenario((body, res, i) => {
    if (i === 1) return complete(res, requestsToRead);
    const output = candidate(body);
    complete(res, JSON.stringify(i === 2 ? { ...output, unknownField: true } : output));
  });
  assert.equal(outcome.status, 'needs_information', JSON.stringify(outcome));
  assert.equal(records.length, 2); assert.deepEqual(records[1].output?.candidateSnapshot.claims, golden.candidateSnapshot.claims);
});
test('B3 修正不能删除困难事实或改掉已有合法值', async () => {
  for (const mode of ['remove', 'change']) {
    const { outcome, records } = await scenario((body, res, i) => {
      if (i === 1) return complete(res, requestsToRead);
      const output = candidate(body);
      if (i === 2) output.candidateSnapshot.evidence[0].excerpt = '不存在的摘录';
      else if (mode === 'remove') output.candidateSnapshot.claims.pop();
      else output.candidateSnapshot.claims[4].value = { type: 'quantity', normalized: 99, unit: '%', raw: '99%' };
      complete(res, JSON.stringify(output));
    });
    assert.equal(outcome.reason, 'invalid_candidate');
    assert.ok(outcome.issues.some(i => i.code === (mode === 'remove' ? 'repair.removed_item' : 'repair.changed_fact')));
    assert.equal(records.length, 2); assert.ok(records.every(r => r.state === 'invalid'));
  }
});
test('B3 修正额度耗尽后停止，不持续重试', async () => {
  const { outcome, records } = await scenario((_body, res) => complete(res, 'broken'));
  assert.equal(outcome.reason, 'invalid_candidate'); assert.equal(outcome.modelCalls, 2);
  assert.equal(records.length, 2);
});
test('B3 来源、版本、覆盖、待审状态和冲突关联的伪造被拒绝', () => {
  const mutations: Array<(o: EvidenceOutput) => void> = [
    o => { o.candidateSnapshot.evidence[0].excerpt = '编造'; },
    o => { o.candidateSnapshot.evidence[0].documentVersionId = 'docv_fake'; },
    o => { o.candidateSnapshot.coverage.documentsProcessed[0].blockIds.pop(); },
    o => { o.candidateSnapshot.coverage.documentsProcessed[0].blockIds.push('b000'); },
    o => { o.candidateSnapshot.coverage.unsupported = [{ documentId: 'doc_a', blockId: 'b999', reason: 'unknown' }]; },
    o => { o.candidateSnapshot.producedBy.sessionId = 'session_forged'; },
    o => { (o.candidateSnapshot as { reviewStatus: string }).reviewStatus = 'passed'; },
    o => { o.candidateSnapshot.claims[1].supportStatus = 'supported'; },
    o => { o.candidateSnapshot.conflicts[0].resolutionStatus = 'resolved'; },
    o => { o.status = 'completed'; delete o.stopReason; },
  ];
  for (const mutate of mutations) { const o = structuredClone(golden); mutate(o); assert.equal(validate(o).ok, false); }
});
test('B3 显式重复事实须合并，不同年份及口径允许同时保留', () => {
  const output = structuredClone(golden);
  const duplicate = structuredClone(output.candidateSnapshot.claims[0]);
  duplicate.claimId = 'claim_duplicate'; duplicate.claimVersionId = 'claimv_duplicate';
  output.candidateSnapshot.claims.push(duplicate);
  assert.ok(validate(output).issues.some(i => i.code === 'claim.duplicate_fact'));
  assert.equal(validate().ok, true);
});
test('B3 未读取块或解析限制必须显式登记且不能宣称完成', () => {
  const output = structuredClone(golden), limitedInput = structuredClone(input);
  limitedInput.documents[1].parseInfo = { parser: 'synthetic', quality: 'partial', unsupported: [{ blockId: 'b002', reason: 'test limitation' }] };
  assert.ok(validate(output, receipts, undefined, limitedInput).issues.some(i => i.code === 'coverage.parser_limitation_omitted'));
  output.candidateSnapshot.coverage.documentsProcessed[1].blockIds.pop();
  output.candidateSnapshot.coverage.unsupported = [{ documentId: 'doc_b', blockId: 'b002', reason: 'test limitation' }];
  assert.equal(validate(output, receipts.slice(0, -1), undefined, limitedInput).ok, true);
});
test('B3 程序来源检查不冒充语义审查', () => {
  const output = structuredClone(golden);
  output.candidateSnapshot.claims[4].value = { type: 'quantity', normalized: 999, unit: '%', raw: '999%' };
  assert.equal(validate(output).ok, true, '值与原文语义不一致需要独立审查；程序不声明已证明事实正确');
});
test('B3 模型、工具和上下文预算生效', async () => {
  for (const [field, reason] of [['maxModelCalls', 'model_budget'], ['maxToolCalls', 'tool_budget'], ['maxContextBytes', 'context_budget']] as const) {
    const { outcome } = await scenario(undefined, { limits: { ...limits, [field]: 1 } });
    assert.equal(outcome.reason, reason); assert.equal(outcome.candidateVersions.length, 0);
  }
  assert.throws(() => validateLimits({ ...limits, maxModelCalls: EVIDENCE_LIMITS.maxModelCalls + 1 }, 'evidence'));
});
test('B3 取消与超时清理资源且不保存候选', async () => {
  const aborted = await scenario(undefined, { signal: AbortSignal.abort() });
  assert.equal(aborted.outcome.reason, 'cancelled'); assert.equal(aborted.requests.length, 0);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300);
  try {
    const cancelled = await scenario(() => {}, { signal: controller.signal });
    assert.equal(cancelled.outcome.reason, 'cancelled'); assert.equal(cancelled.records.length, 0);
  } finally { clearTimeout(timer); }
  const timed = await scenario(() => {}, { limits: { ...limits, timeoutMs: 300 } });
  assert.equal(timed.outcome.reason, 'timeout'); assert.equal(timed.records.length, 0);
});
test('B3 模型错误不进行自动重试', async () => {
  const { outcome, requests, records } = await scenario((_body, res) => { res.writeHead(500); res.end('{}'); });
  assert.equal(outcome.reason, 'provider_failed'); assert.equal(requests.length, 1); assert.equal(records.length, 0);
});
test('B3 追加存储拒绝重复版本并隔离调用方修改；保存失败不报告完成', async () => {
  const { records } = await scenario();
  const store = new MemoryCandidateStore(); store.append(records[0]);
  records[0].state = 'invalid'; assert.equal(store.list()[0].state, 'pending_review');
  const returned = store.list(); returned[0].issues.push({ code: 'x', message: 'x' });
  assert.equal(store.list()[0].issues.length, 0);
  assert.throws(() => store.append(store.list()[0]), /candidate_version_exists/);
  const failed = await scenario(undefined, { store: { append() { throw new Error('private storage error'); } } });
  assert.equal(failed.outcome.reason, 'candidate_store_failed'); assert.equal(failed.outcome.candidateVersionId, undefined);
});
test('B3 初始提示使用权威 Schema 和目录，预算不依赖固定企业字段', () => {
  const prompt = evidenceTaskPrompt(input, envelope, registry);
  assert.equal(prompt.includes('星河制造'), false);
  const parsed = JSON.parse(prompt);
  assert.equal(parsed.schemas.length, 3);
  assert.equal(parsed.catalog.flatMap((d: { blocks: unknown[] }) => d.blocks).length, 6);
  assert.deepEqual(parsed.executionLimits, EVIDENCE_LIMITS);
});

test('B3 CLI 默认拒绝真实调用，缺少报告路径在请求前失败', () => {
  const baseEnv = { ...process.env };
  delete baseEnv.APP_RUN_LIVE_EVAL; delete baseEnv.APP_B3_REPORT_PATH;
  for (const [args, env, status] of [
    [[], baseEnv, 2], [['--live'], baseEnv, 2],
    [[], { ...baseEnv, APP_RUN_LIVE_EVAL: '1' }, 2],
    [['--live'], { ...baseEnv, APP_RUN_LIVE_EVAL: '1' }, 1],
  ] as const) {
    const result = spawnSync(process.execPath, ['apps/server/src/entrypoints/b3-evidence.ts', ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.stdout, '');
  }
});

test('B3 修正期间模型故障明确报告 provider_failed，保留首版候选', async () => {
  const { outcome, records } = await scenario((_body, res, i) => {
    if (i === 1) complete(res, 'broken');
    else { res.writeHead(500); res.end('{}'); }
  });
  assert.equal(outcome.reason, 'provider_failed'); assert.equal(outcome.modelCalls, 2);
  assert.equal(outcome.repairAttempts, 1); assert.equal(outcome.finalStopReason, 'error');
  assert.equal(records.length, 1); assert.equal(records[0].state, 'invalid');
});

test('B3 结构修正不能移除已有缺失或冲突', () => {
  for (const collection of ['missing', 'conflicts'] as const) {
    const output = structuredClone(golden); output.candidateSnapshot[collection] = [];
    assert.ok(validate(output, receipts, golden).issues.some(i => i.code === 'repair.removed_item'));
  }
});

test('B3 HTTP 200 的截断输出单独分类，保存私有正文且不重试', async () => {
  const partial = '{"protocolVersion":"1.0","candidateSnapshot":';
  const { outcome, records, requests } = await scenario((_body, res) => complete(res, partial, 'length'));
  assert.equal(outcome.reason, 'output_truncated'); assert.equal(outcome.finalStopReason, 'length');
  assert.equal(outcome.repairAttempts, 0); assert.equal(requests.length, 1);
  assert.equal(records[0].state, 'invalid'); assert.equal(records[0].rawOutput, partial);
  assert.equal(records[0].output, undefined);
  assert.equal(outcome.events.find(e => e.type === 'model_response')?.ok, false);
  assert.deepEqual(outcome.events.find(e => e.type === 'model_response')?.usage, { input: 200, output: 50, cacheRead: 0, cacheWrite: 0 });
  assert.equal(JSON.stringify(outcome).includes(partial), false);
});

test('B3 重复覆盖后的修正即使截断也记为一次尝试，两个失败版本均保留', async () => {
  const { outcome, records, requests } = await scenario((body, res, i) => {
    if (i === 1) return complete(res, requestsToRead);
    if (i === 3) return complete(res, '{"unfinished":', 'length');
    const output = candidate(body);
    output.candidateSnapshot.coverage.unsupported = [{ documentId: 'doc_a', blockId: 'b000', reason: 'partial' }];
    complete(res, JSON.stringify(output));
  });
  assert.equal(outcome.reason, 'output_truncated'); assert.equal(outcome.repairAttempts, 1);
  assert.equal(requests.length, 3); assert.equal(records.length, 2);
  assert.ok(records[0].issues.some(i => i.code === 'coverage.duplicate_block'));
  assert.equal(records[1].rawOutput, '{"unfinished":');
  assert.notEqual(records[0].snapshotVersionId, records[1].snapshotVersionId);
  assert.ok(records.every(r => r.state === 'invalid'));
  assert.deepEqual(outcome.events.filter(e => e.type === 'model_response').map(e => e.stopReason), ['toolUse', 'stop', 'length']);
  assert.equal(outcome.usage?.output, 150);
});

test('B3 异常供应商结束码仅记录标准原因，不泄漏原始错误', async () => {
  const rawReason = 'private-provider-diagnostic';
  const { outcome, requests, records } = await scenario((_body, res) => complete(res, 'partial candidate', rawReason));
  assert.equal(outcome.reason, 'provider_failed'); assert.equal(outcome.finalStopReason, 'error');
  assert.equal(requests.length, 1);
  assert.equal(JSON.stringify(outcome).includes(rawReason), false);
  assert.equal(outcome.events.find(e => e.type === 'model_response')?.stopReason, 'error');
  assert.equal(records[0].rawOutput, 'partial candidate'); assert.equal(records[0].state, 'invalid');
});

test('B3 取消正在生成的候选后保留已收到的正文，不能提交可用版本', async () => {
  const controller = new AbortController();
  const partial = '{"private_partial_candidate":';
  const { outcome, records } = await scenario((_body, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: partial }, finish_reason: null }] }) + '\n\n');
    const timer = setTimeout(() => controller.abort(), 80);
    res.once('close', () => clearTimeout(timer));
  }, { signal: controller.signal });
  assert.equal(outcome.reason, 'cancelled'); assert.equal(outcome.finalStopReason, 'aborted');
  assert.equal(outcome.candidateVersionId, undefined); assert.equal(outcome.repairAttempts, 0);
  assert.equal(records.length, 1); assert.equal(records[0].rawOutput, partial);
  assert.equal(records[0].state, 'invalid'); assert.equal(records[0].output, undefined);
  assert.equal(JSON.stringify(outcome).includes(partial), false);
  assert.equal(outcome.usage, null); assert.equal(outcome.usageUnreportedResponses, 1);
});

const replayInput = loadFixture<EvidenceInput>('b3-replay/input.json');
const replayRead = replayInput.documents.flatMap(d => d.blocks.map(b => ({ documentId: d.documentId, documentVersionId: d.documentVersionId, blockId: b.blockId })));
function replayCandidate(body: Body, name: 'first' | 'recheck') {
  const output = loadFixture<EvidenceOutput>('b3-replay/' + name + '-candidate.json');
  Object.assign(output.candidateSnapshot, task(body).envelope); output.producedBy = task(body).envelope.producedBy;
  return output;
}
test('B3 SDK 回放旧版语义问题候选：来源与结构通过仍只保存待审状态', async () => {
  const { outcome, records } = await scenario((body, res, i) => complete(res, i === 1 ? replayRead : JSON.stringify(replayCandidate(body, 'first'))), { input: replayInput });
  assert.equal(outcome.status, 'needs_information'); assert.equal(outcome.modelCalls, 2);
  assert.equal(records[0].state, 'pending_review'); assert.equal(outcome.repairAttempts, 0);
  assert.equal(records[0].output?.candidateSnapshot.claims[0].predicate, 'legal_name');
});
test('B3 SDK 回放重验重复覆盖并有界修正，两个版本及语义待审状态保留', async () => {
  const { outcome, records } = await scenario((body, res, i) => {
    if (i === 1) return complete(res, replayRead);
    const output = replayCandidate(body, 'recheck');
    if (i === 3) output.candidateSnapshot.coverage.unsupported = [];
    complete(res, JSON.stringify(output));
  }, { input: replayInput });
  assert.equal(outcome.status, 'needs_information'); assert.equal(outcome.repairAttempts, 1);
  assert.equal(outcome.modelCalls, 3); assert.equal(outcome.successfulReads, 1); assert.equal(records.length, 2);
  assert.deepEqual(records[0].issues.map(i => i.code), ['coverage.duplicate_block']);
  assert.equal(records[1].state, 'pending_review');
  assert.deepEqual(records[1].output?.candidateSnapshot.entities[0].aliases, ['海岚仪器']);
  assert.notEqual(records[0].snapshotVersionId, records[1].snapshotVersionId);
});
test('B3 SDK 回放关闭修正时只保留重复覆盖首版，不产生额外请求', async () => {
  const { outcome, records } = await scenario((body, res, i) => complete(res, i === 1 ? replayRead : JSON.stringify(replayCandidate(body, 'recheck'))), { input: replayInput, maxRepairRounds: 0 });
  assert.equal(outcome.reason, 'invalid_candidate'); assert.equal(outcome.modelCalls, 2);
  assert.equal(outcome.repairAttempts, 0); assert.equal(records.length, 1); assert.equal(records[0].state, 'invalid');
});
for (const mode of ['cancelled', 'timeout'] as const) test('B3 修正中断保留本轮部分正文和首版：' + mode, async () => {
  const controller = new AbortController();
  const partial = '{"private_repair_partial":';
  const { outcome, records } = await scenario((body, res, i) => {
    if (i === 1) return complete(res, replayRead);
    if (i === 2) return complete(res, JSON.stringify(replayCandidate(body, 'recheck')));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: partial }, finish_reason: null }] }) + '\n\n');
    if (mode === 'cancelled') {
      const timer = setTimeout(() => controller.abort(), 80);
      res.once('close', () => clearTimeout(timer));
    }
  }, { input: replayInput, signal: controller.signal, limits: { ...limits, timeoutMs: 800 } });
  assert.equal(outcome.reason, mode); assert.equal(outcome.finalStopReason, 'aborted');
  assert.equal(outcome.repairAttempts, 1); assert.equal(outcome.modelCalls, 3);
  assert.equal(outcome.candidateVersionId, undefined); assert.equal(records.length, 2);
  assert.equal(records[1].rawOutput, partial); assert.ok(records.every(r => r.state === 'invalid'));
  assert.notEqual(records[0].snapshotVersionId, records[1].snapshotVersionId);
  assert.deepEqual(outcome.events.filter(e => e.type === 'model_response').map(e => e.stopReason), ['toolUse', 'stop', 'aborted']);
  assert.equal(outcome.usageReportedResponses, 2); assert.equal(outcome.usageUnreportedResponses, 1);
  assert.equal(JSON.stringify(outcome).includes(partial), false);
});
test('B3 修正请求未生成新响应时不把上一轮正文另存为第二版', async () => {
  const { outcome, records } = await scenario((body, res, i) => complete(res, i === 1 ? replayRead : JSON.stringify(replayCandidate(body, 'recheck'))), { input: replayInput, limits: { ...limits, maxModelCalls: 2 } });
  assert.equal(outcome.reason, 'model_budget'); assert.equal(outcome.repairAttempts, 1);
  assert.equal(outcome.modelCalls, 2); assert.equal(records.length, 1); assert.equal(outcome.candidateVersions.length, 1);
});
test('B3 length 即使返回完整 JSON 或空正文也保留失败，不能作为成功或自动修正', async () => {
  for (const empty of [false, true]) {
    const { outcome, records } = await scenario((body, res, i) => {
      if (i === 1) return complete(res, replayRead);
      complete(res, empty ? '' : JSON.stringify(replayCandidate(body, 'first')), 'length');
    }, { input: replayInput });
    assert.equal(outcome.reason, 'output_truncated'); assert.equal(outcome.modelCalls, 2);
    assert.equal(outcome.repairAttempts, 0); assert.equal(outcome.candidateVersionId, undefined);
    assert.equal(records.length, 1); assert.equal(records[0].state, 'invalid'); assert.equal(records[0].output, undefined);
    assert.equal(records[0].rawOutput.length === 0, empty);
  }
});

const spendPolicy = { limitMicros: 5_000_000, safetyMicros: 1_000_000, inputCnyPerMillion: 2, outputCnyPerMillion: 8, inputTokensPerByte: 2, inputTokenOverhead: 8192 };
test('B3 SDK 每次请求前写入费用预留，正常流程仍可完成', async () => {
  let ledger: readonly SpendReservation[] = [];
  const spendBudget = new RequestSpendBudget(spendPolicy, next => { ledger = next; });
  const { outcome } = await scenario((body, res, i) => {
    assert.equal(ledger.length, i, '先预留，再发起模型请求');
    assert.equal(ledger[i - 1].requestedOutputTokens, limits.maxOutputTokens);
    complete(res, i === 1 ? requestsToRead : JSON.stringify(candidate(body)));
  }, { spendBudget });
  assert.equal(outcome.status, 'needs_information'); assert.equal(ledger.length, 2);
  assert.ok(spendBudget.reservedMicros > 0); assert.ok(spendBudget.reservedMicros < 4_000_000);
});
test('B3 费用不足或台账写入失败在网络请求前停止', async () => {
  for (const reason of ['spend_budget', 'spend_ledger_failed']) {
    const spendBudget = new RequestSpendBudget(reason === 'spend_budget' ? { ...spendPolicy, limitMicros: 100, safetyMicros: 0 } : spendPolicy, () => { if (reason === 'spend_ledger_failed') throw new Error('private ledger failure'); });
    const { outcome, requests } = await scenario(undefined, { spendBudget });
    assert.equal(outcome.reason, reason); assert.equal(requests.length, 0);
    assert.equal(outcome.transport.attempts, 0); assert.equal(outcome.modelCalls, 0);
  }
});
test('B3 实际用量超过预留边界时取消后续模型请求', async () => {
  const spendBudget = new RequestSpendBudget(spendPolicy, () => {});
  const { outcome, requests } = await scenario((_body, res) => complete(res, requestsToRead, 'stop', { prompt_tokens: 1_000_000, completion_tokens: 50, total_tokens: 1_000_050 }), { spendBudget });
  assert.equal(outcome.reason, 'spend_budget'); assert.equal(requests.length, 1);
  assert.equal(outcome.candidateVersionId, undefined); assert.equal(outcome.repairAttempts, 0);
  assert.equal(spendBudget.list().length, 1);
});
