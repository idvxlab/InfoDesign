/** B4 纯虚构真实模型验收 CLI：默认关闭；双开关 + 显式私有报告路径。
 *
 *  仅使用固定合成资料；未启用时不读取模型配置、不创建报告、不调用模型。
 *  报告为私有文件；终端只打印汇总，模型原文与输入只进私有报告。
 */
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { readModelConfig } from '../apps/server/src/config/env.ts';
import { REVIEW_LIMITS } from '../apps/server/src/runtime/pi/execution-limits.ts';
import { runReviewAgent } from '../apps/server/src/agents/review/agent.ts';
import { MemoryReviewStore } from '../apps/server/src/domain/review.service.ts';
import { registry } from '../tests/helpers/fixtures.ts';
import { B4_CASE_IDS, makeB4Case, type B4Expected } from './fixtures/b4-cases.ts';

interface GradeInput {
  outcome: Record<string, unknown>;
  report: unknown;
  expected: B4Expected;
  inputUnchanged: boolean;
  snapshotUnchanged: boolean;
}

interface GradeResult {
  passed: boolean;
  parts: Record<string, boolean>;
  verdict: string | null;
}

/** 把任意引用字段归一为字符串数组，兼容多种可能的字段命名。 */
function asStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => String(item));
  if (typeof value === 'string') return [value];
  return [];
}

/**
 * 一致性检查，不是真相证明：若一个 error/critical 的 value/unit/time/basis/entity_match
 * 类问题同时把 expected 与 actual 写成去除首尾空白后完全相同的字符串，则该问题自相矛盾，
 * 说明模型虽在散文中指出了数值不一致，结构化字段却没有真正区分两者。
 *
 * 仅当两个字段都是字符串且 trim 后相等时判为矛盾；缺失、非字符串或不等一律不算
 * （不臆造、不填充缺失字段，也不因缺字段而拒绝）。
 */
function hasContradictoryMismatch(issue: Record<string, unknown>): boolean {
  const severity = String(issue.severity ?? issue.level ?? '');
  if (severity !== 'error' && severity !== 'critical') return false;

  const category = issue.category ?? issue.checkType;
  if (
    category !== 'value'
    && category !== 'unit'
    && category !== 'time'
    && category !== 'basis'
    && category !== 'entity_match'
  ) {
    return false;
  }

  const expectedValue = issue.expected;
  const actualValue = issue.actual;
  if (typeof expectedValue !== 'string' || typeof actualValue !== 'string') return false;
  return expectedValue.trim() === actualValue.trim();
}

/**
 * 纯离线评分：只根据结构化字段判定，绝不硬编码 passed=true。
 * 奖励一个「只看 verdict 非 pass 就算成功」的策略会失真，因此逐项记录布尔子项。
 */
export function gradeReview(input: GradeInput): GradeResult {
  const { outcome, expected, inputUnchanged, snapshotUnchanged } = input;
  const report = input.report && typeof input.report === 'object'
    ? input.report as Record<string, unknown>
    : undefined;

  const completed = outcome.status === 'completed';
  const resourcesDisposed = outcome.resourcesDisposed === true;
  const successfulReadsCount = typeof outcome.successfulReads === 'number'
    ? outcome.successfulReads as number
    : 0;
  const successfulReads = successfulReadsCount > 0;

  const checks = Array.isArray(report?.checks) ? report!.checks as Array<Record<string, unknown>> : [];
  const issues = Array.isArray(report?.issues) ? report!.issues as Array<Record<string, unknown>> : [];
  const verdict = typeof report?.verdict === 'string' ? report!.verdict as string : undefined;

  const hasReviewReport = !!report && checks.length > 0 && verdict !== undefined;
  const reviewed = hasReviewReport
    && (report!.reviewStatus === undefined || report!.reviewStatus === 'reviewed');

  const claimRefs = (record: Record<string, unknown>): string[] => [
    ...asStrings(record.claimId),
    ...asStrings(record.claimRef),
    ...asStrings(record.claimRefs),
    ...asStrings(record.claimVersionId),
  ];
  const evidenceRefs = (record: Record<string, unknown>): string[] => [
    ...asStrings(record.evidenceRefs),
    ...asStrings(record.evidenceRef),
    ...asStrings(record.evidenceIds),
  ];
  const isFail = (record: Record<string, unknown>): boolean =>
    record.status === 'fail' || record.result === 'fail' || record.passed === false;

  const failingChecks = checks.filter(isFail);
  const relevantIssues = issues.filter(issue => {
    const severity = String(issue.severity ?? issue.level ?? '');
    return severity === 'error' || severity === 'critical';
  });

  // 一致性（非真相）：error/critical 的 value/unit/time/basis/entity_match 问题中，
  // expected 与 actual 不得同时为 trim 后相等的字符串——否则与「不一致」的散文相矛盾。
  const structuredMismatchConsistent = !relevantIssues.some(hasContradictoryMismatch);

  // 正确期望 verdict=pass；其余期望 revise 或 needs_input。
  const verdictExpectationMet = expected.verdict === 'pass'
    ? verdict === 'pass'
    : verdict === 'revise' || verdict === 'needs_input';

  let categorySatisfied = true;
  if (expected.category) {
    const category = expected.category;
    const categoryFails = failingChecks.filter(check => check.checkType === category);
    const categoryIssues = relevantIssues.filter(issue => issue.category === category || issue.checkType === category);
    const categoryFailOrIssue = categoryFails.length > 0 || categoryIssues.length > 0;

    if (category === 'missing') {
      // missing 允许全局问题，不强制绑定具体 claim。
      categorySatisfied = categoryFailOrIssue;
    } else if (category === 'conflict') {
      // conflict 需成功读取至少两份来源，且对应失败检查/问题引用两条证据。
      const twoSourcesSeen = successfulReadsCount >= 2;
      const twoEvidence = [...categoryFails, ...categoryIssues]
        .some(record => evidenceRefs(record).length >= 2);
      categorySatisfied = categoryFailOrIssue && twoSourcesSeen && twoEvidence;
    } else {
      // value/unit/time/entity 必须定位 expected.claimId 并引用实际证据。
      const claimId = expected.claimId;
      categorySatisfied = [...categoryFails, ...categoryIssues].some(record => {
        const located = !claimId || claimRefs(record).includes(claimId);
        return located && evidenceRefs(record).length > 0;
      });
    }
  }

  const parts: Record<string, boolean> = {
    completed,
    resourcesDisposed,
    successfulReads,
    hasReviewReport,
    reviewed,
    inputUnchanged,
    snapshotUnchanged,
    verdictExpectationMet,
    categorySatisfied,
    structuredMismatchConsistent,
  };
  const passed = Object.values(parts).every(Boolean);
  return { passed, parts, verdict: verdict ?? null };
}
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      live: { type: 'boolean' },
      case: { type: 'string' },
      'budget-loopback': { type: 'boolean' },
    },
  });

  // 默认关闭：必须同时提供 --live 与 APP_RUN_LIVE_EVAL=1。
  if (!values.live || process.env.APP_RUN_LIVE_EVAL !== '1') {
    console.error('B4 纯虚构验收未启用：需同时提供 --live 与 APP_RUN_LIVE_EVAL=1，并事先确认单次任务的真实模型用量授权。');
    process.exitCode = 2;
    return;
  }

  // 显式匹配 B4_CASE_IDS；未知值拒绝，绝不默认跑 all。
  const caseId = values.case;
  if (typeof caseId !== 'string' || !(B4_CASE_IDS as readonly string[]).includes(caseId)) {
    console.error('B4 必须显式指定 --case 且属于 B4_CASE_IDS；未知或缺失一律拒绝，绝不默认跑 all。');
    process.exitCode = 2;
    return;
  }

  const reportPath = process.env.APP_B4_REPORT_PATH;
  if (!reportPath) throw new Error('private_report_path_required');

  // loopback 选项仅允许 127.0.0.1/[::1] HTTP；用于容器内固定预算代理，不是任意域名放行。
  const config = readModelConfig(process.env, {
    allowLoopbackHttp: values['budget-loopback'] === true,
  });

  const evalCase = makeB4Case(caseId);
  // 运行前克隆；运行后确认 input/snapshot 未被修改。
  const beforeInput = structuredClone(evalCase.input);
  const beforeSnapshot = structuredClone(evalCase.snapshot);

  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
  // 请求前确认报告路径可创建；wx 禁止覆盖已有验收记录。
  const file = await open(reportPath, 'wx', 0o600);
  const store = new MemoryReviewStore();
  try {
    const outcome = (await runReviewAgent({
      input: evalCase.input,
      candidateSnapshot: evalCase.snapshot,
      config,
      registry,
      store,
      limits: REVIEW_LIMITS,
    })) as unknown as Record<string, unknown>;

    const inputUnchanged = JSON.stringify(evalCase.input) === JSON.stringify(beforeInput);
    const snapshotUnchanged = JSON.stringify(evalCase.snapshot) === JSON.stringify(beforeSnapshot);

    const records = store.list() as unknown as Array<Record<string, unknown>>;
    const lastRecord = records[records.length - 1];
    const report = lastRecord && typeof lastRecord.output === 'object'
      ? (lastRecord.output as Record<string, unknown>).report
      : undefined;

    const grade = gradeReview({
      outcome,
      report,
      expected: evalCase.expected,
      inputUnchanged,
      snapshotUnchanged,
    });

    // 私有报告：仅固定虚构资料；不保存 apiKey、模型配置文件内容；不采纳或修改快照。
    const privateReport = {
      mode: 'live_synthetic',
      sdkVersion: '0.99.1',
      provider: config.provider,
      model: config.modelId,
      caseId,
      input: evalCase.input,
      snapshot: evalCase.snapshot,
      outcome,
      records,
      grade,
      note: '全部为固定合成虚构资料；报告私有；不采纳或修改快照。',
    };
    await file.writeFile(JSON.stringify(privateReport, null, 2) + '\n');

    // 终端只汇总；模型原文与输入只在私有报告中。
    console.log(JSON.stringify({
      caseId,
      status: outcome.status,
      reason: outcome.reason,
      verdict: grade.verdict,
      gradePassed: grade.passed,
      reads: successfulReadsValue(outcome),
      modelCalls: outcome.modelCalls,
      resourcesDisposed: outcome.resourcesDisposed,
      usage: outcome.usage,
    }, null, 2));

    const technicalFailure = outcome.status !== 'completed' || outcome.resourcesDisposed !== true;
    if (technicalFailure || grade.passed !== true) process.exitCode = 1;
  } finally {
    await file.close();
  }
}

function successfulReadsValue(outcome: Record<string, unknown>): unknown {
  return outcome.successfulReads;
}

// 仅在本文件作为入口运行时执行；被 import（如离线测试）时绝不触发主流程。
const isEntryPoint = !!process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main().catch(() => {
    console.error('B4 验收无法启动或保存：请检查显式配置、私有报告路径与容器权限。未输出原始异常或密钥。');
    process.exitCode = 1;
  });
}
