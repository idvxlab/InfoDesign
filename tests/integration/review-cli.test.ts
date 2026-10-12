/** B4 CLI 离线开关守卫测试。
 *
 *  仅验证双开关与私有报告路径的默认关闭行为：绝不启动真实模型、不访问网络。
 *  三个组合均应在写任何报告前以 exitCode=2 退出，且输出不得泄漏 canary 密钥。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const CANARY = 'synthetic_guard_canary';

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  reportPath: string;
}

/** 在临时目录中运行 CLI 并断言守护行为；finally 清理临时目录，无网络、无真实模型。 */
function runGuarded(flags: string[], liveEval: string): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'b4-cli-'));
  const reportPath = join(dir, 'report.json');
  try {
    const result = spawnSync(process.execPath, ['evals/run-b4.ts', ...flags], {
      cwd: repoRoot,
      timeout: 5000,
      encoding: 'utf8',
      env: {
        ...process.env,
        APP_RUN_LIVE_EVAL: liveEval,
        APP_B4_REPORT_PATH: reportPath,
        APP_MODEL_API_KEY: CANARY,
      },
    });

    // 必须立即拒绝：退出码 2、未创建任何报告、输出不含 canary。
    assert.equal(result.status, 2, `expected exitCode 2, got ${result.status}: ${result.stderr}`);
    assert.equal(existsSync(reportPath), false, '报告文件不得在启用前创建');
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    assert.equal(stdout.includes(CANARY), false, 'stdout 不得包含 canary 密钥');
    assert.equal(stderr.includes(CANARY), false, 'stderr 不得包含 canary 密钥');

    return { status: result.status, stdout, stderr, reportPath };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('B4 CLI：无 --live 且 APP_RUN_LIVE_EVAL=0 时拒绝', () => {
  runGuarded([], '0');
});

test('B4 CLI：有 --live 但 APP_RUN_LIVE_EVAL=0 时拒绝', () => {
  runGuarded(['--live'], '0');
});

test('B4 CLI：有 APP_RUN_LIVE_EVAL=1 但无 --live 时拒绝', () => {
  runGuarded([], '1');
});

/** 构造一份除指定问题外全部通过的最小结构化报告，用于隔离 gradeReview 的一致性判定。 */
interface GradeHarness {
  outcome: Record<string, unknown>;
  report: Record<string, unknown>;
  expected: { verdict: string; category?: string; claimId?: string };
  inputUnchanged: boolean;
  snapshotUnchanged: boolean;
}

function validHarness(issue: Record<string, unknown>): GradeHarness {
  const claimId = 'claim-1';
  return {
    outcome: { status: 'completed', resourcesDisposed: true, successfulReads: 2 },
    report: {
      verdict: 'revise',
      checks: [{ checkType: 'value', status: 'fail', claimId, evidenceRefs: ['ev-1'] }],
      issues: [issue],
    },
    expected: { verdict: 'revise', category: 'value', claimId },
    inputUnchanged: true,
    snapshotUnchanged: true,
  };
}

/** 在类型层面复用实现归一化的 GradeInput 形状；不改动生产签名。 */
type GradeFn = (input: GradeHarness) => { passed: boolean; parts: Record<string, boolean>; verdict: string | null };

// 离线 import：入口守卫保证不触发 main()，因此不读模型配置、不写报告、不访问网络。
const { gradeReview } = (await import('../../evals/run-b4.ts')) as { gradeReview: GradeFn };

test('gradeReview：散文+类别+证据俱佳，但某问题 source「60」与 candidate「600」不一致而expected/actual却同为「600」，则新子项与整体均不通过', () => {
  const result = gradeReview(validHarness({
    severity: 'error',
    category: 'value',
    claimId: 'claim-1',
    evidenceRefs: ['ev-1', 'ev-2'],
    expected: '600',
    actual: '600',
  }));
  assert.equal(result.parts.structuredMismatchConsistent, false, '相同结构化值必须判定为矛盾');
  assert.equal(result.passed, false, '矛盾时整体不得通过');
  assert.equal(result.verdict, 'revise');
  // 其余子项仍应通过，确保只新增一致性判定而未放宽已有标准。
  for (const key of Object.keys(result.parts)) {
    if (key === 'structuredMismatchConsistent') continue;
    assert.equal(result.parts[key], true, `子项 ${key} 应通过`);
  }
  // 其余子项仍应通过，确保只新增一致性判定而未放宽已有标准。
  assert.equal(result.parts.categorySatisfied, true);
  assert.equal(result.parts.verdictExpectationMet, true);
});

test('gradeReview：expected/actual 不等时一致性通过', () => {
  const result = gradeReview(validHarness({
    severity: 'error',
    category: 'value',
    claimId: 'claim-1',
    evidenceRefs: ['ev-1'],
    expected: '600',
    actual: '580',
  }));
  assert.equal(result.parts.structuredMismatchConsistent, true);
  assert.equal(result.passed, true);
});

test('gradeReview：trim 后相等（含空白）仍视为矛盾', () => {
  const result = gradeReview(validHarness({
    severity: 'critical',
    category: 'unit',
    claimId: 'claim-1',
    evidenceRefs: ['ev-1'],
    expected: '  600\n',
    actual: '600 ',
  }));
  assert.equal(result.parts.structuredMismatchConsistent, false);
  assert.equal(result.passed, false);
});

test('gradeReview：缺少可选 expected/actual 字段不得判为矛盾，也不得被填充', () => {
  const issue: Record<string, unknown> = {
    severity: 'error',
    category: 'value',
    claimId: 'claim-1',
    evidenceRefs: ['ev-1'],
  };
  const result = gradeReview(validHarness(issue));
  assert.equal(result.parts.structuredMismatchConsistent, true, '缺失字段不算矛盾');
  assert.equal(result.passed, true);
  assert.equal('expected' in issue, false, '不得凭空填充 expected');
  assert.equal('actual' in issue, false, '不得凭空填充 actual');
});

test('gradeReview：其他类别或低严重度下的相同值不影响一致性', () => {
  // conflict 类别不在检查范围。
  const conflict = gradeReview(validHarness({
    severity: 'error',
    category: 'conflict',
    claimId: 'claim-1',
    evidenceRefs: ['ev-1', 'ev-2'],
    expected: '600',
    actual: '600',
  }));
  assert.equal(conflict.parts.structuredMismatchConsistent, true, 'conflict 不受此检查');

  // 低严重度 warning 被严重度过滤排除。
  const warned = gradeReview(validHarness({
    severity: 'warning',
    category: 'value',
    claimId: 'claim-1',
    evidenceRefs: ['ev-1'],
    expected: '600',
    actual: '600',
  }));
  assert.equal(warned.parts.structuredMismatchConsistent, true, '非 error/critical 不受此检查');
});

