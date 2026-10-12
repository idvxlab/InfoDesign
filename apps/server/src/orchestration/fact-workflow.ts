/**
 * 受控事实工作流（B5）。
 *
 * 顺序与分支完全由程序管理，Agent 不能自行互调或无限循环：
 *   提取 → 程序结构/来源/版本校验 → 独立审查 → 程序依有效报告决策
 *   → 通过 / 等待用户 / 有条件返修（生成新版本后重新校验并再审查） / 停止
 *
 * 复用既有 Pi SDK 会话、受控来源读取、审查校验、预算与取消机制；新增的只是编排、
 * 语义返修与决策，不重写信息提取 Agent 与独立审查 Agent。
 *
 * 关键约束：
 *  - 首版最多返修 maxRepairRounds 轮（默认 2），达到上限只能 not_passed，绝不自动转通过。
 *  - 每轮审查使用独立上下文；再审查提供原始任务、新候选与原始来源，且不只复核旧问题。
 *  - 审查建议是待核实反馈而非新证据；返修必须重读来源、只改点名部分、保留稳定标识。
 *  - 每次付费调用前检查并预留共享预算；失败/未知调用不乱记账、不隐式重试。
 *  - 混合问题（缺失/冲突 + 可返修）优先等待用户。
 */
import { randomUUID } from 'node:crypto';
import type {
  EvidenceInput, EvidenceOutput, EvidenceSnapshot,
} from '../../../../packages/contracts/generated/index.ts';
import type { CommonCheckType } from '../../../../packages/contracts/generated/common.ts';
import type { ReviewInput } from '../../../../packages/contracts/generated/review-input.ts';
import type { ReviewOutput } from '../../../../packages/contracts/generated/review-output.ts';
import type { SchemaRegistry } from '../../../../packages/contracts/src/schema-registry.ts';
import { fingerprint } from '../../../../packages/contracts/src/fingerprint.ts';
import type { ModelConfig } from '../config/env.ts';
import type { ExecutionLimits } from '../runtime/pi/execution-limits.ts';
import type { RequestSpendBudget } from '../runtime/pi/spend-budget.ts';
import type { SourceBundle } from '../domain/source-bundle.ts';
import type { CandidateStore, CandidateRecord } from '../domain/evidence.service.ts';
import type { ReviewStore, ReviewRecord } from '../domain/review.service.ts';
import type { FactRunStore, FactRunRecord, FactWorkflowRound, FactChange, UsageRecord, FactRunArtifact, FactRunAttempt, FactRunArtifactIssue } from '../domain/fact-run.service.ts';
import { computeRepairChanges } from '../domain/fact-run.service.ts';
import {
  evaluateReviewReport, repairIssueSignature, deriveWithdrawalPermits, type ReviewIssueFeedback,
  type WithdrawalPermit,
} from '../domain/review-decision.ts';
import type { ExecutionStatus, FactStage, FactTaskStatus, StopReasonCode } from './state.ts';
import { executionStatusFor, isPassed, isTechnicalStop } from './state.ts';
import { runEvidenceAgent, type EvidenceOutcome } from '../agents/evidence/agent.ts';
import { runReviewAgent, type ReviewOutcome } from '../agents/review/agent.ts';
import { prepareEvidenceInput, type CandidateEnvelope } from '../agents/evidence/context.ts';
import { createDocumentReader } from '../runtime/pi/read-document-tool.ts';
import { validateEvidenceCandidate, type EvidenceReceipt } from '../domain/result-validator.ts';

export type CandidateStoreWithList = CandidateStore & { list(): CandidateRecord[] };
export type ReviewStoreWithList = ReviewStore & { list(): ReviewRecord[] };

export interface FactWorkflowOptions {
  input: EvidenceInput;
  config: ModelConfig;
  registry: SchemaRegistry;
  candidateStore: CandidateStoreWithList;
  reviewStore: ReviewStoreWithList;
  runStore?: FactRunStore;
  sourceBundles?: SourceBundle[];
  checksRequired?: CommonCheckType[];
  /** 语义返修上限；首版默认 2（首次提取后最多再生成 2 个修订版本）。 */
  maxRepairRounds?: number;
  /** 全轮共享；模型无法扩大。每次调用前由 Agent 预留并记账。 */
  spendBudget?: RequestSpendBudget;
  evidenceLimits?: ExecutionLimits;
  reviewLimits?: ExecutionLimits;
  signal?: AbortSignal;
  runId?: string;
  now?: () => string;
  /**
   * 仅限受信评估：显式合成的夹具候选，非真实抽取、非生产恢复；
   * 仅当 producedBy.model==='synthetic_fixture'、sessionId==='session_synthetic_seed'、
   * promptVersion==='b5_seed_v1' 且 sourceBundles 缺失/为空时才接受，任何校验失败在模型调用前拒绝。
   */
  evaluationSeed?: EvidenceOutput;
}

export interface FactWorkflowResult {
  runId: string;
  status: FactTaskStatus;
  /** spec §10.2 执行终态；由 status + stopReason 经 executionStatusFor 派生，不蕴涵采纳。 */
  executionStatus: ExecutionStatus;
  stage: FactStage;
  passed: boolean;
  currentVersionId?: string;
  candidateVersions: string[];
  reportVersions: string[];
  repairRounds: number;
  remainingIssues: ReviewIssueFeedback[];
  evidenceRefs: string[];
  stopReason: StopReasonCode;
  stopDetail?: string;
  /** 审查通过与正式采纳分开：passed 仅表示审查结论。 */
  record?: FactRunRecord;
}

/** 事实审查默认要求覆盖全部检查类别。 */
export const DEFAULT_REVIEW_CHECKS: CommonCheckType[] = [
  'support', 'entity_match', 'value', 'unit', 'time', 'basis',
  'source_locator', 'missing', 'conflict', 'traceability',
];

/** 由程序派生审查输入；权限范围来自原始任务，而非模型输出。 */
export function buildReviewInput(
  input: EvidenceInput,
  snapshot: EvidenceSnapshot,
  checksRequired: CommonCheckType[],
): ReviewInput {
  return {
    protocolVersion: '1.0',
    taskId: input.taskId,
    attemptId: input.attemptId,
    projectId: input.projectId,
    reviewMode: 'fact',
    scope: {
      projectId: input.projectId,
      documentRefs: input.scope.documentRefs,
      allowedOperations: ['read_document', 'check_source', 'submit_report'],
    },
    subject: {
      subjectType: 'evidence_snapshot',
      snapshotId: snapshot.snapshotId,
      snapshotVersionId: snapshot.snapshotVersionId,
      contentHash: fingerprint(snapshot),
    },
    documents: input.documents,
    checksRequired,
  };
}

function usageOf(outcome: { usage: UsageRecord['usage']; modelCalls: number; toolCalls: number; usageReportedResponses: number; usageUnreportedResponses: number }): UsageRecord {
  return {
    usage: outcome.usage, modelCalls: outcome.modelCalls, toolCalls: outcome.toolCalls,
    usageReportedResponses: outcome.usageReportedResponses, usageUnreportedResponses: outcome.usageUnreportedResponses,
  };
}

/**
 * 克隆原始 EvidenceInput 作为审计快照：保留原始文档文本与文档版本，供所有内存存储丢失后回读。
 * 仅用 structuredClone 复制纯数据，绝不拷贝 sourceBundle 能力/句柄或任何缓冲；
 * 不修改调用方传入对象。
 */
function cloneInputSnapshot(input: EvidenceInput): EvidenceInput {
  return structuredClone(input);
}

/** 只拷贝安全的校验问题字段（码/路径/消息），绝不复制凭据或隐藏推理。 */
function safeIssues(issues: readonly { code: string; path?: string; message: string }[]): FactRunArtifactIssue[] {
  return issues.slice(0, 64).map((issue) => ({
    code: String(issue.code), path: String(issue.path ?? ''), message: String(issue.message ?? ''),
  }));
}

function classifyEvidenceFailure(outcome: EvidenceOutcome): StopReasonCode {
  switch (outcome.reason) {
    case 'timeout': return 'timeout';
    case 'cancelled': return 'cancelled';
    case 'spend_budget': case 'spend_ledger_failed':
    case 'model_budget': case 'tool_budget': case 'context_budget': return 'budget_exhausted';
    case 'invalid_candidate': case 'validation_failed': return 'candidate_invalid';
    default: return 'evidence_failed';
  }
}

function classifyReviewFailure(outcome: ReviewOutcome): StopReasonCode {
  switch (outcome.reason) {
    case 'timeout': return 'timeout';
    case 'cancelled': return 'cancelled';
    case 'spend_budget': case 'spend_ledger_failed':
    case 'model_budget': case 'tool_budget': case 'context_budget': return 'budget_exhausted';
    default: return 'review_execution_failed';
  }
}

function statusForStop(reason: StopReasonCode): FactTaskStatus {
  if (reason === 'cancelled') return 'cancelled';
  if (isTechnicalStop(reason)) return 'failed';
  switch (reason) {
    // 已处理的业务停止：执行完成，业务结论为 not_passed（其 executionStatus 为 succeeded）。
    case 'repair_limit_reached': case 'no_substantive_change':
    case 'repeated_issue': case 'review_unactionable':
      return 'not_passed';
    default: return 'failed';
  }
}

export async function runFactWorkflow(options: FactWorkflowOptions): Promise<FactWorkflowResult> {
  const { input, config, registry, candidateStore, reviewStore } = options;
  const checksRequired = options.checksRequired ?? DEFAULT_REVIEW_CHECKS;
  const maxRepairRounds = options.maxRepairRounds ?? 2;
  // 返修上限仅允许 0/1/2 的整数；拒绝 3、负数、小数与 NaN，且在任何 Agent 调用之前校验。
  if (maxRepairRounds !== 0 && maxRepairRounds !== 1 && maxRepairRounds !== 2) {
    throw new Error('invalid_repair_rounds');
  }
  const now = options.now ?? (() => new Date().toISOString());
  const runId = options.runId ?? 'run_' + randomUUID().replaceAll('-', '');
  const createdAt = now();

  const candidateVersions: string[] = [];
  const reportVersions: string[] = [];
  const rounds: FactWorkflowRound[] = [];
  const runVersionIds = { candidates: new Set<string>(), reports: new Set<string>() };
  let status: FactTaskStatus = 'running';
  let stage: FactStage = 'extracting';
  let stopReason: StopReasonCode = 'unrecoverable_error';
  let stopDetail: string | undefined;
  let currentVersionId: string | undefined;
  let currentOutput: EvidenceOutput | undefined;
  let currentChanges: FactChange[] = [];
  let repairRounds = 0;
  let remainingIssues: ReviewIssueFeedback[] = [];
  const attempts: FactRunAttempt[] = [];

  /**
   * 在每次 await 得到 Agent 结果后、任何早退之前记录本次调用的类型化历史（含失败）。
   * 只拷贝安全字段：不使用整份 config、不写 API key、不含隐藏推理。
   */
  const recordAttempt = (
    kind: FactRunAttempt['kind'],
    stageAtAttempt: FactStage,
    outcome: {
      reason?: string; status?: string; sessionId?: string; modelCalls: number; toolCalls: number;
      successfulReads: number; usage: UsageRecord['usage']; usageReportedResponses: number;
      usageUnreportedResponses: number; resourcesDisposed: boolean; candidateVersionId?: string;
      reportVersionId?: string; candidateVersions?: string[]; reportVersions?: string[];
    },
    extra: { parentVersionId?: string } = {},
  ): void => {
    attempts.push({
      attempt: attempts.length + 1, kind, stage: stageAtAttempt,
      ...(extra.parentVersionId !== undefined ? { parentVersionId: extra.parentVersionId } : {}),
      ...(outcome.candidateVersionId !== undefined ? { candidateVersionId: outcome.candidateVersionId } : {}),
      ...(outcome.reportVersionId !== undefined ? { reportVersionId: outcome.reportVersionId } : {}),
      ...(outcome.sessionId !== undefined ? { sessionId: outcome.sessionId } : {}),
      modelCalls: outcome.modelCalls, toolCalls: outcome.toolCalls, successfulReads: outcome.successfulReads,
      usage: outcome.usage, usageReportedResponses: outcome.usageReportedResponses,
      usageUnreportedResponses: outcome.usageUnreportedResponses,
      versions: kind === 'review' ? [...(outcome.reportVersions ?? [])] : [...(outcome.candidateVersions ?? [])],
      ...(outcome.reason !== undefined ? { outcomeReason: outcome.reason } : {}),
      outcomeStatus: outcome.status ?? 'failed', resourcesDisposed: outcome.resourcesDisposed,
    });
  };

  const findCandidate = (versionId: string): EvidenceOutput | undefined =>
    candidateStore.list().find((record) => record.snapshotVersionId === versionId && record.output)?.output;

  const collectEvidenceRefs = (snapshot?: EvidenceSnapshot): string[] =>
    snapshot ? [...new Set(snapshot.evidence.map((entry) => entry.evidenceId))] : [];

  /**
   * 只收集本次运行实际产生的候选/报告记录（含非法/失败尝试），作为历史只读快照。
   * 不拷贝共享存储中其他运行/项目的条目；不改变这些历史工件。
   * 非法输出的校验问题（码/路径/消息）一并保留，避免丢失失败诊断。
   */
  const collectArtifacts = (): FactRunArtifact[] => {
    const artifacts: FactRunArtifact[] = [];
    for (const rec of candidateStore.list()) {
      if (!runVersionIds.candidates.has(rec.snapshotVersionId)) continue;
      artifacts.push({
        kind: 'candidate', versionId: rec.snapshotVersionId, state: rec.state, rawOutput: rec.rawOutput,
        ...(rec.output !== undefined ? { output: rec.output } : {}),
        ...(rec.issues !== undefined && rec.issues.length > 0 ? { issues: safeIssues(rec.issues) } : {}),
      });
    }
    for (const rec of reviewStore.list()) {
      if (!runVersionIds.reports.has(rec.reportVersionId)) continue;
      artifacts.push({
        kind: 'report', versionId: rec.reportVersionId, state: rec.state, rawOutput: rec.rawOutput,
        ...(rec.output !== undefined ? { output: rec.output } : {}),
        ...(rec.issues !== undefined && rec.issues.length > 0 ? { issues: safeIssues(rec.issues) } : {}),
      });
    }
    return artifacts;
  };

  const finish = (): FactWorkflowResult => {
    const evidenceRefs = collectEvidenceRefs(currentOutput?.candidateSnapshot);
    if (options.runStore) {
      // 若持久化失败，不得返回 passed：抛出诚实的技术失败，绝不自动重试或转为采纳。
      options.runStore.save({
        runId, taskId: input.taskId, attemptId: input.attemptId, projectId: input.projectId,
        status, executionStatus: executionStatusFor(status, stopReason), stage, passed: isPassed(status), stopReason,
        ...(stopDetail !== undefined ? { stopDetail } : {}),
        ...(currentVersionId !== undefined ? { currentVersionId } : {}),
        candidateVersions: [...candidateVersions], reportVersions: [...reportVersions],
        repairRounds, remainingIssues, evidenceRefs, rounds: [...rounds],
        attempts: attempts.map((entry) => structuredClone(entry)),
        artifacts: collectArtifacts(),
        // 无内部预算时完全省略 budget，绝不臆造为零；有则保守保留实际预留元数据。
        ...(options.spendBudget !== undefined
          ? { budget: { reservedMicrosTotal: options.spendBudget.reservedMicros, currency: 'CNY' as const } }
          : {}),
        inputSnapshot: cloneInputSnapshot(input),
        createdAt, updatedAt: now(),
      });
    }
    return {
      runId, status, executionStatus: executionStatusFor(status, stopReason), stage, passed: isPassed(status),
      ...(currentVersionId !== undefined ? { currentVersionId } : {}),
      candidateVersions: [...candidateVersions], reportVersions: [...reportVersions],
      repairRounds, remainingIssues, evidenceRefs, stopReason,
      ...(stopDetail !== undefined ? { stopDetail } : {}),
      ...(options.runStore ? { record: options.runStore.get(runId) } : {}),
    };
  };


  // ── 1. 首次提取（结构自修正本身受限，属提取阶段）──────────────────────────────
  stage = 'extracting';
  const seed = options.evaluationSeed;
  if (seed !== undefined) {
    // 受信评估种子：仅接受显式合成标记且来源为空，绝不伪装模型统计或 EvidenceOutcome。
    const by = seed.candidateSnapshot?.producedBy;
    const isSynthetic = by?.model === 'synthetic_fixture'
      && by?.sessionId === 'session_synthetic_seed'
      && by?.promptVersion === 'b5_seed_v1';
    const noBundles = options.sourceBundles === undefined || options.sourceBundles.length === 0;
    if (!isSynthetic || !noBundles) {
      status = 'failed'; stopReason = 'candidate_invalid'; stopDetail = 'evaluation_seed_rejected';
      stage = 'done';
      return finish();
    }
    // 用受控读取器实际读取被授权段落块，再走与生产完全相同的校验器。
    const seedInput = prepareEvidenceInput(structuredClone(input), registry, options.sourceBundles);
    const read = createDocumentReader({ scope: input.scope, documents: input.documents }, registry);
    const receipts: EvidenceReceipt[] = [];
    for (const doc of input.documents) {
      for (const block of doc.blocks) {
        if (block.location.kind !== 'paragraph') continue;
        receipts.push(read({
          documentId: doc.documentId, documentVersionId: doc.documentVersionId, blockId: block.blockId,
        }, options.signal));
      }
    }
    const envelope: CandidateEnvelope = {
      snapshotId: seed.candidateSnapshot.snapshotId,
      snapshotVersionId: seed.candidateSnapshot.snapshotVersionId,
      createdAt: seed.candidateSnapshot.createdAt,
      producedBy: structuredClone(seed.candidateSnapshot.producedBy),
    };
    const check = validateEvidenceCandidate(seed, seedInput, envelope, receipts, registry);
    if (!check.ok) {
      status = 'failed'; stopReason = 'candidate_invalid'; stopDetail = 'evaluation_seed_invalid';
      stage = 'done';
      return finish();
    }
    const stored = structuredClone(seed);
    candidateStore.append({
      snapshotVersionId: stored.candidateSnapshot.snapshotVersionId,
      recordedAt: now(),
      state: 'pending_review',
      rawOutput: JSON.stringify(stored),
      output: stored,
      issues: [],
    });
    currentVersionId = stored.candidateSnapshot.snapshotVersionId;
    candidateVersions.push(currentVersionId);
    runVersionIds.candidates.add(currentVersionId);
    currentOutput = stored;
  } else {
    const first = await runEvidenceAgent({
      input, config, registry, store: candidateStore,
      limits: options.evidenceLimits, maxRepairRounds: 1,
      spendBudget: options.spendBudget, sourceBundles: options.sourceBundles, signal: options.signal,
    });
    // 提取含其有界结构修正；其 outcome 已合并计数与版本，作为单个 attempt 记录。
    recordAttempt('extract', 'extracting', first);
    candidateVersions.push(...first.candidateVersions);
    for (const id of first.candidateVersions) runVersionIds.candidates.add(id);
    if (!first.candidateVersionId) {
      stopReason = classifyEvidenceFailure(first);
      status = statusForStop(stopReason);
      stopDetail = first.reason;
      stage = 'done';
      return finish();
    }
    currentVersionId = first.candidateVersionId;
    currentOutput = findCandidate(currentVersionId);
    if (!currentOutput) {
      status = 'failed'; stopReason = 'unrecoverable_error'; stopDetail = 'candidate_missing';
      stage = 'done';
      return finish();
    }
  }

  // ── 2. 审查 → 决策 → 有条件返修循环；轮次/预算由程序控制 ─────────────────────
  let reviewRound = 0;
  let previousSignature: string | undefined;
  for (;;) {
    reviewRound++;
    stage = 'reviewing';
    const reviewInput = buildReviewInput(input, currentOutput.candidateSnapshot, checksRequired);
    const review = await runReviewAgent({
      input: reviewInput, candidateSnapshot: currentOutput.candidateSnapshot,
      config, registry, store: reviewStore,
      limits: options.reviewLimits, spendBudget: options.spendBudget,
      sourceBundles: options.sourceBundles, signal: options.signal,
    });
    recordAttempt('review', 'reviewing', review, { parentVersionId: currentVersionId });
    reportVersions.push(...review.reportVersions);
    for (const id of review.reportVersions) runVersionIds.reports.add(id);
    if (!review.reportVersionId) {
      stopReason = classifyReviewFailure(review);
      status = statusForStop(stopReason);
      stopDetail = review.reason;
      stage = 'done';
      return finish();
    }
    const report: ReviewOutput | undefined = reviewStore.list()
      .find((record) => record.reportVersionId === review.reportVersionId && record.output)?.output;
    // 版本关联守卫：报告必须绑定当前候选版本与指纹，否则属审查执行失败，不构成事实结论。
    if (!report || report.report.subject.snapshotVersionId !== currentVersionId) {
      status = 'failed'; stopReason = 'review_execution_failed'; stopDetail = 'report_binding_mismatch';
      stage = 'done';
      return finish();
    }

    stage = 'deciding';
    const evaluation = evaluateReviewReport(report, currentOutput.candidateSnapshot);
    remainingIssues = evaluation.issues;
    // 服务端从已校验报告与评估派生撤下许可；模型与候选输出均不能自授权限。
    const withdrawalPermits: WithdrawalPermit[] = deriveWithdrawalPermits(
      { output: report, evaluation },
      currentOutput.candidateSnapshot,
      review.reportVersionId,
      currentVersionId,
    );
    rounds.push({
      round: reviewRound, stage: 'reviewing', candidateVersionId: currentVersionId,
      reportVersionId: review.reportVersionId, decision: evaluation.decision.kind,
      ...(evaluation.decision.kind === 'stop' ? { reason: evaluation.decision.reason } : {}),
      ...(evaluation.decision.kind === 'wait_input' ? { reason: evaluation.decision.reason } : {}),
      issues: evaluation.issues, changes: currentChanges, usage: usageOf(review),
      ...(withdrawalPermits.length > 0 ? { withdrawalPermits } : {}),
    });

    if (evaluation.decision.kind === 'pass') {
      status = 'passed'; stopReason = 'passed_all_checks'; stage = 'done'; return finish();
    }
    if (evaluation.decision.kind === 'wait_input') {
      status = 'waiting_for_input'; stopReason = 'needs_user_input'; stage = 'done'; return finish();
    }
    if (evaluation.decision.kind === 'stop') {
      if (evaluation.decision.reason.startsWith('review_inconsistent')) {
        status = 'failed'; stopReason = 'review_inconsistent';
      } else {
        status = 'not_passed'; stopReason = 'review_unactionable';
      }
      stopDetail = evaluation.decision.reason;
      stage = 'done';
      return finish();
    }

    // 可返修：先判上限与重复/无实质修改，再决定是否发起新的付费调用。
    if (repairRounds >= maxRepairRounds) {
      status = 'not_passed'; stopReason = 'repair_limit_reached'; stage = 'done'; return finish();
    }
    const signature = repairIssueSignature(evaluation.decision.feedback);
    if (previousSignature !== undefined && signature === previousSignature) {
      status = 'not_passed'; stopReason = 'repeated_issue'; stage = 'done'; return finish();
    }
    previousSignature = signature;

    repairRounds++;
    stage = 'repairing';
    const parent = currentOutput;
    const repair = await runEvidenceAgent({
      input, config, registry, store: candidateStore,
      limits: options.evidenceLimits, maxRepairRounds: 0,
      spendBudget: options.spendBudget, sourceBundles: options.sourceBundles, signal: options.signal,
      repair: {
        parentVersionId: currentVersionId, previous: parent,
        issues: evaluation.decision.feedback,
        allowedChangeClaimIds: evaluation.decision.allowedChangeClaimIds,
        mustPreserveClaimIds: evaluation.decision.mustPreserveClaimIds,
        round: repairRounds,
        withdrawalPermits,
      },
    });
    // 语义返修含其有界结构修正；其 outcome 已合并计数与版本，作为单个 attempt 记录。
    recordAttempt('repair', 'repairing', repair, { parentVersionId: currentVersionId });
    candidateVersions.push(...repair.candidateVersions);
    for (const id of repair.candidateVersions) runVersionIds.candidates.add(id);
    if (!repair.candidateVersionId) {
      const technical = classifyEvidenceFailure(repair);
      // 非法候选 schema/来源/版本与返修执行失败均为技术失败 → executionStatus 为 failed，
      // 绝不视为有效的业务拒绝（not_passed）。
      stopReason = isTechnicalStop(technical) ? technical : 'repair_failed';
      status = statusForStop(stopReason);
      stopDetail = repair.reason;
      stage = 'done';
      return finish();
    }
    const next = findCandidate(repair.candidateVersionId);
    if (!next) { status = 'not_passed'; stopReason = 'repair_failed'; stage = 'done'; return finish(); }
    const changes = computeRepairChanges(parent, next);
    if (changes.length === 0) {
      status = 'not_passed'; stopReason = 'no_substantive_change'; stage = 'done'; return finish();
    }
    currentVersionId = repair.candidateVersionId;
    currentOutput = next;
    currentChanges = changes;
  }
}