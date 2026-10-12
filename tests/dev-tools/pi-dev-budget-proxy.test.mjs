import { test } from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { startBudgetProxy, DEV_POLICY, resolveAuthorizedPolicy, validateCumulativeConfig, AUTHORIZED_LIMITS, CUMULATIVE_LIMITS } from '../../scripts/pi-dev-budget-proxy.mjs';
import { RequestSpendBudget } from '../../apps/server/src/runtime/pi/spend-budget.ts';

const payload = { model: 'test-model', messages: [{ role: 'user', content: 'Only synthetic code fixture' }], stream: true, max_tokens: 999999 };
const send = (gate, data = payload, key = 'client-token') => fetch(gate.address, {
  method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(data) });
const options = extra => ({ upstreamUrl: 'https://mock.invalid/v1/chat/completions', model: 'test-model',
  apiKey: 'upstream-secret', clientToken: 'client-token', persist: () => {}, ...extra });
const ok = () => new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });

test('Pi HTTP request is reserved before forwarding, output is capped, credentials stay at gate', async () => {
  let saved, calls = 0;
  const gate = await startBudgetProxy(options({ persist: s => { saved = structuredClone(s); }, fetchImpl: async (_url, init) => {
    calls++; assert.equal(saved.records.length, 1); assert.equal(saved.attempts.length, 1);
    assert.equal(init.headers.authorization, 'Bearer upstream-secret'); assert.equal(init.redirect, 'error');
    assert.equal(JSON.parse(init.body).max_tokens, 4096); return ok();
  } }));
  try { const response = await send(gate); assert.equal(response.status, 200); await response.text();
    assert.equal(calls, 1); assert.equal(saved.reservedMicros, saved.records[0].reservedMicros);
    assert.equal(JSON.stringify(saved).includes('secret'), false);
  } finally { await gate.close(); }
});
test('insufficient money prevents first upstream request', async () => {
  let calls = 0;
  const gate = await startBudgetProxy(options({ policy: { ...DEV_POLICY, limitMicros: 100, safetyMicros: 0 }, fetchImpl: async () => { calls++; return ok(); } }));
  try { assert.equal((await send(gate)).status, 429); assert.equal(calls, 0); assert.equal(gate.state().stopReason, 'spend_budget'); }
  finally { await gate.close(); }
});
test('reservation persistence failure prevents upstream and latches stop', async () => {
  let writes = 0, calls = 0;
  const gate = await startBudgetProxy(options({ persist: () => { if (++writes > 1) throw Error('disk'); }, fetchImpl: async () => { calls++; return ok(); } }));
  try { assert.equal((await send(gate)).status, 429); assert.equal((await send(gate)).status, 429); assert.equal(calls, 0); }
  finally { await gate.close(); }
});
test('initial ledger failure opens no server', async () => {
  await assert.rejects(startBudgetProxy(options({ persist: () => { throw Error('disk'); } })));
});
test('no hidden retries: upstream failure stops all later requests and keeps full reservation', async () => {
  let calls = 0;
  const gate = await startBudgetProxy(options({ fetchImpl: async () => { calls++; return new Response('private', { status: 429 }); } }));
  try { const first = await send(gate); assert.equal(first.status, 502); assert.equal((await first.text()).includes('private'), false);
    assert.equal((await send(gate)).status, 429); assert.equal(calls, 1); assert.ok(gate.state().reservedMicros > 0);
  } finally { await gate.close(); }
});
test('request count limit prevents next paid request; no usage never releases reservations', async () => {
  let calls = 0;
  const gate = await startBudgetProxy(options({ maxCalls: 1, fetchImpl: async () => { calls++; return ok(); } }));
  try { await (await send(gate)).text(); const reserved = gate.state().reservedMicros;
    assert.equal((await send(gate)).status, 429); assert.equal(calls, 1); assert.equal(gate.state().reservedMicros, reserved);
  } finally { await gate.close(); }
});
test('timeout aborts in-flight transport and prevents subsequent upstream calls', async () => {
  let calls = 0, aborted = false;
  const gate = await startBudgetProxy(options({ timeoutMs: 50, fetchImpl: async (_url, init) => { calls++;
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(Error('abort')); }, { once: true }));
  } }));
  try { await send(gate); assert.ok(aborted); assert.equal(gate.state().stopReason, 'timeout');
    assert.equal((await send(gate)).status, 429); assert.equal(calls, 1);
  } finally { await gate.close(); }
});
test('unauthorized, image and wrong model requests never forward', async () => {
  for (const [body,key] of [[payload,'wrong'],[{ ...payload, model:'wrong' },'client-token'],
    [{ ...payload, messages:[{role:'user',content:[{type:'image_url',image_url:{url:'fake'}}]}] },'client-token']]) {
    let calls=0; const gate=await startBudgetProxy(options({fetchImpl:async()=>{calls++;return ok();}}));
    try { assert.notEqual((await send(gate,body,key)).status,200); assert.equal(calls,0); } finally {await gate.close();}
  }
});


for (const bailian of [false, true, 'low']) test(`real Pi CLI writes through an offline gate (Bailian thinking-off=${bailian})`, async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawn } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'pi-budget-smoke-'));
  let calls = 0;
  const gate = await startBudgetProxy(options({ maxCalls: 2, fetchImpl: async (_url, init) => {
    const sent = JSON.parse(init.body);
    if (bailian) { assert.equal(sent.enable_thinking, bailian === 'low'); assert.equal(sent.thinking, undefined); assert.equal(sent.reasoning_effort, bailian === 'low' ? 'low' : undefined); assert.equal(sent.messages[0].role, 'system'); assert.equal(sent.store, undefined); }
    const index = calls++;
    const delta = index === 0 ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_smoke', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'smoke.txt', content: 'synthetic Pi write' }) } }] } : { role: 'assistant', content: 'Finished.' };
    const chunk = { id: 'smoke', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason: null }] };
    const end = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: index === 0 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } }));
  let child;
  try {
    await writeFile(join(dir, 'models.json'), JSON.stringify({ providers: { 'budget-smoke': { baseUrl: gate.address.replace('/chat/completions', ''), api: 'openai-completions', apiKey: 'client-token', models: [{ id: 'test-model', name: 'test-model', reasoning: !!bailian, ...(bailian ? { compat: { thinkingFormat: 'qwen', supportsReasoningEffort: true, supportsDeveloperRole: false, supportsStore: false } } : {}), input: ['text'], contextWindow: 32768, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } }, compaction: { enabled: false }, cacheWarming: 'off', enableAnalytics: false, enableInstallTelemetry: false, packages: [], extensions: [], skills: [], prompts: [], enableSkillCommands: false, images: { blockImages: true } }));
    child = spawn('pi', ['--print', '--mode', 'json', '--offline', '--provider', 'budget-smoke', '--model', 'test-model', '--thinking', bailian === 'low' ? 'low' : 'off', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--no-approve', '--tools', 'write', '--system-prompt', 'Use the allowed tool to write the synthetic smoke file.', 'Write smoke.txt'], { cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    const [code] = await once(child, 'exit'); clearTimeout(timer);
    assert.equal(code, 0, output.slice(-2500));
    assert.equal(await readFile(join(dir, 'smoke.txt'), 'utf8'), 'synthetic Pi write');
    assert.equal(calls, 2); assert.equal(gate.state().records.length, 2); assert.ok(gate.state().reservedMicros > 0);
  } finally { if (child && child.exitCode === null) child.kill('SIGKILL'); await gate.close(); await rm(dir, { recursive: true, force: true }); }
});


test('explicit ten-yuan task policy reserves cumulatively; default remains two and larger limits are rejected', async () => {
  assert.equal(DEV_POLICY.limitMicros, 2_000_000);
  await assert.rejects(startBudgetProxy(options({ policy: { ...DEV_POLICY, limitMicros: 100_000_001 } })), /invalid_dev_budget_configuration/);
  let calls = 0;
  const gate = await startBudgetProxy(options({ policy: { ...DEV_POLICY, limitMicros: 10_000_000, safetyMicros: 1_000_000 }, fetchImpl: async () => { calls++; return ok(); } }));
  const large = { ...payload, messages: [{ role: 'user', content: 'x'.repeat(120000) }] };
  try {
    for (let i = 0; i < 5; i++) assert.equal((await send(gate, large)).status, 200);
    assert.equal(calls, 5); assert.ok(gate.state().reservedMicros > 2_000_000);
    assert.ok(gate.state().reservedMicros < 9_000_000);
    assert.equal(gate.state().policy.safetyMicros, 1_000_000);
  } finally { await gate.close(); }
});


test('cumulative reservations survive a new task; exhausted or tampered history cannot spend again', async () => {
  let saved;
  const first = await startBudgetProxy(options({ persist: state => { saved = structuredClone(state); }, fetchImpl: async () => ok() }));
  await (await send(first)).text(); await first.close();
  const prior = saved.records;
  let calls = 0;
  const next = await startBudgetProxy(options({ previousReservations: prior, policy: { ...DEV_POLICY, limitMicros: prior[0].reservedMicros + 1, safetyMicros: 0 }, fetchImpl: async () => { calls++; return ok(); } }));
  try { assert.equal((await send(next)).status, 429); assert.equal(calls, 0); assert.equal(next.state().reservedMicros, prior[0].reservedMicros); }
  finally { await next.close(); }
  const tampered = structuredClone(prior); tampered[0].reservedMicros--;
  await assert.rejects(startBudgetProxy(options({ previousReservations: tampered })), /invalid_spend_history/);
});


test('upstream diagnostics are bounded, redacted and never cause a retry', async () => {
  const gate = await startBudgetProxy(options({ fetchImpl: async () => new Response(JSON.stringify({error:{code:'invalid_parameter',param:'thinking',message:'unsupported upstream-secret sk-example-secret',private:'do not keep'}}), {status:400}) }));
  try { assert.equal((await send(gate)).status,502); const d=gate.state().attempts[0].diagnostic;
    assert.equal(d.param,'thinking'); assert.equal(d.message.includes('secret'),false); assert.equal(d.private,undefined);
    assert.equal((await send(gate)).status,429);
  } finally { await gate.close(); }
});


test('SSE terminal framing completes before a delayed upstream EOF, preserving full reservation', async () => {
  let cancelled = false;
  const gate = await startBudgetProxy(options({ fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: [DO')); setTimeout(() => controller.enqueue(new TextEncoder().encode('NE]\n\n')), 10); },
    cancel() { cancelled = true; }
  })) }));
  try { const response = await send(gate); assert.equal(await response.text(), 'data: [DONE]\n\n');
    assert.equal(gate.state().stopReason, null); assert.equal(gate.state().attempts[0].completed, true);
    assert.ok(gate.state().reservedMicros > 0); assert.ok(cancelled);
    assert.equal((await send(gate)).status, 200);
  } finally { await gate.close(); }
});

test('premature SSE EOF cannot be marked completed or release its reservation', async () => {
  const gate = await startBudgetProxy(options({ fetchImpl: async () => new Response('data: {}\n\n') }));
  try { await send(gate).then(response => response.text()).catch(() => {});
    assert.equal(gate.state().attempts[0].completed, false); assert.ok(gate.state().stopReason);
    assert.ok(gate.state().reservedMicros > 0); assert.equal((await send(gate)).status, 429);
  } finally { await gate.close(); }
});


test('per-request timeout ends a stalled response before the whole task deadline and keeps reservation', async () => {
  let calls = 0;
  const gate = await startBudgetProxy(options({ requestTimeoutMs: 25, fetchImpl: async (_url, init) => {
    calls++; return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Error('abort')), { once: true }));
  } }));
  try { assert.equal((await send(gate)).status, 502); assert.equal(gate.state().stopReason, 'upstream_timeout');
    assert.equal((await send(gate)).status, 429); assert.equal(calls, 1); assert.ok(gate.state().reservedMicros > 0);
  } finally { await gate.close(); }
});


test('trusted business profile permits only controlled source tools; default coding profile cannot widen it', async () => {
  for (const [profile, name, accepted] of [['coding', 'read_source', false], ['business', 'read_source', true], ['business', 'read_document', true], ['business', 'bash', false]]) {
    let calls = 0;
    const gate = await startBudgetProxy(options({ toolProfile: profile, fetchImpl: async () => { calls++; return ok(); } }));
    try { const response = await send(gate, { ...payload, tools: [{ type: 'function', function: { name, parameters: {} } }] });
      await response.text(); assert.equal(response.status === 200, accepted); assert.equal(calls, accepted ? 1 : 0);
    } finally { await gate.close(); }
  }
  await assert.rejects(startBudgetProxy(options({ toolProfile: 'unrestricted' })), /invalid_dev_budget_configuration/);
});

test('larger trusted coding context is still bounded and reserved before forwarding', async () => {
  let calls = 0;
  const gate = await startBudgetProxy(options({ maxBodyBytes: 256000, fetchImpl: async () => { calls++; assert.ok(gate.state().records[0].contextBytes > 190000); return ok(); } }));
  try { const response = await send(gate, { ...payload, messages: [{ role: 'user', content: 'x'.repeat(200000) }] });
    await response.text(); assert.equal(response.status, 200); assert.equal(calls, 1); assert.ok(gate.state().reservedMicros > 800000);
  } finally { await gate.close(); }
  await assert.rejects(startBudgetProxy(options({ maxBodyBytes: 256001 })), /invalid_dev_budget_configuration/);
});


test('trusted pacing delays subsequent forwarding without adding a model retry', async () => {
  const starts = [];
  const gate = await startBudgetProxy(options({ minRequestIntervalMs: 40, fetchImpl: async () => { starts.push(Date.now()); return ok(); } }));
  try { await (await send(gate)).text(); await (await send(gate)).text();
    assert.equal(starts.length, 2); assert.ok(starts[1] - starts[0] >= 30); assert.equal(gate.state().records.length, 2);
  } finally { await gate.close(); }
});


test('transport failures retain only fixed safe codes, keep reservation and never retry', async () => {
  let calls = 0, saved;
  const gate = await startBudgetProxy(options({ persist: s => { saved = structuredClone(s); }, fetchImpl: async () => {
    calls++; throw new Error('private upstream-secret', { cause: Object.assign(new Error('private URL and payload'), { code: 'ECONNRESET' }) });
  } }));
  try {
    assert.equal((await send(gate)).status, 502);
    assert.deepEqual(saved.attempts[0].transport, { attempts: 1, httpStatuses: [], failureCodes: ['ECONNRESET'] });
    assert.equal(saved.stopReason, 'request_failed');
    assert.equal(saved.attempts[0].completed, false);
    assert.ok(saved.reservedMicros > 0);
    assert.equal(JSON.stringify(saved).includes('private'), false);
    assert.equal(JSON.stringify(saved).includes('secret'), false);
    assert.equal((await send(gate)).status, 429); assert.equal(calls, 1);
  } finally { await gate.close(); }
});

// --- New tests for cumulative authorization (budgetcap200) ---

// Build real, valid previous records via the production budget implementation.
const realRecords = (policy, requests, persistCapture) => {
  const records = [];
  const budget = new RequestSpendBudget(policy, next => { records.splice(0, records.length, ...next); if (persistCapture) persistCapture(records); });
  for (const [contextBytes, outputTokens] of requests) budget.reserve(contextBytes, outputTokens);
  return structuredClone(records);
};

test('resolveAuthorizedPolicy maps allowed caps to exact frozen safeties', () => {
  assert.deepEqual(AUTHORIZED_LIMITS, { 2000000: 200000, 10000000: 1000000, 100000000: 10000000, 200000000: 10000000, 300000000: 10000000, 400000000: 10000000 });
  assert.deepEqual(CUMULATIVE_LIMITS, [100000000, 200000000, 300000000, 400000000]);
  for (const [limitMicros, safetyMicros] of Object.entries(AUTHORIZED_LIMITS)) {
    const policy = resolveAuthorizedPolicy(Number(limitMicros));
    assert.equal(policy.limitMicros, Number(limitMicros));
    assert.equal(policy.safetyMicros, safetyMicros);
    assert.ok(Object.isFrozen(policy));
    assert.deepEqual({ ...policy, limitMicros: 0, safetyMicros: 0 }, { ...DEV_POLICY, limitMicros: 0, safetyMicros: 0 });
  }
});

test('resolveAuthorizedPolicy rejects unlisted and non-integer caps', () => {
  assert.throws(() => resolveAuthorizedPolicy(100000001), /invalid_authorized_limit/);
  assert.throws(() => resolveAuthorizedPolicy(500000000), /invalid_authorized_limit/);
  assert.throws(() => resolveAuthorizedPolicy(Number.NaN), /invalid_authorized_limit/);
});

test('cumulative caps 100m, 200m, 300m and 400m all require a configured ledger', () => {
  for (const limitMicros of CUMULATIVE_LIMITS) {
    const policy = resolveAuthorizedPolicy(limitMicros);
    assert.throws(() => validateCumulativeConfig({}, policy, null), /cumulative_ledger_required/);
    assert.throws(() => validateCumulativeConfig({ totalLedgerPath: '/l.json' }, policy, null), /cumulative_ledger_required/);
    assert.equal(validateCumulativeConfig({ totalLedgerPath: '/l.json', authorizationId: 'a' }, policy, null).previousReservations.length, 0);
  }
});

test('saved 100m ledger is refused under a new 200m task without reset', () => {
  const oldPolicy = resolveAuthorizedPolicy(100000000);
  const records = realRecords(oldPolicy, [[10, 100]]);
  const stored = { authorizationId: 'task-100', policy: oldPolicy, records, reservedMicros: records.reduce((n, r) => n + r.reservedMicros, 0) };
  const newPolicy = resolveAuthorizedPolicy(200000000);
  assert.throws(() => validateCumulativeConfig({ totalLedgerPath: '/l.json', authorizationId: 'task-200' }, newPolicy, stored), /cumulative_authorization_mismatch/);
  // Same records under the matching authorizationId still validate and are preserved exactly.
  const same = validateCumulativeConfig({ totalLedgerPath: '/l.json', authorizationId: 'task-100' }, oldPolicy, stored);
  assert.deepEqual(same.previousReservations, records);
});

test('malformed records and wrong saved totals are refused', () => {
  const policy = resolveAuthorizedPolicy(100000000);
  const records = realRecords(policy, [[10, 100]]);
  const good = { authorizationId: 'a', policy, records, reservedMicros: records[0].reservedMicros };
  assert.equal(validateCumulativeConfig({ totalLedgerPath: '/l.json', authorizationId: 'a' }, policy, good).previousReservations.length, 1);
  assert.throws(() => validateCumulativeConfig({ totalLedgerPath: '/l.json', authorizationId: 'a' }, policy, { ...good, records: [{ sequence: 1, contextBytes: 10, requestedOutputTokens: 100, reservedInputTokens: 1, reservedMicros: 999999 }] }), /cumulative_authorization_mismatch/);
  assert.throws(() => validateCumulativeConfig({ totalLedgerPath: '/l.json', authorizationId: 'a' }, policy, { ...good, reservedMicros: records[0].reservedMicros + 1 }), /cumulative_authorization_mismatch/);
  assert.throws(() => validateCumulativeConfig({ totalLedgerPath: '/l.json', authorizationId: 'a' }, policy, { ...good, reservedMicros: 1.5 }), /cumulative_authorization_mismatch/);
  assert.throws(() => validateCumulativeConfig({ totalLedgerPath: '/l.json', authorizationId: 'a' }, policy, { ...good, records: 'nope' }), /cumulative_authorization_mismatch/);
});

test('proxy accepts an additional call and retains old records in order', async () => {
  const policy = resolveAuthorizedPolicy(100000000);
  const previous = realRecords(policy, [[10, 100], [20, 200]]);
  const snapshots = [];
  let calls = 0;
  const gate = await startBudgetProxy(options({ policy, previousReservations: previous, persist: s => snapshots.push(structuredClone(s)), fetchImpl: async () => { calls++; return ok(); } }));
  try {
    const response = await send(gate); assert.equal(response.status, 200); await response.text();
    assert.equal(calls, 1);
    const saved = snapshots.at(-1);
    assert.equal(saved.records.length, 3);
    assert.deepEqual(saved.records.slice(0, 2), previous);
    assert.equal(saved.records[2].sequence, 3);
    assert.equal(saved.reservedMicros, saved.records.reduce((n, r) => n + r.reservedMicros, 0));
  } finally { await gate.close(); }
});

test('real near-190m history stops the first forward and keeps all records', async () => {
  const policy = resolveAuthorizedPolicy(200000000);
  const previous = realRecords(policy, [[47490000, 2048]]);
  assert.ok(previous[0].reservedMicros > 180000000 * 0.97, `near 190m: ${previous[0].reservedMicros}`);
  let calls = 0;
  const gate = await startBudgetProxy(options({ policy, previousReservations: previous, fetchImpl: async () => { calls++; return ok(); } }));
  try {
    const response = await send(gate);
    assert.equal(response.status, 429);
    assert.equal(calls, 0);
    assert.deepEqual(gate.state().records, previous);
  } finally { await gate.close(); }
});

test('proxy accepts a 300m task and preserves prior records after a successful forward', async () => {
  const policy = resolveAuthorizedPolicy(300000000);
  const previous = realRecords(policy, [[10, 100], [20, 200]]);
  const snapshots = [];
  let calls = 0;
  const gate = await startBudgetProxy(options({ policy, previousReservations: previous, persist: s => snapshots.push(structuredClone(s)), fetchImpl: async () => { calls++; return ok(); } }));
  try {
    const response = await send(gate); assert.equal(response.status, 200); await response.text();
    assert.equal(calls, 1);
    const saved = snapshots.at(-1);
    assert.equal(saved.records.length, 3);
    assert.deepEqual(saved.records.slice(0, 2), previous);
    assert.equal(saved.records[2].sequence, 3);
    assert.equal(saved.reservedMicros, saved.records.reduce((n, r) => n + r.reservedMicros, 0));
  } finally { await gate.close(); }
});

test('real near-290m history denies before fetch and keeps all records', async () => {
  const policy = resolveAuthorizedPolicy(300000000);
  const previous = realRecords(policy, [[72490000, 2048]]);
  assert.ok(previous[0].reservedMicros > 280000000 * 0.97, `near 290m: ${previous[0].reservedMicros}`);
  let calls = 0;
  const gate = await startBudgetProxy(options({ policy, previousReservations: previous, fetchImpl: async () => { calls++; return ok(); } }));
  try {
    const response = await send(gate);
    assert.equal(response.status, 429);
    assert.equal(calls, 0);
    assert.deepEqual(gate.state().records, previous);
  } finally { await gate.close(); }
});

test('proxy still rejects intermediate caps above 100m that are not 200m, 300m or 400m', async () => {
  await assert.rejects(startBudgetProxy(options({ policy: { ...DEV_POLICY, limitMicros: 150000000, safetyMicros: 10000000 } })), /invalid_dev_budget_configuration/);
});

// --- New tests for 400m cumulative authorization (only400CNY) ---

test('proxy accepts a 400m task and preserves prior records after a successful forward', async () => {
  const policy = resolveAuthorizedPolicy(400000000);
  const previous = realRecords(policy, [[10, 100], [20, 200]]);
  const snapshots = [];
  let calls = 0;
  const gate = await startBudgetProxy(options({ policy, previousReservations: previous, persist: s => snapshots.push(structuredClone(s)), fetchImpl: async () => { calls++; return ok(); } }));
  try {
    const response = await send(gate); assert.equal(response.status, 200); await response.text();
    assert.equal(calls, 1);
    const saved = snapshots.at(-1);
    assert.equal(saved.records.length, 3);
    assert.deepEqual(saved.records.slice(0, 2), previous);
    assert.equal(saved.records[2].sequence, 3);
    assert.equal(saved.reservedMicros, saved.records.reduce((n, r) => n + r.reservedMicros, 0));
  } finally { await gate.close(); }
});

test('real near-390m history denies before fetch and keeps all records', async () => {
  const policy = resolveAuthorizedPolicy(400000000);
  const previous = realRecords(policy, [[97490000, 2048]]);
  assert.ok(previous[0].reservedMicros > 380000000 * 0.97, `near 390m: ${previous[0].reservedMicros}`);
  let calls = 0;
  const gate = await startBudgetProxy(options({ policy, previousReservations: previous, fetchImpl: async () => { calls++; return ok(); } }));
  try {
    const response = await send(gate);
    assert.equal(response.status, 429);
    assert.equal(calls, 0);
    assert.deepEqual(gate.state().records, previous);
  } finally { await gate.close(); }
});
