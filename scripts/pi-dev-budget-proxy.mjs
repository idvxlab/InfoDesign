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
      || policy.limitMicros > 100_000_000) throw new Error('invalid_dev_budget_configuration');
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
      delete body.max_tokens; delete body.max_completion_tokens;
      body[maxTokensField] = maxOutputTokens;
      const payload = JSON.stringify(body), contextBytes = Buffer.byteLength(payload);
      if (contextBytes > maxBodyBytes || stopReason || Date.now() >= startedAt + timeoutMs) throw new Error(stopReason ?? 'context_or_time_limit');
      if (attempts.length >= maxCalls) { stop('request_limit'); reply(429, stopReason); return; }
      const waitMs = attempts.length ? minRequestIntervalMs - (Date.now() - attempts.at(-1).startedAt) : 0;
      if (waitMs > 0) await delay(waitMs, undefined, { signal: controller.signal });
      if (stopReason || Date.now() >= startedAt + timeoutMs) throw new Error(stopReason ?? 'context_or_time_limit');
      try { budget.reserve(contextBytes, maxOutputTokens); }
      catch (error) { stop(error.code ?? 'budget_failed'); reply(429, stopReason); return; }
      attempt = { sequence: attempts.length + 1, startedAt: Date.now(), status: null, completed: false, transport: { attempts: 0, httpStatuses: [], failureCodes: [] } };
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
      const known = new Set(['request_too_large', 'unsupported_request', 'stream_required', 'context_or_time_limit']);
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
  if (![2_000_000, 10_000_000, 100_000_000].includes(limitMicros)) throw new Error('invalid_authorized_limit');
  const policy = { ...DEV_POLICY, limitMicros, safetyMicros: limitMicros / 10 };
  let previousReservations = [], globalLock;
  if (limitMicros === 100_000_000) {
    if (!config.totalLedgerPath || !config.authorizationId) throw new Error('cumulative_ledger_required');
    globalLock = `${config.totalLedgerPath}.lock`;
    const fd = openSync(globalLock, 'wx', 0o600); closeSync(fd);
    if (existsSync(config.totalLedgerPath)) {
      const saved = JSON.parse(readFileSync(config.totalLedgerPath, 'utf8'));
      if (saved.authorizationId !== config.authorizationId || JSON.stringify(saved.policy) !== JSON.stringify(policy)) throw new Error('cumulative_authorization_mismatch');
      previousReservations = saved.records;
    }
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
