/**
 * 审查结论 → 程序决策。
 *
 * 纯函数，不发起模型调用、不写入存储。职责：
 *  1) 一致性守卫：审查报告不能自相矛盾。尤其当“证据值与候选值不同”时，
 *     issue.expected 与 issue.actual 不得错误地相同；否则属无效审查结论，既不放行也不据此返修。
 *  2) 问题分类：区分“证据充分但提取有误”（可自动返修）与“资料缺失/来源冲突”（等待用户）。
 *     混合问题优先等待用户。
 *  3) 输出程序可执行的决策：pass / wait_input / repair / stop。
 *
 * 该模块不信任报告的自由文本，只依据结构化字段与程序可核对的一致性。
 */
import type { EvidenceSnapshot } from '../../../../packages/contracts/generated/evidence-snapshot.ts';
import type { ReviewReport } from '../../../../packages/contracts/generated/review-report.ts';
import type { ReviewOutput } from '../../../../packages/contracts/generated/review-output.ts';
import { canonicalize } from '../../../../packages/contracts/src/validator.ts';
import { fingerprint } from '../../../../packages/contracts/src/fingerprint.ts';

/** schema 允许的阻塞严重度。 */
const BLOCKING_SEVERITIES = new Set<string>(['error', 'critical']);

/** 有明确“证据值 vs 候选值”语义的问题类别；expected/actual 不得相同。 */
export const VALUE_BEARING_CATEGORIES = new Set<string>(['value', 'unit', 'time', 'entity_match', 'basis']);

/** 证据充分但提取有误、可由提取 Agent 重读来源后修正的类别。 */
export const REPAIRABLE_CATEGORIES = new Set<string>([
  'value', 'unit', 'time', 'entity_match', 'basis', 'support', 'source_locator', 'traceability',
]);

/** 资料缺失 / 未解决冲突；首版必须转等待用户，不能自动返修。 */
export const WAIT_CATEGORIES = new Set<string>(['missing', 'conflict']);

/**
 * 支持性/可追溯性失败类别：证据存在但无法支撑该事实，或事实无法追溯到证据。
 * 这类“无支撑事实”在审查报告结构化点名后可申请撤下（需证据引用与具体理由）。
 * 数值/单位/时间等“可修正错误”不属于此集合：应返修而非删除。
 */
export const SUPPORT_FAILURE_CATEGORIES = new Set<string>(['support', 'traceability']);

export interface ReviewIssueFeedback {
  issueId: string;
  category: string;
  claimId?: string;
  severity: string;
  description: string;
  expected?: string;
  actual?: string;
  evidenceRefs: string[];
  suggestedStage?: string;
}

/**
 * 撤下许可：服务端从**已校验的、绑定版本的**审查报告派生，模型无法自授。
 * 它显式绑定父候选版本、审查报告版本、被点名事实、问题编号、证据引用与具体理由。
 * 只有具备本结构（且经服务端核对）的撤下才被放行；自由文本不构成许可。
 */
export interface WithdrawalPermit {
  /** 许可所绑定的父候选版本；撤下只能发生在其直接后继版本上。 */
  parentVersionId: string;
  /** 派生本许可的审查报告版本（服务端已校验一致性与版本绑定）。 */
  reportVersionId: string;
  /** 允许撤下的事实编号（来自结构化 issue.claimId，且非可修正类别）。 */
  claimId: string;
  /** 触发许可的审查问题编号（可为多个，均须结构化引用同一事实）。 */
  issueIds: string[];
  /** 支撑失败相关的证据引用；必须非空且存在于候选中。 */
  evidenceRefs: string[];
  /** 具体理由；来自审查问题描述，必须非空且非纯空白。 */
  reason: string;
}

/** 真实 ReviewOutput（非自由文本）。许可派生只接受经校验、绑定版本的审查输出 + 快照。 */
export interface WithdrawalPermitSource {
  output: ReviewOutput;
  evaluation: ReviewEvaluation;
}

/**
 * 报告是否显式识别出“可撤下的无支撑事实”。
 * 要求：category ∈ SUPPORT_FAILURE_CATEGORIES ∧ severity ∈ 阻塞级 ∧ claimId 存在
 *        ∧ 具体理由非空 ∧ evidenceRefs 非空（且都属于候选证据）。
 * 注意：数值/单位/时间等可修正类别不在此集合，故 value/unit/time 等永远不会生成许可。
 */
function reasonsForWithdrawal(issue: ReviewIssueFeedback): boolean {
  return SUPPORT_FAILURE_CATEGORIES.has(issue.category)
    && BLOCKING_SEVERITIES.has(issue.severity)
    && issue.claimId !== undefined
    && issue.evidenceRefs.length > 0
    && issue.description.trim().length > 0;
}

/**
 * 从**已校验的**审查评估结果派生撤下许可。
 *
 * 撤下是“服务端授予的可选能力”，不是模型可自授的权限。许可只在同时满足以下全部条件时才生成：
 *  1) 评估已给出 repair 决策（存在可返修反馈）；
 *  2) 直传真实 ReviewOutput 与 EvidenceSnapshot，且报告 subject 绑定当前父候选版本与指纹；
 *  3) reportVersionId 非空，且与报告自身版本逐字一致；
 *  4) 存在一条**审查失败检查**（status=fail）同时引用该事实与既存证据，形成证据链；
 *  5) 结构化问题类别为支撑/可追溯性失败、严重度为阻塞级、理由非空、证据引用非空且都存在于候选。
 *
 * 引用非法（事实不存在 / 证据不存在 / 失败检查不匹配）一律**不生成**许可——绝不静默过滤非法引用后
 * 为剩余部分照常发许可。数值/单位/时间等可修正类别不生成许可。自由文本描述本身不构成许可。
 */
export function deriveWithdrawalPermits(
  source: WithdrawalPermitSource,
  snapshot: EvidenceSnapshot,
  reportVersionId: string,
  parentVersionId: string,
): WithdrawalPermit[] {
  const { output, evaluation } = source;
  if (evaluation.decision.kind !== 'repair') return [];
  // 报告版本必须非空、且与派生许可时所绑定版本一致。
  if (typeof reportVersionId !== 'string' || reportVersionId.trim().length === 0) return [];
  const report = output.report;
  if (report.reportVersionId !== reportVersionId) return [];
  // 报告 subject 必须绑定当前父候选版本与指纹；否则属未绑定当前候选的报告，不授予任何许可。
  const subject = report.subject;
  if (subject.subjectType !== 'evidence_snapshot') return [];
  if (subject.snapshotVersionId !== parentVersionId) return [];
  if (subject.snapshotId !== snapshot.snapshotId) return [];
  if (subject.contentHash !== fingerprint(snapshot)) return [];

  const claimIds = new Set(snapshot.claims.map((claim) => claim.claimId));
  const evidenceIds = new Set(snapshot.evidence.map((entry) => entry.evidenceId));
  // 既存证据引用的合法事实（claimRefs 与候选事实编号的交集按报告中的失败检查核对）。
  const byClaim = new Map<string, WithdrawalPermit>();
  for (const issue of evaluation.issues) {
    if (!reasonsForWithdrawal(issue)) continue;
    const claimId = issue.claimId!;
    if (!claimIds.has(claimId)) continue;
    // 证据引用必须全部存在，否则视为非法引用，直接不生成许可（不静默过滤）。
    if (!issue.evidenceRefs.every((ref) => evidenceIds.has(ref))) continue;
    // 必须存在一条失败检查，链接该事实与该问题的全部证据引用。
    if (!hasFailedCheckLinking(report, claimId, issue.evidenceRefs)) continue;
    const existing = byClaim.get(claimId);
    if (existing) {
      existing.issueIds.push(issue.issueId);
      for (const ref of issue.evidenceRefs) if (!existing.evidenceRefs.includes(ref)) existing.evidenceRefs.push(ref);
      if (existing.reason.trim().length === 0) existing.reason = issue.description;
      continue;
    }
    byClaim.set(claimId, {
      parentVersionId, reportVersionId, claimId,
      issueIds: [issue.issueId], evidenceRefs: [...issue.evidenceRefs], reason: issue.description,
    });
  }
  return [...byClaim.values()];
}

/**
 * 报告是否存在一条失败检查（status=fail）同时引用给定事实与全部证据引用。
 * 这是撤下许可的“证据链”条件：审查必须显式把该事实与既存证据标记为核对失败。
 */
function hasFailedCheckLinking(report: ReviewOutput['report'], claimId: string, evidenceRefs: readonly string[]): boolean {
  if (evidenceRefs.length === 0) return false;
  return report.checks.some((check) => {
    if (check.status !== 'fail') return false;
    if (check.checkType !== 'support' && check.checkType !== 'traceability') return false;
    const claimRefs = check.claimRefs ?? [];
    const evidenceRefs2 = check.evidenceRefs ?? [];
    if (!claimRefs.includes(claimId)) return false;
    return evidenceRefs.every((ref) => evidenceRefs2.includes(ref));
  });
}

export type ReviewDecision =
  | { kind: 'pass' }
  | { kind: 'wait_input'; reason: string; issues: ReviewIssueFeedback[] }
  | {
      kind: 'repair';
      feedback: ReviewIssueFeedback[];
      allowedChangeClaimIds: string[];
      mustPreserveClaimIds: string[];
    }
  | { kind: 'stop'; reason: string; issues: ReviewIssueFeedback[] };

export interface ReviewEvaluation {
  decision: ReviewDecision;
  /** 全部问题（程序可诊断）。 */
  issues: ReviewIssueFeedback[];
  /** 一致性违规码；非空表示审查结论无效。 */
  consistency: string[];
}

function toFeedback(issue: ReviewReport['issues'][number]): ReviewIssueFeedback {
  return {
    issueId: issue.issueId,
    category: issue.category,
    ...(issue.claimId !== undefined ? { claimId: issue.claimId } : {}),
    severity: issue.severity,
    description: issue.description,
    ...(issue.expected !== undefined ? { expected: issue.expected } : {}),
    ...(issue.actual !== undefined ? { actual: issue.actual } : {}),
    evidenceRefs: issue.evidenceRefs ?? [],
    ...(issue.suggestedStage !== undefined ? { suggestedStage: issue.suggestedStage } : {}),
  };
}

function isBlocking(issue: ReviewIssueFeedback): boolean {
  return BLOCKING_SEVERITIES.has(issue.severity);
}

function identicalExpectedActual(issue: ReviewIssueFeedback): boolean {
  if (issue.expected === undefined || issue.actual === undefined) return false;
  if (!VALUE_BEARING_CATEGORIES.has(issue.category)) return false;
  // 采用去空白比较："1" vs " 1 " 属同一值，不得借空白规避一致性守卫。
  return issue.expected.trim() === issue.actual.trim();
}

/**
 * 审查报告一致性守卫。返回违规码列表；非空表示该报告不能作为有效审查结论。
 * 不修改报告，不把自由文本当真值。
 */
export function reportConsistencyIssues(
  output: ReviewOutput,
  snapshot: EvidenceSnapshot,
): string[] {
  const report = output.report;
  const violations: string[] = [];
  const verdict = report.verdict;
  const issues = report.issues.map(toFeedback);
  const claimIds = new Set(snapshot.claims.map((claim) => claim.claimId));

  if (report.executionStatus !== 'completed') violations.push('report.not_completed');

  for (const issue of issues) {
    // 引用了候选快照中不存在的事实编号 → 报告未绑定当前候选，视为无效结论。
    if (issue.claimId !== undefined && !claimIds.has(issue.claimId)) {
      violations.push('report.claim_not_found');
    }
    // 回归守卫：证据值与候选值不同时，expected 与 actual 绝不能相同。
    if (identicalExpectedActual(issue)) {
      violations.push('report.expected_actual_identical');
    }
    // 有 expected/actual 的取值类问题必须真的给出差异；只有一方存在不足以证明核对过。
    if (VALUE_BEARING_CATEGORIES.has(issue.category) && isBlocking(issue)
      && (issue.expected === undefined) !== (issue.actual === undefined)) {
      violations.push('report.mismatch_incomplete');
    }
  }

  if (verdict === 'pass') {
    if (issues.some(isBlocking)) violations.push('report.pass_with_blocking_issue');
    // 存在已核对出的取值差异却仍判 pass，说明结论与问题清单矛盾。
    if (issues.some((issue) => VALUE_BEARING_CATEGORIES.has(issue.category)
      && issue.expected !== undefined && issue.actual !== undefined && !identicalExpectedActual(issue))) {
      violations.push('report.pass_with_unresolved_mismatch');
    }
  }

  if (verdict === 'revise' && issues.length === 0) {
    violations.push('report.revise_without_issue');
  }

  if (verdict === 'needs_input' && !issues.some((issue) => WAIT_CATEGORIES.has(issue.category))) {
    violations.push('report.needs_input_without_gap');
  }

  return [...new Set(violations)];
}

/** 供跨轮次比较的稳定问题签名；用于发现“同一问题持续存在”。 */
export function repairIssueSignature(issues: ReviewIssueFeedback[]): string {
  return canonicalize(
    issues
      .map((issue) => [issue.category, issue.claimId ?? '', issue.expected ?? '', issue.actual ?? ''])
      .sort((a, b) => canonicalize(a) < canonicalize(b) ? -1 : 1),
  );
}

/** 给定候选快照，算出返修必须保留的事实编号（未被点名的全部事实）。 */
function mustPreserveClaimIds(snapshot: EvidenceSnapshot, allowed: Set<string>): string[] {
  return snapshot.claims.map((claim) => claim.claimId).filter((id) => !allowed.has(id));
}

/**
 * 依据一致性校验后的有效报告作出程序决策。
 *
 * 决策规则：
 *  - 一致性违规 → stop（审查执行层面失败，不返修、不放行）。
 *  - pass → 通过。
 *  - needs_input 或存在 missing/conflict → 等待用户（混合问题优先等待）。
 *  - revise 且问题均可返修 → 返修，并给出允许修改/必须保留的事实编号。
 *  - 其余（revise 但无可返修目标）→ stop（不能凭空返修）。
 */
export function evaluateReviewReport(
  output: ReviewOutput,
  snapshot: EvidenceSnapshot,
): ReviewEvaluation {
  const consistency = reportConsistencyIssues(output, snapshot);
  const issues = output.report.issues.map(toFeedback);
  const verdict = output.report.verdict;

  if (consistency.length > 0) {
    return {
      decision: { kind: 'stop', reason: `review_inconsistent:${consistency.join('|')}`, issues },
      issues,
      consistency,
    };
  }

  if (verdict === 'pass') {
    return { decision: { kind: 'pass' }, issues, consistency };
  }

  const waitIssues = issues.filter((issue) => WAIT_CATEGORIES.has(issue.category));
  if (verdict === 'needs_input' || waitIssues.length > 0) {
    return {
      decision: { kind: 'wait_input', reason: 'review_needs_input', issues },
      issues,
      consistency,
    };
  }

  // revise：把可返修的问题交给提取 Agent，并标明允许/禁止触碰的事实。
  const repairable = issues.filter((issue) => REPAIRABLE_CATEGORIES.has(issue.category));
  if (repairable.length === 0) {
    return {
      decision: { kind: 'stop', reason: 'review_unactionable', issues },
      issues,
      consistency,
    };
  }
  const allowed = new Set<string>();
  for (const issue of repairable) if (issue.claimId !== undefined) allowed.add(issue.claimId);
  return {
    decision: {
      kind: 'repair',
      feedback: repairable,
      allowedChangeClaimIds: [...allowed],
      mustPreserveClaimIds: mustPreserveClaimIds(snapshot, allowed),
    },
    issues,
    consistency,
  };
}