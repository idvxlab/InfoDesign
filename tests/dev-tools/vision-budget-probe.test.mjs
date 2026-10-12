// Offline tests for vision-budget-probe.mjs (no network, no real credentials).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as probe from '../../scripts/vision-budget-probe.mjs';
import { RequestSpendBudget } from '../../apps/server/src/runtime/pi/spend-budget.ts';

const {
  runVisionProbe, VISION_LEDGER_PATH, AUTHORIZATION_ID, MODEL, SPEND_POLICY,
  CASE_IDS, CASE_FILES, CONTEXT_BYTES, MAX_OUTPUT_TOKENS, EXPECTED_RESERVED_MICROS,
  MAX_CALLS, PNG_MAX_BYTES,
} = probe;

const API_KEY = 'test-key';
const AUTH = AUTHORIZATION_ID;
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

// Build a fully synthetic 512x512 PNG buffer: sig + IHDR(512,512) + trailing bytes.
function makePng512(fill) {
  const buf = Buffer.alloc(PNG_MAX_BYTES - 1, fill ?? 0x61);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(512, 16);
  buf.writeUInt32BE(512, 20);
  return buf;
}

const EXPECTEDS = {
  text: { answer: 'alpha-42' },
  chart: { answer: 'beta-17' },
  table: { answer: 'gamma-88' },
  shapes: { answer: 'delta-53' },
};

function makeFixtureDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vprobe-'));
  if (t) t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cases = CASE_IDS.map((id, i) => {
    const png = makePng512(0x40 + i);
    writeFileSync(join(dir, CASE_FILES[id]), png);
    return {
      id, file: CASE_FILES[id], sha256: `sha256:${sha256(png)}`,
      prompt: `Describe the ${id} image and reply with JSON only.`,
      expected: EXPECTEDS[id],
    };
  });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 1, cases }));
  return dir;
}

// Real global ledger written with the production spend-budget implementation.
function realRecords(policy, requests) {
  let records = [];
  const budget = new RequestSpendBudget(policy, (next) => { records = next.map((r) => ({ ...r })); });
  for (const [contextBytes, outputTokens] of requests) budget.reserve(contextBytes, outputTokens);
  return structuredClone(records);
}

function makeGlobalLedger(t, requests = []) {
  const dir = mkdtempSync(join(tmpdir(), 'vprobe-run-'));
  if (t) t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixtureDir = makeFixtureDir(t);
  const ledgerPath = join(dir, 'global-ledger.json');
  const records = realRecords(SPEND_POLICY, requests);
  writeFileSync(ledgerPath, JSON.stringify({
    authorizationId: AUTH, policy: SPEND_POLICY, reservedMicros: records.reduce((n, r) => n + r.reservedMicros, 0), records,
  }));
  return { dir, fixtureDir, ledgerPath };
}

function okResponse(expected, usage = { prompt_tokens: 12, completion_tokens: 8 }) {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(expected) } }],
    usage,
  }), { status: 200 });
}

function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return handler(calls.length, { url, init });
  };
  fn.calls = calls;
  return fn;
}

function persistRecorder(t) {
  const written = [];
  const fn = (path, value) => {
    written.push({ path, value: structuredClone(value) });
    writeFileSync(path, JSON.stringify(value));
  };
  fn.written = written;
  if (t) t.after(() => {});
  return fn;
}

function baseOpts(s, extra = {}) {
  return {
    fixtureDir: s.fixtureDir,
    totalLedgerPath: s.ledgerPath,
    authorizationId: AUTH,
    apiKey: API_KEY,
    fetchImpl: mockFetch((n) => okResponse(EXPECTEDS[CASE_IDS[n - 1]])),
    persist: persistRecorder(),
    requestTimeoutMs: 5000,
    ...extra,
  };
}

// ------------------------------------------------------------------ happy path
test('4 successful calls: global reserve +4M, output/model fixed, no answer leak', async (t) => {
  const s = makeGlobalLedger(t);
  // Read BOTH actual ledger files inside each fetch callback to prove the
  // reservation and reserved attempt were durable on disk BEFORE forwarding.
  const seenBefore = [];
  const fetchImpl = mockFetch((n) => {
    const g = JSON.parse(readFileSync(s.ledgerPath, 'utf8'));
    const v = JSON.parse(readFileSync(VISION_LEDGER_PATH(s.ledgerPath), 'utf8'));
    seenBefore.push({ n, globalRecords: g.records.length, globalReserved: g.reservedMicros, visionAttempts: v.attempts.length });
    return okResponse(EXPECTEDS[CASE_IDS[n - 1]]);
  });
  const persist = persistRecorder(t);
  const res = await runVisionProbe(baseOpts(s, { fetchImpl, persist }));

  assert.equal(res.status, 'passed');
  assert.equal(fetchImpl.calls.length, MAX_CALLS);
  assert.deepEqual(res.results.map((r) => r.status), CASE_IDS.map(() => 'semantic_pass'));
  assert.equal(res.results.length, 4);

  // Global 200m disk ledger grew by exactly 4 * 1 CNY, appending to real history.
  const global = JSON.parse(readFileSync(s.ledgerPath, 'utf8'));
  assert.equal(global.authorizationId, AUTH);
  assert.equal(global.reservedMicros, 4 * EXPECTED_RESERVED_MICROS);
  assert.equal(global.records.length, 4);
  assert.equal(global.records.reduce((n, r) => n + r.reservedMicros, 0), 4 * EXPECTED_RESERVED_MICROS);
  assert.deepEqual(global.records.map((r) => r.sequence), [1, 2, 3, 4]);

  // One image per request; body carries the fixed model/limits and no expected answer.
  for (const [i, c] of fetchImpl.calls.entries()) {
    const body = JSON.parse(c.init.body);
    assert.equal(body.model, MODEL);
    assert.equal(body.max_tokens, MAX_OUTPUT_TOKENS);
    assert.equal(body.enable_thinking, false);
    assert.equal(body.stream, false);
    assert.equal(body.n, 1);
    assert.equal(body.messages.length, 1);
    const content = body.messages[0].content;
    const imgs = content.filter((p) => p.type === 'image_url');
    const txts = content.filter((p) => p.type === 'text');
    assert.equal(imgs.length, 1);
    assert.equal(txts.length, 1);
    const expectedStr = JSON.stringify(EXPECTEDS[CASE_IDS[i]]);
    assert.ok(!c.init.body.includes(expectedStr), 'expected answer must not be in request body');
    for (const key of Object.keys(EXPECTEDS[CASE_IDS[i]])) {
      assert.ok(!txts[0].text.includes(key), 'answer field name leaked into prompt');
    }
  }

  // Durable ledger state was written BEFORE each fetch: read BOTH actual ledger
  // files inside the callback and prove the reservation and reserved attempt
  // were on disk before the request was forwarded.
  for (const [i, snap] of seenBefore.entries()) {
    assert.equal(snap.n, i + 1);
    assert.equal(snap.globalRecords, i + 1, 'global reservation durable before fetch');
    assert.equal(snap.globalReserved, (i + 1) * EXPECTED_RESERVED_MICROS, 'global reserve total durable before fetch');
    assert.equal(snap.visionAttempts, i + 1, 'reserved attempt durable before fetch');
  }

  // Durable global disk ledger was written BEFORE each fetch.
  const globalWrites = persist.written.filter((w) => w.path === s.ledgerPath);
  assert.equal(globalWrites.length >= 4, true, 'global ledger persisted before each fetch');
  assert.ok(existsSync(VISION_LEDGER_PATH(s.ledgerPath)));
});

// ------------------------------------------------------------- semantic_fail
test('wrong-value HTTP 200 => semantic_fail, batch continues to next distinct case', async (t) => {
  const s = makeGlobalLedger(t);
  const wrong = { answer: 'not-the-answer' };
  const res = await runVisionProbe(baseOpts(s, {
    fetchImpl: mockFetch(() => okResponse(wrong)),
  }));
  assert.equal(res.status, 'failed');
  assert.ok(res.results.some((r) => r.status === 'semantic_fail'));
  assert.ok(res.results.some((r) => r.status === 'semantic_pass') || res.results.some((r) => r.status === 'semantic_fail'));
});

// ------------------------------------------------ fail-closed: must not pass
for (const [name, mk] of [
  ['finish_reason=length', () => new Response(JSON.stringify({
    choices: [{ finish_reason: 'length', message: { content: JSON.stringify(EXPECTEDS.text) } }], usage: {},
  }), { status: 200 })],
  ['invalid JSON body', () => new Response('not-json{', { status: 200 })],
  ['HTTP 500', () => new Response('boom', { status: 500 })],
  ['transport throw', () => { throw new Error('reset'); }],
]) {
  test(`fail-closed: ${name} must not pass and stops the batch (no retries)`, async (t) => {
    const s = makeGlobalLedger(t);
    const fetchImpl = mockFetch(() => mk());
    const res = await runVisionProbe(baseOpts(s, { fetchImpl }));
    assert.notEqual(res.status, 'passed');
    assert.equal(fetchImpl.calls.length, 1, 'no retry / no remaining cases forwarded');
    assert.ok(res.results.some((r) => r.status !== 'semantic_pass'));
    assert.ok(res.results.some((r) => r.status === 'not_run'), 'remaining cases not run');
  });
}

// --------------------------------------------------- budget / ledger guards
test('insufficient global remaining prevents any network call', async (t) => {
  // Real near-190m history leaves far less than 1 CNY available.
  const s = makeGlobalLedger(t, [[47_490_000, 2048]]);
  const seeded = JSON.parse(readFileSync(s.ledgerPath, 'utf8'));
  assert.ok(seeded.reservedMicros > 189_000_000, `near 190m: ${seeded.reservedMicros}`);
  const fetchImpl = mockFetch(() => okResponse(EXPECTEDS.text));
  const res = await runVisionProbe(baseOpts(s, { fetchImpl }));
  assert.notEqual(res.status, 'passed');
  assert.equal(fetchImpl.calls.length, 0, 'network must not be touched');
  assert.ok(res.results.some((r) => r.status === 'failed'));
  // History is preserved unchanged.
  assert.deepEqual(JSON.parse(readFileSync(s.ledgerPath, 'utf8')).records, seeded.records);
});

test('invalid reserved total (corrupt history) rejected before network', async (t) => {
  const s = makeGlobalLedger(t);
  const raw = JSON.parse(readFileSync(s.ledgerPath, 'utf8'));
  raw.records = [{ sequence: 1, contextBytes: 10, reservedInputTokens: 2, requestedOutputTokens: 100, reservedMicros: 999999 }];
  raw.reservedMicros = 999999;
  writeFileSync(s.ledgerPath, JSON.stringify(raw));
  const fetchImpl = mockFetch(() => okResponse(EXPECTEDS.text));
  await assert.rejects(() => runVisionProbe(baseOpts(s, { fetchImpl })), /invalid_ledger/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('tampered policy rejected', async (t) => {
  const s = makeGlobalLedger(t, [[10, 100]]);
  const raw = JSON.parse(readFileSync(s.ledgerPath, 'utf8'));
  raw.policy = { ...raw.policy, limitMicros: 1 };
  writeFileSync(s.ledgerPath, JSON.stringify(raw));
  const fetchImpl = mockFetch(() => okResponse(EXPECTEDS.text));
  await assert.rejects(() => runVisionProbe(baseOpts(s, { fetchImpl })), /invalid_ledger/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('wrong authorizationId rejected', async (t) => {
  const s = makeGlobalLedger(t, [[10, 100]]);
  const raw = JSON.parse(readFileSync(s.ledgerPath, 'utf8'));
  raw.authorizationId = 'someone-else';
  writeFileSync(s.ledgerPath, JSON.stringify(raw));
  const fetchImpl = mockFetch(() => okResponse(EXPECTEDS.text));
  await assert.rejects(() => runVisionProbe(baseOpts(s, { fetchImpl })), /invalid_ledger/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('bad saved total rejected', async (t) => {
  const s = makeGlobalLedger(t, [[10, 100]]);
  const raw = JSON.parse(readFileSync(s.ledgerPath, 'utf8'));
  raw.reservedMicros = raw.reservedMicros + 1;
  writeFileSync(s.ledgerPath, JSON.stringify(raw));
  const fetchImpl = mockFetch(() => okResponse(EXPECTEDS.text));
  await assert.rejects(() => runVisionProbe(baseOpts(s, { fetchImpl })), /invalid_ledger/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('existing global lock rejected (concurrent run blocked); own lock never removed', async (t) => {
  const s = makeGlobalLedger(t);
  const otherLock = `${s.ledgerPath}.lock`;
  writeFileSync(otherLock, 'owned-by-someone-else');
  const fetchImpl = mockFetch(() => okResponse(EXPECTEDS.text));
  await assert.rejects(() => runVisionProbe(baseOpts(s, { fetchImpl })), /lock_unavailable/);
  assert.equal(fetchImpl.calls.length, 0);
  assert.ok(existsSync(otherLock), 'must not delete a lock it does not own');
  assert.equal(readFileSync(otherLock, 'utf8'), 'owned-by-someone-else');
});

// ------------------------------------------------ vision ledger / restart guard
test('existing vision ledger rejected (restart must not reset it)', async (t) => {
  const s = makeGlobalLedger(t);
  const visionPath = VISION_LEDGER_PATH(s.ledgerPath);
  const prior = { authorizationId: AUTH, model: MODEL, attempts: [], results: [], status: 'failed' };
  writeFileSync(visionPath, JSON.stringify(prior));
  const fetchImpl = mockFetch(() => okResponse(EXPECTEDS.text));
  await assert.rejects(() => runVisionProbe(baseOpts(s, { fetchImpl })), /vision_ledger_exists/);
  assert.equal(fetchImpl.calls.length, 0);
  assert.deepEqual(JSON.parse(readFileSync(visionPath, 'utf8')), prior);
});

// ------------------------------------------------ fixture validation guards
test('hash/size/dimension/manifest all validated before any request', async (t) => {
  // mismatch hash
  const s1 = makeGlobalLedger(t);
  const m1 = JSON.parse(readFileSync(join(s1.fixtureDir, 'manifest.json'), 'utf8'));
  m1.cases[0].sha256 = 'sha256:' + 'a'.repeat(64);
  writeFileSync(join(s1.fixtureDir, 'manifest.json'), JSON.stringify(m1));
  const f1 = mockFetch(() => okResponse(EXPECTEDS.text));
  await assert.rejects(() => runVisionProbe(baseOpts(s1, { fetchImpl: f1 })), /fixture_hash_mismatch/);
  assert.equal(f1.calls.length, 0);

  // bare-hex (unprefixed) hash is invalid
  const s1b = makeGlobalLedger(t);
  const m1b = JSON.parse(readFileSync(join(s1b.fixtureDir, 'manifest.json'), 'utf8'));
  m1b.cases[0].sha256 = sha256(readFileSync(join(s1b.fixtureDir, CASE_FILES.text)));
  writeFileSync(join(s1b.fixtureDir, 'manifest.json'), JSON.stringify(m1b));
  const f1b = mockFetch(() => okResponse(EXPECTEDS.text));
  await assert.rejects(() => runVisionProbe(baseOpts(s1b, { fetchImpl: f1b })), /invalid_manifest/);
  assert.equal(f1b.calls.length, 0);

  // 513 dimensions
  const s2 = makeGlobalLedger(t);
  const bad = makePng512(0x40);
  bad.writeUInt32BE(513, 16);
  writeFileSync(join(s2.fixtureDir, CASE_FILES.text), bad);
  const m2 = JSON.parse(readFileSync(join(s2.fixtureDir, 'manifest.json'), 'utf8'));
  m2.cases[0].sha256 = `sha256:${sha256(bad)}`;
  writeFileSync(join(s2.fixtureDir, 'manifest.json'), JSON.stringify(m2));
  const f2 = mockFetch(() => okResponse(EXPECTEDS.text));
  await assert.rejects(() => runVisionProbe(baseOpts(s2, { fetchImpl: f2 })), /invalid_png/);
  assert.equal(f2.calls.length, 0);
});

test('symlink fixture and path escape rejected before forward', async (t) => {
  // symlink: replace our own generated file with a symlink to a sibling
  const s1 = makeGlobalLedger(t);
  const target = join(s1.fixtureDir, CASE_FILES.text);
  const real = join(s1.fixtureDir, 'real.png');
  writeFileSync(real, readFileSync(target));
  rmSync(target);
  symlinkSync(real, target);
  const f1 = mockFetch(() => okResponse(EXPECTEDS.text));
  await assert.rejects(() => runVisionProbe(baseOpts(s1, { fetchImpl: f1 })), /unsafe_path/);
  assert.equal(f1.calls.length, 0);

  // path escape in manifest file name
  const s2 = makeGlobalLedger(t);
  const m2 = JSON.parse(readFileSync(join(s2.fixtureDir, 'manifest.json'), 'utf8'));
  m2.cases[0].file = '../escape.png';
  writeFileSync(join(s2.fixtureDir, 'manifest.json'), JSON.stringify(m2));
  const f2 = mockFetch(() => okResponse(EXPECTEDS.text));
  await assert.rejects(() => runVisionProbe(baseOpts(s2, { fetchImpl: f2 })), /unsafe_path|invalid_manifest/);
  assert.equal(f2.calls.length, 0);
});

// --------------------------------------------------- persistence failure guard
test('persist failure at third write is caught by reserve and rejected without HTTP', async (t) => {
  // Correct write order: seed vision / intent vision / global reservation / reserved vision.
  const s = makeGlobalLedger(t);
  const seedGlobal = JSON.parse(readFileSync(s.ledgerPath, 'utf8'));
  const fetchImpl = mockFetch(() => okResponse(EXPECTEDS.text));
  let writes = 0;
  const persist = (path, value) => {
    writes++;
    if (writes === 3) throw new Error('disk_full');
    writeFileSync(path, JSON.stringify(value));
  };
  // reserve() throws -> runVisionProbe returns failed with reserve_failed (not a reject).
  const res = await runVisionProbe(baseOpts(s, { fetchImpl, persist }));
  assert.equal(res.status, 'failed');
  assert.ok(res.results.some((r) => r.status === 'failed' && r.error === 'reserve_failed'), 'reserve_failed branch');
  assert.equal(fetchImpl.calls.length, 0, 'no network when the reservation write fails');
  assert.deepEqual(JSON.parse(readFileSync(s.ledgerPath, 'utf8')).records, seedGlobal.records, 'global records unchanged');
});

test('persist failure at writes 1,2,4 rejects and prevents network forward', async (t) => {
  for (const failOn of [1, 2, 4]) {
    const s = makeGlobalLedger(t);
    const fetchImpl = mockFetch(() => okResponse(EXPECTEDS.text));
    let writes = 0;
    const persist = (path, value) => {
      writes++;
      if (writes === failOn) throw new Error('disk_full');
      writeFileSync(path, JSON.stringify(value));
    };
    await assert.rejects(() => runVisionProbe(baseOpts(s, { fetchImpl, persist })), /disk_full/);
    assert.equal(fetchImpl.calls.length, 0, `no network when durable write ${failOn} fails`);
  }
});

// --------------------------------------------------- timeout / abort behavior
test('timeout during headers preserves the attempt/reservation (no silent reset)', async (t) => {
  const s = makeGlobalLedger(t);
  const fetchImpl = async (url, init) => {
    await new Promise((res) => {
      if (init.signal.aborted) return res();
      const timer = setTimeout(res, 10000);
      init.signal.addEventListener('abort', () => { clearTimeout(timer); res(); });
    });
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }), { status: 200 });
  };
  const res = await runVisionProbe(baseOpts(s, { fetchImpl, requestTimeoutMs: 50 }));
  assert.notEqual(res.status, 'passed');
  const ledger = JSON.parse(readFileSync(VISION_LEDGER_PATH(s.ledgerPath), 'utf8'));
  assert.ok(ledger.attempts.length >= 1, 'attempt kept');
  assert.equal(ledger.attempts[0].reservedMicros, EXPECTED_RESERVED_MICROS);
});

test('caller abort before start preserves reservation state and does not run all cases', async (t) => {
  const s = makeGlobalLedger(t);
  const controller = new AbortController();
  controller.abort();
  const fetchImpl = mockFetch(() => okResponse(EXPECTEDS.text));
  await assert.rejects(
    () => runVisionProbe(baseOpts(s, { fetchImpl, signal: controller.signal })),
    /aborted/,
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('timeout during body consumption is enforced (incremental cap/timeout active)', async (t) => {
  const s = makeGlobalLedger(t);
  let cancelled = false;
  const fetchImpl = async (url, init) => new Response(new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(new TextEncoder().encode('{"choices":'));
      init.signal.addEventListener('abort', () => { cancelled = true; try { ctrl.error(new Error('abort')); } catch {} });
    },
    cancel() { cancelled = true; },
  }), { status: 200 });
  const res = await runVisionProbe(baseOpts(s, { fetchImpl, requestTimeoutMs: 50 }));
  assert.notEqual(res.status, 'passed');
  assert.equal(cancelled, true, 'in-flight body was aborted/cancelled');
  const ledger = JSON.parse(readFileSync(VISION_LEDGER_PATH(s.ledgerPath), 'utf8'));
  assert.ok(ledger.attempts.length >= 1);
});

test('oversize body is rejected incrementally before full consumption', async (t) => {
  const s = makeGlobalLedger(t);
  let enqueued = 0;
  const fetchImpl = async () => new Response(new ReadableStream({
    pull(ctrl) {
      enqueued++;
      ctrl.enqueue(new Uint8Array(16 * 1024).fill(65)); // 64KiB cap exceeded after 5 chunks
      if (enqueued > 12) ctrl.close();
    },
  }), { status: 200 });
  const res = await runVisionProbe(baseOpts(s, { fetchImpl }));
  assert.notEqual(res.status, 'passed');
  assert.ok(enqueued < 12, 'must stop reading once the incremental cap is exceeded');
});

// ---------------------------------------------------------------- usage semantics
test('unknown usage stays null (not 0) and does not release reservation', async (t) => {
  const s = makeGlobalLedger(t);
  const fetchImpl = mockFetch((n) => okResponse(EXPECTEDS[CASE_IDS[n - 1]], {}));
  const res = await runVisionProbe(baseOpts(s, { fetchImpl }));
  assert.equal(res.status, 'passed');
  const ledger = JSON.parse(readFileSync(VISION_LEDGER_PATH(s.ledgerPath), 'utf8'));
  for (const r of ledger.results) {
    if (r.status === 'semantic_pass') {
      assert.ok(!('usage' in r) || r.usage === null, 'unknown usage must not be recorded as 0');
    }
  }
});

test('reported output tokens above requested 2048 cannot pass', async (t) => {
  const s = makeGlobalLedger(t);
  const fetchImpl = mockFetch((n) => okResponse(EXPECTEDS[CASE_IDS[n - 1]], { prompt_tokens: 12, completion_tokens: 4096 }));
  const res = await runVisionProbe(baseOpts(s, { fetchImpl }));
  assert.notEqual(res.status, 'passed');
  assert.ok(res.results.some((r) => r.status === 'excessive_usage' || r.status === 'failed'));
});

// ---------------------------------------------------------------- logging / secrets
test('normal synthetic output is preserved as evidence without redaction', async (t) => {
  const s = makeGlobalLedger(t);
  const fetchImpl = mockFetch((n) => okResponse(EXPECTEDS[CASE_IDS[n - 1]]));
  const persist = persistRecorder(t);
  const res = await runVisionProbe(baseOpts(s, { fetchImpl, persist }));
  assert.equal(res.status, 'passed');
  const visionPath = VISION_LEDGER_PATH(s.ledgerPath);
  const finalVision = persist.written.filter((w) => w.path === visionPath).at(-1).value;
  for (const r of finalVision.results) {
    assert.equal(r.status, 'semantic_pass');
    assert.deepEqual(r.output, EXPECTEDS[r.id], 'synthetic parsed output preserved');
    assert.ok(!r.outputRedacted, 'normal output must not be flagged redacted');
  }
});

test('credential-like synthetic output is suppressed and flagged, semantic_fail stays fail', async (t) => {
  const s = makeGlobalLedger(t);
  const leakyExpected = { answer: 'x' };
  // Response content intentionally echoes credential-like material; still differs from expected.
  const leaky = { answer: `Bearer ${API_KEY}`, image: 'data:image/png;base64,AAAA' };
  const fetchImpl = mockFetch(() => okResponse(leaky));
  const persist = persistRecorder(t);
  const res = await runVisionProbe(baseOpts(s, { fetchImpl, persist }));
  assert.notEqual(res.status, 'passed', 'semantic mismatch must never pass');
  const visionPath = VISION_LEDGER_PATH(s.ledgerPath);
  const finalVision = persist.written.filter((w) => w.path === visionPath).at(-1).value;
  const leakyResult = finalVision.results.find((r) => r.status === 'semantic_fail');
  assert.ok(leakyResult, 'semantic_fail recorded');
  assert.equal(leakyResult.outputRedacted, true, 'credential-like output flagged redacted');
  assert.equal('output' in leakyResult ? leakyResult.output : null, null, 'suppressed output');
  for (const { value } of persist.written) {
    const text = JSON.stringify(value);
    assert.ok(!text.includes(API_KEY), 'api key must not be persisted');
    assert.ok(!text.includes('Bearer'), 'auth header text must not be persisted');
    assert.ok(!text.includes('data:image'), 'image data URL must not be persisted');
  }
});

test('credentials/body absent from saved artifacts; synthetic semantic output may persist', async (t) => {
  const s = makeGlobalLedger(t);
  const fetchImpl = mockFetch((n) => okResponse(EXPECTEDS[CASE_IDS[n - 1]]));
  const persist = persistRecorder(t);
  await runVisionProbe(baseOpts(s, { fetchImpl, persist }));
  for (const { value } of persist.written) {
    const text = JSON.stringify(value);
    assert.ok(!text.includes(API_KEY), 'api key must not be persisted');
    assert.ok(!text.includes('Bearer'), 'auth header must not be persisted');
    assert.ok(!text.includes('data:image'), 'request image data must not be persisted');
    assert.ok(!text.includes('"prompt"'), 'prompt text must not be persisted');
  }
  // Synthetic semantic result output is allowed and useful as evidence.
  const merged = JSON.stringify(persist.written.map((w) => w.value));
  assert.ok(merged.includes('semantic_pass') || merged.includes('semantic_fail'));
});

// ------------------------------------------------------- bounded CLI config file
test('bounded file-config reader rejects symlinks, oversize and bad keys', async (t) => {
  assert.equal(typeof probe.readBoundedFile, 'function');
  const dir = mkdtempSync(join(tmpdir(), 'vprobe-cfg-'));
  if (t) t.after(() => rmSync(dir, { recursive: true, force: true }));

  const good = join(dir, 'good.json');
  writeFileSync(good, JSON.stringify({ fixtureDir: 'f', totalLedgerPath: 'l', authorizationId: AUTH }));
  const buf = probe.readBoundedFile(good, probe.CONFIG_MAX_BYTES);
  const cfg = probe.parseCliConfig(buf.toString('utf8'));
  assert.equal(cfg.authorizationId, AUTH);
  assert.deepEqual([cfg.fixtureDir, cfg.totalLedgerPath], ['f', 'l']);

  // oversize rejected
  const big = join(dir, 'big.json');
  writeFileSync(big, Buffer.alloc(probe.CONFIG_MAX_BYTES + 1, 0x20));
  assert.throws(() => probe.readBoundedFile(big, probe.CONFIG_MAX_BYTES), /too_large/);

  // symlink rejected
  const link = join(dir, 'link.json');
  symlinkSync(good, link);
  assert.throws(() => probe.readBoundedFile(link, probe.CONFIG_MAX_BYTES), /unsafe_path/);

  // invalid keys rejected by parseCliConfig
  assert.throws(() => probe.parseCliConfig(JSON.stringify({ fixtureDir: 'f', totalLedgerPath: 'l', apiKey: 'sk' })), /invalid_cli_config/);
  assert.throws(() => probe.parseCliConfig(JSON.stringify({ fixtureDir: 'f' })), /invalid_cli_config/);
  assert.throws(() => probe.parseCliConfig(JSON.stringify({ fixtureDir: 'f', totalLedgerPath: 'l', authorizationId: 'x' })), /invalid_cli_config/);
});

// ------------------------------------------------------------------ lock cleanup
test('own lock is cleaned up after a run (failure path)', async (t) => {
  const s = makeGlobalLedger(t);
  const fetchImpl = mockFetch(() => { throw new Error('down'); });
  await runVisionProbe(baseOpts(s, { fetchImpl })).catch(() => {});
  assert.ok(!existsSync(`${s.ledgerPath}.lock`), 'own lock must be released');
});

test('own lock is cleaned up after a run (success path)', async (t) => {
  const s = makeGlobalLedger(t);
  const fetchImpl = mockFetch((n) => okResponse(EXPECTEDS[CASE_IDS[n - 1]]));
  const res = await runVisionProbe(baseOpts(s, { fetchImpl }));
  assert.equal(res.status, 'passed');
  assert.ok(!existsSync(`${s.ledgerPath}.lock`), 'own lock must be released');
});