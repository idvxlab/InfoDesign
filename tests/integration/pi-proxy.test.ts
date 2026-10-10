/** Real SDK, local HTTPS gateway and CONNECT proxy. Run in the network-disabled development container. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { once } from 'node:events';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDocumentReader } from '../../apps/server/src/runtime/pi/read-document-tool.ts';
import type { EvidenceInput } from '../../packages/contracts/generated/index.ts';
import type { ProbeOutcome } from '../../apps/server/src/runtime/pi/read-probe.ts';
import { loadFixture, registry } from '../helpers/fixtures.ts';

const fixture = loadFixture<EvidenceInput>('evidence-input.json');
const readRequest = { documentId: 'doc_profile', documentVersionId: 'docv_profile_1', blockId: 'b004' };
const expected = createDocumentReader({ scope: fixture.scope, documents: fixture.documents }, registry)(readRequest);
let certificateDirectory: string;
before(() => {
  certificateDirectory = mkdtempSync(join(tmpdir(), 'tju-proxy-tls-'));
  // Ephemeral test CA: trusted only by the child, never disable TLS verification or change system trust.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-keyout', join(certificateDirectory, 'key.pem'), '-out', join(certificateDirectory, 'cert.pem'),
    '-subj', '/CN=b2-target.invalid', '-addext', 'subjectAltName=DNS:b2-target.invalid,IP:127.0.0.1'], { stdio: 'ignore' });
});
after(() => rmSync(certificateDirectory, { recursive: true, force: true }));

type Body = { max_tokens?: number; max_completion_tokens?: number; messages: Array<{ role: string }> };
function reply(res: ServerResponse, body: Body) {
  const hasRead = body.messages.some(message => message.role === 'tool');
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const delta = hasRead ? { role: 'assistant', content: JSON.stringify(expected) }
    : { role: 'assistant', tool_calls: [{ index: 0, id: 'call_proxy', type: 'function', function: { name: 'read_document', arguments: JSON.stringify(readRequest) } }] };
  res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model: 'synthetic-model', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model: 'synthetic-model', choices: [{ index: 0, delta: {}, finish_reason: hasRead ? 'stop' : 'tool_calls' }] })}\n\n`);
  res.end('data: [DONE]\n\n');
}
async function mockNetwork(options: { proxyStatus?: number; gatewayStatus?: number; hangTunnel?: boolean; hangResponse?: boolean; dropResponse?: boolean } = {}) {
  const sockets = new Set<Duplex>();
  const requests: Body[] = [];
  const targets: string[] = [];
  let child: ChildProcess | undefined;
  let abortOnRequest = false;
  const gateway = createHttpsServer({ key: readFileSync(join(certificateDirectory, 'key.pem')), cert: readFileSync(join(certificateDirectory, 'cert.pem')) }, async (req, res) => {
    if (req.method === 'GET') { res.end('local-proxy'); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    assert.equal(req.headers.authorization, 'Bearer synthetic-proxy-key');
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Body;
    requests.push(body);
    if (abortOnRequest) child?.send('abort');
    if (options.dropResponse) { req.socket.destroy(); return; }
    if (options.hangResponse) return;
    if (options.gatewayStatus) { res.writeHead(options.gatewayStatus); res.end('synthetic-gateway-error'); return; }
    reply(res, body);
  });
  const track = (socket: Duplex) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); };
  gateway.on('connection', track);
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const gatewayAddress = gateway.address(); assert.ok(gatewayAddress && typeof gatewayAddress !== 'string');
  const proxy = createServer((_req, res) => { res.writeHead(405); res.end(); });
  proxy.on('connection', track);
  proxy.on('connect', (req, socket, head) => {
    targets.push(req.url ?? '');
    if (options.hangTunnel) return;
    if (options.proxyStatus) { socket.end(`HTTP/1.1 ${options.proxyStatus} Synthetic failure\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`); return; }
    // No DNS or external connection: every synthetic target goes to this local gateway only.
    const upstream = connect(gatewayAddress.port, '127.0.0.1'); track(upstream);
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    upstream.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    socket.on('close', () => upstream.destroy()); upstream.on('close', () => socket.destroy());
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const proxyAddress = proxy.address(); assert.ok(proxyAddress && typeof proxyAddress !== 'string');
  const proxyUrl = `http://127.0.0.1:${proxyAddress.port}`;
  return {
    requests, targets, proxyUrl, gatewayUrl: `https://127.0.0.1:${gatewayAddress.port}/v1`,
    async run(mode: string, env: Record<string, string> = {}, abort = false) {
      abortOnRequest = abort;
      child = spawn(process.execPath, ['tests/integration/fixtures/pi-proxy-child.ts', mode], {
        cwd: new URL('../../', import.meta.url), timeout: 10_000,
        env: { PATH: process.env.PATH, TMPDIR: certificateDirectory, NODE_USE_ENV_PROXY: '1', NODE_EXTRA_CA_CERTS: join(certificateDirectory, 'cert.pem'),
          HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: '', PROXY_TEST_URL: 'https://b2-target.invalid/v1', ...env },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      let stdout = '', stderr = '';
      child.stdout!.on('data', chunk => stdout += chunk); child.stderr!.on('data', chunk => stderr += chunk);
      const [code, signal] = await once(child, 'exit');
      assert.equal(code, 0, JSON.stringify({ mode, signal, stderr }));
      assert.equal(stdout.includes('synthetic-proxy-key'), false);
      return JSON.parse(stdout) as ProbeOutcome & { temporaryDirectoriesUnchanged: boolean; body: string; unchanged: boolean };
    },
    async close() {
      child?.kill(); for (const socket of sockets) socket.destroy();
      await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => gateway.close(() => resolve()))]);
    },
  };
}
async function scenario(options: Parameters<typeof mockNetwork>[0], body: (mock: Awaited<ReturnType<typeof mockNetwork>>) => Promise<void>) {
  const mock = await mockNetwork(options);
  try { await body(mock); } finally { await mock.close(); }
}
function released(outcome: ProbeOutcome & { temporaryDirectoriesUnchanged: boolean }) {
  assert.equal(outcome.resourcesDisposed, true); assert.equal(outcome.temporaryDirectoriesUnchanged, true);
}

test('Proxy: native fetch before SDK import and explicit transport after import both use the existing HTTPS proxy', async () => {
  await scenario({}, async mock => {
    for (const mode of ['native', 'transport']) {
      const result = await mock.run(mode);
      assert.equal(result.status, 200); assert.equal(result.body, 'local-proxy'); assert.equal(result.unchanged, true);
    }
    assert.deepEqual(mock.targets, ['b2-target.invalid:443', 'b2-target.invalid:443']);
  });
});
test('Proxy: real SDK tool read succeeds through CONNECT with max_tokens and no extra model calls', async () => {
  await scenario({}, async mock => {
    const outcome = await mock.run('probe', { HTTP_PROXY: 'http://127.0.0.1:1' }); released(outcome);
    assert.equal(outcome.status, 'completed', JSON.stringify(outcome));
    assert.equal(outcome.modelCalls, 2); assert.equal(outcome.toolCalls, 1); assert.deepEqual(outcome.result, expected);
    assert.equal(mock.requests.length, 2);
    assert.deepEqual(outcome.transport, { attempts: 2, httpStatuses: [200, 200], failureCodes: [] });
    for (const body of mock.requests) { assert.equal(body.max_tokens, 1024); assert.equal(body.max_completion_tokens, undefined); }
  });
});
test('Proxy: lowercase settings take precedence and explicit NO_PROXY keeps a local bypass', async () => {
  await scenario({}, async mock => {
    const first = await mock.run('probe', { HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', http_proxy: mock.proxyUrl, https_proxy: mock.proxyUrl });
    assert.equal(first.status, 'completed'); released(first);
    const tunnels = mock.targets.length;
    const second = await mock.run('probe', { HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1', PROXY_TEST_URL: mock.gatewayUrl });
    assert.equal(second.status, 'completed'); released(second); assert.equal(mock.targets.length, tunnels);
  });
});
test('Proxy: CONNECT denial never falls back to a reachable destination or retries', async () => {
  for (const proxyStatus of [403, 407, 502]) await scenario({ proxyStatus }, async mock => {
    const outcome = await mock.run('probe', { PROXY_TEST_URL: mock.gatewayUrl }); released(outcome);
    assert.equal(outcome.reason, 'provider_failed'); assert.equal(outcome.modelCalls, 1); assert.equal(outcome.transport.attempts, 1);
    assert.equal(mock.targets.length, 1); assert.equal(mock.requests.length, 0);
  });
});
test('Proxy: gateway errors and dropped POST responses do not trigger hidden retries', async () => {
  for (const options of [{ gatewayStatus: 401 }, { gatewayStatus: 429 }, { gatewayStatus: 500 }, { dropResponse: true }]) await scenario(options, async mock => {
    const outcome = await mock.run('probe'); released(outcome);
    assert.equal(outcome.reason, 'provider_failed'); assert.equal(outcome.modelCalls, 1); assert.equal(outcome.transport.attempts, 1);
    assert.equal(mock.requests.length, 1); assert.equal(mock.targets.length, 1);
    if (options.gatewayStatus) assert.deepEqual(outcome.transport.httpStatuses, [options.gatewayStatus]);
  });
});
test('Proxy: caller cancellation aborts an in-flight HTTPS response and releases session resources', async () => {
  await scenario({ hangResponse: true }, async mock => {
    const outcome = await mock.run('probe', {}, true); released(outcome);
    assert.equal(outcome.reason, 'cancelled'); assert.equal(outcome.transport.attempts, 1);
    assert.equal(mock.requests.length, 1); assert.equal(mock.targets.length, 1); assert.ok(outcome.elapsedMs < 3000);
  });
});
test('Proxy: budget timeout aborts a stalled CONNECT without contacting the gateway or retrying', async () => {
  await scenario({ hangTunnel: true }, async mock => {
    const outcome = await mock.run('timeout'); released(outcome);
    assert.equal(outcome.reason, 'timeout'); assert.equal(outcome.transport.attempts, 1);
    assert.equal(mock.targets.length, 1); assert.equal(mock.requests.length, 0); assert.ok(outcome.elapsedMs < 3000);
  });
});
test('Proxy: untrusted HTTPS certificates remain rejected', async () => {
  await scenario({}, async mock => {
    const outcome = await mock.run('probe', { NODE_EXTRA_CA_CERTS: '' }); released(outcome);
    assert.equal(outcome.reason, 'provider_failed'); assert.equal(outcome.transport.attempts, 1);
    assert.equal(mock.requests.length, 0); assert.equal(mock.targets.length, 1);
    assert.ok(outcome.transport.failureCodes.includes('DEPTH_ZERO_SELF_SIGNED_CERT'));
  });
});
