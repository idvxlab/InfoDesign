/**
 * 审查运行时的程序验证：真实 Pi SDK + 本地回环模拟网关；全部数据为合成数据。
 * 这些测试只验证运行时基础（配置边界、预算、会话隔离、线格式、拒绝时机），
 * 不代表真实模型验收，也不声称语义化审查已实现。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readModelConfig, readModelConfigFromModels } from '../../apps/server/src/config/env.ts';
import {
  B2_LIMITS, EVIDENCE_LIMITS, REVIEW_LIMITS, validateLimits,
  ExecutionBudget, type ExecutionLimits,
} from '../../apps/server/src/runtime/pi/execution-limits.ts';
import { createBusinessSession } from '../../apps/server/src/runtime/pi/session-factory.ts';
import { createDocumentReader, createReadDocumentTool, type DocumentAccess } from '../../apps/server/src/runtime/pi/read-document-tool.ts';
import type { EvidenceInput, ReadDocumentRequest } from '../../packages/contracts/generated/index.ts';
import { loadFixture, registry } from '../helpers/fixtures.ts';

const fixture = loadFixture<EvidenceInput>('evidence-input.json');
const access: DocumentAccess = { scope: fixture.scope, documents: fixture.documents };
const request: ReadDocumentRequest = { documentId: 'doc_profile', documentVersionId: 'docv_profile_1', blockId: 'b004' };
const expected = createDocumentReader(access, registry)(request);
const reviewLimits: ExecutionLimits = { ...REVIEW_LIMITS, timeoutMs: 5000 };
const syntheticKey = 'synthetic-api-key-do-not-log';

type WireMessage = { role: string; content: unknown };
type RequestBody = {
  messages: WireMessage[];
  tools: Array<{ function: { name: string } }>;
  max_tokens?: number;
  max_completion_tokens?: number;
  enable_thinking?: boolean;
  reasoning_effort?: string;
  store?: unknown;
};

function complete(res: ServerResponse, response: { text?: string; args?: unknown; toolName?: string }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (delta: unknown, finish_reason: string | null) =>
    res.write(`data: ${JSON.stringify({ id: 'synthetic_response', object: 'chat.completion.chunk', model: 'synthetic-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (response.args !== undefined) {
    chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_synthetic', type: 'function', function: { name: response.toolName ?? 'read_document', arguments: JSON.stringify(response.args) } }] }, null);
    chunk({}, 'tool_calls');
  } else {
    chunk({ role: 'assistant', content: response.text ?? JSON.stringify(expected) }, null);
    chunk({}, 'stop');
  }
  res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
  res.end('data: [DONE]\n\n');
}

async function gateway(
  handle: (body: RequestBody, res: ServerResponse, index: number) => void,
  profile?: 'bailian-off' | 'bailian-low',
  maxTokensField?: 'max_tokens' | 'max_completion_tokens',
) {
  const requests: RequestBody[] = [];
  // 每个请求独立捕获错误，避免未处理的异步服务器错误。
  const server = createServer((req, res) => {
    (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as RequestBody;
      requests.push(body);
      handle(body, res, requests.length);
    })().catch(() => { if (!res.writableEnded) res.destroy(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const env: NodeJS.ProcessEnv = {
    APP_MODEL_PROVIDER: 'b2-review', APP_MODEL_ID: 'synthetic-model',
    APP_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`, APP_MODEL_API_KEY: syntheticKey,
  };
  if (profile) env.APP_MODEL_THINKING_PROFILE = profile;
  if (maxTokensField) env.APP_MODEL_MAX_TOKENS_FIELD = maxTokensField;
  const config = readModelConfig(env, { allowLoopbackHttp: true });
  return {
    config, requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

function reviewWorkspaces(): string[] {
  return readdirSync(tmpdir()).filter(name => name.startsWith('tju-review-session-')).sort();
}

// ---------------------------------------------------------------------------
// 1. 配置：thinkingProfile 只接受两个显式值；models-config 保留显式 profile。
// ---------------------------------------------------------------------------

test('review 配置只接受 bailian-off/bailian-low/未定义，拒绝空值与无效值', () => {
  const base: NodeJS.ProcessEnv = {
    APP_MODEL_PROVIDER: 'b2-review', APP_MODEL_ID: 'synthetic-model',
    APP_MODEL_BASE_URL: 'https://example.invalid/v1', APP_MODEL_API_KEY: syntheticKey,
  };
  assert.equal(readModelConfig(base).thinkingProfile, undefined);
  assert.equal(readModelConfig({ ...base, APP_MODEL_THINKING_PROFILE: 'bailian-off' }).thinkingProfile, 'bailian-off');
  assert.equal(readModelConfig({ ...base, APP_MODEL_THINKING_PROFILE: 'bailian-low' }).thinkingProfile, 'bailian-low');
  for (const bad of ['', ' ', 'bailian-high', 'BAILIAN-OFF', 'off', 'null']) {
    assert.throws(() => readModelConfig({ ...base, APP_MODEL_THINKING_PROFILE: bad }),
      error => error instanceof Error && !error.message.includes(syntheticKey));
  }
});

test('models-config 保留显式 env profile，且不受任意 model.compat thinking 设置影响', () => {
  const env: NodeJS.ProcessEnv = {
    APP_MODEL_PROVIDER: 'b2-review', APP_MODEL_ID: 'synthetic-model',
    APP_MODEL_API_KEY: syntheticKey, APP_MODEL_THINKING_PROFILE: 'bailian-low',
  };
  const data = {
    providers: {
      'b2-review': {
        api: 'openai-completions', baseUrl: 'https://example.invalid/v1',
        models: [{
          id: 'synthetic-model',
          // 任意且不受支持的 compat 思维设置必须被忽略。
          compat: { thinkingFormat: 'openai', supportsReasoningEffort: false, maxTokensField: 'max_completion_tokens' },
        }],
      },
    },
  };
  const config = readModelConfigFromModels(env, data);
  assert.equal(config.thinkingProfile, 'bailian-low');
  assert.equal(config.maxTokensField, 'max_completion_tokens');
  // 任意 model.compat 思维开关不会泄漏进返回配置。
  assert.equal('compat' in config, false);
  // 缺失显式 env profile 时不臆造。
  assert.equal(readModelConfigFromModels({ ...env, APP_MODEL_THINKING_PROFILE: undefined }, data).thinkingProfile, undefined);
});

// ---------------------------------------------------------------------------
// 2. 预算：REVIEW_LIMITS 校验，取消与上限在副作用前生效。
// ---------------------------------------------------------------------------

test('review 预算校验 REVIEW_LIMITS：每个字段超过上限及无效数字都被拒绝', () => {
  validateLimits(reviewLimits, 'review');
  for (const key of Object.keys(REVIEW_LIMITS) as Array<keyof ExecutionLimits>) {
    for (const bad of [REVIEW_LIMITS[key] + 1, 0, -1, 2.5, NaN, Infinity, undefined]) {
      assert.throws(() => validateLimits({ ...reviewLimits, [key]: bad as number }, 'review'), /review/);
    }
  }
  // 无效 profile 被拒绝。
  assert.throws(() => validateLimits(reviewLimits, 'reviewer' as never), /invalid_execution_profile/);
});

test('三组精确不变上限：evidence 仅 output 为 16384，review 完整保持 8192，probe 原值不变', () => {
  assert.deepEqual(EVIDENCE_LIMITS, { timeoutMs: 120_000, maxModelCalls: 6, maxToolCalls: 12, maxOutputTokens: 16384, maxContextBytes: 128_000 });
  assert.deepEqual(REVIEW_LIMITS, { timeoutMs: 180_000, maxModelCalls: 6, maxToolCalls: 16, maxOutputTokens: 8192, maxContextBytes: 128_000 });
  assert.deepEqual(B2_LIMITS, { timeoutMs: 90_000, maxModelCalls: 3, maxToolCalls: 2, maxOutputTokens: 1024, maxContextBytes: 12_000 });
  // 非 output 维度 review 仍不低于 evidence（仅 output 独立定向调整）。
  for (const key of Object.keys(EVIDENCE_LIMITS) as Array<keyof ExecutionLimits>) {
    if (key === 'maxOutputTokens') continue;
    assert.ok(REVIEW_LIMITS[key] >= EVIDENCE_LIMITS[key]);
  }
  // output 维度精确断言，不允许提高 REVIEW。
  assert.equal(REVIEW_LIMITS.maxOutputTokens, 8192);
  assert.equal(EVIDENCE_LIMITS.maxOutputTokens, 16384);
  // 证据预算仍按 evidence 上限校验（回归保证）。
  validateLimits({ ...EVIDENCE_LIMITS }, 'evidence');
  // 复用 evidence 预算做 review 也不被误改语义。
  validateLimits(reviewLimits, 'review');
});

test('已取消的 review 预算在产生任何副作用前抛出 cancelled', () => {
  const controller = new AbortController();
  const budget = new ExecutionBudget(reviewLimits, controller.signal, 'review');
  try {
    controller.abort();
    assert.equal(budget.stopCode, 'cancelled');
    assert.throws(() => budget.model({ k: 1 }), /cancelled/);
    assert.throws(() => budget.model({ k: 1 }), /cancelled/);
    assert.equal(budget.modelCalls, 0); // 无任何模型调用被计数
    assert.throws(() => budget.tool(), /cancelled/);
    assert.equal(budget.toolCalls, 0);
  } finally { budget.dispose(); }
});

test('模型与工具请求上限在副作用前生效且仅计一次', () => {
  const budget = new ExecutionBudget({ ...reviewLimits, maxModelCalls: 2, maxToolCalls: 1 }, undefined, 'review');
  const toolBudget = new ExecutionBudget({ ...reviewLimits, maxModelCalls: 2, maxToolCalls: 1 }, undefined, 'review');
  try {
    budget.model({}); budget.model({});
    assert.equal(budget.modelCalls, 2);
    assert.throws(() => budget.model({}), /model_budget/);
    assert.equal(budget.modelCalls, 2); // 超限不增加计数
    toolBudget.tool();
    assert.equal(toolBudget.toolCalls, 1);
    assert.throws(() => toolBudget.tool(), /tool_budget/);
    assert.equal(toolBudget.toolCalls, 1);
  } finally { budget.dispose(); toolBudget.dispose(); }
});

// ---------------------------------------------------------------------------
// 3. review 会话：唯一 ID、空历史、只读工具、无继承资源、提示词隔离。
// ---------------------------------------------------------------------------

test('review 角色创建两次得到唯一 ID 与独立工作区，空历史且仅 read_document', async () => {
  const mock = await gateway((_body, res) => complete(res, {}));
  const budgetA = new ExecutionBudget(reviewLimits, undefined, 'review');
  const budgetB = new ExecutionBudget(reviewLimits, undefined, 'review');
  const a = await createBusinessSession(mock.config, createReadDocumentTool(access, registry, budgetA).tool, budgetA, 'review');
  const b = await createBusinessSession(mock.config, createReadDocumentTool(access, registry, budgetB).tool, budgetB, 'review');
  try {
    assert.notEqual(a.session.sessionId, b.session.sessionId);
    assert.notEqual(a.workspace, b.workspace);
    assert.deepEqual(a.session.state.messages, []);
    assert.deepEqual(b.session.state.messages, []);
    assert.deepEqual(a.session.getActiveToolNames(), ['read_document']);
    assert.deepEqual(a.session.getCallableToolNames(), ['read_document']);
    // 无加载的上下文文件、扩展、提示模板或技能。
    assert.deepEqual(a.resources, { skills: 0, contextFiles: 0, extensions: 0, prompts: 0 });
    assert.equal(mock.requests.length, 0);
    assert.equal(existsSync(a.workspace), true);
  } finally {
    await a.dispose(); await b.dispose();
    budgetA.dispose(); budgetB.dispose();
    await mock.close();
  }
  assert.equal(existsSync(a.workspace), false);
  assert.equal(existsSync(b.workspace), false);
});

test('提示一个 review 实例后其历史增长，第二个实例仍为空且工作区相互隔离', async () => {
  const mock = await gateway((_body, res) => complete(res, {}));
  const budgetA = new ExecutionBudget(reviewLimits, undefined, 'review');
  const budgetB = new ExecutionBudget(reviewLimits, undefined, 'review');
  const a = await createBusinessSession(mock.config, createReadDocumentTool(access, registry, budgetA).tool, budgetA, 'review');
  const b = await createBusinessSession(mock.config, createReadDocumentTool(access, registry, budgetB).tool, budgetB, 'review');
  try {
    await a.session.prompt('合成审查输入：仅用于测试。');
    assert.ok(a.session.state.messages.length > 0);
    assert.deepEqual(b.session.state.messages, []);
    assert.equal(mock.requests.length, 1);
  } finally {
    await a.dispose(); await b.dispose();
    budgetA.dispose(); budgetB.dispose();
    await mock.close();
  }
});

test('固定 review 提示词内容进入 system 消息，且不包含证据角色提示词', async () => {
  const mock = await gateway((_body, res) => complete(res, {}));
  const budget = new ExecutionBudget(reviewLimits, undefined, 'review');
  const a = await createBusinessSession(mock.config, createReadDocumentTool(access, registry, budget).tool, budget, 'review');
  try {
    await a.session.prompt('synthetic review test');
    const messages = mock.requests[0].messages as Array<{ role: string; content?: unknown }>;
    const system = messages.find((m) => m.role === 'system');
    assert.ok(system, 'system message expected');
    const systemText =
      typeof system.content === 'string' ? system.content : JSON.stringify(system.content);
    // 审查提示词内容存在。
    assert.match(systemText, /你是独立事实审查 Agent/);
    // 证据角色提示词特征不应出现。
    assert.doesNotMatch(systemText, /证据角色/);
  } finally {
    await a.dispose(); budget.dispose(); await mock.close();
  }
});

test('dispose 清理两个 review 会话且重复调用幂等', async () => {
  const mock = await gateway((_body, res) => complete(res, {}));
  const budgetA = new ExecutionBudget(reviewLimits, undefined, 'review');
  const budgetB = new ExecutionBudget(reviewLimits, undefined, 'review');
  const a = await createBusinessSession(mock.config, createReadDocumentTool(access, registry, budgetA).tool, budgetA, 'review');
  const b = await createBusinessSession(mock.config, createReadDocumentTool(access, registry, budgetB).tool, budgetB, 'review');
  try {
    await a.dispose(); await a.dispose();
    await b.dispose(); await b.dispose();
  } finally {
    budgetA.dispose(); budgetB.dispose(); await mock.close();
  }
  assert.equal(existsSync(a.workspace), false);
  assert.equal(existsSync(b.workspace), false);
  assert.deepEqual(reviewWorkspaces(), []);
});

// ---------------------------------------------------------------------------
// 4. 线格式：真实 SDK 经本地 mock 网关，检查 provider 接口边界。
// ---------------------------------------------------------------------------

async function runWire(profile?: 'bailian-off' | 'bailian-low', maxTokensField?: 'max_tokens' | 'max_completion_tokens') {
  const before = reviewWorkspaces();
  const mock = await gateway((_body, res, i) => complete(res, i === 1 ? { args: request } : {}), profile, maxTokensField);
  const budget = new ExecutionBudget(reviewLimits, undefined, 'review');
  const session = await createBusinessSession(mock.config, createReadDocumentTool(access, registry, budget).tool, budget, 'review');
  try {
    await session.session.prompt('合成审查输入：请读取资料块后返回 JSON。');
    return { requests: mock.requests, session, budget, mock, before };
  } catch (error) {
    await session.dispose(); budget.dispose(); await mock.close();
    throw error;
  }
}

test('bailian-off：线请求 enable_thinking:false，无 reasoning_effort/developer/store，max_tokens 受控', async () => {
  const run = await runWire('bailian-off');
  try {
    assert.ok(run.requests.length >= 1);
    for (const body of run.requests) {
      assert.equal(body.enable_thinking, false);
      assert.equal('reasoning_effort' in body, false);
      assert.equal('store' in body, false);
      assert.equal(body.messages.some(m => m.role === 'developer'), false);
      assert.equal(body.messages.some(m => m.role === 'system'), true);
      assert.equal(body.max_tokens ?? body.max_completion_tokens, reviewLimits.maxOutputTokens);
    }
  } finally { await run.session.dispose(); run.budget.dispose(); await run.mock.close(); }
  assert.deepEqual(reviewWorkspaces(), run.before);
});

test('bailian-low：线请求 enable_thinking:true 与 reasoning_effort:low，无 developer/store', async () => {
  const run = await runWire('bailian-low');
  try {
    assert.ok(run.requests.length >= 1);
    for (const body of run.requests) {
      assert.equal(body.enable_thinking, true);
      assert.equal(body.reasoning_effort, 'low');
      assert.equal('store' in body, false);
      assert.equal(body.messages.some(m => m.role === 'developer'), false);
      assert.equal(body.messages.some(m => m.role === 'system'), true);
      assert.equal(body.max_tokens ?? body.max_completion_tokens, reviewLimits.maxOutputTokens);
    }
  } finally { await run.session.dispose(); run.budget.dispose(); await run.mock.close(); }
  assert.deepEqual(reviewWorkspaces(), run.before);
});

test('未声明 profile：不发送 enable_thinking/reasoning_effort，保留既有 max token 字段', async () => {
  const run = await runWire(undefined, 'max_completion_tokens');
  try {
    assert.ok(run.requests.length >= 1);
    for (const body of run.requests) {
      assert.equal('enable_thinking' in body, false);
      assert.equal('reasoning_effort' in body, false);
      assert.equal(body.store, false);
      assert.equal(body.max_completion_tokens, reviewLimits.maxOutputTokens);
      assert.equal('max_tokens' in body, false);
    }
  } finally { await run.session.dispose(); run.budget.dispose(); await run.mock.close(); }
  assert.deepEqual(reviewWorkspaces(), run.before);
});

// ---------------------------------------------------------------------------
// 5. 拒绝时机：无效 profile/role 和已取消预算都在 HTTP 与工作区分配前拒绝。
// ---------------------------------------------------------------------------

test('无效 thinkingProfile 与无效 role 在任何 HTTP 与工作区分配前拒绝', async () => {
  const mock = await gateway((_body, res) => complete(res, {}));
  const before = reviewWorkspaces();
  const budget = new ExecutionBudget(reviewLimits, undefined, 'review');
  const tool = createReadDocumentTool(access, registry, budget).tool;
  try {
    await assert.rejects(
      () => createBusinessSession({ ...mock.config, thinkingProfile: 'bailian-high' as never }, tool, budget, 'review'),
      /unsupported_thinking_profile/,
    );
    await assert.rejects(
      () => createBusinessSession(mock.config, tool, budget, 'administrator' as never),
      /invalid_session_role/,
    );
    assert.equal(mock.requests.length, 0);
    assert.deepEqual(reviewWorkspaces(), before);
  } finally { budget.dispose(); await mock.close(); }
});

test('已取消的 review 预算在 HTTP 请求与工作区分配前拒绝', async () => {
  const mock = await gateway((_body, res) => complete(res, {}));
  const before = reviewWorkspaces();
  const controller = new AbortController();
  const budget = new ExecutionBudget(reviewLimits, controller.signal, 'review');
  try {
    controller.abort();
    await assert.rejects(
      () => createBusinessSession(mock.config, createReadDocumentTool(access, registry, budget).tool, budget, 'review'),
      /cancelled/,
    );
    assert.equal(mock.requests.length, 0);
    assert.deepEqual(reviewWorkspaces(), before);
  } finally { budget.dispose(); await mock.close(); }
});