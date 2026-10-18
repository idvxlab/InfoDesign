/** A per-task gate for the existing Pi CLI; credentials stay outside the coding container. */
import { createServer } from 'node:http';
import { openSync, writeSync, fsyncSync, closeSync, renameSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { RequestSpendBudget } from '../apps/server/src/runtime/pi/spend-budget.ts';
import { createModelTransport } from '../apps/server/src/runtime/pi/model-transport.ts';
import { createDiagnosticFetch } from '../apps/server/src/runtime/pi/transport-diagnostics.ts';

export const DEV_POLICY = Object.freeze({ limitMicros: 2_000_000, safetyMicros: 200_000,
  inputCnyPerMillion: 2, outputCnyPerMillion: 8, inputTokensPerByte: 2, inputTokenOverhead: 8192 });

// Trusted-host-only authorization table. Caps outside this table are never accepted by the CLI,
// and the authorized 100m/200m/300m/400m/450m/550m caps all carry the same 10m safety (not a proportional 20m/30m/40m/45m),
// so a 300m/400m/450m/550m task can never spend more than 290m/390m/440m/540m and keeps the exact same 10m headroom. Pure and offline-testable.
export const AUTHORIZED_LIMITS = Object.freeze({
  2_000_000: 200_000, 10_000_000: 1_000_000, 100_000_000: 10_000_000, 200_000_000: 10_000_000, 300_000_000: 10_000_000, 400_000_000: 10_000_000, 450_000_000: 10_000_000, 550_000_000: 10_000_000,
});
export const CUMULATIVE_LIMITS = Object.freeze([100_000_000, 200_000_000, 300_000_000, 400_000_000, 450_000_000, 550_000_000]);

// coding 任务继续无条件使用配置输出上限（默认 4096），行为不变。
// business 任务必须由 SDK 显式声明一个合法正整数输出上限，代理只保留该值（不得超过信任代理 cap），
// 绝不把 review 的 8192 或 probe 的 1024 抬升成配置值。缺失、非法、双字段冲突或超过 cap 都在预留/上游前拒绝。
export function resolveRequestedOutputTokens({ body, toolProfile, maxOutputTokens, cap }) {
  if (toolProfile === 'coding') return { ok: true, value: maxOutputTokens, field: null };
  const hasMaxTokens = Object.prototype.hasOwnProperty.call(body, 'max_tokens');
  const hasMaxCompletionTokens = Object.prototype.hasOwnProperty.call(body, 'max_completion_tokens');
  if (hasMaxTokens && hasMaxCompletionTokens) return { ok: false, code: 'conflicting_output_token_fields' };
  if (!hasMaxTokens && !hasMaxCompletionTokens) return { ok: false, code: 'missing_output_token_fields' };
  const field = hasMaxTokens ? 'max_tokens' : 'max_completion_tokens';
  const value = body[field];
  if (!Number.isSafeInteger(value) || value <= 0) return { ok: false, code: 'invalid_output_token_limit' };
  if (value > cap) return { ok: false, code: 'output_token_limit_exceeds_cap' };
  return { ok: true, value, field };
}

/** Resolve the exact frozen policy for a trusted authorized cap; rejects any unlisted cap. */
export function resolveAuthorizedPolicy(limitMicros) {
  if (!Number.isSafeInteger(limitMicros) || !(limitMicros in AUTHORIZED_LIMITS)) throw new Error('invalid_authorized_limit');
  return Object.freeze({ ...DEV_POLICY, limitMicros, safetyMicros: AUTHORIZED_LIMITS[limitMicros] });
}

/**
 * Pure trusted-CLI config gate: requires a cumulative ledger for every cumulative cap (100m, 200m, 300m, 400m, 450m and 550m),
 * keeps the exact same ledger/authorizationId contract, and rejects a stored ledger whose
 * authorizationId, policy or record shapes do not exactly match the current task. Never migrates or
 * resets history. Takes the already-parsed stored ledger (or null) so it can be exercised offline.
 * Prior records are replayed through the real RequestSpendBudget to validate shape, sequence and
 * quote, and the stored reservedMicros total must be a safe integer equal to the validated sum.
 */
export function validateCumulativeConfig(config, policy, storedLedger) {
  if (!config || !config.totalLedgerPath || !config.authorizationId) throw new Error('cumulative_ledger_required');
  let previousReservations = [];
  if (storedLedger) {
    if (storedLedger.authorizationId !== config.authorizationId || JSON.stringify(storedLedger.policy) !== JSON.stringify(policy)) throw new Error('cumulative_authorization_mismatch');
    if (!Array.isArray(storedLedger.records) || !Number.isSafeInteger(storedLedger.reservedMicros)) throw new Error('cumulative_authorization_mismatch');
    try {
      const replay = new RequestSpendBudget(policy, () => {}, structuredClone(storedLedger.records));
      const validated = replay.list();
      const sum = validated.reduce((n, r) => n + r.reservedMicros, 0);
      if (!Array.isArray(validated) || validated.length !== storedLedger.records.length || sum !== storedLedger.reservedMicros) throw new Error('cumulative_authorization_mismatch');
      previousReservations = storedLedger.records;
    } catch { throw new Error('cumulative_authorization_mismatch'); }
  }
  return { totalLedgerPath: config.totalLedgerPath, authorizationId: config.authorizationId, previousReservations };
}

export function atomicLedger(path, value) {
  const fd = openSync(`${path}.tmp`, 'w', 0o600);
  try { writeSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(`${path}.tmp`, path);
}

export async function startBudgetProxy(options) {
  const { upstreamUrl, model, apiKey, clientToken, ledgerPath, fetchImpl = globalThis.fetch,
    timeoutMs = 900_000, maxCalls = 12, maxBodyBytes = 128_000, maxOutputTokens = 4096,
    policy = DEV_POLICY, persist = value => atomicLedger(ledgerPath, value), host = '127.0.0.1', port = 0,
    maxTokensField = 'max_tokens', previousReservations = [], requestTimeoutMs = 180_000, toolProfile = 'coding', minRequestIntervalMs = 0 } = options;
  if (!apiKey || !clientToken || !model || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 900_000
      || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > 300_000
      || !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 24
      || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 16384
      || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 256_000
      || !['max_tokens', 'max_completion_tokens'].includes(maxTokensField)
      || !Number.isSafeInteger(minRequestIntervalMs) || minRequestIntervalMs < 0 || minRequestIntervalMs > 30_000
      || !['coding', 'business'].includes(toolProfile)
      // Only the 200m, 300m, 400m, 450m and 550m authorized caps may exceed 100m; every intermediate cap stays rejected.
      || (policy.limitMicros > 100_000_000 && policy.limitMicros !== 200_000_000 && policy.limitMicros !== 300_000_000 && policy.limitMicros !== 400_000_000 && policy.limitMicros !== 450_000_000 && policy.limitMicros !== 550_000_000)) throw new Error('invalid_dev_budget_configuration');
  const startedAt = Date.now(), controller = new AbortController();
  let active = false, stopReason = null, records = structuredClone(previousReservations);
  const attempts = [];
  const allowedTools = toolProfile === 'coding' ? ['read', 'bash', 'edit', 'write'] : ['read_document', 'read_source'];
  const state = () => ({ startedAt, deadline: startedAt + timeoutMs, policy, maxCalls, maxOutputTokens, maxBodyBytes, toolProfile, minRequestIntervalMs,
    reservedMicros: records.reduce((n, r) => n + r.reservedMicros, 0), records, attempts, stopReason });
  const save = () => persist(state());
  const stop = reason => { if (!stopReason) stopReason = reason; controller.abort(); try { save(); } catch {} };
  const budget = new RequestSpendBudget(policy, next => { persist({ ...state(), records: next,
    reservedMicros: next.reduce((n, r) => n + r.reservedMicros, 0) }); records = [...next]; }, previousReservations);
  save(); // No server / network if the ledger cannot be initialized.
  const timer = setTimeout(() => stop('timeout'), timeoutMs);
  const server = createServer(async (req, res) => {
    const reply = (status, code) => { if (!res.destroyed && !res.headersSent) res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: code, type: 'budget_gate' } })); };
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { reply(404, 'unsupported_endpoint'); return; }
    if (req.headers.authorization !== `Bearer ${clientToken}`) { reply(401, 'unauthorized'); return; }
    if (stopReason || Date.now() >= startedAt + timeoutMs) { if (!stopReason) stop('timeout'); reply(429, stopReason); return; }
    if (active) { reply(409, 'parallel_request_denied'); return; }
    active = true;
    let attempt, requestTimer;
    const disconnect = () => { if (!res.writableEnded) stop('client_disconnected'); };
    res.once('close', disconnect);
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > maxBodyBytes) throw new Error('request_too_large'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.model !== model || !Array.isArray(body.messages) || !body.messages.length || body.n > 1
          || body.messages.some(m => m.content != null && typeof m.content !== 'string'
            && (!Array.isArray(m.content) || m.content.some(c => c.type !== 'text' || typeof c.text !== 'string')))
          || (body.tools ?? []).some(t => t.type !== 'function' || !allowedTools.includes(t.function?.name))) throw new Error('unsupported_request');
      if (body.stream !== true) throw new Error('stream_required');
      // business 保留 SDK 声明的合法输出上限；coding 依旧使用配置值。预留、持久化与上游都必须按最终值。
      const requested = resolveRequestedOutputTokens({ body, toolProfile, maxOutputTokens, cap: maxOutputTokens });
      if (!requested.ok) throw new Error(requested.code);
      const upstreamOutputTokens = requested.value;
      delete body.max_tokens; delete body.max_completion_tokens;
      // 配置字段决定上游写入哪个字段名（两字段名兼容转换），值始终是被保留/校验过的输出上限。
      body[maxTokensField] = upstreamOutputTokens;
      const payload = JSON.stringify(body), contextBytes = Buffer.byteLength(payload);
      if (contextBytes > maxBodyBytes || stopReason || Date.now() >= startedAt + timeoutMs) throw new Error(stopReason ?? 'context_or_time_limit');
      if (attempts.length >= maxCalls) { stop('request_limit'); reply(429, stopReason); return; }
      const waitMs = attempts.length ? minRequestIntervalMs - (Date.now() - attempts.at(-1).startedAt) : 0;
      if (waitMs > 0) await delay(waitMs, undefined, { signal: controller.signal });
      if (stopReason || Date.now() >= startedAt + timeoutMs) throw new Error(stopReason ?? 'context_or_time_limit');
      // 预留金额按最终实际上游输出上限计算，确保账本与真实请求一致。
      try { budget.reserve(contextBytes, upstreamOutputTokens); }
      catch (error) { stop(error.code ?? 'budget_failed'); reply(429, stopReason); return; }
      attempt = { sequence: attempts.length + 1, startedAt: Date.now(), status: null, outputTokens: upstreamOutputTokens, completed: false, transport: { attempts: 0, httpStatuses: [], failureCodes: [] } };
      attempts.push(attempt);
      save(); // The individual HTTP attempt must also be durable before forwarding.
      requestTimer = setTimeout(() => stop('upstream_timeout'), requestTimeoutMs);
      const upstream = await createDiagnosticFetch(fetchImpl, attempt.transport)(upstreamUrl, { method: 'POST', headers: {
        'content-type': 'application/json', authorization: `Bearer ${apiKey}`,
      }, body: payload, redirect: 'error', signal: controller.signal });
      attempt.status = upstream.status;
      if (!upstream.ok || !upstream.body) {
        // Keep only bounded, credential-redacted diagnostic fields; never persist a request body.
        if (upstream.body) {
          const pieces = []; let bytes = 0;
          for await (const chunk of upstream.body) { bytes += chunk.length; if (bytes > 8192) break; pieces.push(chunk); }
          try {
            const parsed = JSON.parse(Buffer.concat(pieces).toString('utf8'));
            const error = parsed.error ?? parsed;
            attempt.diagnostic = Object.fromEntries(['code', 'type', 'param', 'message'].filter(k => typeof error[k] === 'string')
              .map(k => [k, error[k].split(apiKey).join('[redacted]').replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 400)]));
          } catch {}
        }
        stop('upstream_failed'); reply(502, stopReason); return;
      }
      res.writeHead(200, { 'content-type': upstream.headers.get('content-type') || 'text/event-stream', 'cache-control': 'no-store' });
      // Pi may close as soon as it sees [DONE], before the upstream HTTP body closes.
      // Persist terminal framing before forwarding it; a real premature disconnect still stops.
      const decoder = new TextDecoder(); let pendingLine = '', terminal = false;
      for await (const chunk of upstream.body) {
        pendingLine += decoder.decode(chunk, { stream: true });
        const lines = pendingLine.split('\n'); pendingLine = lines.pop() ?? '';
        if (pendingLine.length > 128_000) throw new Error('upstream_line_limit');
        terminal = lines.some(line => /^data: ?\[DONE\]\r?$/.test(line));
        if (terminal) {
          attempt.completed = true; attempt.endedAt = Date.now(); save(); res.end(chunk); break;
        }
        if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
      }
      if (!terminal) throw new Error('upstream_incomplete');
    } catch (error) {
      const known = new Set(['request_too_large', 'unsupported_request', 'stream_required', 'context_or_time_limit',
        'missing_output_token_fields', 'conflicting_output_token_fields', 'invalid_output_token_limit', 'output_token_limit_exceeds_cap']);
      stop(known.has(error.message) ? error.message : (stopReason ?? 'request_failed'));
      reply(502, stopReason); if (res.headersSent && !res.writableEnded) res.destroy();
    } finally { clearTimeout(requestTimer); active = false; res.off('close', disconnect); }
  });
  server.requestTimeout = Math.min(timeoutMs, 30_000);
  server.headersTimeout = Math.min(timeoutMs, 10_000);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return { server, state, stop, address: `http://${host}:${server.address().port}/v1/chat/completions`,
    async close() { clearTimeout(timer); stop('closed'); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Only trusted host configuration reaches this process; the coding container never mounts it.
  const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const endpoint = new URL(config.upstreamUrl);
  if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'apicz.boyuerichdata.com'
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || config.model !== 'deepseek-v4.1-flash' || existsSync(config.ledgerPath)) throw new Error('invalid_or_reused_task');
  const lock = openSync(`${config.ledgerPath}.lock`, 'wx', 0o600); closeSync(lock);
  const limitMicros = config.limitMicros ?? DEV_POLICY.limitMicros;
  const policy = resolveAuthorizedPolicy(limitMicros);
  let previousReservations = [], globalLock;
  if (CUMULATIVE_LIMITS.includes(limitMicros)) {
    // Presence check is fine before locking, but the ledger must be read only AFTER we hold the
    // exclusive global lock, so another owner cannot finish between our read and our lock and have
    // a fresh run overwrite their history.
    globalLock = `${config.totalLedgerPath}.lock`;
    const fd = openSync(globalLock, 'wx', 0o600); closeSync(fd);
    let cumulative;
    try {
      const storedLedger = config.totalLedgerPath && existsSync(config.totalLedgerPath) ? JSON.parse(readFileSync(config.totalLedgerPath, 'utf8')) : null;
      cumulative = validateCumulativeConfig(config, policy, storedLedger);
      previousReservations = cumulative.previousReservations;
    } catch (error) { unlinkSync(globalLock); throw error; }
  }
  const persist = state => {
    if (config.totalLedgerPath) atomicLedger(config.totalLedgerPath, { authorizationId: config.authorizationId,
      policy, records: state.records, reservedMicros: state.reservedMicros });
    atomicLedger(config.ledgerPath, state);
  };
  const transport = createModelTransport();
  const gate = await startBudgetProxy({ upstreamUrl: endpoint.href, model: config.model,
    policy, previousReservations, persist, maxCalls: config.maxCalls ?? 12,
    maxOutputTokens: config.maxOutputTokens ?? 4096, maxBodyBytes: config.maxBodyBytes ?? 128_000,
    toolProfile: config.toolProfile ?? 'coding', minRequestIntervalMs: config.minRequestIntervalMs ?? 0, apiKey: process.env.APP_MODEL_API_KEY, clientToken: config.clientToken, ledgerPath: config.ledgerPath,
    fetchImpl: transport.fetch, maxTokensField: config.maxTokensField ?? 'max_tokens', host: '0.0.0.0', port: 8080 });
  console.log(JSON.stringify({ ready: true, limitCny: policy.limitMicros / 1e6, safetyCny: policy.safetyMicros / 1e6, maxCalls: config.maxCalls ?? 12, maxOutputTokens: config.maxOutputTokens ?? 4096, timeoutSeconds: 900 }));
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await gate.close(); await transport.dispose(); if (globalLock) unlinkSync(globalLock); process.exit(0); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
}
