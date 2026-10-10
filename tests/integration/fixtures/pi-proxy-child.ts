/** Child-process fixture. Synthetic local traffic only; the caller supplies a local test proxy/CA. */
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const mode = process.argv[2];
if (mode === 'native' || mode === 'transport') {
  let dispose: (() => Promise<void>) | undefined;
  let request = globalThis.fetch;
  let unchanged = true;
  if (mode === 'transport') {
    await import('../../../apps/server/src/runtime/pi/session-factory.ts');
    const before = Object.getOwnPropertyDescriptor(globalThis, Symbol.for('undici.globalDispatcher.2'))?.value;
    const environment = JSON.stringify(process.env);
    const { createModelTransport } = await import('../../../apps/server/src/runtime/pi/model-transport.ts');
    const transport = createModelTransport();
    request = transport.fetch; dispose = transport.dispose;
    unchanged = before === Object.getOwnPropertyDescriptor(globalThis, Symbol.for('undici.globalDispatcher.2'))?.value
      && environment === JSON.stringify(process.env);
  }
  try {
    const response = await request(process.env.PROXY_TEST_URL!, { signal: AbortSignal.timeout(3000) });
    console.log(JSON.stringify({ status: response.status, body: await response.text(), unchanged }));
  } finally { await dispose?.(); }
} else {
  const { runReadProbe } = await import('../../../apps/server/src/runtime/pi/read-probe.ts');
  const { readModelConfigFromModels } = await import('../../../apps/server/src/config/env.ts');
  const { B2_LIMITS } = await import('../../../apps/server/src/runtime/pi/execution-limits.ts');
  const { loadFixture, registry } = await import('../../helpers/fixtures.ts');
  const data = loadFixture<import('../../../packages/contracts/generated/index.ts').EvidenceInput>('evidence-input.json');
  const config = readModelConfigFromModels({
    APP_MODEL_PROVIDER: 'proxy-test', APP_MODEL_ID: 'synthetic-model', APP_MODEL_API_KEY: 'synthetic-proxy-key',
  }, { providers: { 'proxy-test': {
    api: 'openai-completions', baseUrl: process.env.PROXY_TEST_URL!, compat: { maxTokensField: 'max_tokens' },
    models: [{ id: 'synthetic-model', name: 'Synthetic model' }],
  } } });
  const before = readdirSync(tmpdir()).filter(name => name.startsWith('tju-b2-session-')).sort();
  const controller = new AbortController();
  process.on('message', message => { if (message === 'abort') controller.abort(); });
  const outcome = await runReadProbe({
    config, access: { scope: data.scope, documents: data.documents }, registry,
    request: { documentId: 'doc_profile', documentVersionId: 'docv_profile_1', blockId: 'b004' },
    limits: { ...B2_LIMITS, timeoutMs: mode === 'timeout' ? 500 : 5000 }, signal: controller.signal,
  });
  const after = readdirSync(tmpdir()).filter(name => name.startsWith('tju-b2-session-')).sort();
  console.log(JSON.stringify({ ...outcome, temporaryDirectoriesUnchanged: JSON.stringify(before) === JSON.stringify(after) }));
}
process.disconnect?.();
