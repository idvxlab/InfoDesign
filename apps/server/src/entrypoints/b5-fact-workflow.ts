/** B5 真实验收入口：固定合成资料上的完整受控工作流。
 *  双开关：除 --live 外还须 APP_RUN_LIVE_EVAL=1；二者任一缺失即退出 2，绝不发起任何 HTTP。
 *  只使用既有外部预算代理（只读预检 + 每次请求由代理控制花费）；本入口不新建预算、不写账本。
 *  私有 JSON 报告在发起 HTTP 之前以独占（'wx'）方式创建；业务失败时报告仍会保存。
 *  默认不调用模型。 */
import { mkdir, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readModelConfig } from '../config/env.ts';
import { loadSchemasFromDir } from '../../../../packages/contracts/src/schema-registry.ts';
import { runFactWorkflow } from '../orchestration/fact-workflow.ts';
import { MemoryCandidateStore } from '../domain/evidence.service.ts';
import { MemoryReviewStore } from '../domain/review.service.ts';
import { FileSystemFactRunStore } from '../domain/fact-run.service.ts';
import { readExternalBudgetGate } from '../runtime/pi/external-budget-gate.ts';
import { makeB5Case } from '../../../../evals/fixtures/b5-cases.ts';

const MAX_REPAIR_ROUNDS = 2;

class B5StartupError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'B5StartupError';
    this.code = code;
  }
}

function fail(code: string): never {
  throw new B5StartupError(code);
}

interface AttemptLike {
  kind: 'extract' | 'review' | 'repair' | string;
  sessionId?: string;
  successfulReads: number;
  modelCalls: number;
  resourcesDisposed: boolean;
}

async function main() {
  const { values } = parseArgs({
    options: {
      live: { type: 'boolean' },
      case: { type: 'string' },
      'budget-loopback': { type: 'boolean' },
    },
  });

  // ---- 双开关护栏：任何 HTTP 或报告创建之前先判定；缺一即退出 2。 ----
  if (!values.live || process.env.APP_RUN_LIVE_EVAL !== '1') {
    console.error('B5 真实验收未启用：需 --live 和 APP_RUN_LIVE_EVAL=1。');
    process.exitCode = 2;
    return;
  }

  const env = { ...process.env };

  // 明确已知的用例 ID。
  const caseId = values.case;
  if (typeof caseId !== 'string' || caseId.length === 0) fail('b5_case_required');
  const fixture = makeB5Case(caseId);

  // 回环预算必须显式为真；否则绝不进入 HTTP。
  if (values['budget-loopback'] !== true) fail('b5_budget_loopback_required');

  // 必需的显式环境变量。
  const reportPath = env.APP_B5_REPORT_PATH;
  const runDir = env.APP_B5_RUN_DIR;
  const taskLedgerPath = env.APP_B5_TASK_LEDGER_PATH;
  const totalLedgerPath = env.APP_B5_TOTAL_LEDGER_PATH;
  const authorizationId = env.APP_B5_AUTHORIZATION_ID;
  if (!reportPath) fail('b5_report_path_required');
  if (!runDir) fail('b5_run_dir_required');
  if (!taskLedgerPath) fail('b5_task_ledger_path_required');
  if (!totalLedgerPath) fail('b5_total_ledger_path_required');
  if (!authorizationId) fail('b5_authorization_id_required');

  // 仅回环 HTTP 允许；不读取 models-file，也不回退到直连网关。
  const config = readModelConfig(env, { allowLoopbackHttp: true });

  // 只读预检既有外部预算代理；绝不写入/预留/释放账本，也不新建预算。
  const before = readExternalBudgetGate({
    config,
    authorizationId,
    taskLedgerPath,
    totalLedgerPath,
    phase: 'before',
  });

  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const registry = loadSchemasFromDir(join(repoRoot, 'packages/contracts/schemas'));

  const candidateStore = new MemoryCandidateStore();
  const reviewStore = new MemoryReviewStore();
  const runStore = new FileSystemFactRunStore(runDir, fixture.input.projectId);

  // 在发起任何 HTTP 之前先独占创建报告（不覆盖既有记录）。父目录 0700，文件 0600。
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
  const reportFile = await open(reportPath, 'wx', 0o600);

  try {
    const result = await runFactWorkflow({
      input: fixture.input,
      config,
      registry,
      candidateStore,
      reviewStore,
      runStore,
      maxRepairRounds: MAX_REPAIR_ROUNDS,
      signal: AbortSignal.timeout(Math.max(1, before.deadline - Date.now())),
      ...(fixture.seed ? { evaluationSeed: fixture.seed } : {}),
    });

    // 工作流结束后重新读取既有预算代理（after 阶段）；只读，不写账本。
    const after = readExternalBudgetGate({
      config,
      authorizationId,
      taskLedgerPath,
      totalLedgerPath,
      phase: 'after',
    });

    const attempts = (result.record?.attempts ?? []) as ReadonlyArray<AttemptLike>;
    const candidates = candidateStore.list();
    const acceptance = gradeAcceptance({
      fixture,
      result,
      attempts,
      candidateStates: candidates.map((c) => c.state),
    });

    const report = {
      caseId: fixture.caseId,
      syntheticOnly: true as const,
      seededForEvaluation: fixture.seededForEvaluation,
      seedOrigin: fixture.seededForEvaluation ? 'manual synthetic fixture' : null,
      input: fixture.input,
      result,
      candidates,
      reports: reviewStore.list(),
      externalBudget: {
        before,
        after,
        deltaReservedMicros: after.reservedMicros - before.reservedMicros,
        currency: 'CNY' as const,
        billedAmount: null,
      },
      acceptance: {
        expectedStatus: fixture.expectedStatus,
        passed: acceptance.passed,
      },
    };

    // report.result.record/artifacts 已包含全部历史与产物（含每次尝试的 kinds/会话/读取/调用/释放）。
    await reportFile.writeFile(JSON.stringify(report, null, 2) + '\n');
    process.exitCode = acceptance.passed ? 0 : 1;
  } finally {
    await reportFile.close();
  }
}

export interface GradeArgs {
  fixture: ReturnType<typeof makeB5Case>;
  result: Awaited<ReturnType<typeof runFactWorkflow>>;
  attempts: ReadonlyArray<AttemptLike>;
  candidateStates: ReadonlyArray<'invalid' | 'pending_review'>;
}

/** 分级：仅决定报告内 acceptance.passed 与退出码，不改变工作流自身判定。 */
export function gradeAcceptance({ fixture, result, attempts, candidateStates }: GradeArgs): { passed: boolean } {
  void result;
  // 仅 result.status 相符不足以通过；必须有原始尝试证据。
  if (attempts.length === 0) return { passed: false };
  if (result.status !== fixture.expectedStatus) return { passed: false };

  // 所有候选必须处于 pending_review（无 invalid）。
  if (candidateStates.length === 0) return { passed: false };
  if (candidateStates.some((state) => state !== 'pending_review')) return { passed: false };

  const extractAttempts = attempts.filter((a) => a.kind === 'extract');
  const reviewAttempts = attempts.filter((a) => a.kind === 'review');
  const repairAttempts = attempts.filter((a) => a.kind === 'repair');

  // 所有实际发生的尝试必须共享同一真实会话证据约束：会话 ID 非空且互不重复，
  // 真实读取 > 0、真实模型调用 > 0，且资源全部释放。both branches 都要满足。
  const sessionIds = attempts.map((a) => a.sessionId ?? '');
  if (sessionIds.some((id) => id.length === 0)) return { passed: false };
  if (new Set(sessionIds).size !== sessionIds.length) return { passed: false };
  for (const attempt of attempts) {
    if (!(attempt.successfulReads > 0)) return { passed: false };
    if (!(attempt.modelCalls > 0)) return { passed: false };
    if (!attempt.resourcesDisposed) return { passed: false };
  }

  if (fixture.seededForEvaluation) {
    // 种子验收：种子刻意跳过抽取，故必须零抽取；且必须发生返修，
    // 顺序为 review -> repair -> review，最后一次审查在返修之后。
    if (extractAttempts.length !== 0) return { passed: false };
    if (result.repairRounds < 1) return { passed: false };
    if (repairAttempts.length < 1 || reviewAttempts.length < 2) return { passed: false };
    const kinds = attempts.map((a) => a.kind);
    const firstReview = kinds.indexOf('review');
    const firstRepair = kinds.indexOf('repair');
    const lastReview = kinds.lastIndexOf('review');
    if (firstReview < 0 || firstRepair < 0) return { passed: false };
    if (!(firstReview < firstRepair)) return { passed: false };
    if (!(firstRepair < lastReview)) return { passed: false };
  } else {
    // 非种子用例：真实抽取（>=1）+ 真实审查。
    // 初始正常的 correct/missing 用例只发生一次审查（提取 → 审查 → 决策）；
    // 允许仅一次审查（>=1）。种子分支仍要求 >=2。
    if (extractAttempts.length < 1) return { passed: false };
    if (reviewAttempts.length < 1) return { passed: false };
  }

  return { passed: true };
}

// 仅在作为脚本直接运行时执行 main()；被导入时绝不启动工作流、绝不发起 HTTP。
if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) {
  main().catch((error: unknown) => {
    // 仅输出经过处理的一般性提示，不回显原始异常、配置或密钥。
    void error;
    console.error('B5 验收无法启动或保存：请检查显式配置、私有报告路径和容器权限。未输出原始异常。');
    process.exitCode = 1;
  });
}