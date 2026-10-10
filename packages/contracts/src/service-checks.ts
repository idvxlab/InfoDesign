/**
 * 服务层校验：在结构校验之外检查引用是否存在、版本是否一致、位置能否回查、
 * 项目与工具访问是否允许、成果指纹是否匹配，以及模型是否伪造权限或采纳状态。
 *
 * 这一层由程序执行，不能用 JSON Schema 代替，也不能替代独立审查 Agent 的语义核验。
 *
 * 结构安全约定：所有公开入口在结构非法时也不抛异常，遍历一律经过 asArray/asObject
 * 收窄；结构错误由 schema.* 问题码报告，业务检查随后继续在安全类型上进行。
 */
import type { SchemaRegistry } from './schema-registry.ts';
import { fingerprint, textFingerprint } from './fingerprint.ts';
import type { ValidationResult, JsonValue } from './validator.ts';

export interface CheckIssue {
  code: string;
  message: string;
  path?: string;
}

export interface CheckResult {
  ok: boolean;
  issues: CheckIssue[];
}

export const COMMON_ID = 'urn:tju-mas:contracts:common';
export const TASK_ID = 'urn:tju-mas:contracts:task';
export const DOCUMENT_IR_ID = 'urn:tju-mas:contracts:document-ir';
export const EVIDENCE_SNAPSHOT_ID = 'urn:tju-mas:contracts:evidence-snapshot';
export const REVIEW_REPORT_ID = 'urn:tju-mas:contracts:review-report';
export const EVIDENCE_INPUT_ID = 'urn:tju-mas:contracts:evidence-input';
export const EVIDENCE_OUTPUT_ID = 'urn:tju-mas:contracts:evidence-output';
export const REVIEW_INPUT_ID = 'urn:tju-mas:contracts:review-input';
export const REVIEW_OUTPUT_ID = 'urn:tju-mas:contracts:review-output';

/** 首轮实际运行范围：只支持首次生成的事实阶段。 */
export const SUPPORTED_TASK_TYPES = ['generate'];
export const SUPPORTED_REVIEW_MODES = ['fact'];

/** 会导致审查结论不能为 pass、也不能被采纳的严重级别。 */
export const BLOCKING_SEVERITIES = ['error', 'critical'];

interface Dict {
  [key: string]: any;
}

interface DocumentBlock {
  blockId: string;
  index: number;
  type: string;
  text: string;
  location: Dict;
}

interface DocumentLike {
  documentId: string;
  documentVersionId: string;
  projectId: string;
  version: number;
  contentHash: string;
  blocks: DocumentBlock[];
}

/** 安全收窄：非数组一律视为空，避免结构错误导致后续遍历抛异常。 */
function asArray<T = Dict>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asObject(value: unknown): Dict {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Dict) : {};
}

function schemaIssues(prefix: string, result: ValidationResult): CheckIssue[] {
  return result.errors.map((err) => ({
    code: `schema.${err.keyword}`,
    message: `${prefix}${err.instancePath || ''}: ${err.message}`,
    path: err.schemaPath,
  }));
}

function finalize(issues: CheckIssue[]): CheckResult {
  return { ok: issues.length === 0, issues };
}

function findByKey(items: unknown, key: string): Set<string> {
  const ids = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of asArray(items)) {
    const value = item?.[key];
    if (typeof value !== 'string') continue;
    if (ids.has(value)) duplicates.add(value);
    ids.add(value);
  }
  return duplicates;
}

function documentKey(documentId: unknown, documentVersionId: unknown): string {
  return `${documentId}::${documentVersionId}`;
}

export function indexDocuments(documents: DocumentLike[]): Map<string, DocumentLike> {
  const index = new Map<string, DocumentLike>();
  for (const doc of asArray<DocumentLike>(documents)) {
    index.set(documentKey(doc.documentId, doc.documentVersionId), doc);
  }
  return index;
}

const TEXTUAL_BLOCK_TYPES = new Set(['heading', 'paragraph', 'list', 'caption', 'other']);

function blockText(block: DocumentBlock | undefined): string {
  return typeof block?.text === 'string' ? block.text : '';
}

/**
 * 校验原文定位。
 *
 * 首轮只把 `paragraph` 视为完整支持：核对段落序号、字符起止范围，并在给了范围时
 * 回查摘录是否落在该范围内。其他已登记的定位类型（table_cell、page_region 等）
 * 尚未接入真实解析，明确标记 `location.not_verified` 并拒绝，不能默认算作已验证。
 */
function checkLocatorOnBlock(
  block: DocumentBlock,
  locator: Dict,
  excerpt: unknown,
  path: string,
): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const kind = locator?.kind;
  const text = blockText(block);
  if (kind === 'paragraph') {
    if (locator.paragraphIndex !== block?.index) {
      issues.push({
        code: 'location.index_mismatch',
        message: `${path} paragraphIndex 与块 index 不一致：${locator.paragraphIndex} != ${block?.index}`,
        path,
      });
    }
    const length = [...text].length;
    const start = locator.charStart;
    const end = locator.charEnd;
    if (start !== undefined && (!Number.isInteger(start) || start < 0 || start > length)) {
      issues.push({
        code: 'location.char_out_of_range',
        message: `${path} charStart ${start} 超出块范围 0..${length}`,
        path,
      });
    }
    if (end !== undefined && (!Number.isInteger(end) || end < 0 || end > length)) {
      issues.push({
        code: 'location.char_out_of_range',
        message: `${path} charEnd ${end} 超出块范围 0..${length}`,
        path,
      });
    }
    if (Number.isInteger(start) && Number.isInteger(end)) {
      if (start > end) {
        issues.push({ code: 'location.char_range_invalid', message: `${path} charStart 大于 charEnd`, path });
      } else if (end <= length && typeof excerpt === 'string' && excerpt.length > 0) {
        const slice = [...text].slice(start, end).join('');
        if (!slice.includes(excerpt)) {
          issues.push({
            code: 'location.excerpt_position_mismatch',
            message: `${path} 摘录不在字符范围 ${start}..${end} 内`,
            path,
          });
        }
      }
    }
  } else if (kind === undefined) {
    issues.push({ code: 'location.kind_missing', message: `${path} 缺少定位类型`, path });
  } else {
    issues.push({
      code: 'location.not_verified',
      message: `${path} 定位类型 ${kind} 尚未接入真实解析，B1 不能视为已验证`,
      path,
    });
  }
  return issues;
}

function checkBlockLocation(block: DocumentBlock, path: string): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const location = asObject(block?.location);
  const kind = location.kind;
  if (kind === 'paragraph') {
    if (location.paragraphIndex !== block?.index) {
      issues.push({
        code: 'location.index_mismatch',
        message: `${path} paragraphIndex 与块 index 不一致：${location.paragraphIndex} != ${block?.index}`,
        path,
      });
    }
    return issues;
  }
  if (kind === undefined) {
    issues.push({ code: 'location.kind_missing', message: `${path} 缺少定位类型`, path });
    return issues;
  }
  if (TEXTUAL_BLOCK_TYPES.has(block?.type)) {
    issues.push({
      code: 'location.kind_mismatch',
      message: `${path} 文本块应使用 paragraph 定位，实际 ${kind}`,
      path,
    });
  }
  issues.push({
    code: 'location.not_verified',
    message: `${path} 定位类型 ${kind} 尚未接入真实解析，B1 不能视为已验证`,
    path,
  });
  return issues;
}

export function checkDocument(doc: Dict, registry: SchemaRegistry, path = 'document'): CheckIssue[] {
  const issues: CheckIssue[] = schemaIssues(path, registry.validate(DOCUMENT_IR_ID, doc));
  const blocks = asArray<DocumentBlock>(doc?.blocks);
  const blockIds = new Set<string>();
  blocks.forEach((block, position) => {
    if (blockIds.has(block?.blockId)) {
      issues.push({ code: 'document.duplicate_block_id', message: `${path} 重复块编号 ${block?.blockId}`, path });
    }
    blockIds.add(block?.blockId);
    if (block?.index !== position) {
      issues.push({ code: 'document.block_index_mismatch', message: `${path} 块 ${block?.blockId} 的 index 与顺序不一致`, path });
    }
    issues.push(...checkBlockLocation(block, `${path}.blocks[${position}]`));
  });
  return issues;
}

/** 核对 DocumentIR 的 contentHash 与原始文本一致。 */
export function checkDocumentHash(doc: DocumentLike, rawText: string, path = 'document'): CheckIssue[] {
  const expected = textFingerprint(rawText);
  if (doc?.contentHash !== expected) {
    return [
      {
        code: 'document.hash_mismatch',
        message: `${path} contentHash 与原始文本不一致：${doc?.contentHash} != ${expected}`,
        path,
      },
    ];
  }
  return [];
}

export function checkTask(task: Dict, registry: SchemaRegistry): CheckResult {
  const issues = schemaIssues('task', registry.validate(TASK_ID, task));
  if (!SUPPORTED_TASK_TYPES.includes(task?.taskType)) {
    issues.push({
      code: 'task.type_not_supported',
      message: `首轮只运行 ${SUPPORTED_TASK_TYPES.join('/')}，收到 ${task?.taskType}`,
      path: 'taskType',
    });
  }
  return finalize(issues);
}

export function checkDocuments(documents: Dict[], registry: SchemaRegistry): CheckResult {
  const issues: CheckIssue[] = [];
  const seen = new Set<string>();
  asArray<Dict>(documents).forEach((doc, i) => {
    issues.push(...checkDocument(doc, registry, `documents[${i}]`));
    const key = documentKey(doc?.documentId, doc?.documentVersionId);
    if (seen.has(key)) {
      issues.push({ code: 'documents.duplicate_version', message: `重复的资料版本 ${key}`, path: `documents[${i}]` });
    }
    seen.add(key);
  });
  return finalize(issues);
}

/**
 * 校验授权的资料集合：每份文档必须属于本项目，且必须出现在可信 scope.documentRefs 中。
 * 项目归属与授权范围来自服务上下文，不能由模型自行填写相同的 projectId 来证明。
 */
function checkScopedDocuments(documents: Dict[], scopeRefs: Dict[], projectId: unknown): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const index = indexDocuments(documents as DocumentLike[]);
  for (const doc of documents) {
    if (doc?.projectId !== projectId) {
      issues.push({
        code: 'documents.project_mismatch',
        message: `资料 ${doc?.documentId}@${doc?.documentVersionId} 属于其他项目：${doc?.projectId}`,
        path: 'documents',
      });
    }
    const inScope = scopeRefs.some(
      (ref) => ref?.documentId === doc?.documentId && ref?.documentVersionId === doc?.documentVersionId,
    );
    if (!inScope) {
      issues.push({
        code: 'scope.document_not_authorized',
        message: `资料 ${doc?.documentId}@${doc?.documentVersionId} 未在授权范围内`,
        path: 'documents',
      });
    }
  }
  for (const ref of scopeRefs) {
    if (!index.has(documentKey(ref?.documentId, ref?.documentVersionId))) {
      issues.push({
        code: 'scope.document_not_provided',
        message: `授权引用 ${ref?.documentId}@${ref?.documentVersionId} 未提供原始资料`,
        path: 'scope.documentRefs',
      });
    }
  }
  return issues;
}

export function checkEvidenceInput(input: Dict, registry: SchemaRegistry): CheckResult {
  const issues = schemaIssues('evidenceInput', registry.validate(EVIDENCE_INPUT_ID, input));
  const projectId = input?.projectId;
  const scope = asObject(input?.scope);
  if (scope.projectId !== projectId) {
    issues.push({ code: 'scope.project_mismatch', message: 'scope.projectId 与输入项目不一致', path: 'scope.projectId' });
  }
  const documents = asArray<Dict>(input?.documents);
  issues.push(...checkDocuments(documents, registry).issues);
  const scopeRefs = asArray<Dict>(scope.documentRefs);
  issues.push(...checkScopedDocuments(documents, scopeRefs, projectId));
  const ops = asArray<string>(scope.allowedOperations);
  for (const required of ['read_document', 'submit_candidate']) {
    if (!ops.includes(required)) {
      issues.push({ code: 'scope.operation_missing', message: `信息提取缺少操作权限 ${required}`, path: 'scope.allowedOperations' });
    }
  }
  return finalize(issues);
}

function resolveEvidence(
  evidence: Dict,
  index: Map<string, DocumentLike>,
): { doc?: DocumentLike; block?: DocumentBlock; issues: CheckIssue[] } {
  const issues: CheckIssue[] = [];
  const key = documentKey(evidence?.documentId, evidence?.documentVersionId);
  const doc = index.get(key);
  if (!doc) {
    const anyVersion = [...index.values()].some((d) => d.documentId === evidence?.documentId);
    issues.push({
      code: anyVersion ? 'evidence.version_mismatch' : 'evidence.source_missing',
      message: anyVersion
        ? `证据来源版本不匹配：${key}`
        : `证据来源不在授权范围内：${key}`,
      path: 'evidence',
    });
    return { issues };
  }
  const block = asArray<DocumentBlock>(doc.blocks).find((b) => b?.blockId === evidence?.blockId);
  if (!block) {
    issues.push({ code: 'evidence.block_missing', message: `证据块不存在：${evidence?.blockId}`, path: 'evidence.blockId' });
    return { doc, issues };
  }
  issues.push(...checkLocatorOnBlock(block, asObject(evidence?.locator), evidence?.excerpt, 'evidence.locator'));
  if (typeof evidence?.excerpt === 'string' && evidence.excerpt.length > 0 && !blockText(block).includes(evidence.excerpt)) {
    issues.push({
      code: 'evidence.excerpt_not_found',
      message: `摘录无法在块 ${block.blockId} 原文中回查`,
      path: 'evidence.excerpt',
    });
  }
  return { doc, block, issues };
}

const FORBIDDEN_KEYS = ['accepted', 'permissions', 'approved', 'toolAccess', 'adoption', 'granted'];

function checkForgedFields(output: Dict): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const target = asObject(output);
  for (const key of FORBIDDEN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(target, key)) {
      issues.push({ code: 'forged.field', message: `输出包含保留字段 ${key}`, path: key });
    }
  }
  const snapshot = target.candidateSnapshot;
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    for (const key of FORBIDDEN_KEYS) {
      if (Object.prototype.hasOwnProperty.call(snapshot, key)) {
        issues.push({ code: 'forged.field', message: `候选快照包含保留字段 ${key}`, path: `candidateSnapshot.${key}` });
      }
    }
  }
  return issues;
}

export function checkEvidenceOutput(
  output: Dict,
  input: Dict,
  registry: SchemaRegistry,
): CheckResult {
  const issues = schemaIssues('evidenceOutput', registry.validate(EVIDENCE_OUTPUT_ID, output));
  issues.push(...checkForgedFields(output));
  for (const field of ['taskId', 'attemptId', 'projectId']) {
    if (output?.[field] !== input?.[field]) {
      issues.push({ code: 'output.identity_mismatch', message: `输出 ${field} 与任务不一致`, path: field });
    }
  }
  const snapshot = asObject(output?.candidateSnapshot);
  for (const field of ['taskId', 'attemptId', 'projectId']) {
    if (snapshot?.[field] !== input?.[field]) {
      issues.push({ code: 'snapshot.identity_mismatch', message: `候选快照 ${field} 与任务不一致`, path: `candidateSnapshot.${field}` });
    }
  }
  if (snapshot?.reviewStatus !== 'pending') {
    issues.push({
      code: 'snapshot.review_status_forged',
      message: `候选提交时审查状态必须为 pending，不能由模型改为 ${snapshot?.reviewStatus}`,
      path: 'candidateSnapshot.reviewStatus',
    });
  }
  const producedBy = asObject(snapshot?.producedBy);
  if (producedBy?.role !== 'evidence') {
    issues.push({ code: 'snapshot.role_forged', message: `候选快照角色应为 evidence`, path: 'candidateSnapshot.producedBy.role' });
  }

  const duplicateChecks: Array<[string, string]> = [
    ['entities', 'entityId'],
    ['claims', 'claimId'],
    ['evidence', 'evidenceId'],
    ['relations', 'relationId'],
    ['events', 'eventId'],
    ['assets', 'assetId'],
    ['conflicts', 'conflictId'],
    ['missing', 'missingId'],
  ];
  for (const [collection, key] of duplicateChecks) {
    const duplicates = findByKey(snapshot?.[collection], key);
    for (const id of duplicates) {
      issues.push({ code: 'snapshot.duplicate_id', message: `${collection} 重复编号 ${id}`, path: `candidateSnapshot.${collection}` });
    }
  }

  const documents = asArray<Dict>(input?.documents);
  const index = indexDocuments(documents as DocumentLike[]);
  const entities = asArray<Dict>(snapshot?.entities);
  const claims = asArray<Dict>(snapshot?.claims);
  const evidenceList = asArray<Dict>(snapshot?.evidence);
  const conflicts = asArray<Dict>(snapshot?.conflicts);

  const entityIds = new Set<string>(entities.map((e) => e?.entityId));
  const claimIds = new Set<string>(claims.map((c) => c?.claimId));
  const evidenceIds = new Set<string>(evidenceList.map((e) => e?.evidenceId));
  const conflictIds = new Set<string>(conflicts.map((c) => c?.conflictId));

  for (const evidence of evidenceList) {
    issues.push(...resolveEvidence(evidence, index).issues);
  }

  // 候选内部的每条事实都必须保持待审，审查状态由审查流程写回，不能由提取者提交。
  for (const claim of claims) {
    if (claim?.reviewStatus !== 'pending') {
      issues.push({
        code: 'claim.review_status_forged',
        message: `候选事实 ${claim?.claimId} 审查状态必须为 pending，不能是 ${claim?.reviewStatus}`,
        path: 'candidateSnapshot.claims',
      });
    }
    if (!entityIds.has(claim?.entityId)) {
      issues.push({ code: 'claim.entity_missing', message: `事实 ${claim?.claimId} 引用不存在的实体 ${claim?.entityId}`, path: 'candidateSnapshot.claims' });
    }
    for (const ref of asArray<string>(claim?.evidenceRefs)) {
      if (!evidenceIds.has(ref)) {
        issues.push({ code: 'claim.evidence_missing', message: `事实 ${claim?.claimId} 引用不存在的证据 ${ref}`, path: 'candidateSnapshot.claims' });
      }
    }
    if (claim?.conflictGroupId !== undefined && !conflictIds.has(claim.conflictGroupId)) {
      issues.push({
        code: 'claim.conflict_group_missing',
        message: `事实 ${claim?.claimId} 引用的冲突组不存在 ${claim.conflictGroupId}`,
        path: 'candidateSnapshot.claims',
      });
    }
  }

  for (const conflict of conflicts) {
    for (const ref of asArray<string>(conflict?.claimRefs)) {
      if (!claimIds.has(ref)) {
        issues.push({ code: 'conflict.claim_missing', message: `冲突 ${conflict?.conflictId} 引用不存在的事实 ${ref}`, path: 'candidateSnapshot.conflicts' });
      }
    }
  }

  for (const relation of asArray<Dict>(snapshot?.relations)) {
    if (!entityIds.has(relation?.fromEntityId)) {
      issues.push({ code: 'relation.from_entity_missing', message: `关系 ${relation?.relationId} 引用不存在的主体实体 ${relation?.fromEntityId}`, path: 'candidateSnapshot.relations' });
    }
    if (!entityIds.has(relation?.toEntityId)) {
      issues.push({ code: 'relation.to_entity_missing', message: `关系 ${relation?.relationId} 引用不存在的客体实体 ${relation?.toEntityId}`, path: 'candidateSnapshot.relations' });
    }
    for (const ref of asArray<string>(relation?.evidenceRefs)) {
      if (!evidenceIds.has(ref)) {
        issues.push({ code: 'relation.evidence_missing', message: `关系 ${relation?.relationId} 引用不存在的证据 ${ref}`, path: 'candidateSnapshot.relations' });
      }
    }
  }

  for (const event of asArray<Dict>(snapshot?.events)) {
    if (!entityIds.has(event?.entityId)) {
      issues.push({ code: 'event.entity_missing', message: `事件 ${event?.eventId} 引用不存在的实体 ${event?.entityId}`, path: 'candidateSnapshot.events' });
    }
    for (const ref of asArray<string>(event?.evidenceRefs)) {
      if (!evidenceIds.has(ref)) {
        issues.push({ code: 'event.evidence_missing', message: `事件 ${event?.eventId} 引用不存在的证据 ${ref}`, path: 'candidateSnapshot.events' });
      }
    }
  }

  for (const asset of asArray<Dict>(snapshot?.assets)) {
    const doc = index.get(documentKey(asset?.documentId, asset?.documentVersionId));
    if (!doc || doc.projectId !== input?.projectId) {
      issues.push({ code: 'asset.document_not_authorized', message: `素材 ${asset?.assetId} 来源不在授权范围内`, path: 'candidateSnapshot.assets' });
      continue;
    }
    const block = asArray<DocumentBlock>(doc.blocks).find((b) => b?.blockId === asset?.blockId);
    if (!block) {
      issues.push({ code: 'asset.block_missing', message: `素材 ${asset?.assetId} 引用的块不存在 ${asset?.blockId}`, path: 'candidateSnapshot.assets' });
      continue;
    }
    issues.push(...checkLocatorOnBlock(block, asObject(asset?.location), undefined, 'candidateSnapshot.assets.location'));
  }

  for (const item of asArray<Dict>(snapshot?.missing)) {
    if (item?.entityId !== undefined && !entityIds.has(item.entityId)) {
      issues.push({ code: 'missing.entity_missing', message: `缺失项 ${item?.missingId} 引用不存在的实体 ${item.entityId}`, path: 'candidateSnapshot.missing' });
    }
  }

  for (const cov of asArray<Dict>(snapshot?.coverage?.documentsProcessed)) {
    const doc = index.get(documentKey(cov?.documentId, cov?.documentVersionId));
    if (!doc) {
      issues.push({
        code: 'coverage.document_not_authorized',
        message: `覆盖范围包含未授权资料 ${cov?.documentId}@${cov?.documentVersionId}`,
        path: 'candidateSnapshot.coverage.documentsProcessed',
      });
      continue;
    }
    const blockIds = new Set<string>(asArray<DocumentBlock>(doc.blocks).map((b) => b?.blockId));
    for (const blockId of asArray<string>(cov?.blockIds)) {
      if (!blockIds.has(blockId)) {
        issues.push({
          code: 'coverage.block_missing',
          message: `覆盖范围包含不存在的块 ${blockId}（${cov?.documentId}@${cov?.documentVersionId}）`,
          path: 'candidateSnapshot.coverage.documentsProcessed',
        });
      }
    }
  }
  return finalize(issues);
}

export function checkReviewInput(
  input: Dict,
  subjectSnapshot: Dict,
  registry: SchemaRegistry,
): CheckResult {
  const issues = schemaIssues('reviewInput', registry.validate(REVIEW_INPUT_ID, input));
  if (!SUPPORTED_REVIEW_MODES.includes(input?.reviewMode)) {
    issues.push({
      code: 'review.mode_not_supported',
      message: `首轮只支持事实审查，收到 ${input?.reviewMode}`,
      path: 'reviewMode',
    });
  }
  const scope = asObject(input?.scope);
  if (scope.projectId !== input?.projectId) {
    issues.push({ code: 'scope.project_mismatch', message: 'scope.projectId 与输入项目不一致', path: 'scope.projectId' });
  }
  const documents = asArray<Dict>(input?.documents);
  issues.push(...checkDocuments(documents, registry).issues);
  const scopeRefs = asArray<Dict>(scope.documentRefs);
  // 审查输入与提取输入使用同一套资料权限检查：项目归属 + 授权范围双向核对。
  issues.push(...checkScopedDocuments(documents, scopeRefs, input?.projectId));
  const ops = asArray<string>(scope.allowedOperations);
  for (const required of ['read_document', 'check_source', 'submit_report']) {
    if (!ops.includes(required)) {
      issues.push({ code: 'scope.operation_missing', message: `事实审查缺少操作权限 ${required}`, path: 'scope.allowedOperations' });
    }
  }
  const subject = asObject(input?.subject);
  if (subject?.snapshotId !== subjectSnapshot?.snapshotId || subject?.snapshotVersionId !== subjectSnapshot?.snapshotVersionId) {
    issues.push({ code: 'subject.version_mismatch', message: '待审成果版本与提供的候选快照不一致', path: 'subject' });
  }
  const expectedHash = fingerprint(subjectSnapshot);
  if (subject?.contentHash !== expectedHash) {
    issues.push({
      code: 'subject.fingerprint_mismatch',
      message: `待审成果指纹不匹配：${subject?.contentHash} != ${expectedHash}`,
      path: 'subject.contentHash',
    });
  }
  if (subjectSnapshot?.projectId !== input?.projectId) {
    issues.push({ code: 'subject.project_mismatch', message: '待审成果属于其他项目', path: 'subject' });
  }
  return finalize(issues);
}

export function checkReviewOutput(
  output: Dict,
  reviewInput: Dict,
  subjectSnapshot: Dict,
  registry: SchemaRegistry,
): CheckResult {
  const issues = schemaIssues('reviewOutput', registry.validate(REVIEW_OUTPUT_ID, output));
  for (const field of ['taskId', 'attemptId', 'projectId']) {
    if (output?.[field] !== reviewInput?.[field]) {
      issues.push({ code: 'output.identity_mismatch', message: `审查输出 ${field} 与任务不一致`, path: field });
    }
  }
  const report = asObject(output?.report);
  for (const field of ['taskId', 'attemptId', 'projectId']) {
    if (report?.[field] !== reviewInput?.[field]) {
      issues.push({ code: 'report.identity_mismatch', message: `报告 ${field} 与任务不一致`, path: `report.${field}` });
    }
  }
  if (report?.reviewMode !== reviewInput?.reviewMode) {
    issues.push({ code: 'report.mode_mismatch', message: '报告审查模式与任务不一致', path: 'report.reviewMode' });
  }
  const expectedHash = fingerprint(subjectSnapshot);
  if (report?.subject?.contentHash !== expectedHash) {
    issues.push({ code: 'report.fingerprint_mismatch', message: '报告绑定的成果指纹与实际候选不一致', path: 'report.subject.contentHash' });
  }
  if (
    report?.subject?.snapshotId !== subjectSnapshot?.snapshotId ||
    report?.subject?.snapshotVersionId !== subjectSnapshot?.snapshotVersionId
  ) {
    issues.push({ code: 'report.subject_version_mismatch', message: '报告绑定的成果版本与实际候选不一致', path: 'report.subject' });
  }
  if (
    report?.subject?.snapshotId !== reviewInput?.subject?.snapshotId ||
    report?.subject?.snapshotVersionId !== reviewInput?.subject?.snapshotVersionId
  ) {
    issues.push({ code: 'report.subject_mismatch', message: '报告绑定的成果与审查任务指定的成果不一致', path: 'report.subject' });
  }
  if (report?.reviewedBy?.role !== 'review') {
    issues.push({ code: 'report.role_forged', message: '报告提交角色应为 review', path: 'report.reviewedBy.role' });
  }

  // 外层执行状态与内层报告必须一致：任务没跑完时不能给出完成的报告，也不能 pass。
  if (output?.status !== 'completed') {
    if (report?.executionStatus !== 'failed') {
      issues.push({
        code: 'report.execution_status_inconsistent',
        message: `任务状态为 ${output?.status} 时报告执行状态应为 failed，实际 ${report?.executionStatus}`,
        path: 'report.executionStatus',
      });
    }
    if (report?.verdict === 'pass') {
      issues.push({ code: 'report.pass_on_failed_task', message: '任务未完成时不能给出 pass', path: 'report.verdict' });
    }
  }
  if (report?.executionStatus !== 'completed' && report?.verdict === 'pass') {
    issues.push({ code: 'report.pass_on_failed_execution', message: '技术执行失败时不能给出 pass', path: 'report.verdict' });
  }

  const blockingIssues = asArray<Dict>(report?.issues).filter((issue) =>
    BLOCKING_SEVERITIES.includes(issue?.severity),
  );
  if (report?.verdict === 'pass' && blockingIssues.length > 0) {
    issues.push({
      code: 'report.pass_with_blocking_issue',
      message: `存在 ${blockingIssues.length} 条阻塞级问题时不能给出 pass`,
      path: 'report.verdict',
    });
  }

  if (report?.verdict === 'pass') {
    const required = asArray<string>(reviewInput?.checksRequired);
    const byType = new Map<string, string>();
    for (const check of asArray<Dict>(report?.checks)) {
      byType.set(check?.checkType, check?.status);
    }
    for (const type of required) {
      if (byType.get(type) !== 'pass') {
        issues.push({
          code: 'report.required_check_not_passed',
          message: `给出 pass 前必须完成检查 ${type}，实际 ${byType.get(type) ?? 'not_run'}`,
          path: 'report.checks',
        });
      }
    }
  }

  const snapshot = asObject(subjectSnapshot);
  const claimIds = new Set<string>(asArray<Dict>(snapshot?.claims).map((c) => c?.claimId));
  const evidenceIds = new Set<string>(asArray<Dict>(snapshot?.evidence).map((e) => e?.evidenceId));
  for (const issue of asArray<Dict>(report?.issues)) {
    if (issue?.claimId && !claimIds.has(issue.claimId)) {
      issues.push({ code: 'issue.claim_missing', message: `问题 ${issue?.issueId} 引用不存在的候选事实 ${issue.claimId}`, path: 'report.issues' });
    }
    for (const ref of asArray<string>(issue?.evidenceRefs)) {
      if (!evidenceIds.has(ref)) {
        issues.push({ code: 'issue.evidence_missing', message: `问题 ${issue?.issueId} 引用不存在的证据 ${ref}`, path: 'report.issues' });
      }
    }
  }
  for (const check of asArray<Dict>(report?.checks)) {
    for (const ref of asArray<string>(check?.claimRefs)) {
      if (!claimIds.has(ref)) {
        issues.push({ code: 'check.claim_missing', message: `检查 ${check?.checkId} 引用不存在的候选事实 ${ref}`, path: 'report.checks' });
      }
    }
    for (const ref of asArray<string>(check?.evidenceRefs)) {
      if (!evidenceIds.has(ref)) {
        issues.push({ code: 'check.evidence_missing', message: `检查 ${check?.checkId} 引用不存在的证据 ${ref}`, path: 'report.checks' });
      }
    }
  }
  return finalize(issues);
}

export interface AdoptionContext {
  /**
   * 工作流核对后的外层审查任务状态（ReviewOutput.status）。
   * 采纳必须同时看到外层执行状态，不能只凭内层报告；运行时缺失或未完成一律拒绝。
   */
  outputStatus: string;
  /**
   * 任务要求的必需检查类型（来自 ReviewInput.checksRequired，由可信服务上下文提供）。
   * 采纳前逐项确认这些检查都已 pass，避免只看 verdict；不能从模型报告反推，
   * 运行时缺失、为空或类型非法一律返回结构化错误。
   */
  checksRequired: string[];
}

/**
 * 采纳判定：候选快照通过独立审查后，才允许工作流登记为可用成果。
 * 候选提交状态必须仍是 pending；已审查状态由服务层写回，而不是模型提交。
 * 调用方必须传入经工作流核对的 outputStatus 与 checksRequired，防止仅凭内层报告
 * 采纳失败执行或漏传必需检查；运行时仍防御性校验，缺失、为空或类型非法时
 * 返回结构化错误而不是放行或抛异常。
 */
export function evaluateAdoption(
  subjectSnapshot: Dict,
  report: Dict,
  registry: SchemaRegistry,
  context: AdoptionContext,
): CheckResult {
  const issues: CheckIssue[] = [];
  issues.push(...schemaIssues('snapshot', registry.validate(EVIDENCE_SNAPSHOT_ID, subjectSnapshot)));
  issues.push(...schemaIssues('report', registry.validate(REVIEW_REPORT_ID, report)));

  const ctx = asObject(context);
  const outputStatus = ctx.outputStatus;
  const requiredChecks = ctx.checksRequired;
  // 可信上下文校验：必需检查列表必须是非空的非空字符串数组。
  const requiredChecksShape =
    Array.isArray(requiredChecks) &&
    requiredChecks.length > 0 &&
    requiredChecks.every((type: unknown) => typeof type === 'string' && type.length > 0);

  if (outputStatus !== 'completed') {
    issues.push({
      code: 'adoption.output_not_completed',
      message: `审查任务状态为 ${outputStatus ?? '未提供'}，不能采纳`,
      path: 'outputStatus',
    });
  }
  if (!Array.isArray(requiredChecks)) {
    issues.push({
      code: 'adoption.required_checks_missing',
      message: '采纳判定必须收到来自可信服务上下文的必需检查列表，当前缺失或类型非法',
      path: 'checksRequired',
    });
  } else if (requiredChecks.length === 0) {
    issues.push({
      code: 'adoption.required_checks_empty',
      message: '必需检查列表不能为空，采纳前必须逐项核对',
      path: 'checksRequired',
    });
  } else if (!requiredChecksShape) {
    issues.push({
      code: 'adoption.required_checks_invalid',
      message: '必需检查列表只能包含非空字符串',
      path: 'checksRequired',
    });
  }
  if (subjectSnapshot?.reviewStatus !== 'pending') {
    issues.push({ code: 'adoption.candidate_not_pending', message: `候选状态应为 pending，实际 ${subjectSnapshot?.reviewStatus}`, path: 'reviewStatus' });
  }
  if (report?.executionStatus !== 'completed') {
    issues.push({ code: 'adoption.execution_failed', message: '审查执行未完成，不能采纳', path: 'executionStatus' });
  }
  if (report?.subject?.contentHash !== fingerprint(subjectSnapshot)) {
    issues.push({ code: 'adoption.fingerprint_mismatch', message: '审查报告未绑定当前候选指纹', path: 'subject.contentHash' });
  }
  if (report?.verdict !== 'pass') {
    issues.push({ code: 'adoption.verdict_not_pass', message: `审查结论为 ${report?.verdict}，不能采纳`, path: 'verdict' });
  }
  for (const check of asArray<Dict>(report?.checks)) {
    if (check?.status === 'fail' || check?.status === 'not_run') {
      issues.push({ code: 'adoption.check_incomplete', message: `检查 ${check?.checkId}(${check?.checkType}) 状态为 ${check?.status}`, path: 'checks' });
    }
  }
  if (report?.verdict === 'pass' && requiredChecksShape) {
    const byType = new Map<string, string>();
    for (const check of asArray<Dict>(report?.checks)) {
      byType.set(check?.checkType, check?.status);
    }
    for (const type of requiredChecks as string[]) {
      if (byType.get(type) !== 'pass') {
        issues.push({
          code: 'adoption.required_check_not_passed',
          message: `必需检查 ${type} 未通过（${byType.get(type) ?? 'not_run'}），不能采纳`,
          path: 'checks',
        });
      }
    }
  }
  for (const issue of asArray<Dict>(report?.issues)) {
    if (BLOCKING_SEVERITIES.includes(issue?.severity)) {
      issues.push({
        code: 'adoption.blocking_issue',
        message: `存在阻塞级问题 ${issue?.issueId}（${issue?.severity}），不能采纳`,
        path: 'issues',
      });
    }
  }
  return finalize(issues);
}

export type { JsonValue };