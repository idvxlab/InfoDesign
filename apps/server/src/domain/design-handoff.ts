/**
 * 设计交接包（Design Handoff Package）适配器模块。
 *
 * 定位与信任边界：
 *  - 本模块是「服务适配层」，把服务端已校验的事实运行记录（FactRunRecord）投影为
 *    一份设计团队可消费的只读交接包。它**不是**新的 DesignInput 正式协议；包内
 *    `packageVersion` 仅表示本适配器版本号。
 *  - 信任来源仅限服务端可信依赖：`FactRunStore`（只读 `get(runId)`）与
 *    调用方独立提供的「可信上下文钉」。提交方（上传物）永远不是信任来源；
 *    只有与「依据同一可信依赖与上下文重新派生」的期望包逐字段相等才算绑定。
 *  - 不生成新时间戳：需要时间时只复用 `record.updatedAt`。
 *  - 不产生审批闸门、不改动事实、不触发采纳；`pending` 事实保持原状。
 */
import type { EvidenceInput } from '../../../../packages/contracts/generated/evidence-input.ts';
import type { EvidenceOutput } from '../../../../packages/contracts/generated/evidence-output.ts';
import type { ReviewOutput } from '../../../../packages/contracts/generated/review-output.ts';
import type { EvidenceSnapshot } from '../../../../packages/contracts/generated/evidence-snapshot.ts';
import type { CommonCheckType, CommonDocumentVersionRef } from '../../../../packages/contracts/generated/common.ts';
import type { FactRunRecord, FactRunStore } from './fact-run.service.ts';
import { buildReviewInput, DEFAULT_REVIEW_CHECKS } from '../orchestration/fact-workflow.ts';
import { evaluateReviewReport } from './review-decision.ts';
import { checkReviewOutput, evaluateAdoption } from '../../../../packages/contracts/src/service-checks.ts';
import type { SchemaRegistry } from '../../../../packages/contracts/src/schema-registry.ts';
import { fingerprint } from '../../../../packages/contracts/src/fingerprint.ts';
import { canonicalize } from '../../../../packages/contracts/src/validator.ts';

/** 交接包适配器版本号；仅代表本适配器，不是新的正式协议版本。 */
export const DESIGN_HANDOFF_PACKAGE_VERSION = '1.0' as const;

/** 两条分支共用的设计团队联调状态：本单元尚未完成真实对接。 */
export const DESIGN_TEAM_STATUS = '待联调' as const;

/**
 * 调用方独立提供的可信上下文钉。全部字段必须由服务端从可信编排上下文注入，
 * **绝不**能从被提交的交接包读取；用于在读取 store 前先做身份范围校验。
 */
export interface HandoffContextPins {
  runId: string;
  projectId: string;
  taskId: string;
  attemptId: string;
  expectedCandidateVersionId: string | null;
  expectedReportVersionId: string | null;
  allowedDocumentRefs: CommonDocumentVersionRef[];
  checksRequired: CommonCheckType[];
}

/** 安全的结构化原因：只含稳定码与安全说明，绝不携带可消费事实或原始错误。 */
export interface HandoffReason {
  code: string;
  message: string;
  path?: string;
}

/** 就绪分支的最小 MOCK 引用/声明摘要：仅用于本地接口校验演示。 */
export interface MockConsumerSummary {
  runId: string;
  candidateVersionId: string;
  reportVersionId: string;
  reviewVerdict: string;
  bindingFingerprint: string;
  /** 声明投影：每条声明持有的证据 id 引用。 */
  claims: Array<{ claimId: string; supportStatus: string; evidenceIds: string[] }>;
  /** 证据投影：物理来源位置。 */
  evidence: Array<{
    evidenceId: string;
    documentId: string;
    documentVersionId: string;
    blockId: string;
    locator: EvidenceSnapshot['evidence'][number]['locator'];
  }>;
  /** 来源文档投影：物理文档版本引用。 */
  sources: Array<{ documentId: string; documentVersionId: string }>;
}

/** 已就绪的交接包：包含可复用类型、完整快照与原始来源位置。 */
export interface DesignHandoffReadyPackage {
  kind: 'ready';
  packageVersion: typeof DESIGN_HANDOFF_PACKAGE_VERSION;
  designTeamStatus: typeof DESIGN_TEAM_STATUS;
  bindingFingerprint: string;
  recordedAt: string;
  identity: {
    runId: string;
    projectId: string;
    taskId: string;
    attemptId: string;
    candidateVersionId: string;
    reportVersionId: string;
    candidateFingerprint: string;
    reportFingerprint: string;
    reviewVerdict: string;
    stopReason: string;
  };
  evidenceOutput: EvidenceOutput;
  reviewOutput: ReviewOutput;
  documents: EvidenceInput['documents'];
  /** 经快照证据保留的原始来源位置。 */
  sourceLocations: Array<{
    evidenceId: string;
    documentId: string;
    documentVersionId: string;
    blockId: string;
    locator: EvidenceSnapshot['evidence'][number]['locator'];
  }>;
  checksRequired: CommonCheckType[];
}

/** 被阻断的交接包：仅安全结构化原因，**不含**任何可消费事实。 */
export interface DesignHandoffBlockedPackage {
  kind: 'blocked';
  packageVersion: typeof DESIGN_HANDOFF_PACKAGE_VERSION;
  designTeamStatus: typeof DESIGN_TEAM_STATUS;
  recordedAt: string;
  reasons: HandoffReason[];
  stopReason?: string;
}

export type DesignHandoffPackage = DesignHandoffReadyPackage | DesignHandoffBlockedPackage;

/** 消费者等值校验结果。 */
export interface HandoffVerificationResult {
  ok: boolean;
  reasons: HandoffReason[];
}

/* ── 通用工具 ───────────────────────────────────────────────────────────────── */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function blocked(
  reasons: HandoffReason[],
  recordedAt: string,
  stopReason?: string,
): DesignHandoffBlockedPackage {
  return {
    kind: 'blocked',
    packageVersion: DESIGN_HANDOFF_PACKAGE_VERSION,
    designTeamStatus: DESIGN_TEAM_STATUS,
    recordedAt,
    reasons,
    ...(stopReason !== undefined ? { stopReason } : {}),
  };
}

/** 只读、容错的 store 读取；任何异常折叠为 undefined，不上抛原始错误。 */
function safeReadRecord(store: FactRunStore, runId: string): FactRunRecord | undefined {
  try {
    return store.get(runId);
  } catch {
    return undefined;
  }
}

/** 安全解析 JSON 字符串；失败返回 undefined，不泄露解析错误。 */
function safeJsonParse(raw: unknown): unknown {
  if (typeof raw !== 'string') return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** 深比较：原始工件 JSON 必须与已解析输出完全一致。 */
function rawMatchesParsed(raw: unknown, parsed: unknown): boolean {
  const fromRaw = safeJsonParse(raw);
  if (fromRaw === undefined) return false;
  try {
    return canonicalize(fromRaw) === canonicalize(parsed);
  } catch {
    return false;
  }
}

/** 校验 checksRequired：非空且全部为权威 CommonCheckType 值。 */
const COMMON_CHECK_TYPES: readonly CommonCheckType[] = DEFAULT_REVIEW_CHECKS;
function validateChecksRequired(checks: CommonCheckType[]): boolean {
  if (!Array.isArray(checks) || checks.length === 0) return false;
  return checks.every((type) => COMMON_CHECK_TYPES.includes(type));
}

/** 文档引用键，用于白名单交叉核对。 */
function refKey(documentId: unknown, documentVersionId: unknown): string {
  const id = typeof documentId === 'string' ? documentId : '';
  const ver = typeof documentVersionId === 'string' ? documentVersionId : '';
  return `${id}::${ver}`;
}

/**
 * 安全调用注册表：任一校验失败或异常折叠为 undefined（fail-closed），
 * 不返回原始错误文本，不通过类型断言掩盖结构性错误。
 */
function safeValidateRegistry(
  registry: SchemaRegistry,
  entries: ReadonlyArray<readonly [string, unknown]>,
): boolean[] | undefined {
  const results: boolean[] = [];
  for (const [urn, payload] of entries) {
    try {
      const outcome = registry.validate(urn, payload);
      if (!isObject(outcome) || typeof outcome.valid !== 'boolean') return undefined;
      results.push(outcome.valid);
    } catch {
      return undefined;
    }
  }
  return results;
}

const SEVERITY_BLOCKING = new Set(['error', 'critical']);/* ── 包派生 ─────────────────────────────────────────────────────────────────── */

/**
 * 依据可信 FactRunStore 与注册表，产出交接包。只读 `store.get(runId)`；
 * 身份不匹配时早阻断，阻断分支绝不回显来源数据。
 */
export function produceDesignHandoff(
  store: FactRunStore,
  registry: SchemaRegistry,
  pins: HandoffContextPins,
): DesignHandoffPackage {
  const reasons: HandoffReason[] = [];

  // 1) 上下文钉结构校验（独立于 store）。
  if (!isObject(pins)
    || typeof pins.runId !== 'string' || pins.runId.length === 0
    || typeof pins.projectId !== 'string' || pins.projectId.length === 0
    || typeof pins.taskId !== 'string' || pins.taskId.length === 0
    || typeof pins.attemptId !== 'string' || pins.attemptId.length === 0) {
    return blocked([{ code: 'context.invalid', message: '可信上下文钉缺失或类型非法', path: 'context' }], '');
  }
  if (pins.expectedCandidateVersionId !== null && typeof pins.expectedCandidateVersionId !== 'string') {
    return blocked([{ code: 'context.invalid_candidate_pin', message: '期望候选版本钉类型非法', path: 'context.expectedCandidateVersionId' }], '');
  }
  if (pins.expectedReportVersionId !== null && typeof pins.expectedReportVersionId !== 'string') {
    return blocked([{ code: 'context.invalid_report_pin', message: '期望报告版本钉类型非法', path: 'context.expectedReportVersionId' }], '');
  }
  if (!Array.isArray(pins.allowedDocumentRefs)) {
    return blocked([{ code: 'context.invalid_doc_allowlist', message: '允许文档引用白名单缺失', path: 'context.allowedDocumentRefs' }], '');
  }
  if (!validateChecksRequired(pins.checksRequired)) {
    return blocked([{ code: 'context.invalid_checks', message: '必需检查列表为空或含非法检查类型', path: 'context.checksRequired' }], '');
  }

  // 2) 只读读取可信记录；缺失/损坏 fail-closed。
  const record = safeReadRecord(store, pins.runId);
  if (record === undefined || !isObject(record)) {
    return blocked([{ code: 'store.not_found', message: '未找到可信运行记录，或记录不可读' }], '');
  }

  const recordedAt = typeof record.updatedAt === 'string' ? record.updatedAt : '';

  // 3) 身份范围校验。
  if (record.runId !== pins.runId
    || record.projectId !== pins.projectId
    || record.taskId !== pins.taskId
    || record.attemptId !== pins.attemptId) {
    return blocked([{ code: 'identity.scope_mismatch', message: '运行记录身份与可信上下文钉不一致' }], recordedAt);
  }

  try {
    return derive(record, registry, pins, reasons, recordedAt);
  } catch {
    // 生产者意外异常一律折叠为安全阻断，绝不泄露原始错误。
    return blocked([{ code: 'producer.error', message: '交接包派生过程中出现内部错误' }], recordedAt);
  }
}

/** 派生正文：捕获任何意外异常由调用方折叠为安全阻断。 */
function derive(
  record: FactRunRecord,
  registry: SchemaRegistry,
  pins: HandoffContextPins,
  reasons: HandoffReason[],
  recordedAt: string,
): DesignHandoffPackage {
  // 4) 终态与停止原因：多条件与。
  if (record.status !== 'passed') reasons.push({ code: 'status.not_passed', message: '运行终态不是 passed', path: 'status' });
  if (record.executionStatus !== 'succeeded') reasons.push({ code: 'execution.not_succeeded', message: '执行终态不是 succeeded', path: 'executionStatus' });
  if (record.passed !== true) reasons.push({ code: 'passed.not_true', message: 'passed 不为 true', path: 'passed' });
  if (record.stopReason !== 'passed_all_checks') reasons.push({ code: 'stop_reason.not_all_checks', message: '停止原因不是 passed_all_checks', path: 'stopReason' });
  if (record.stage !== 'done') reasons.push({ code: 'stage.not_done', message: '执行阶段不是 done', path: 'stage' });

  // 5) remainingIssues 形状校验：仅 error/critical 阻断，保留 info/warning。
  const remainingIssues = record.remainingIssues;
  if (!Array.isArray(remainingIssues)) {
    reasons.push({ code: 'remaining_issues.malformed', message: '未解决问题列表结构非法', path: 'remainingIssues' });
  } else if (remainingIssues.some((issue) => isObject(issue) && SEVERITY_BLOCKING.has(issue.severity as string))) {
    reasons.push({ code: 'remaining_issues.blocking', message: '仍存在阻断级未解决问题', path: 'remainingIssues' });
  }

  // 6) 版本与轮次/工件数组形状校验。
  const candidateVersions = record.candidateVersions;
  const reportVersions = record.reportVersions;
  if (!Array.isArray(candidateVersions)) reasons.push({ code: 'candidate_versions.malformed', message: '候选版本列表结构非法', path: 'candidateVersions' });
  if (!Array.isArray(reportVersions)) reasons.push({ code: 'report_versions.malformed', message: '报告版本列表结构非法', path: 'reportVersions' });
  const rounds = record.rounds;
  if (!Array.isArray(rounds)) reasons.push({ code: 'rounds.malformed', message: '编排轮次列表结构非法', path: 'rounds' });
  const artifacts = record.artifacts;
  if (!Array.isArray(artifacts)) reasons.push({ code: 'artifacts.malformed', message: '工件列表结构非法', path: 'artifacts' });

  // 定位最终轮次。实际成功记录：run.stage='done'，但最终 round.stage 保持 'reviewing'。
  let finalRound: Record<string, unknown> | undefined;
  if (Array.isArray(rounds)) {
    if (rounds.length === 0) {
      reasons.push({ code: 'rounds.empty', message: '缺少编排轮次记录', path: 'rounds' });
    } else {
      const last = rounds[rounds.length - 1];
      if (!isObject(last)) reasons.push({ code: 'final_round.malformed', message: '最终轮次记录结构非法', path: 'rounds' });
      else finalRound = last;
    }
  }

  // 期望版本钉：ready 分支必须给出有效钉，并与 currentVersionId/版本列表/最终轮一致。
  const candidateVersionId = pins.expectedCandidateVersionId;
  const reportVersionId = pins.expectedReportVersionId;
  if (candidateVersionId === null || reportVersionId === null) {
    reasons.push({ code: 'pin.missing', message: '就绪交接必须提供候选/报告版本钉', path: 'context' });
  } else {
    if (record.currentVersionId !== candidateVersionId) {
      reasons.push({ code: 'pin.current_version_mismatch', message: '记录当前版本与期望候选版本钉不一致', path: 'currentVersionId' });
    }
    if (Array.isArray(candidateVersions) && !candidateVersions.includes(candidateVersionId)) {
      reasons.push({ code: 'pin.candidate_not_persisted', message: '期望候选版本未出现在候选版本列表', path: 'candidateVersions' });
    }
    if (Array.isArray(reportVersions) && !reportVersions.includes(reportVersionId)) {
      reasons.push({ code: 'pin.report_not_persisted', message: '期望报告版本未出现在报告版本列表', path: 'reportVersions' });
    }
    if (finalRound !== undefined) {
      if (finalRound.stage !== 'reviewing') reasons.push({ code: 'final_round.stage_invalid', message: '最终轮阶段不是 reviewing', path: 'rounds' });
      if (finalRound.decision !== 'pass') reasons.push({ code: 'final_round.not_pass', message: '最终轮决策不是 pass', path: 'rounds' });
      if (finalRound.candidateVersionId !== candidateVersionId) reasons.push({ code: 'pin.candidate_mismatch', message: '期望候选版本与最终轮绑定不一致', path: 'rounds.candidateVersionId' });
      if (finalRound.reportVersionId !== reportVersionId) reasons.push({ code: 'pin.report_mismatch', message: '期望报告版本与最终轮绑定不一致', path: 'rounds.reportVersionId' });
      const roundIssues = finalRound.issues;
      if (roundIssues !== undefined && !Array.isArray(roundIssues)) {
        reasons.push({ code: 'final_round.issues_malformed', message: '最终轮问题列表结构非法', path: 'rounds.issues' });
      } else if (Array.isArray(roundIssues)
        && roundIssues.some((issue) => isObject(issue) && SEVERITY_BLOCKING.has(issue.severity as string))) {
        reasons.push({ code: 'final_round.issues_blocking', message: '最终轮仍存在阻断级问题', path: 'rounds.issues' });
      }
    }
  }

  if (reasons.length > 0 || candidateVersionId === null || reportVersionId === null || finalRound === undefined) {
    return blocked(reasons.length > 0 ? reasons : [{ code: 'pin.missing', message: '缺少候选/报告版本钉' }], recordedAt, record.stopReason);
  }

  // 7) 收集工件：候选与报告，逐一绑定本 run 版本；重复即失败。
  let candidateArtifact: Record<string, unknown> | undefined;
  let reportArtifact: Record<string, unknown> | undefined;
  if (Array.isArray(artifacts)) {
    const candidates: Record<string, unknown>[] = [];
    const reports: Record<string, unknown>[] = [];
    let artifactShapeBad = false;
    for (const artifact of artifacts) {
      if (!isObject(artifact)) { artifactShapeBad = true; break; }
      if (artifact.kind === 'candidate' && artifact.versionId === candidateVersionId) candidates.push(artifact);
      if (artifact.kind === 'report' && artifact.versionId === reportVersionId) reports.push(artifact);
    }
    if (artifactShapeBad) {
      reasons.push({ code: 'artifact.malformed', message: '工件条目结构非法', path: 'artifacts' });
    } else {
      if (candidates.length === 0) reasons.push({ code: 'artifact.candidate_missing', message: '缺少最终候选工件' });
      if (candidates.length > 1) reasons.push({ code: 'artifact.candidate_duplicate', message: '最终候选项存在重复工件' });
      if (reports.length === 0) reasons.push({ code: 'artifact.report_missing', message: '缺少最终报告工件' });
      if (reports.length > 1) reasons.push({ code: 'artifact.report_duplicate', message: '最终报告项存在重复工件' });
      candidateArtifact = candidates.length === 1 ? candidates[0] : undefined;
      reportArtifact = reports.length === 1 ? reports[0] : undefined;
    }
  }

  // 实际成功记录：候选工件 state='pending_review'，报告工件 state='reviewed'。
  if (candidateArtifact !== undefined && candidateArtifact.state !== 'pending_review') {
    reasons.push({ code: 'artifact.candidate_invalid_state', message: '最终候选状态非法（应为 pending_review）', path: 'artifacts' });
  }
  if (reportArtifact !== undefined && reportArtifact.state !== 'reviewed') {
    reasons.push({ code: 'artifact.report_invalid_state', message: '最终报告状态非法（应为 reviewed）', path: 'artifacts' });
  }

  const input = record.inputSnapshot;
  if (!isObject(input)) reasons.push({ code: 'input.missing', message: '缺少原始输入快照', path: 'inputSnapshot' });

  if (reasons.length > 0 || candidateArtifact === undefined || reportArtifact === undefined || !isObject(input)) {
    return blocked(reasons, recordedAt, record.stopReason);
  }

  // 8) schema 校验（解引用前）：输入、候选输出、报告输出。
  if (candidateArtifact.output === undefined) reasons.push({ code: 'schema.evidence_output_invalid', message: '候选输出缺失，无法校验 schema' });
  if (reportArtifact.output === undefined) reasons.push({ code: 'schema.review_output_invalid', message: '报告输出缺失，无法校验 schema' });
  if (reasons.length === 0) {
    const validation = safeValidateRegistry(registry, [
      ['urn:tju-mas:contracts:evidence-input', input],
      ['urn:tju-mas:contracts:evidence-output', candidateArtifact.output],
      ['urn:tju-mas:contracts:review-output', reportArtifact.output],
    ]);
    if (validation === undefined) {
      reasons.push({ code: 'registry.unavailable', message: 'schema 注册表不可用或校验失败' });
    } else {
      if (!validation[0]) reasons.push({ code: 'schema.input_invalid', message: '原始输入未通过 schema 校验', path: 'inputSnapshot' });
      if (!validation[1]) reasons.push({ code: 'schema.evidence_output_invalid', message: '候选输出未通过 schema 校验' });
      if (!validation[2]) reasons.push({ code: 'schema.review_output_invalid', message: '报告输出未通过 schema 校验' });
    }
  }

  // 9) 原始 JSON 必须等于解析输出。
  if (!rawMatchesParsed(candidateArtifact.rawOutput, candidateArtifact.output)) {
    reasons.push({ code: 'artifact.candidate_raw_mismatch', message: '候选原始工件内容与解析输出不一致' });
  }
  if (!rawMatchesParsed(reportArtifact.rawOutput, reportArtifact.output)) {
    reasons.push({ code: 'artifact.report_raw_mismatch', message: '报告原始工件内容与解析输出不一致' });
  }

  if (reasons.length > 0) return blocked(reasons, recordedAt, record.stopReason);

  const evidenceOutput = candidateArtifact.output as EvidenceOutput;
  const reviewOutput = reportArtifact.output as ReviewOutput;
  const evidenceInput = input as EvidenceInput;
  const snapshot = evidenceOutput.candidateSnapshot as EvidenceSnapshot;

  // 10) 交叉核对身份：输出与输入、报告与候选。
  if (evidenceOutput.taskId !== pins.taskId || evidenceOutput.attemptId !== pins.attemptId || evidenceOutput.projectId !== pins.projectId) {
    reasons.push({ code: 'cross.evidence_identity_mismatch', message: '候选输出身份与可信上下文不一致' });
  }
  if (reviewOutput.taskId !== pins.taskId || reviewOutput.attemptId !== pins.attemptId || reviewOutput.projectId !== pins.projectId) {
    reasons.push({ code: 'cross.review_identity_mismatch', message: '报告输出身份与可信上下文不一致' });
  }
  if (snapshot.taskId !== pins.taskId || snapshot.attemptId !== pins.attemptId || snapshot.projectId !== pins.projectId) {
    reasons.push({ code: 'cross.snapshot_identity_mismatch', message: '候选快照身份与可信上下文不一致' });
  }
  if (snapshot.snapshotVersionId !== candidateVersionId) {
    reasons.push({ code: 'cross.snapshot_version_mismatch', message: '候选快照版本与最终候选版本钉不一致' });
  }
  if (evidenceInput.taskId !== pins.taskId || evidenceInput.attemptId !== pins.attemptId || evidenceInput.projectId !== pins.projectId) {
    reasons.push({ code: 'cross.input_identity_mismatch', message: '原始输入身份与可信上下文不一致' });
  }

  // 11) 来源访问交叉核对：白名单 + 物理来源解析 + 覆盖 + 报告绑定。
  const inputScope = isObject(evidenceInput.scope) ? evidenceInput.scope : undefined;
  if (inputScope === undefined) {
    reasons.push({ code: 'source.scope_missing', message: '原始输入缺少 scope', path: 'inputSnapshot.scope' });
  } else if (inputScope.projectId !== pins.projectId) {
    reasons.push({ code: 'source.project_mismatch', message: '原始输入 scope 项目与可信上下文不一致', path: 'inputSnapshot.scope.projectId' });
  }

  const documents = Array.isArray(evidenceInput.documents) ? evidenceInput.documents : undefined;
  if (documents === undefined) reasons.push({ code: 'source.documents_malformed', message: '原始输入文档列表结构非法', path: 'inputSnapshot.documents' });

  // 白名单集合（可信、独立）。
  const allow = new Set<string>();
  for (const ref of pins.allowedDocumentRefs) {
    if (!isObject(ref)) {
      reasons.push({ code: 'source.allowlist_malformed', message: '允许文档引用白名单条目结构非法', path: 'context.allowedDocumentRefs' });
      break;
    }
    allow.add(refKey(ref.documentId, ref.documentVersionId));
  }

  // 已持久化的物理文档+块索引：documentId::documentVersionId -> Set(blockId)。
  const persisted = new Map<string, Set<string>>();
  if (documents !== undefined) {
    for (const doc of documents) {
      if (!isObject(doc)
        || typeof doc.projectId !== 'string'
        || typeof doc.documentId !== 'string'
        || typeof doc.documentVersionId !== 'string'
        || !Array.isArray(doc.blocks)) {
        reasons.push({ code: 'source.document_malformed', message: '原始输入文档条目结构非法', path: 'inputSnapshot.documents' });
        break;
      }
      if (doc.projectId !== pins.projectId) {
        reasons.push({ code: 'source.document_project_mismatch', message: '原始输入文档项目与可信上下文不一致', path: 'inputSnapshot.documents' });
        break;
      }
      const key = refKey(doc.documentId, doc.documentVersionId);
      if (!allow.has(key)) {
        reasons.push({ code: 'source.document_not_allowed', message: '原始输入文档不在可信白名单内', path: 'inputSnapshot.documents' });
        break;
      }
      const blocks = new Set<string>();
      let blockBad = false;
      for (const block of doc.blocks as unknown[]) {
        if (!isObject(block) || typeof block.blockId !== 'string') { blockBad = true; break; }
        blocks.add(block.blockId);
      }
      if (blockBad) {
        reasons.push({ code: 'source.block_malformed', message: '文档块条目结构非法', path: 'inputSnapshot.documents' });
        break;
      }
      if (persisted.has(key)) {
        reasons.push({ code: 'source.document_duplicate', message: '原始输入存在重复物理文档版本', path: 'inputSnapshot.documents' });
        break;
      }
      persisted.set(key, blocks);
    }
  }

  // input.scope.documentRefs 必须存在且全部在白名单内、且已持久化。
  const scopeRefs = inputScope !== undefined && Array.isArray(inputScope.documentRefs) ? inputScope.documentRefs : undefined;
  if (inputScope !== undefined && scopeRefs === undefined) {
    reasons.push({ code: 'source.scope_refs_malformed', message: '原始输入 scope.documentRefs 结构非法', path: 'inputSnapshot.scope.documentRefs' });
  } else if (scopeRefs !== undefined) {
    for (const ref of scopeRefs) {
      if (!isObject(ref)) {
        reasons.push({ code: 'source.scope_ref_malformed', message: 'scope 文档引用条目结构非法', path: 'inputSnapshot.scope.documentRefs' });
        break;
      }
      const key = refKey(ref.documentId, ref.documentVersionId);
      if (!allow.has(key)) {
        reasons.push({ code: 'source.scope_ref_not_allowed', message: 'scope 引用的文档不在可信白名单内', path: 'inputSnapshot.scope.documentRefs' });
        break;
      }
      if (!persisted.has(key)) {
        reasons.push({ code: 'source.scope_ref_not_persisted', message: 'scope 引用的物理文档未出现在原始输入', path: 'inputSnapshot.scope.documentRefs' });
        break;
      }
    }
  }

  // 快照证据数组形状校验，并逐条解析到实际持久化文档+块。
  const evidenceEntries = Array.isArray(snapshot.evidence) ? snapshot.evidence : undefined;
  if (evidenceEntries === undefined) {
    reasons.push({ code: 'source.evidence_malformed', message: '快照证据列表结构非法', path: 'snapshot.evidence' });
  } else {
    for (const entry of evidenceEntries) {
      if (!isObject(entry)
        || typeof entry.evidenceId !== 'string'
        || typeof entry.documentId !== 'string'
        || typeof entry.documentVersionId !== 'string'
        || typeof entry.blockId !== 'string') {
        reasons.push({ code: 'source.evidence_malformed', message: '快照证据条目结构非法', path: 'snapshot.evidence' });
        break;
      }
      const key = refKey(entry.documentId, entry.documentVersionId);
      if (!allow.has(key)) {
        reasons.push({ code: 'cross.source_not_allowed', message: '来源文档不在可信白名单内', path: 'snapshot.evidence' });
        break;
      }
      const blocks = persisted.get(key);
      if (blocks === undefined || !blocks.has(entry.blockId)) {
        reasons.push({ code: 'cross.source_not_persisted', message: '来源证据未解析到已持久化文档块', path: 'snapshot.evidence' });
        break;
      }
    }
  }

  // coverage.documentsProcessed 必须逐条与白名单/持久化/覆盖块一致。
  const coverage = isObject(snapshot.coverage) ? snapshot.coverage : undefined;
  const documentsProcessed = coverage !== undefined && Array.isArray(coverage.documentsProcessed)
    ? coverage.documentsProcessed
    : undefined;
  if (coverage === undefined) {
    reasons.push({ code: 'coverage.missing', message: '快照缺少 coverage', path: 'snapshot.coverage' });
  } else if (documentsProcessed === undefined) {
    reasons.push({ code: 'coverage.malformed', message: 'coverage.documentsProcessed 结构非法', path: 'snapshot.coverage.documentsProcessed' });
  } else {
    for (const processed of documentsProcessed) {
      if (!isObject(processed)
        || typeof processed.documentId !== 'string'
        || typeof processed.documentVersionId !== 'string'
        || !Array.isArray(processed.blockIds)) {
        reasons.push({ code: 'coverage.malformed', message: 'coverage 文档处理条目结构非法', path: 'snapshot.coverage.documentsProcessed' });
        break;
      }
      const key = refKey(processed.documentId, processed.documentVersionId);
      if (!allow.has(key)) {
        reasons.push({ code: 'coverage.document_not_allowed', message: 'coverage 引用的文档不在可信白名单内', path: 'snapshot.coverage.documentsProcessed' });
        break;
      }
      const blocks = persisted.get(key);
      if (blocks === undefined) {
        reasons.push({ code: 'coverage.document_not_persisted', message: 'coverage 引用的物理文档未出现在原始输入', path: 'snapshot.coverage.documentsProcessed' });
        break;
      }
      let coveredBad = false;
      for (const blockId of processed.blockIds as unknown[]) {
        if (typeof blockId !== 'string' || !blocks.has(blockId)) { coveredBad = true; break; }
      }
      if (coveredBad) {
        reasons.push({ code: 'coverage.block_not_persisted', message: 'coverage 覆盖的块未出现在已持久化文档', path: 'snapshot.coverage.documentsProcessed' });
        break;
      }
    }
  }

  // 报告绑定：reviewOutput.report.reportVersionId 必须等于钉住的报告工件版本。
  const reviewReport = isObject(reviewOutput.report) ? reviewOutput.report : undefined;
  if (reviewReport === undefined) {
    reasons.push({ code: 'review.report_malformed', message: '审查报告负载结构非法' });
  } else if (reviewReport.reportVersionId !== reportVersionId) {
    reasons.push({ code: 'review.report_version_mismatch', message: '审查报告版本与钉住的报告工件不一致' });
  }

  if (reasons.length > 0) return blocked(reasons, recordedAt, record.stopReason);

  // 12) 复用既有纯函数：审查输入构建、报告校验、决策评估、采纳资格。
  const reviewInput = buildReviewInput(evidenceInput, snapshot, pins.checksRequired);
  const reviewCheck = checkReviewOutput(reviewOutput, reviewInput, snapshot, registry);
  if (!reviewCheck.ok) {
    for (const issue of reviewCheck.issues) {
      reasons.push({ code: `review.${issue.code}`, message: issue.message });
    }
  }

  const evaluation = evaluateReviewReport(reviewOutput, snapshot);
  if (evaluation.consistency.length > 0) {
    reasons.push({ code: 'review.inconsistent', message: '审查报告一致性违规' });
  }
  if (evaluation.decision.kind !== 'pass') {
    reasons.push({ code: 'review.not_pass', message: '审查决策不是 pass' });
  }

  const adoption = evaluateAdoption(
    snapshot as unknown as Record<string, unknown>,
    (reviewReport ?? {}) as Record<string, unknown>,
    registry,
    { outputStatus: reviewOutput.status, checksRequired: pins.checksRequired },
  );
  if (!adoption.ok) {
    for (const issue of adoption.issues) {
      reasons.push({ code: `adoption.${issue.code}`, message: issue.message });
    }
  }

  if (reasons.length > 0) return blocked(reasons, recordedAt, record.stopReason);

  // 13) 组装就绪包：保留可复用类型、完整快照、原始来源位置；不新增事实格式。
  const candidateFingerprint = fingerprint(snapshot);
  const reportFingerprint = fingerprint(reviewOutput.report);
  const sourceLocations = (evidenceEntries ?? []).map((entry) => ({
    evidenceId: entry.evidenceId,
    documentId: entry.documentId,
    documentVersionId: entry.documentVersionId,
    blockId: entry.blockId,
    locator: entry.locator,
  }));

  const identity = {
    runId: record.runId,
    projectId: record.projectId,
    taskId: record.taskId,
    attemptId: record.attemptId,
    candidateVersionId,
    reportVersionId,
    candidateFingerprint,
    reportFingerprint,
    reviewVerdict: reviewOutput.report.verdict,
    stopReason: record.stopReason,
  };

  // 绑定指纹：对确定性载荷做实际指纹（sha256:hex），而非整段 canonical JSON。
  const bindingFingerprint = fingerprint({
    packageVersion: DESIGN_HANDOFF_PACKAGE_VERSION,
    identity,
    checksRequired: pins.checksRequired,
    documents: evidenceInput.documents,
    evidenceOutput,
    reviewOutput,
    sourceLocations,
  });

  return structuredClone({
    kind: 'ready' as const,
    packageVersion: DESIGN_HANDOFF_PACKAGE_VERSION,
    designTeamStatus: DESIGN_TEAM_STATUS,
    bindingFingerprint,
    recordedAt,
    identity,
    evidenceOutput,
    reviewOutput,
    documents: evidenceInput.documents,
    sourceLocations,
    checksRequired: pins.checksRequired,
  });
}

/* ── 消费者等值校验 ─────────────────────────────────────────────────────────── */

/** 判定包是否为就绪包（结构判别，不构成信任）。 */
function isReadyPackage(pkg: unknown): pkg is DesignHandoffReadyPackage {
  return isObject(pkg) && pkg.kind === 'ready';
}

/**
 * 消费者校验：用同一组独立可信 store/上下文钉从零重新派生期望包，再做规范化等值比较。
 * 期望为 blocked 时，任何非 blocked（含任意 blocked 载荷）都不构成绑定 → ok:false。
 */
export function verifyDesignHandoff(
  submitted: unknown,
  store: FactRunStore,
  registry: SchemaRegistry,
  pins: HandoffContextPins,
): HandoffVerificationResult {
  const expected = produceDesignHandoff(store, registry, pins);

  if (!isObject(submitted)) {
    return { ok: false, reasons: [{ code: 'verify.malformed', message: '提交包不可解析' }] };
  }

  // 期望 blocked：只有「提交也 blocked」且逐字段等于期望 blocked 才可视为一致；
  // 但 blocked 分支无绑定，一律 ok:false，避免误导性验证通过。
  if (expected.kind === 'blocked') {
    return { ok: false, reasons: [{ code: 'verify.expected_blocked', message: '可信派生为阻断包，无法验证为就绪' }] };
  }

  if (!isReadyPackage(submitted)) {
    return { ok: false, reasons: [{ code: 'verify.kind_mismatch', message: '提交包分支与可信派生不一致' }] };
  }

  let submittedCanonical: string;
  let expectedCanonical: string;
  try {
    submittedCanonical = canonicalize(submitted);
    expectedCanonical = canonicalize(expected);
  } catch {
    return { ok: false, reasons: [{ code: 'verify.uncomparable', message: '提交包无法规范化比较' }] };
  }

  if (submittedCanonical !== expectedCanonical) {
    return { ok: false, reasons: [{ code: 'verify.not_bound', message: '提交包与可信重新派生结果不一致' }] };
  }

  return { ok: true, reasons: [] };
}

/**
 * 供消费者/测试使用的就绪摘要：仅在 `verifyDesignHandoff` 通过后才给出最小
 * MOCK 引用/声明摘要，否则返回 null。绝不据此进行真值消费或采纳。
 */
export function summarizeDesignHandoff(
  submitted: unknown,
  store: FactRunStore,
  registry: SchemaRegistry,
  pins: HandoffContextPins,
): MockConsumerSummary | null {
  const verified = verifyDesignHandoff(submitted, store, registry, pins);
  if (!verified.ok || !isReadyPackage(submitted)) return null;
  const snapshot = submitted.evidenceOutput.candidateSnapshot as EvidenceSnapshot;

  const claims = Array.isArray(snapshot.claims)
    ? snapshot.claims.map((claim) => ({
        claimId: claim.claimId,
        supportStatus: String(claim.supportStatus),
        evidenceIds: Array.isArray(claim.evidenceRefs) ? [...claim.evidenceRefs] : [],
      }))
    : [];

  const evidence = Array.isArray(snapshot.evidence)
    ? snapshot.evidence.map((entry) => ({
        evidenceId: entry.evidenceId,
        documentId: entry.documentId,
        documentVersionId: entry.documentVersionId,
        blockId: entry.blockId,
        locator: entry.locator,
      }))
    : [];

  const sources = Array.isArray(submitted.documents)
    ? submitted.documents.map((doc) => ({ documentId: doc.documentId, documentVersionId: doc.documentVersionId }))
    : [];

  return {
    runId: submitted.identity.runId,
    candidateVersionId: submitted.identity.candidateVersionId,
    reportVersionId: submitted.identity.reportVersionId,
    reviewVerdict: submitted.identity.reviewVerdict,
    bindingFingerprint: submitted.bindingFingerprint,
    claims,
    evidence,
    sources,
  };
}