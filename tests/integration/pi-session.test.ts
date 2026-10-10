/** B2 程序验证：真实 Pi SDK + 本地模拟网关；不访问外部模型，不代表真实模型验收。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readModelConfig, readModelConfigFromModels } from '../../apps/server/src/config/env.ts';
import { createDiagnosticFetch, type TransportDiagnostics } from '../../apps/server/src/runtime/pi/transport-diagnostics.ts';
import { B2_LIMITS, ExecutionBudget, validateLimits } from '../../apps/server/src/runtime/pi/execution-limits.ts';
import { createBusinessSession } from '../../apps/server/src/runtime/pi/session-factory.ts';
import { createDocumentReader, createReadDocumentTool, type DocumentAccess } from '../../apps/server/src/runtime/pi/read-document-tool.ts';
import { runReadProbe } from '../../apps/server/src/runtime/pi/read-probe.ts';
import type { EvidenceInput, ReadDocumentRequest } from '../../packages/contracts/generated/index.ts';
import { loadFixture, registry } from '../helpers/fixtures.ts';

const fixture = loadFixture<EvidenceInput>('evidence-input.json');
const access: DocumentAccess = { scope: fixture.scope, documents: fixture.documents };
const request: ReadDocumentRequest = { documentId: 'doc_profile', documentVersionId: 'docv_profile_1', blockId: 'b004' };
const expected = createDocumentReader(access, registry)(request);
const limits = { ...B2_LIMITS, timeoutMs: 5000 };
const syntheticKey = 'synthetic-api-key-do-not-log';

type RequestBody = { messages: Array<{ role: string; content: unknown }>; tools: Array<{ function: { name: string } }>; max_tokens?: number; max_completion_tokens?: number };
function complete(res: ServerResponse, response: { text?: string; args?: unknown; toolName?: string; usage?: boolean }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (delta: unknown, finish_reason: string | null) => res.write(`data: ${JSON.stringify({ id: 'synthetic_response', object: 'chat.completion.chunk', model: 'synthetic-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (response.args !== undefined) {
    chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_synthetic', type: 'function', function: { name: response.toolName ?? 'read_document', arguments: JSON.stringify(response.args) } }] }, null);
    chunk({}, 'tool_calls');
  } else {
    chunk({ role: 'assistant', content: response.text ?? JSON.stringify(expected) }, null);
    chunk({}, 'stop');
  }
  if (response.usage !== false) res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
  res.end('data: [DONE]\n\n');
}
async function gateway(handle: (body: RequestBody, res: ServerResponse, index: number) => void) {
  const requests: RequestBody[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as RequestBody;
    requests.push(body);
    handle(body, res, requests.length);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const config = readModelConfig({
    APP_MODEL_PROVIDER: 'b2-test', APP_MODEL_ID: 'synthetic-model',
    APP_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`, APP_MODEL_API_KEY: syntheticKey,
  }, { allowLoopbackHttp: true });
  return { config, requests, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

async function runScenario(handle: Parameters<typeof gateway>[0], changes: Partial<Parameters<typeof runReadProbe>[0]> = {}) {
  const before = readdirSync(tmpdir()).filter(name => name.startsWith('tju-b2-session-')).sort();
  const mock = await gateway(handle);
  try {
    const outcome = await runReadProbe({ config: mock.config, access, request, registry, limits, ...changes });
    assert.equal(JSON.stringify(outcome).includes(syntheticKey), false);
    assert.equal(outcome.resourcesDisposed, true);
    assert.deepEqual(readdirSync(tmpdir()).filter(name => name.startsWith('tju-b2-session-')).sort(), before);
    return { outcome, requests: mock.requests };
  } finally { await mock.close(); }
}

test('B2 配置拒绝缺凭据、无效 URL、URL 凭据与任意 HTTP，错误不含密钥', () => {
  const env = { APP_MODEL_PROVIDER: 'test', APP_MODEL_ID: 'model', APP_MODEL_BASE_URL: 'https://example.invalid/v1', APP_MODEL_API_KEY: syntheticKey };
  assert.equal(readModelConfig(env).modelId, 'model');
  for (const mutation of [
    { APP_MODEL_API_KEY: '' }, { APP_MODEL_BASE_URL: 'not-a-url' },
    { APP_MODEL_BASE_URL: 'https://user:secret@example.invalid/v1' },
    { APP_MODEL_BASE_URL: 'http://127.0.0.1:9000/v1' },
  ]) assert.throws(() => readModelConfig({ ...env, ...mutation }), error => error instanceof Error && !error.message.includes(syntheticKey));
});

test('B2 预算拒绝零、负数、非整数、非有限值、缺失和超过上限', () => {
  for (const bad of [0, -1, 1.5, NaN, Infinity, undefined, B2_LIMITS.maxModelCalls + 1]) {
    assert.throws(() => validateLimits({ ...limits, maxModelCalls: bad as number }));
  }
});

test('B2 读工具检查项目、资料版本、块、操作权限和未知字段，输入变化不修改授权快照', () => {
  const data = structuredClone(access);
  const read = createDocumentReader(data, registry);
  data.scope.allowedOperations.length = 0;
  assert.deepEqual(read(request), expected);
  for (const bad of [
    { ...request, documentId: 'doc_other' }, { ...request, documentVersionId: 'docv_other' },
    { ...request, blockId: 'b999' }, { ...request, path: '/etc/passwd' },
    { ...request, projectId: 'project_tju_demo' }, null,
  ]) assert.throws(() => read(bad));
  const foreign = structuredClone(access); foreign.scope.projectId = 'project_other';
  assert.throws(() => createDocumentReader(foreign, registry)(request), /document_access_denied/);
  const denied = structuredClone(access); denied.scope.allowedOperations = [];
  assert.throws(() => createDocumentReader(denied, registry)(request));
  const signal = AbortSignal.abort();
  assert.throws(() => read(request, signal));
});

test('B2 注册表可校验公共定义片段，作用域缺字段会被拒绝', () => {
  const id = 'urn:tju-mas:contracts:common#/$defs/scope';
  assert.equal(registry.validate(id, fixture.scope).valid, true);
  assert.equal(registry.validate(id, {}).valid, false);
  assert.throws(() => registry.validate('urn:tju-mas:contracts:common#/$defs/missing', {}));
});

test('B2 会话独立、只有授权工具、无开发资源，正常关闭清理临时目录', async () => {
  const mock = await gateway((_body, res) => complete(res, {}));
  const firstBudget = new ExecutionBudget(limits);
  const secondBudget = new ExecutionBudget(limits);
  const a = await createBusinessSession(mock.config, createReadDocumentTool(access, registry, firstBudget).tool, firstBudget);
  const b = await createBusinessSession(mock.config, createReadDocumentTool(access, registry, secondBudget).tool, secondBudget);
  try {
    assert.notEqual(a.session.sessionId, b.session.sessionId);
    assert.deepEqual(a.session.state.messages, []);
    assert.deepEqual(b.session.state.messages, []);
    assert.deepEqual(a.session.getActiveToolNames(), ['read_document']);
    assert.deepEqual(a.session.getCallableToolNames(), ['read_document']);
    assert.deepEqual(a.resources, { skills: 0, contextFiles: 0, extensions: 0, prompts: 0 });
    assert.equal(mock.requests.length, 0);
    const auth = join(a.workspace, 'auth.json');
    if (existsSync(auth)) assert.equal(readFileSync(auth, 'utf8').includes(syntheticKey), false);
  } finally {
    await a.dispose(); await b.dispose(); firstBudget.dispose(); secondBudget.dispose(); await mock.close();
  }
  assert.equal(existsSync(a.workspace), false);
  assert.equal(existsSync(b.workspace), false);
});

test('B2 真实 SDK 经模拟网关执行工具，再通过输出及依据校验', async () => {
  const { outcome, requests } = await runScenario((_body, res, i) => complete(res, i === 1 ? { args: request } : {}));
  assert.equal(outcome.status, 'completed', JSON.stringify(outcome));
  assert.deepEqual(outcome.result, expected);
  assert.equal(outcome.modelCalls, 2);
  assert.equal(outcome.toolCalls, 1);
  assert.equal(outcome.successfulReads, 1);
  assert.ok(outcome.events.some(e => e.type === 'tool_end' && e.ok));
  assert.deepEqual(outcome.usage, { input: 200, output: 40, cacheRead: 0, cacheWrite: 0 });
  assert.equal(outcome.usageReportedResponses, 2);
  assert.equal(outcome.usageUnreportedResponses, 0);
  assert.equal(outcome.billedAmount, null);
  assert.deepEqual(outcome.transport, { attempts: 2, httpStatuses: [200, 200], failureCodes: [] });
  for (const body of requests) {
    assert.deepEqual(body.tools.map(t => t.function.name), ['read_document']);
    assert.equal(body.max_tokens ?? body.max_completion_tokens, limits.maxOutputTokens);
  }
});

test('B2 模型未调用工具即使给出正确 JSON 也不能通过', async () => {
  const { outcome } = await runScenario((_body, res) => complete(res, {}));
  assert.equal(outcome.reason, 'no_tool_call');
});

test('B2 越权工具调用不能读取资料或凭最终 JSON 冒充成功', async () => {
  const { outcome } = await runScenario((_body, res, i) => complete(res, i === 1 ? { args: { ...request, documentVersionId: 'docv_other' } } : {}));
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.successfulReads, 0);
  assert.ok(outcome.events.some(e => e.type === 'tool_end' && !e.ok));
});

test('B2 非法输出和无依据输出分别拒绝', async () => {
  for (const [text, reason] of [['not json', 'invalid_output'], [JSON.stringify({ ...expected, text: '伪造的原文' }), 'evidence_mismatch']] as const) {
    const { outcome } = await runScenario((_body, res, i) => complete(res, i === 1 ? { args: request } : { text }));
    assert.equal(outcome.reason, reason);
  }
});

test('B2 请求前限制模型次数，不额外重试', async () => {
  const { outcome, requests } = await runScenario((_body, res) => complete(res, { args: request }), { limits: { ...limits, maxModelCalls: 1 } });
  assert.equal(outcome.reason, 'model_budget');
  assert.equal(outcome.modelCalls, 1);
  assert.equal(requests.length, 1);
  assert.equal(outcome.successfulReads, 1);
});

test('B2 工具次数上限阻止额外执行', async () => {
  const { outcome } = await runScenario((_body, res) => complete(res, { args: request }), { limits: { ...limits, maxToolCalls: 1 } });
  assert.equal(outcome.reason, 'tool_budget');
  assert.equal(outcome.toolCalls, 1);
  assert.equal(outcome.successfulReads, 1);
});

test('B2 上下文超限在 HTTP 请求前停止', async () => {
  const { outcome, requests } = await runScenario((_body, res) => complete(res, {}), { limits: { ...limits, maxContextBytes: 1 } });
  assert.equal(outcome.reason, 'context_budget');
  assert.equal(requests.length, 0);
  assert.equal(outcome.transport.attempts, 0);
});

test('B2 超时取消在途请求并清理', async () => {
  const { outcome } = await runScenario(() => {}, { limits: { ...limits, timeoutMs: 500 } });
  assert.equal(outcome.reason, 'timeout');
  assert.ok(outcome.elapsedMs < 3000);
});

test('B2 外部取消与预先取消都停止执行', async () => {
  const controller = new AbortController();
  const { outcome } = await runScenario(() => controller.abort(), { signal: controller.signal });
  assert.equal(outcome.reason, 'cancelled');
  const pre = await runScenario((_body, res) => complete(res, {}), { signal: AbortSignal.abort() });
  assert.equal(pre.outcome.reason, 'cancelled');
  assert.equal(pre.requests.length, 0);
});

test('B2 网关错误明确失败，不打印原始错误或重试', async () => {
  const { outcome, requests } = await runScenario((_body, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `sensitive ${syntheticKey}` } }));
  });
  assert.equal(outcome.reason, 'provider_failed');
  assert.equal(requests.length, 1);
  assert.deepEqual(outcome.transport, { attempts: 1, httpStatuses: [500], failureCodes: [] });
});

test('B2 未报告用量时保留未知，不显示免费', async () => {
  const { outcome } = await runScenario((_body, res, i) => complete(res, i === 1 ? { args: request, usage: false } : { usage: false }));
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.usage, null);
  assert.equal(outcome.usageReportedResponses, 0);
  assert.equal(outcome.usageUnreportedResponses, 2);
  assert.equal(outcome.billedAmount, null);
});

test('B2 部分响应缺少用量时显式标记缺口，不把已知小计当作全部用量', async () => {
  const { outcome } = await runScenario((_body, res, i) => complete(res, i === 1 ? { args: request } : { usage: false }));
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(outcome.usage, { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 });
  assert.equal(outcome.usageReportedResponses, 1);
  assert.equal(outcome.usageUnreportedResponses, 1);
  assert.equal(outcome.billedAmount, null);
});


test('B2 CLI 默认关闭真实模型调用', () => {
  const result = spawnSync(process.execPath, ['apps/server/src/entrypoints/b2-probe.ts'], {
    cwd: new URL('../../', import.meta.url), encoding: 'utf8',
    env: { ...process.env, APP_RUN_LIVE_EVAL: '0' },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /真实验收未启用/);
  assert.equal(result.stdout, '');
});

test('B2 模型请求内置 bash 工具时不会获得执行能力', async () => {
  const { outcome } = await runScenario((_body, res, i) => complete(res, i === 1
    ? { toolName: 'bash', args: { command: 'printf forbidden' } } : {}));
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.successfulReads, 0);
  assert.equal(outcome.toolCalls, 0);
  assert.ok(outcome.events.some(e => e.type === 'tool_end' && !e.ok));
});

test('B2 显式模型选择保留 maxTokensField，模型级优先且配置不读取密钥或命令', () => {
  const env = { APP_MODEL_PROVIDER: 'company-gateway', APP_MODEL_ID: 'deepseek-v4.1-flash', APP_MODEL_API_KEY: syntheticKey };
  const provider = { baseUrl: 'https://example.invalid/v1', api: 'openai-completions', apiKey: '!must-not-execute',
    compat: { maxTokensField: 'max_tokens' }, models: [{ id: env.APP_MODEL_ID }] };
  const data = { providers: { 'company-gateway': provider } };
  const config = readModelConfigFromModels(env, data);
  assert.equal(config.maxTokensField, 'max_tokens');
  assert.equal(config.apiKey, syntheticKey);
  assert.equal(config.baseUrl, provider.baseUrl);
  const override = { providers: { 'company-gateway': { ...provider,
    models: [{ id: env.APP_MODEL_ID, compat: { maxTokensField: 'max_completion_tokens' } }],
  } } };
  assert.equal(readModelConfigFromModels(env, override).maxTokensField, 'max_completion_tokens');
  for (const bad of ['', 'unsupported', syntheticKey]) {
    const invalid = structuredClone(data); invalid.providers['company-gateway'].compat.maxTokensField = bad;
    assert.throws(() => readModelConfigFromModels(env, invalid), error => error instanceof Error && !error.message.includes(syntheticKey));
  }
  assert.throws(() => readModelConfigFromModels({ ...env, APP_MODEL_ID: 'missing' }, data));
  assert.throws(() => readModelConfigFromModels({ ...env, APP_MODEL_API_KEY: '' }, data));
});

test('B2 从 models 配置到实际请求保留 max_tokens，不再发送不兼容字段', async () => {
  const mock = await gateway((body, res, i) => {
    if (body.max_tokens !== 1024 || body.max_completion_tokens !== undefined) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'local fixture requires max_tokens' } }));
    } else complete(res, i === 1 ? { args: request } : {});
  });
  try {
    const config = readModelConfigFromModels({ APP_MODEL_PROVIDER: 'company-gateway', APP_MODEL_ID: 'deepseek-v4.1-flash', APP_MODEL_API_KEY: syntheticKey }, {
      providers: { 'company-gateway': { baseUrl: mock.config.baseUrl, api: 'openai-completions', compat: { maxTokensField: 'max_tokens' }, models: [{ id: 'deepseek-v4.1-flash' }] } },
    }, { allowLoopbackHttp: true });
    const outcome = await runReadProbe({ config, access, request, registry, limits });
    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.toolCalls, 1);
    assert.equal(outcome.resourcesDisposed, true);
    assert.equal(mock.requests.length, 2);
    assert.deepEqual(outcome.transport, { attempts: 2, httpStatuses: [200, 200], failureCodes: [] });
  } finally { await mock.close(); }
});

test('B2 传输诊断只保留固定错误码和状态，不读取响应正文或输出原始异常', async () => {
  const diagnostics: TransportDiagnostics = { attempts: 0, httpStatuses: [], failureCodes: [] };
  const response = new Response(`private ${syntheticKey}`, { status: 403 });
  const returned = await createDiagnosticFetch(async () => response, diagnostics)('https://example.invalid');
  assert.equal(returned, response);
  assert.equal(returned.bodyUsed, false);
  for (const [error, expectedCode] of [
    [new Error(`private ${syntheticKey}`, { cause: { code: 'ENOTFOUND', message: syntheticKey } }), 'ENOTFOUND'],
    [Object.assign(new Error(syntheticKey), { code: syntheticKey }), 'unknown'],
    [new DOMException(syntheticKey, 'AbortError'), 'aborted'],
  ] as const) {
    const fetch = createDiagnosticFetch(async () => { throw error; }, diagnostics);
    await assert.rejects(fetch('https://example.invalid'), actual => actual === error);
    assert.equal(diagnostics.failureCodes.at(-1), expectedCode);
  }
  assert.deepEqual(diagnostics.httpStatuses, [403]);
  assert.equal(diagnostics.attempts, 4);
  assert.equal(JSON.stringify(diagnostics).includes(syntheticKey), false);
});

test('B2 保留拒绝与限流 HTTP 状态但不泄漏响应内容，不自动重试', async () => {
  for (const status of [401, 429]) {
    const { outcome, requests } = await runScenario((_body, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `private ${syntheticKey}` } }));
    });
    assert.equal(outcome.reason, 'provider_failed');
    assert.equal(requests.length, 1);
    assert.deepEqual(outcome.transport, { attempts: 1, httpStatuses: [status], failureCodes: [] });
  }
});
