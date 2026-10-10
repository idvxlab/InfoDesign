/** B3 真实验收入口：仅固定合成资料；双开关、显式私有报告路径，默认不调用模型。 */
import { readFile, mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readModelConfig, readModelConfigFromModels } from '../config/env.ts';
import { loadSchemasFromDir } from '../../../../packages/contracts/src/schema-registry.ts';
import type { EvidenceInput } from '../../../../packages/contracts/generated/index.ts';
import { EVIDENCE_LIMITS } from '../runtime/pi/execution-limits.ts';
import { runEvidenceAgent } from '../agents/evidence/agent.ts';
import { MemoryCandidateStore } from '../domain/evidence.service.ts';

async function main() {
  const { values } = parseArgs({ options: { live: { type: 'boolean' }, 'models-file': { type: 'string' } } });
  if (!values.live || process.env.APP_RUN_LIVE_EVAL !== '1') {
    console.error('B3 真实验收未启用：需 --live 和 APP_RUN_LIVE_EVAL=1，并事先确认单次任务的 API 用量授权。');
    process.exitCode = 2; return;
  }
  const env = { ...process.env };
  if (!env.APP_B3_REPORT_PATH) throw new Error('private_report_path_required');
  const config = values['models-file']
    ? readModelConfigFromModels(env, JSON.parse(await readFile(values['models-file'], 'utf8')))
    : readModelConfig(env);
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const input = JSON.parse(await readFile(join(root, 'tests/fixtures/synthetic/b3-evidence-input.json'), 'utf8')) as EvidenceInput;
  const registry = loadSchemasFromDir(join(root, 'packages/contracts/schemas'));
  await mkdir(dirname(env.APP_B3_REPORT_PATH), { recursive: true, mode: 0o700 });
  // 请求前确认报告路径可创建；不覆盖已有验收记录。
  const file = await open(env.APP_B3_REPORT_PATH, 'wx', 0o600);
  const store = new MemoryCandidateStore();
  try {
    const outcome = await runEvidenceAgent({ input, config, registry, store });
    const report = {
      mode: 'live', sdkVersion: '0.99.1', provider: config.provider, model: config.modelId,
      recordedAt: new Date().toISOString(), limits: EVIDENCE_LIMITS, maxRepairRounds: 1,
      fixture: 'synthetic/b3-evidence-input.json', ...outcome, candidates: store.list(),
      validationBoundary: '程序结构与来源检查；语义预期仍须对照合成资料独立核验，未执行独立审查 Agent。',
    };
    await file.writeFile(JSON.stringify(report, null, 2) + '\n');
    // 终端仅汇总；模型原文、失败候选、来源内容保存在私有报告中。
    console.log(JSON.stringify({
      status: outcome.status, reason: outcome.reason, candidateVersionId: outcome.candidateVersionId,
      modelCalls: outcome.modelCalls, toolCalls: outcome.toolCalls, successfulReads: outcome.successfulReads,
      repairAttempts: outcome.repairAttempts, finalStopReason: outcome.finalStopReason,
      elapsedMs: outcome.elapsedMs, usage: outcome.usage, billedAmount: null,
      resourcesDisposed: outcome.resourcesDisposed, transport: outcome.transport,
    }, null, 2));
    if (!outcome.candidateVersionId || !['completed', 'needs_information'].includes(outcome.status)) process.exitCode = 1;
  } finally { await file.close(); }
}
main().catch(() => {
  console.error('B3 验收无法启动或保存：请检查显式配置、私有报告路径和容器权限。未输出原始异常。');
  process.exitCode = 1;
});
