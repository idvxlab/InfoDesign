/** Real Pi SDK against a scripted loopback gateway. Not real-model design quality. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { designTaskFixture } from '../helpers/design-fixtures.ts';
import { extendedDesignTaskFixture } from '../helpers/pagespec-fixtures.ts';
import { registry, loadFixture } from '../helpers/fixtures.ts';
import { runDesignAgent } from '../../apps/server/src/agents/design/agent.ts';
import { designDraftProtocol, designPrompt, materializeDesign } from '../../apps/server/src/agents/design/context.ts';
import { createDesignTools } from '../../apps/server/src/tools/design.tools.ts';
import { DESIGN_LIMITS, ExecutionBudget } from '../../apps/server/src/runtime/pi/execution-limits.ts';
import { readModelConfig } from '../../apps/server/src/config/env.ts';
import { RequestSpendBudget } from '../../apps/server/src/runtime/pi/spend-budget.ts';
import { fingerprint } from '../../packages/contracts/src/fingerprint.ts';
import { SchemaRegistry } from '../../packages/contracts/src/schema-registry.ts';
import type { DesignInput, DocumentIr } from '../../packages/contracts/generated/index.ts';

const fixture = () => {
  const f = designTaskFixture();
  const pick = (obj: any, keys: string[]) => Object.fromEntries(keys.map(key => [key, structuredClone(obj[key])]));
  return { ...f, input: f.input as DesignInput, draft: { status: 'completed',
    informationPlan: pick(f.output.informationPlan, ['audience', 'goal', 'readerQuestions', 'sections', 'omissions', 'openIssues']),
    pageSpec: pick(f.output.pageSpec, ['state', 'root', 'actions', 'checks']) } };
};
const reads = [{ kind: 'catalog' }, ...fixture().input.snapshot.claims.map(c => ({ kind: 'claim', id: c.claimId }))];
function complete(res: ServerResponse, data: unknown, finish = 'stop') {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (delta: unknown, finish_reason: string | null) => res.write('data: ' + JSON.stringify({ id: 'design_test', object: 'chat.completion.chunk', model: 'test-model', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
  if (Array.isArray(data)) {
    chunk({ role: 'assistant', tool_calls: data.map((args, index) => ({ index, id: 'call_' + index, type: 'function', function: { name: 'read_design', arguments: JSON.stringify(args) } })) }, null);
    chunk({}, 'tool_calls');
  } else { chunk({ role: 'assistant', content: typeof data === 'string' ? data : JSON.stringify(data) }, null); chunk({}, finish); }
  res.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
}
type Handler = (body: any, res: ServerResponse, index: number) => void;
async function scenario(handler?: Handler, changes: Partial<Parameters<typeof runDesignAgent>[0]> = {}, modelOverrides: Partial<Pick<ReturnType<typeof readModelConfig>, 'provider' | 'modelId' | 'maxTokensField'>> = {}) {
  const f = fixture(), requests: any[] = [];
  const before = readdirSync(tmpdir()).filter(n => n.startsWith('tju-design-session-')).sort();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c));
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    if (handler) handler(body, res, requests.length); else complete(res, requests.length === 1 ? reads : f.draft);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const config = readModelConfig({ APP_MODEL_PROVIDER: 'design-test', APP_MODEL_ID: 'test-model', APP_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`, APP_MODEL_API_KEY: 'design-test-secret' }, { allowLoopbackHttp: true });
  try {
    const outcome = await runDesignAgent({ input: f.input, trusted: f.trusted, registry, config: { ...config, ...modelOverrides }, limits: { ...DESIGN_LIMITS, timeoutMs: 5000 }, ...changes });
    assert.equal(outcome.resourcesDisposed, true);
    assert.deepEqual(readdirSync(tmpdir()).filter(n => n.startsWith('tju-design-session-')).sort(), before);
    assert.equal(JSON.stringify(outcome).includes('design-test-secret'), false);
    return { outcome, requests };
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('design SDK: reads claims, produces a candidate, service assigns hashes and versions', async () => {
  const { outcome, requests } = await scenario();
  assert.equal(outcome.status, 'completed', JSON.stringify(outcome));
  assert.equal(outcome.modelCalls, 2); assert.equal(outcome.successfulReads, 5);
  assert.equal(outcome.output!.pageSpec!.informationPlanRef.contentHash, fingerprint(outcome.output!.informationPlan));
  assert.deepEqual(requests[0].tools.map((t: any) => t.function.name), ['read_design']);
  assert.equal(JSON.stringify(requests[0]).includes('仅用于协议校验的测试文本'), false);
  assert.ok(JSON.stringify(requests[0]).includes('Impeccable 原则适配'));
  assert.ok(JSON.stringify(requests[0]).includes('内容驱动的阅读型展示'));
  assert.equal(JSON.stringify(requests[0]).includes('concept-seed'), false);
  assert.equal(JSON.stringify(requests[1]).includes('仅用于协议校验的测试文本'), true);
  assert.ok(outcome.events.some(e => e.type === 'tool_end' && e.toolName === 'read_design' && e.ok));
  assert.equal(outcome.billedAmount, null);
});
test('design SDK 1.1: extended body survives tool execution and service materialization', async () => {
  const f=extendedDesignTaskFixture();
  const extendedReads=[{kind:'catalog'},...f.snapshot.claims.map((c:any)=>({kind:'claim',id:c.claimId})),
    {kind:'event',id:'event_start'},{kind:'relation',id:'relation_test'},{kind:'asset',id:'asset_test'}];
  const {outcome}=await scenario((_b,res,i)=>complete(res,i===1?extendedReads:f.draft),{input:f.input as DesignInput,trusted:f.trusted});
  assert.equal(outcome.status,'completed',JSON.stringify(outcome));
  assert.equal(outcome.output!.pageSpec!.protocolVersion,'1.1');
  assert.deepEqual(outcome.output!.pageSpec!.calculations,f.page.calculations);
  assert.equal(outcome.output!.pageSpec!.root.responsiveLayout!.large.type,'split');
});
test('design SDK 1.1: unqueried event and asset records cannot be submitted', async () => {
  const f=extendedDesignTaskFixture();
  const claimReads=[{kind:'catalog'},...f.snapshot.claims.map((c:any)=>({kind:'claim',id:c.claimId}))];
  const {outcome}=await scenario((_b,res,i)=>complete(res,i===1?claimReads:f.draft),{input:f.input as DesignInput,trusted:f.trusted,maxRepairRounds:0});
  assert.equal(outcome.status,'failed');assert.ok(outcome.attempts[0].issues.some(i=>i.code==='design.source_not_read'));
});
test('design SDK: independent sessions and candidate IDs', async () => {
  const a = await scenario(), b = await scenario();
  assert.notEqual(a.outcome.sessionId, b.outcome.sessionId);
  assert.notEqual(a.outcome.output!.informationPlan!.planId, b.outcome.output!.informationPlan!.planId);
  assert.equal(JSON.stringify(b.requests[0]).includes(a.outcome.sessionId!), false);
});
test('design SDK: compact protocol leaves at least 6000 output tokens after fact reads', async () => {
  for (const field of ['max_completion_tokens', 'max_tokens'] as const) {
    const overrides = { provider: 'company-gateway', modelId: 'deepseek-v4.1-flash',
      ...(field === 'max_tokens' ? { maxTokensField: field } : {}) };
    const { outcome, requests } = await scenario((_body, res, index) =>
      complete(res, index === 1 ? reads.slice(0, 1) : index === 2 ? reads.slice(1) : fixture().draft), {}, overrides);
    assert.equal(outcome.status, 'completed');
    assert.equal(requests.length, 3);
    for (const body of requests) {
      assert.equal(body.model, 'deepseek-v4.1-flash');
      assert.ok(body[field] >= 6000 && body[field] <= 8192, JSON.stringify(requests.map(r => r[field])));
      assert.equal(body[field === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'], undefined);
    }
  }
});
test('design SDK: correct-looking output without actual reads is rejected', async () => {
  const { outcome } = await scenario((_b, res) => complete(res, fixture().draft), { maxRepairRounds: 0 });
  assert.equal(outcome.reason, 'invalid_candidate');
  assert.ok(outcome.attempts[0].issues.some(i => i.code === 'design.claim_not_read'));
  assert.equal(outcome.output, undefined);
});
test('design SDK: malformed output gets at most one repair', async () => {
  const { outcome } = await scenario((_b, res, i) => complete(res, i === 1 ? reads : i === 2 ? 'not json' : fixture().draft));
  assert.equal(outcome.status, 'completed', JSON.stringify(outcome));
  assert.equal(outcome.repairAttempts, 1); assert.equal(outcome.attempts.length, 2);
  const failed = await scenario((_b, res, i) => complete(res, i === 1 ? reads : 'not json'));
  assert.equal(failed.outcome.reason, 'invalid_candidate'); assert.equal(failed.outcome.modelCalls, 3);
});
test('design SDK: truncation is never accepted or automatically repaired', async () => {
  const diagnostics: any[] = [];
  const { outcome } = await scenario((_b, res, i) => complete(res, i === 1 ? reads : fixture().draft, 'length'), {
    onDraft: draft => diagnostics.push(draft),
  });
  assert.equal(outcome.reason, 'output_truncated'); assert.equal(outcome.output, undefined); assert.equal(outcome.modelCalls, 2);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].status, 'unvalidated');
  assert.equal(diagnostics[0].stopReason, 'length');
  assert.deepEqual(JSON.parse(diagnostics[0].text), fixture().draft);
  assert.equal(JSON.stringify(outcome).includes(diagnostics[0].text), false);
});
test('design SDK: diagnostic persistence failure cannot return a successful candidate', async () => {
  const { outcome } = await scenario(undefined, { onDraft: () => { throw Error('private_path'); } });
  assert.equal(outcome.reason, 'diagnostic_failed');
  assert.equal(outcome.output, undefined);
  assert.equal(JSON.stringify(outcome).includes('private_path'), false);
});
test('design SDK: invalid input never reaches model', async () => {
  const f = fixture(); f.input.goal = 'tampered';
  const { outcome, requests } = await scenario(undefined, { input: f.input, trusted: f.trusted });
  assert.equal(outcome.reason, 'invalid_input'); assert.equal(requests.length, 0);
});
test('design SDK: model and tool budgets stop execution', async () => {
  const a = await scenario(undefined, { limits: { ...DESIGN_LIMITS, timeoutMs: 5000, maxModelCalls: 1 } });
  assert.equal(a.outcome.reason, 'model_budget'); assert.equal(a.requests.length, 1);
  const b = await scenario(undefined, { limits: { ...DESIGN_LIMITS, timeoutMs: 5000, maxToolCalls: 1 } });
  assert.equal(b.outcome.reason, 'tool_budget'); assert.equal(b.outcome.output, undefined);
});
test('design SDK: cancelled or timed out tasks dispose resources', async () => {
  const controller = new AbortController(); controller.abort();
  const a = await scenario(undefined, { signal: controller.signal });
  assert.equal(a.outcome.reason, 'cancelled'); assert.equal(a.requests.length, 0);
  const b = await scenario(() => {}, { limits: { ...DESIGN_LIMITS, timeoutMs: 150 } });
  assert.equal(b.outcome.reason, 'timeout'); assert.equal(b.outcome.output, undefined);
});
test('design SDK: controlled stop remains a stop, not a page candidate', async () => {
  const { outcome } = await scenario((_b, res, i) => complete(res, i === 1 ? [{ kind: 'catalog' }] : { status: 'blocked', stopReason: '缺少测试所需组件', requirements: [{ kind: 'component', description: '测试能力' }] }));
  assert.equal(outcome.status, 'blocked'); assert.equal(outcome.output!.pageSpec, undefined);
});
test('design SDK: provider failure is not retried or exposed', async () => {
  const { outcome, requests } = await scenario((_b, res) => { res.writeHead(429); res.end('private-provider-error'); });
  assert.equal(outcome.status, 'failed'); assert.equal(outcome.output, undefined); assert.equal(requests.length, 1);
  assert.equal(JSON.stringify(outcome).includes('private-provider-error'), false);
});
test('design SDK: context and spend limits reject before HTTP', async () => {
  const a = await scenario(undefined, { limits: { ...DESIGN_LIMITS, timeoutMs: 5000, maxContextBytes: 10 } });
  assert.equal(a.outcome.reason, 'context_budget'); assert.equal(a.requests.length, 0);
  const spendBudget = new RequestSpendBudget({ limitMicros: 1, safetyMicros: 0, inputCnyPerMillion: 1,
    outputCnyPerMillion: 1, inputTokensPerByte: 1, inputTokenOverhead: 0 }, () => {});
  const b = await scenario(undefined, { spendBudget });
  assert.equal(b.outcome.reason, 'spend_budget'); assert.equal(b.requests.length, 0);
});
test('design SDK: cancelling an in-flight request clears the session', async () => {
  const controller = new AbortController();
  const { outcome, requests } = await scenario(() => controller.abort(), { signal: controller.signal });
  assert.equal(outcome.reason, 'cancelled'); assert.equal(outcome.output, undefined); assert.equal(requests.length, 1);
});
test('design SDK: semantic binding mistakes are rejected after real reads', async () => {
  const bad = fixture().draft;
  bad.pageSpec.root.children[1].bindings.rows.items[0].entityRef.id = 'entity_product_b_placeholder';
  const { outcome } = await scenario((_b, res, i) => complete(res, i === 1 ? reads : bad), { maxRepairRounds: 0 });
  assert.equal(outcome.reason, 'invalid_candidate');
  assert.ok(outcome.attempts[0].issues.some(i => i.code === 'design.cell_mismatch'));
});
test('design context: derived draft rejects identity and permission injection', () => {
  const f = fixture(), protocol = designDraftProtocol(registry);
  const original = fingerprint(registry.get('urn:tju-mas:contracts:page-spec'));
  assert.throws(() => materializeDesign({ ...f.draft, projectId: 'project_other' }, f.input, f.trusted, protocol));
  assert.throws(() => materializeDesign({ ...f.draft, permissions: ['all'] }, f.input, f.trusted, protocol));
  assert.equal(original, fingerprint(registry.get('urn:tju-mas:contracts:page-spec')));
  assert.ok(Buffer.byteLength(designPrompt(f.input, registry, protocol.schema)) < DESIGN_LIMITS.maxContextBytes);
  const schema = JSON.parse(designPrompt(f.input, registry, protocol.schema)).schemas[0];
  const standalone = new SchemaRegistry();
  standalone.addSchema('prompt-only', schema); standalone.compile();
  assert.equal(standalone.validate(schema.$id, f.draft).valid, true);
  const invalid = structuredClone(f.draft);
  invalid.pageSpec.root.children[1].bindings.rows.items[0].cells[0].claimRef.claimVersionId = 123;
  assert.equal(standalone.validate(schema.$id, invalid).valid, false);
});
test('design tools: invalid IDs/paths denied, original unavailable is explicit', async () => {
  const f = fixture(), budget = new ExecutionBudget(DESIGN_LIMITS, undefined, 'design');
  try {
    const tools = createDesignTools(f.input, f.trusted, registry, budget);
    const execute = (params: any) => tools.tool.execute('test', params, undefined, undefined, {} as never);
    await assert.rejects(execute({ kind: 'claim', id: 'claim_foreign' }));
    await assert.rejects(execute({ kind: 'catalog', path: '/etc/passwd' }));
    await assert.rejects(execute({ kind: 'evidence', id: f.input.snapshot.evidence[0].evidenceId }), /original_evidence_unavailable/);
    assert.equal(tools.receipts.length, 0);
  } finally { budget.dispose(); }
});
test('design tools: authorized original paragraph can be read', async () => {
  const f = fixture(), doc = loadFixture<DocumentIr>('document-ir.json');
  const budget = new ExecutionBudget(DESIGN_LIMITS, undefined, 'design');
  try {
    const tools = createDesignTools(f.input, f.trusted, registry, budget, { documents: [doc], scope: {
      projectId: doc.projectId, allowedOperations: ['read_document'], documentRefs: [{ documentId: doc.documentId, documentVersionId: doc.documentVersionId }],
    } });
    const result = await tools.tool.execute('test', { kind: 'evidence', id: f.input.snapshot.evidence[0].evidenceId }, undefined, undefined, {} as never);
    assert.match(JSON.stringify(result), /original_paragraph/); assert.equal(tools.receipts.length, 1);
  } finally { budget.dispose(); }
});
