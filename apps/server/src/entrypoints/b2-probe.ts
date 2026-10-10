/** 显式启用的 B2 真实验收 CLI；固定读取合成资料，不自动重试或继承开发会话。 */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readModelConfig, readModelConfigFromModels } from '../config/env.ts';
import { loadSchemasFromDir } from '../../../../packages/contracts/src/schema-registry.ts';
import type { EvidenceInput } from '../../../../packages/contracts/generated/index.ts';
import { runReadProbe } from '../runtime/pi/read-probe.ts';
import { B2_LIMITS } from '../runtime/pi/execution-limits.ts';

async function main() {
  const { values } = parseArgs({ options: { live: { type: 'boolean' }, 'models-file': { type: 'string' } } });
  if (!values.live || process.env.APP_RUN_LIVE_EVAL !== '1') {
    console.error('B2 真实验收未启用：需 --live 和 APP_RUN_LIVE_EVAL=1，并事先确认 API 用量授权。');
    process.exitCode = 2;
    return;
  }
  // 可显式复用开发模型列表中的选定端点；不执行配置命令、不读列表中的 apiKey，不自动选模型。
  const env = { ...process.env };
  const config = values['models-file']
    ? readModelConfigFromModels(env, JSON.parse(await readFile(values['models-file'], 'utf8')))
    : readModelConfig(env);
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const input = JSON.parse(await readFile(join(root, 'tests/fixtures/synthetic/evidence-input.json'), 'utf8')) as EvidenceInput;
  const registry = loadSchemasFromDir(join(root, 'packages/contracts/schemas'));
  const outcome = await runReadProbe({
    config, registry, access: { scope: input.scope, documents: input.documents },
    request: { documentId: 'doc_profile', documentVersionId: 'docv_profile_1', blockId: 'b004' },
  });
  const report = {
    mode: 'live', sdkVersion: '0.99.1', provider: config.provider, model: config.modelId,
    recordedAt: new Date().toISOString(), limits: B2_LIMITS, fixture: 'synthetic/evidence-input.json', ...outcome,
  };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (env.APP_B2_REPORT_PATH) {
    await mkdir(dirname(env.APP_B2_REPORT_PATH), { recursive: true, mode: 0o700 });
    await writeFile(env.APP_B2_REPORT_PATH, json, { mode: 0o600, flag: 'wx' });
  }
  console.log(json);
  if (outcome.status !== 'completed') process.exitCode = 1;
}
main().catch(() => {
  // 配置或 SDK 异常可能带凭据、响应正文或端点；终端只显示固定诊断。
  console.error('B2 验收无法启动或保存：请检查显式配置、预算、报告路径和容器权限。未输出原始异常。');
  process.exitCode = 1;
});
