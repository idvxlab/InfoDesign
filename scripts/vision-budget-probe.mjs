/**
 * Isolated developer vision capability probe (NOT a business Agent / B4).
 * Fixed qwen3.5-flash @ Ali.Bailian, FOUR code-generated fictional 512x512 PNGs,
 * at most 4 calls (1 image, <=2048 output tokens, enable_thinking:false, no retry).
 * One fixed 1 CNY reservation per call under the SAME global 200 CNY ledger
 * (approved cumulative cap, same ledger ID, never reset; safety stays exactly 10 CNY).
 * Imports the REAL spend budget + real model transport. No live network required.
 */
import { readFileSync, lstatSync, openSync, closeSync, existsSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { RequestSpendBudget } from '../apps/server/src/runtime/pi/spend-budget.ts';
import { createModelTransport } from '../apps/server/src/runtime/pi/model-transport.ts';
import { atomicLedger, resolveAuthorizedPolicy } from './pi-dev-budget-proxy.mjs';

export const AUTHORIZATION_ID = 'tju-multimodal-review-100cny-20261010';
export const MODEL = 'qwen3.5-flash';
export const ENDPOINT = 'https://apicz.boyuerichdata.com/v1/chat/completions';
// Approved cumulative 200 CNY cap (same ledger identity, no reset). Safety stays exactly 10 CNY.
export const SPEND_POLICY = resolveAuthorizedPolicy(200_000_000);
export const CASE_IDS = Object.freeze(['text', 'chart', 'table', 'shapes']);
export const CASE_FILES = Object.freeze({ text: 'text.png', chart: 'chart.png', table: 'table.png', shapes: 'shapes.png' });
export const CONTEXT_BYTES = 241_808;
export const MAX_OUTPUT_TOKENS = 2048;
export const EXPECTED_RESERVED_MICROS =
  (CONTEXT_BYTES * SPEND_POLICY.inputTokensPerByte + SPEND_POLICY.inputTokenOverhead) * SPEND_POLICY.inputCnyPerMillion +
  MAX_OUTPUT_TOKENS * SPEND_POLICY.outputCnyPerMillion; // 1_000_000
export const MAX_CALLS = 4;
export const MANIFEST_MAX_BYTES = 16 * 1024;
export const CONFIG_MAX_BYTES = 16 * 1024;
export const PNG_MAX_BYTES = 128 * 1024;
export const PROMPT_MAX_BYTES = 3000;
export const EXPECTED_MAX_BYTES = 4000;
export const RESPONSE_MAX_BYTES = 64 * 1024;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 120_000;
export const VISION_LEDGER_PATH = (p) => `${p}.vision-qwen-20261010.json`;

const ERR = (code) => Object.assign(new Error(code), { code });
const SHA_RE = /^sha256:[0-9a-f]{64}$/;
const URL_RE = /(https?:\/\/|data:|ftp:\/\/)/i;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function readBoundedFile(path, maxBytes) {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isFile()) throw ERR('unsafe_path');
  if (st.size > maxBytes) throw ERR('too_large');
  const buf = readFileSync(path);
  if (buf.length > maxBytes) throw ERR('too_large');
  return buf;
}
function assertNoSymlinkDir(dir) {
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw ERR('unsafe_path');
}
function assertPlainChild(dir, name, maxBytes) {
  if (typeof name !== 'string' || name.length === 0) throw ERR('unsafe_path');
  if (name.includes('/') || name.includes('\\') || name.includes('..') || isAbsolute(name)) throw ERR('unsafe_path');
  const full = join(dir, name);
  if (resolve(full) !== resolve(dir) + sep + name) throw ERR('unsafe_path');
  return readBoundedFile(full, maxBytes);
}
function isPng512(buf) {
  if (buf.length < 33) return false;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) return false;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return false;
  return buf.readUInt32BE(16) === 512 && buf.readUInt32BE(20) === 512;
}

export function loadValidatedFixtures(fixtureDir) {
  const dir = resolve(fixtureDir);
  assertNoSymlinkDir(dir);
  const manifestBytes = assertPlainChild(dir, 'manifest.json', MANIFEST_MAX_BYTES);
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { throw ERR('invalid_manifest'); }
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.cases)) throw ERR('invalid_manifest');
  if (Object.keys(manifest).length !== 2 || manifest.cases.length !== CASE_IDS.length) throw ERR('invalid_manifest');
  const fixtures = [];
  for (let i = 0; i < CASE_IDS.length; i++) {
    const id = CASE_IDS[i]; const c = manifest.cases[i];
    if (!c || c.id !== id || c.file !== CASE_FILES[id]) throw ERR('invalid_manifest');
    if (Object.keys(c).sort().join(',') !== 'expected,file,id,prompt,sha256') throw ERR('invalid_manifest');
    if (!SHA_RE.test(String(c.sha256 || ''))) throw ERR('invalid_manifest');
    const prompt = c.prompt;
    if (typeof prompt !== 'string' || prompt.length === 0 || Buffer.byteLength(prompt, 'utf8') > PROMPT_MAX_BYTES || URL_RE.test(prompt)) throw ERR('invalid_manifest');
    const expectedText = JSON.stringify(c.expected);
    if (expectedText === undefined || Buffer.byteLength(expectedText, 'utf8') > EXPECTED_MAX_BYTES) throw ERR('invalid_manifest');
    const png = assertPlainChild(dir, c.file, PNG_MAX_BYTES);
    if (!isPng512(png)) throw ERR('invalid_png');
    if (`sha256:${sha256(png)}` !== c.sha256) throw ERR('fixture_hash_mismatch');
    fixtures.push({ id, prompt, expected: c.expected, sha256: c.sha256, dataUrl: `data:image/png;base64,${png.toString('base64')}` });
  }
  return fixtures;
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a); const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.hasOwn(b, k) || !deepEqual(a[k], b[k])) return false;
  return true;
}
function extractAssistantJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false };
  let s = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  if (fence) s = fence[1].trim();
  try { return { ok: true, value: JSON.parse(s) }; } catch { return { ok: false }; }
}
const validCount = (v) => Number.isSafeInteger(v) && v >= 0;
function readUsage(usg) {
  if (!usg || typeof usg !== 'object') return null;
  const pick = (a, b) => (usg[a] !== undefined ? usg[a] : usg[b]);
  const input = pick('prompt_tokens', 'input_tokens');
  const output = pick('completion_tokens', 'output_tokens');
  const cacheRead = usg.cache_read_tokens === undefined ? 0 : usg.cache_read_tokens;
  const cacheWrite = usg.cache_write_tokens === undefined ? 0 : usg.cache_write_tokens;
  if (![input, output, cacheRead, cacheWrite].every(validCount)) return null;
  return { input, output, cacheRead, cacheWrite };
}
function evaluate(fixture, outcome) {
  if (outcome?.error) return { status: 'transport_error', usage: null };
  if (outcome.httpStatus !== 200) return { status: 'http_error', usage: null };
  let json;
  try { json = JSON.parse(outcome.body); } catch { return { status: 'invalid_response', usage: null }; }
  const choice = json?.choices?.[0];
  if (!choice) return { status: 'invalid_response', usage: null };
  const usage = readUsage(json.usage);
  if (choice.finish_reason !== 'stop') return { status: 'rejected_response', usage };
  if (choice.message?.tool_calls || json?.error) return { status: 'rejected_response', usage };
  const parsed = extractAssistantJson(choice.message?.content);
  if (!parsed.ok) return { status: 'rejected_response', usage };
  if (!deepEqual(parsed.value, fixture.expected)) return { status: 'semantic_fail', output: parsed.value, usage };
  return { status: 'semantic_pass', output: parsed.value, usage };
}

async function readBoundedBody(response, signal) {
  const body = response.body;
  if (!body) return '';
  const reader = typeof body.getReader === 'function' ? body.getReader() : null;
  const chunks = []; let total = 0;
  const push = (u8) => {
    total += u8.length;
    if (total > RESPONSE_MAX_BYTES) throw ERR('response_too_large');
    chunks.push(Buffer.from(u8));
  };
  if (reader) {
    try {
      for (;;) {
        if (signal?.aborted) throw ERR('aborted');
        const { value, done } = await reader.read();
        if (done) break;
        if (value) push(value);
      }
    } catch (e) {
      try { await reader.cancel(); } catch {}
      throw e;
    }
  } else {
    for await (const chunk of body) { if (signal?.aborted) throw ERR('aborted'); push(chunk); }
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function materializeResponse(response, signal) {
  if (response == null || typeof response.status !== 'number') return { error: true, usage: null };
  const httpStatus = response.status;
  if (httpStatus !== 200) return { httpStatus, usage: null };
  let text;
  try { text = await readBoundedBody(response, signal); }
  catch { return { httpStatus, error: true, usage: null }; }
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > RESPONSE_MAX_BYTES) return { httpStatus, error: true, usage: null };
  return { httpStatus: 200, body: text };
}
function buildRequestBody(fixture) {
  const body = {
    model: MODEL, stream: false, n: 1, max_tokens: MAX_OUTPUT_TOKENS, enable_thinking: false,
    messages: [{ role: 'user', content: [
      { type: 'text', text: fixture.prompt },
      { type: 'image_url', image_url: { url: fixture.dataUrl } },
    ] }],
  };
  const text = JSON.stringify(body);
  if (Buffer.byteLength(text, 'utf8') > CONTEXT_BYTES) throw ERR('context_too_large');
  return text;
}

function readLedger(path) {
  if (!existsSync(path)) throw ERR('missing_ledger');
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isFile()) throw ERR('unsafe_path');
  if (st.size > 4 * 1024 * 1024) throw ERR('invalid_ledger');
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { throw ERR('invalid_ledger'); }
  if (!value || typeof value !== 'object') throw ERR('invalid_ledger');
  if (typeof value.authorizationId !== 'string' || !Array.isArray(value.records)) throw ERR('invalid_ledger');
  return value;
}
function writeLedger(path, value) {
  atomicLedger(path, value); // fsync + rename, never a partial/truncated ledger
}

// Bounded synthetic parsed JSON output for independent semantic acceptance.
// Never persist raw exceptions, prompts, request bodies, or credentials: if the
// serialized value contains the api key, auth header text, or an image data URL,
// suppress the value entirely and flag redaction. A redacted/suppressed output
// must never be turned into a pass -- it only marks the recorded evidence.
function serializeParsedOutput(output, apiKey) {
  if (output === undefined) return null;
  let text;
  try { text = JSON.stringify(output); } catch { return { value: null, redacted: true }; }
  if (typeof text !== 'string') return { value: null, redacted: true };
  if (Buffer.byteLength(text, 'utf8') > EXPECTED_MAX_BYTES) return { value: null, redacted: true };
  const lower = text.toLowerCase();
  const leaks =
    (typeof apiKey === 'string' && apiKey.length > 0 && text.includes(apiKey)) ||
    lower.includes('bearer') ||
    lower.includes('authorization') ||
    lower.includes('data:image') ||
    lower.includes('\"prompt\"');
  if (leaks) return { value: null, redacted: true };
  return { value: output, redacted: false };
}

export async function runVisionProbe(options) {
  const { fixtureDir, totalLedgerPath, authorizationId, apiKey, fetchImpl,
    persist, requestTimeoutMs = DEFAULT_TIMEOUT_MS, signal } = options || {};
  if (authorizationId !== AUTHORIZATION_ID) throw ERR('unauthorized');
  if (typeof apiKey !== 'string' || apiKey.length === 0) throw ERR('missing_api_key');
  if (typeof totalLedgerPath !== 'string' || totalLedgerPath.length === 0) throw ERR('invalid_ledger_path');
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > MAX_TIMEOUT_MS) throw ERR('invalid_timeout');
  if (typeof fetchImpl !== 'function') throw ERR('missing_transport');
  const ledgerPath = resolve(totalLedgerPath);
  const visionPath = VISION_LEDGER_PATH(ledgerPath);
  const writeLedgerImpl = typeof persist === 'function' ? persist : (p, v) => writeLedger(p, v);

  const fixtures = loadValidatedFixtures(fixtureDir); // ALL 4 validated BEFORE any spend

  const ownLockPath = `${ledgerPath}.lock`;
  let lockFd = -1;
  try { lockFd = openSync(ownLockPath, 'wx'); } catch { throw ERR('lock_unavailable'); }

  const results = CASE_IDS.map((id) => ({ id, status: 'not_run' }));
  const visionLedger = { authorizationId: AUTHORIZATION_ID, model: MODEL, attempts: [], results };
  const flush = (value) => writeLedgerImpl(visionPath, value);

  try {
    // Global read + vision reuse check happen only AFTER lock acquired.
    const globalLedger = readLedger(ledgerPath);
    if (globalLedger.authorizationId !== AUTHORIZATION_ID) throw ERR('invalid_ledger');
    if (JSON.stringify(globalLedger.policy) !== JSON.stringify(SPEND_POLICY)) throw ERR('invalid_ledger');
    if (existsSync(visionPath)) throw ERR('vision_ledger_exists');

    const previous = globalLedger.records; // real cumulative records, never defaulted
    const savedReserved = Number(globalLedger.reservedMicros);
    let probeBudget;
    try { probeBudget = new RequestSpendBudget(SPEND_POLICY, () => {}, previous); }
    catch { throw ERR('invalid_ledger'); }
    if (probeBudget.list().length !== previous.length) throw ERR('invalid_ledger');
    if (!Number.isSafeInteger(savedReserved) || savedReserved !== probeBudget.reservedMicros) throw ERR('invalid_ledger');

    // Same chosen persist implementation for BOTH global and vision ledgers so
    // injection/fault tests observe every durable write and production stays atomic.
    const persistGlobal = (records) => {
      writeLedgerImpl(ledgerPath, {
        authorizationId: AUTHORIZATION_ID, policy: { ...SPEND_POLICY },
        reservedMicros: records.reduce((n, r) => n + r.reservedMicros, 0), records,
      });
    };
    const budget = new RequestSpendBudget(SPEND_POLICY, persistGlobal, previous);

    const abortCheck = () => { if (signal?.aborted) throw ERR('aborted'); };
    flush(visionLedger); // seed durable vision ledger BEFORE any reservation

    for (let i = 0; i < fixtures.length; i++) {
      const fixture = fixtures[i];
      abortCheck();
      const sequence = budget.list().length + 1;
      const attempt = {
        caseId: fixture.id, sequence, imageSha256: fixture.sha256, status: 'intent',
        requestedOutputTokens: MAX_OUTPUT_TOKENS, contextBytes: CONTEXT_BYTES,
        reservedMicros: EXPECTED_RESERVED_MICROS,
      };
      visionLedger.attempts.push(attempt);
      visionLedger.results[i] = { id: fixture.id, status: 'intent' };
      flush(visionLedger); // persist intent BEFORE reserve

      abortCheck();
      try { budget.reserve(CONTEXT_BYTES, MAX_OUTPUT_TOKENS); }
      catch {
        attempt.status = 'reserve_failed';
        visionLedger.results[i] = { id: fixture.id, status: 'failed', error: 'reserve_failed' };
        flush(visionLedger);
        break;
      }
      attempt.status = 'reserved';
      attempt.reservation = { ...budget.list().at(-1) };
      visionLedger.globalRecords = budget.list();
      visionLedger.results[i] = { id: fixture.id, status: 'reserved' };
      flush(visionLedger); // persist reserved BEFORE fetch

      abortCheck();
      const body = buildRequestBody(fixture);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      const onAbort = () => controller.abort();
      signal?.addEventListener?.('abort', onAbort);
      let response = null;
      try {
        response = await fetchImpl(ENDPOINT, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }, body,
        });
      } catch { response = null; }
      try {
        const outcome = await materializeResponse(response, controller.signal);
        const verdict = evaluate(fixture, outcome);
        if (verdict.usage) {
          try { budget.checkReportedUsage(verdict.usage); } catch { verdict.status = 'excessive_usage'; }
        }
        attempt.status = verdict.status;
        if (verdict.usage) attempt.usage = verdict.usage;
        const outputEvidence = serializeParsedOutput(verdict.output, apiKey);
        if (outputEvidence) {
          attempt.output = outputEvidence.value;
          if (outputEvidence.redacted) attempt.outputRedacted = true;
        }
        visionLedger.results[i] = { id: fixture.id, status: verdict.status,
          ...(verdict.usage ? { usage: verdict.usage } : {}),
          ...(outputEvidence ? { output: outputEvidence.value } : {}),
          ...(outputEvidence && outputEvidence.redacted ? { outputRedacted: true } : {}) };
      } catch {
        attempt.status = 'transport_error';
        visionLedger.results[i] = { id: fixture.id, status: 'transport_error' };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
      }
      flush(visionLedger);

      const st = visionLedger.results[i].status;
      if (st !== 'semantic_pass' && st !== 'semantic_fail') break;
    }

    const status = visionLedger.results.every((r) => r.status === 'semantic_pass') ? 'passed' : 'failed';
    visionLedger.status = status;
    flush(visionLedger);
    return { status, results: visionLedger.results, reservedMicros: budget.reservedMicros };
  } finally {
    try { if (lockFd >= 0) closeSync(lockFd); } catch {}
    try { if (lockFd >= 0 && existsSync(ownLockPath)) unlinkSync(ownLockPath); } catch {}
  }
}

export function parseCliConfig(raw) {
  let cfg;
  try { cfg = JSON.parse(raw); } catch { throw ERR('invalid_cli_config'); }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw ERR('invalid_cli_config');
  const allowed = new Set(['fixtureDir', 'totalLedgerPath', 'authorizationId']);
  for (const k of Object.keys(cfg)) if (!allowed.has(k)) throw ERR('invalid_cli_config');
  if (typeof cfg.fixtureDir !== 'string' || typeof cfg.totalLedgerPath !== 'string') throw ERR('invalid_cli_config');
  if (cfg.authorizationId !== undefined && cfg.authorizationId !== AUTHORIZATION_ID) throw ERR('invalid_cli_config');
  return { fixtureDir: cfg.fixtureDir, totalLedgerPath: cfg.totalLedgerPath, authorizationId: AUTHORIZATION_ID };
}

async function main() {
  const rawConfig = readBoundedFile(process.argv[2], CONFIG_MAX_BYTES);
  const cfg = parseCliConfig(rawConfig.toString('utf8'));
  const apiKey = process.env.APP_MODEL_API_KEY;
  const transport = createModelTransport();
  let result;
  try { result = await runVisionProbe({ ...cfg, apiKey, fetchImpl: transport.fetch }); }
  finally { try { await transport.dispose?.(); } catch {} }
  const counts = result.results.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
  process.stdout.write(JSON.stringify({ status: result.status, counts }));
  if (result.status !== 'passed') process.exitCode = 1;
}

const isEntry = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isEntry) main().catch(() => { process.exitCode = 1; });
