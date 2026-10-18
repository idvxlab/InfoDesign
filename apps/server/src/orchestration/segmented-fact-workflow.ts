/**
 * 分段事实工作流（最小切片）。
 *
 * 受信调用方提供两段或多段 EvidenceInput，按顺序复用真实 runFactWorkflow；
 * 每段拥有独立的候选/审查存储与真实 Pi 执行上下文。
 *
 * 本文件不是通用框架：不做 PDF 读取、数据库、队列或恢复机制，不改变原文件、
 * 预算与角色输出上限，不使用 evaluationSeed，不注入 fake workflow，
 * 也不把 synthetic fixture 当作生产 passed 捷径。
 *
 * 聚合视图由纯函数 mergeReviewedSegments 生成，绝不构造“已采纳/已审”新快照。
 */
import { fingerprint } from '../../../../packages/contracts/src/fingerprint.ts';
import { canonicalize } from '../../../../packages/contracts/src/validator.ts';
import type { EvidenceInput } from '../../../../packages/contracts/generated/index.ts';
import type { ModelConfig } from '../config/env.ts';
import type { EvidenceSnapshot } from '../../../../packages/contracts/generated/evidence-snapshot.ts';
import type { ReviewReport } from '../../../../packages/contracts/generated/review-report.ts';
import type { CommonCheckType } from '../../../../packages/contracts/generated/common.ts';
import type { CheckIssue } from '../../../../packages/contracts/src/service-checks.ts';
import type { SchemaRegistry } from '../../../../packages/contracts/src/schema-registry.ts';
import {
  DEFAULT_REVIEW_CHECKS,
  runFactWorkflow,
  type FactWorkflowOptions,
  type FactWorkflowResult,
} from './fact-workflow.ts';
import type { FactRunStore } from '../domain/fact-run.service.ts';
import type { SourceBundle } from '../domain/source-bundle.ts';
import type { RequestSpendBudget } from '../runtime/pi/spend-budget.ts';
import type { ExecutionLimits } from '../runtime/pi/execution-limits.ts';
import { MemoryCandidateStore, type CandidateRecord } from '../domain/evidence.service.ts';
import { MemoryReviewStore, type ReviewRecord } from '../domain/review.service.ts';

export type { CandidateRecord, ReviewRecord, CheckIssue };

// ---------------------------------------------------------------------------
// 公共接口
// ---------------------------------------------------------------------------

/** 一段输入：段 ID（非空、唯一、项目一致）+ 原样 EvidenceInput。 */
export interface SegmentTask { id: string; input: EvidenceInput; }

/** 段级失败信息；失败不得被吞成空成功。 */
export interface SegmentedSegmentError { code: string; message: string; fatal: boolean; }

/** 单段原始记录：输入、候选、审查全量保留，不修剪、不覆盖。 */
export interface SegmentRecord {
  id: string;
  inputHash: string;
  input: EvidenceInput;
  result?: FactWorkflowResult;
  candidates: CandidateRecord[];
  reviews: ReviewRecord[];
  error?: SegmentedSegmentError;
}

export interface SegmentedWorkflowOptions {
  segments: SegmentTask[];
  config: ModelConfig;
  registry: SchemaRegistry;
  spendBudget?: RequestSpendBudget;
  evidenceLimits?: ExecutionLimits;
  reviewLimits?: ExecutionLimits;
  signal?: AbortSignal;
  maxRepairRounds?: number;
  checksRequired?: CommonCheckType[];
  sourceBundles?: SourceBundle[];
  runStore?: FactRunStore;
  now?: () => string;
}

export type SegmentedStatus = 'completed' | 'aborted' | 'failed';

export interface SegmentedBlocker { code: string; segmentId?: string; detail: string; }

/** 规范化指纹键：实体 type+label、predicate、qualifiers、value。 */
export interface ClaimFingerprintKey {
  entityType: string; entityLabel: string; predicate: string;
  qualifiers: string; value: string; fingerprint: string;
}

export interface ClaimSourceRef {
  segmentId: string; snapshotVersionId: string; claimId: string; evidenceRefs: string[];
}

export interface MergedClaim {
  fingerprint: string;
  key: ClaimFingerprintKey;
  /** 完全相同的合并：来源全部保留。 */
  sources: ClaimSourceRef[];
  /** 同键不同值时列出全部值。 */
  conflictingValues?: string[];
}

export interface SegmentedConflict {
  fingerprint: string; key: ClaimFingerprintKey;
  segmentIds: string[]; values: string[]; detail: string;
}

export interface SegmentedAggregate {
  claimCount: number;
  claims: MergedClaim[];
  conflicts: SegmentedConflict[];
  /** 原始 snapshot 的 relations/events/assets/missing/conflicts 全量保留。 */
  relations: Array<{ segmentId: string; snapshotVersionId: string; value: unknown }>;
  events: Array<{ segmentId: string; snapshotVersionId: string; value: unknown }>;
  assets: Array<{ segmentId: string; snapshotVersionId: string; value: unknown }>;
  missing: Array<{ segmentId: string; snapshotVersionId: string; value: unknown }>;
  rawConflicts: Array<{ segmentId: string; snapshotVersionId: string; value: unknown }>;
}

export interface SegmentedWorkflowResult {
  status: SegmentedStatus;
  passed: boolean;
  segmentRecords: SegmentRecord[];
  /** 聚合视图（去重视图），不是新快照。 */
  aggregate: SegmentedAggregate;
  /** 明确阻断全文通过的原因；为空才可能 passed=true。 */
  blockers: SegmentedBlocker[];
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 输入哈希：规范化序列化后的 sha256 指纹，用于检测陈旧输入。 */
export function hashEvidenceInput(input: EvidenceInput): string {
  return fingerprint(input);
}

/** 依规范化的 type+label / predicate / qualifiers / value 生成精确键。 */
export function claimKeyOf(snapshot: EvidenceSnapshot, claim: EvidenceSnapshot['claims'][number]): ClaimFingerprintKey {
  const entity = snapshot.entities.find((e) => e.entityId === claim.entityId);
  const entityType = entity?.entityType ?? 'unknown';
  const entityLabel = entity?.label ?? claim.entityId;
  const qualifiers = canonicalize(claim.qualifiers ?? {});
  const value = canonicalize(claim.value);
  return { entityType, entityLabel, predicate: claim.predicate, qualifiers, value,
    fingerprint: fingerprint({ entityType, entityLabel, predicate: claim.predicate, qualifiers, value }) };
}

function distinct(values: string[]): string[] { return [...new Set(values)]; }

function currentCandidate(record: SegmentRecord): CandidateRecord | undefined {
  const versionId = record.result?.currentVersionId;
  if (!versionId) return undefined;
  return record.candidates.find((c) => c.snapshotVersionId === versionId);
}

function currentSnapshot(record: SegmentRecord): EvidenceSnapshot | undefined {
  return currentCandidate(record)?.output?.candidateSnapshot;
}

// ---------------------------------------------------------------------------
// 聚合（纯函数，可独立测试；由 runner 实际调用）
// ---------------------------------------------------------------------------

/**
 * 把每段原始记录合并为聚合视图。
 * - 完全相同（指纹一致）合并，来源全部保留；
 * - 同键不同值 → 显式 conflict；
 * - 原始 relations/events/assets/missing/conflicts 原样留在视图里，不删除。
 */
function buildAggregate(plan: SegmentTask[], records: SegmentRecord[]): SegmentedAggregate {
  const byFingerprint = new Map<string, MergedClaim>();
  const aggregate: SegmentedAggregate = {
    claimCount: 0, claims: [], conflicts: [],
    relations: [], events: [], assets: [], missing: [], rawConflicts: [],
  };
  const planIds = new Set(plan.map((s) => s.id));

  for (const record of records) {
    if (!planIds.has(record.id)) continue; // 额外段不进视图
    const snapshot = currentSnapshot(record);
    if (!snapshot) continue;
    const seg = record.id;
    const snapshotVersionId = snapshot.snapshotVersionId;
    const collect = (values: unknown[] | undefined, sink: typeof aggregate.relations) => {
      for (const value of values ?? []) sink.push({ segmentId: seg, snapshotVersionId, value });
    };
    collect(snapshot.relations, aggregate.relations);
    collect(snapshot.events, aggregate.events);
    collect(snapshot.assets, aggregate.assets);
    collect(snapshot.missing, aggregate.missing);
    collect(snapshot.conflicts, aggregate.rawConflicts);

    for (const claim of snapshot.claims) {
      const key = claimKeyOf(snapshot, claim);
      const source: ClaimSourceRef = { segmentId: seg, snapshotVersionId, claimId: claim.claimId, evidenceRefs: [...claim.evidenceRefs] };
      const existing = byFingerprint.get(key.fingerprint);
      if (existing) {
        const duplicate = existing.sources.some((s) => s.segmentId === seg && s.claimId === source.claimId && s.snapshotVersionId === snapshotVersionId);
        if (!duplicate) existing.sources.push(source);
        continue;
      }
      const sameKey = findSameKeyDifferentValue(byFingerprint, key);
      if (sameKey) {
        sameKey.sources.push(source);
        sameKey.conflictingValues = distinct([...(sameKey.conflictingValues ?? [sameKey.key.value]), key.value]);
        continue;
      }
      byFingerprint.set(key.fingerprint, { fingerprint: key.fingerprint, key, sources: [source] });
    }
  }

  for (const merged of byFingerprint.values()) {
    if (merged.conflictingValues && merged.conflictingValues.length > 1) {
      aggregate.conflicts.push({
        fingerprint: merged.fingerprint, key: merged.key,
        segmentIds: distinct(merged.sources.map((s) => s.segmentId)),
        values: merged.conflictingValues,
        detail: '同一实体/谓词/限定符下出现不同取值。',
      });
    }
  }
  aggregate.claims = [...byFingerprint.values()];
  aggregate.claimCount = aggregate.claims.length;
  return aggregate;
}

function findSameKeyDifferentValue(map: Map<string, MergedClaim>, key: ClaimFingerprintKey): MergedClaim | undefined {
  for (const merged of map.values()) {
    const a = merged.key;
    if (a.entityType === key.entityType && a.entityLabel === key.entityLabel && a.predicate === key.predicate && a.qualifiers === key.qualifiers) {
      return merged;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 绑定与完整性核实
// ---------------------------------------------------------------------------

export function checkPlan(plan: SegmentTask[]): SegmentedBlocker[] {
  const blockers: SegmentedBlocker[] = [];
  if (plan.length === 0) return [{ code: 'empty_plan', detail: '计划为空。' }];
  const seen = new Set<string>();
  let projectId: string | undefined;
  for (const segment of plan) {
    if (!segment.id || segment.id.trim() === '') {
      blockers.push({ code: 'empty_segment_id', detail: '段 ID 为空。' });
      continue;
    }
    if (seen.has(segment.id)) {
      blockers.push({ code: 'duplicate_segment_id', segmentId: segment.id, detail: '段 ID 重复。' });
      continue;
    }
    seen.add(segment.id);
    if (projectId === undefined) projectId = segment.input.projectId;
    else if (segment.input.projectId !== projectId) {
      blockers.push({ code: 'project_mismatch', segmentId: segment.id, detail: '段项目与计划不一致。' });
    }
  }
  return blockers;
}

/** 逐段核实：结果状态、绑定、候选/审查完整性、会话独立、输入新鲜度与冲突/缺失。 */
export function verifySegment(record: SegmentRecord): SegmentedBlocker[] {
  const blockers: SegmentedBlocker[] = [];
  const push = (code: string, detail: string) => blockers.push({ code, segmentId: record.id, detail });

  if (record.inputHash !== hashEvidenceInput(record.input)) push('stale_input_hash', '段记录输入哈希与当前输入不一致（陈旧）。');
  if (record.error) push(record.error.code, record.error.message);
  if (!record.result) {
    push('missing_result', '段缺少工作流结果。');
    return blockers;
  }
  const { result, input } = record;
  if (!result.passed) push('segment_not_passed', '段审查未通过：' + String(result.stopReason) + '。');
  if (result.status !== 'passed' || result.executionStatus !== 'succeeded'
    || result.stopReason !== 'passed_all_checks') {
    push('segment_status_not_passed', '段工作流终态与审查通过不一致。');
  }

  const versionId = result.currentVersionId;
  if (!versionId) {
    push('missing_current_version', '缺少当前候选版本。');
    return blockers;
  }
  if (!result.candidateVersions.includes(versionId)) push('current_version_unbound', '当前候选版本不在 candidateVersions 中。');

  const currentCandidates = record.candidates.filter((c) => c.snapshotVersionId === versionId);
  if (currentCandidates.length > 1) push('duplicate_candidate_version', '当前候选版本记录重复。');
  const candidate = currentCandidates[0];
  if (!candidate) {
    push('candidate_record_missing', '缺少当前版本的候选记录。');
    return blockers;
  }
  if (candidate.state !== 'pending_review') push('candidate_state_unexpected', '候选记录状态非 pending_review。');
  if (candidate.issues.length > 0) push('candidate_has_issues', '候选记录带有校验问题。');
  const output = candidate.output;
  if (!output) {
    push('candidate_output_missing', '候选记录缺少输出。');
    return blockers;
  }

  const snapshot = output.candidateSnapshot;
  if (output.status !== 'completed') push('candidate_output_not_completed', '候选输出未完成。');
  if (output.projectId !== input.projectId || output.taskId !== input.taskId || output.attemptId !== input.attemptId) {
    push('candidate_identity_mismatch', '候选输出的 project/task/attempt 与输入不一致。');
  }
  if (snapshot.projectId !== input.projectId || snapshot.taskId !== input.taskId || snapshot.attemptId !== input.attemptId) {
    push('candidate_snapshot_identity_mismatch', '候选快照的 project/task/attempt 与输入不一致。');
  }
  if (snapshot.snapshotVersionId !== versionId) push('candidate_snapshot_version_mismatch', '候选快照版本 ID 与当前版本不一致。');
  if (snapshot.claims.length === 0) push('candidate_claims_empty', '候选快照缺少 claims。');
  if (snapshot.evidence.length === 0) push('candidate_evidence_empty', '候选快照缺少 evidence。');

  const evidenceIds = new Set(snapshot.evidence.map((e) => e.evidenceId));
  const entityIds = new Set(snapshot.entities.map((e) => e.entityId));
  for (const claim of snapshot.claims) {
    if (!entityIds.has(claim.entityId)) push('claim_entity_missing', 'claim 引用了不存在的实体：' + claim.claimId + '。');
    if (claim.evidenceRefs.length === 0) push('claim_evidence_empty', 'claim 缺少 evidenceRefs：' + claim.claimId + '。');
    for (const ref of claim.evidenceRefs) {
      if (!evidenceIds.has(ref)) push('claim_evidence_ref_missing', 'claim 引用了不存在的证据：' + ref + '。');
    }
  }

  // 审查侧核实（不信任 passed 旗标或任意旧报告）。
  const review = currentReview(record);
  if (!review) {
    push('review_record_missing', '缺少与当前候选绑定的已审报告。');
    return blockers;
  }
  if (record.reviews.filter(r => r.reportVersionId === review.reportVersionId).length !== 1) {
    push('duplicate_report_version', '当前审查版本记录重复。');
  }
  if (review.state !== 'reviewed') push('review_state_unexpected', '审查记录状态非 reviewed。');
  if (review.issues.length > 0) push('review_has_issues', '审查记录带有校验问题。');
  const reviewOutput = review.output;
  if (!reviewOutput) {
    push('review_output_missing', '审查记录缺少输出。');
    return blockers;
  }
  const report: ReviewReport = reviewOutput.report;
  if (reviewOutput.projectId !== input.projectId || reviewOutput.taskId !== input.taskId
    || reviewOutput.attemptId !== input.attemptId) {
    push('review_output_identity_mismatch', '审查输出身份与原输入不一致。');
  }
  if (report.reportVersionId !== review.reportVersionId) push('report_record_version_mismatch', '报告与存储版本不一致。');
  if (reviewOutput.status !== 'completed') push('review_output_not_completed', '审查输出状态非完成。');
  if (report.executionStatus !== 'completed') push('review_execution_not_completed', '审查执行状态非完成。');
  if (report.verdict !== 'pass') push('review_verdict_not_pass', '审查结论非 pass：' + String(report.verdict) + '。');
  if (report.reviewMode !== 'fact') push('review_mode_not_fact', '审查模式非 fact：' + String(report.reviewMode) + '。');
  if (!result.reportVersions.includes(report.reportVersionId)) push('report_version_unbound', '审查报告版本不在 result.reportVersions 中。');
  if (report.projectId !== input.projectId || report.taskId !== input.taskId || report.attemptId !== input.attemptId) {
    push('review_identity_mismatch', '审查报告的 project/task/attempt 与输入不一致。');
  }
  const subject = report.subject;
  if (subject.subjectType !== 'evidence_snapshot' || subject.snapshotId !== snapshot.snapshotId
    || subject.snapshotVersionId !== snapshot.snapshotVersionId || subject.contentHash !== fingerprint(snapshot)) {
    push('review_subject_mismatch', '审查对象与当前候选快照不一致。');
  }

  const checkTypes = new Set(report.checks.map((c) => c.checkType));
  if (report.checks.length === 0) push('review_checks_empty', '审查缺少 checks。');
  for (const required of DEFAULT_REVIEW_CHECKS) {
    if (!checkTypes.has(required)) push('review_checks_incomplete', '审查缺少检查类别：' + required + '。');
  }
  for (const check of report.checks) {
    if (check.status !== 'pass') push('review_check_not_pass', '检查未通过：' + check.checkType + '/' + String(check.status) + '。');
  }
  if (report.issues.some((i) => i.severity === 'error' || i.severity === 'critical')) {
    push('review_blocking_issues', '审查存在阻断性问题。');
  }

  const candidateSession = snapshot.producedBy.sessionId;
  const reviewSession = report.reviewedBy.sessionId;
  if (!candidateSession || !reviewSession || candidateSession === reviewSession) {
    push('session_not_independent', '候选与审查共享 sessionId，违反独立执行上下文。');
  }

  for (const conflict of snapshot.conflicts) {
    if (conflict.resolutionStatus !== 'resolved') push('candidate_open_conflict', '候选存在未决冲突：' + conflict.conflictId + '。');
  }
  for (const missing of snapshot.missing) {
    if (missing.severity === 'error' || missing.severity === 'critical') push('candidate_critical_missing', '候选存在关键缺失：' + missing.missingId + '。');
  }
  return blockers;
}

/** reportVersions 是原工作流的追加顺序；不以时间字符串排序或复用旧候选报告。
 * 选择当前候选的最新报告后完整验证；最新报告失效时不能倒退到更早的 pass。 */
function currentReview(record: SegmentRecord): ReviewRecord | undefined {
  const snapshot = currentSnapshot(record);
  if (!snapshot) return undefined;
  for (const versionId of [...(record.result?.reportVersions ?? [])].reverse()) {
    const review = record.reviews.find((r) => r.reportVersionId === versionId);
    const subject = review?.output?.report.subject;
    if (subject?.snapshotId === snapshot.snapshotId && subject.snapshotVersionId === snapshot.snapshotVersionId) return review;
  }
  return undefined;
}

/** 只接收本工作流产生的受信已校验记录，不是外部 JSON 导入或权限授予入口。
 * 返回完整性判定和诊断视图；失败时原输入/版本仍保留，视图不构成事实采纳。 */
export function mergeReviewedSegments(plan: SegmentTask[], records: SegmentRecord[]): SegmentedWorkflowResult {
  const blockers = checkPlan(plan);
  const plannedIds = new Set(plan.map(s => s.id));
  const sessions = new Set<string>();
  for (const segment of plan) {
    const matches = records.filter(r => r.id === segment.id);
    if (matches.length !== 1) {
      blockers.push({ code: matches.length ? 'duplicate_segment_result' : 'missing_segment', segmentId: segment.id, detail: '计划段必须恰好有一个结果。' });
      continue;
    }
    const record = matches[0]!;
    if (record.inputHash !== hashEvidenceInput(segment.input)) {
      blockers.push({ code: 'planned_input_mismatch', segmentId: segment.id, detail: '结果输入版本与计划不一致。' });
    }
    const issues = verifySegment(record);
    blockers.push(...issues);
    if (issues.length === 0) {
      for (const session of [currentSnapshot(record)!.producedBy.sessionId, currentReview(record)!.output!.report.reviewedBy.sessionId]) {
        if (!session) continue; // verifySegment already rejected missing provenance.
        if (sessions.has(session)) blockers.push({ code: 'session_reused', segmentId: record.id, detail: '不同段复用了执行上下文。' });
        sessions.add(session);
      }
    }
  }
  for (const record of records) {
    if (!plannedIds.has(record.id)) blockers.push({ code: 'unexpected_segment', segmentId: record.id, detail: '出现计划外段。' });
  }
  const aggregate = buildAggregate(plan, records);
  for (const conflict of aggregate.conflicts) {
    blockers.push({ code: 'claim_value_conflict', detail: '同一实体、谓词、限定符的取值冲突：' + conflict.fingerprint });
  }
  const aborted = records.some(r => r.error?.code === 'aborted' || r.result?.status === 'cancelled');
  return { status: aborted ? 'aborted' : blockers.length ? 'failed' : 'completed', passed: !aborted && blockers.length === 0,
    segmentRecords: structuredClone(records), aggregate: structuredClone(aggregate), blockers };
}

// ---------------------------------------------------------------------------
// 执行器
// ---------------------------------------------------------------------------

/**
 * 顺序执行各段，复用真实 runFactWorkflow。
 * 取消（已 abort）不启动后续段；失败段保留原始记录，不吞成空成功。
 */
export async function runSegmentedFactWorkflow(options: SegmentedWorkflowOptions): Promise<SegmentedWorkflowResult> {
  // Freeze the intended input versions before any asynchronous role execution.
  const plan = structuredClone(options.segments);
  const records: SegmentRecord[] = plan.map(segment => ({
    id: segment.id, inputHash: hashEvidenceInput(segment.input), input: segment.input,
    candidates: [], reviews: [],
  }));
  if (checkPlan(plan).length) return mergeReviewedSegments(plan, records);

  let aborted = false;
  for (const record of records) {
    if (aborted || options.signal?.aborted) {
      aborted = true;
      record.error = { code: 'aborted', message: '任务已取消，未启动该段。', fatal: true };
      continue;
    }
    const candidateStore = new MemoryCandidateStore();
    const reviewStore = new MemoryReviewStore();
    const workflowOptions: FactWorkflowOptions = {
      input: record.input, config: options.config, registry: options.registry,
      candidateStore, reviewStore,
      runStore: options.runStore, sourceBundles: options.sourceBundles,
      checksRequired: options.checksRequired, maxRepairRounds: options.maxRepairRounds,
      spendBudget: options.spendBudget, evidenceLimits: options.evidenceLimits,
      reviewLimits: options.reviewLimits, signal: options.signal, now: options.now,
    };
    try {
      record.result = await runFactWorkflow(workflowOptions);
    } catch (error) {
      record.error = { code: 'segment_execution_failed', message: error instanceof Error ? error.message : String(error), fatal: true };
    } finally {
      record.candidates = candidateStore.list();
      record.reviews = reviewStore.list();
    }
    if (options.signal?.aborted || record.result?.status === 'cancelled') {
      aborted = true;
      record.error = { code: 'aborted', message: '执行期间收到取消信号。', fatal: true };
    }
  }
  return mergeReviewedSegments(plan, records);
}

export { DEFAULT_REVIEW_CHECKS };
