/** B3 确定性检查：结构/来源/实际读取/覆盖/修正保留，不替代语义审查。
 *
 * B3-source 扩展：可选接收可信 sourceBundles。为“已验证匹配 PDF”的候选证据/素材：
 *  - 保留全部既有 schema/identity/scope/operations/references/duplicate-block/version/字符/摘录/覆盖检查；
 *  - 在“仅校验用克隆”里把物理定位映射为 legacy paragraph 序号，交由既有 checkEvidenceOutput 通过；
 *  - 存储/输出的原始候选仍保留物理定位，并额外新增物理定位不匹配问题码。
 * 绝不整体删除 location.not_verified：legacy 通用路径不受影响。
 */
import type { EvidenceInput, EvidenceOutput, ReadDocumentResult } from '../../../../packages/contracts/generated/index.ts';
import type { DocumentIr } from '../../../../packages/contracts/generated/document-ir.ts';
import type { ReadSourceResult } from '../../../../packages/contracts/generated/read-source-result.ts';
import { checkEvidenceOutput, EVIDENCE_OUTPUT_ID, type CheckResult, type CheckIssue } from '../../../../packages/contracts/src/service-checks.ts';
import type { SchemaRegistry } from '../../../../packages/contracts/src/schema-registry.ts';
import { canonicalize } from '../../../../packages/contracts/src/validator.ts';
import type { CandidateEnvelope } from '../agents/evidence/context.ts';
import type { SourceBundle } from './source-bundle.ts';
import {
  verifyPdfSources, physicalLocatorMatches, receiptCovers, hasPdfSource, type VerifiedPdfSource,
} from './evidence-source-policy.ts';

/** 最小收据身份，兼容 ReadDocumentResult / ReadSourceResult。 */
export interface MinimalReceipt {
  documentId: string;
  documentVersionId: string;
  blockId: string;
  contentHash?: string;
  text?: string | null;
  location?: unknown;
}
export type EvidenceReceipt = ReadDocumentResult | ReadSourceResult | MinimalReceipt;

const key = (d: { documentId: string; documentVersionId: string; blockId: string }) => JSON.stringify([d.documentId, d.documentVersionId, d.blockId]);
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * 构造“仅校验用克隆”：对属于已验证匹配 PDF 且物理定位精确匹配的候选证据/素材，
 * 把定位替换为 legacy paragraph 序号，让既有 checkEvidenceOutput 通过。
 * 其余条目原样保留（从而触发既有 not_verified/kind_mismatch 拒绝）。
 * 返回 { clone, physicalMismatches } —— 原始候选不受影响。
 */
function buildValidationView(
  raw: unknown,
  input: EvidenceInput,
  verified: Map<string, VerifiedPdfSource>,
): { clone: unknown; presentedLocators: Map<string, unknown> } {
  if (verified.size === 0) return { clone: raw, presentedLocators: new Map() };
  const clone = structuredClone(raw) as Record<string, unknown>;
  const snapshot = record(clone.candidateSnapshot);
  const presentedLocators = new Map<string, unknown>();

  // 逐条映射：多条不同 evidenceId 引用同一 PDF 块是合法的，必须逐条各自映射并通过，
  // 不能“每块只保留一条”而把后续同块证据判为未验证。
  const mapEntries = (collection: string, locatorField: 'locator' | 'location'): void => {
    const items = snapshot[collection];
    if (!Array.isArray(items)) return;
    for (const item of items) {
      const entry = record(item);
      const entryKey = key(entry as { documentId: string; documentVersionId: string; blockId: string });
      if (physicalLocatorMatches(verified, input.documents as DocumentIr[], { ...entry, locator: entry[locatorField] } as never)) {
        const doc = input.documents.find(d => d.documentId === entry.documentId && d.documentVersionId === entry.documentVersionId);
        const block = doc?.blocks.find(b => b.blockId === entry.blockId);
        if (block) {
          presentedLocators.set(entryKey, entry[locatorField]);
          entry[locatorField] = { kind: 'paragraph', paragraphIndex: block.index };
        }
      }
    }
  };
  mapEntries('evidence', 'locator');
  mapEntries('assets', 'location');
  return { clone, presentedLocators };
}

export function validateEvidenceCandidate(
  raw: unknown,
  input: EvidenceInput,
  envelope: CandidateEnvelope,
  receipts: EvidenceReceipt[],
  registry: SchemaRegistry,
  previous?: unknown,
  sourceBundles?: SourceBundle[],
  options?: { allowUpdate?: boolean },
): CheckResult {
  const verified = sourceBundles && sourceBundles.length ? verifyPdfSources(sourceBundles, input.documents as DocumentIr[]) : new Map<string, VerifiedPdfSource>();
  const { clone, presentedLocators } = buildValidationView(raw, input, verified);
  const checked = checkEvidenceOutput(record(clone), input, registry);
  const issues: CheckIssue[] = [...checked.issues];
  const add = (code: string, path: string) => issues.push({ code, path, message: code });
  if (!registry.validate(EVIDENCE_OUTPUT_ID, raw).valid) return { ok: false, issues };
  const output = raw as EvidenceOutput;
  const snapshot = output.candidateSnapshot;
  if (!['completed', 'needs_information', 'blocked', 'failed'].includes(output.status)) add('candidate.unsupported_status', 'status');
  for (const field of ['snapshotId', 'snapshotVersionId', 'createdAt', 'producedBy'] as const) {
    if (canonicalize(snapshot[field]) !== canonicalize(envelope[field])) add('candidate.envelope_mismatch', 'candidateSnapshot.' + field);
  }
  if (canonicalize(output.producedBy) !== canonicalize(envelope.producedBy)) add('candidate.provenance_mismatch', 'producedBy');
  if (!options?.allowUpdate && (snapshot.basedOnSnapshotVersionId !== undefined || output.changes?.some(c => c.changeType !== 'added'))) add('candidate.update_not_supported', 'candidateSnapshot');

  const read = new Set(receipts.map(key));
  const docFor = (entry: { documentId: string; documentVersionId: string }) =>
    input.documents.find(d => d.documentId === entry.documentId && d.documentVersionId === entry.documentVersionId) as DocumentIr | undefined;
  // 物理定位/摘录/收据强校验：仅对“该文档确实拥有 genuine 匹配 PDF”的候选条目生效。
  // 混合 PDF+文本输入中的 legacy（非 PDF）条目保留原有 paragraph/字符/摘录检查，绝不套用 PDF 物理规则。
  const enforcePhysical = (entry: Record<string, unknown>, field: 'locator' | 'location', path: string): void => {
    const doc = docFor(entry as { documentId: string; documentVersionId: string });
    if (!doc || !hasPdfSource(verified, doc)) return;
    const locator = entry[field];
    // 辅助函数统一读 entry.locator；asset 使用 location，只在此处归一化参数，不改动输出字段。
    const normalized = { ...entry, locator };
    if (!receiptCovers(receipts, input.documents as DocumentIr[], normalized as never)) {
      issues.push({ code: 'evidence.not_read', path, message: 'evidence.not_read' });
    }
    if (!physicalLocatorMatches(verified, input.documents as DocumentIr[], normalized as never)) {
      add(field === 'locator' ? 'evidence.physical_location_mismatch' : 'asset.physical_location_mismatch', path);
    }
  };
  for (const [i, entry] of snapshot.evidence.entries()) enforcePhysical(record(entry), 'locator', 'candidateSnapshot.evidence[' + i + ']');
  for (const [i, asset] of (snapshot.assets ?? []).entries()) enforcePhysical(record(asset), 'location', 'candidateSnapshot.assets[' + i + ']');
  for (const [i, entry] of snapshot.evidence.entries()) if (!read.has(key(entry))) add('evidence.not_read', 'candidateSnapshot.evidence[' + i + ']');
  for (const [i, asset] of (snapshot.assets ?? []).entries()) if (!read.has(key(asset))) add('asset.not_read', 'candidateSnapshot.assets[' + i + ']');

  const processed = new Set<string>(), unsupported = new Set<string>(), documents = new Set<string>();
  for (const [i, entry] of snapshot.coverage.documentsProcessed.entries()) {
    const docKey = JSON.stringify([entry.documentId, entry.documentVersionId]);
    if (documents.has(docKey)) add('coverage.duplicate_document', 'candidateSnapshot.coverage.documentsProcessed[' + i + ']');
    documents.add(docKey);
    for (const blockId of entry.blockIds) {
      const blockKey = key({ ...entry, blockId });
      if (processed.has(blockKey)) add('coverage.duplicate_block', 'candidateSnapshot.coverage');
      if (!read.has(blockKey)) add('coverage.not_read', 'candidateSnapshot.coverage');
      processed.add(blockKey);
    }
  }
  for (const entry of snapshot.coverage.unsupported ?? []) {
    const doc = input.documents.find(d => d.documentId === entry.documentId);
    if (!doc || !doc.blocks.some(b => b.blockId === entry.blockId)) { add('coverage.unknown_unsupported', 'candidateSnapshot.coverage.unsupported'); continue; }
    const blockKey = key({ ...doc, blockId: entry.blockId });
    if (unsupported.has(blockKey) || processed.has(blockKey)) add('coverage.duplicate_block', 'candidateSnapshot.coverage.unsupported');
    unsupported.add(blockKey);
  }
  for (const doc of input.documents) {
    for (const block of doc.blocks) {
      const blockKey = key({ ...doc, blockId: block.blockId });
      if (!processed.has(blockKey) && !unsupported.has(blockKey)) add('coverage.omitted_block', 'candidateSnapshot.coverage');
      if (doc.parseInfo?.unsupported?.some(u => u.blockId === block.blockId) && !unsupported.has(blockKey)) add('coverage.parser_limitation_omitted', 'candidateSnapshot.coverage');
    }
  }
  for (const entry of [...snapshot.evidence, ...(snapshot.assets ?? [])]) {
    if (!processed.has(key(entry))) add('evidence.outside_processed_coverage', 'candidateSnapshot.coverage');
  }
  // 模态处理守卫：空图、空文本块、解析器未支持块、带警告的表格候选都不得被声称为“已处理”（processed）。
  // 仅凭元数据/图片读取收据不等于理解；此类块必须留在 unsupported（部分 → needs_information）。
  const blockUnprocessable = (doc: DocumentIr, blockId: string): boolean => {
    const block = doc.blocks.find(b => b.blockId === blockId);
    if (!block) return false;
    const parserUnsupported = !!doc.parseInfo?.unsupported?.some(u => u.blockId === blockId);
    const isImage = block.type === 'image';
    // 带警告的表格候选只有在“该文档确实拥有 genuine 匹配 PDF 源”时才由该源拥有。
    // warnings 是 ARRAY，来源是匹配 verified bundle.tables 条目，而 block.extensions.table_warnings 是 STRING
    // （legacy 标识），因此绝不能在那里用 Array.isArray。
    const verifiedSource = verified.get(JSON.stringify([doc.documentId, doc.documentVersionId]));
    const sourceTable = verifiedSource?.bundle.tables?.find(t => t.blockId === blockId);
    const tableWarnings = Array.isArray(sourceTable?.warnings) && sourceTable!.warnings.length > 0;
    const blankText = (block.text ?? '').trim().length === 0;
    return parserUnsupported || isImage || tableWarnings || (blankText && block.type !== 'table');
  };
  for (const [i, entry] of snapshot.coverage.documentsProcessed.entries()) {
    const doc = docFor(entry as { documentId: string; documentVersionId: string });
    if (!doc) continue;
    for (const blockId of entry.blockIds) {
      if (blockUnprocessable(doc, blockId)) {
        add('coverage.unsupported_block_processed', 'candidateSnapshot.coverage.documentsProcessed[' + i + ']');
      }
    }
  }
  // 空图/未支持块的 evidence 或 semantic asset 一律拒绝（元数据读取不等于图像/表格理解）。
  for (const [i, entry] of snapshot.evidence.entries()) {
    const doc = docFor(entry as { documentId: string; documentVersionId: string });
    if (doc && blockUnprocessable(doc, entry.blockId)) add('evidence.from_unsupported_block', 'candidateSnapshot.evidence[' + i + ']');
  }
  for (const [i, asset] of (snapshot.assets ?? []).entries()) {
    const doc = docFor(asset as { documentId: string; documentVersionId: string });
    if (doc && blockUnprocessable(doc, asset.blockId)) add('asset.from_unsupported_block', 'candidateSnapshot.assets[' + i + ']');
  }
  const unresolved = snapshot.conflicts.some(c => c.resolutionStatus !== 'resolved');
  if (output.status === 'completed' && input.documents.some(d => d.parseInfo && d.parseInfo.quality !== 'complete')) add('coverage.partial_parse', 'status');
  if (output.status === 'completed' && (unsupported.size || snapshot.missing.length || unresolved)) add('candidate.incomplete_status', 'status');
  if (output.status === 'completed' && !receipts.length) add('candidate.no_read', 'status');
  // 相同的显式值、主体和口径才是程序能确定的重复；不把多值属性或不同口径强判为冲突。
  const seen = new Set<string>();
  for (const [i, claim] of snapshot.claims.entries()) {
    const { raw: _raw, ...value } = claim.value as unknown as Record<string, unknown>;
    const signature = canonicalize([claim.entityId, claim.predicate, value, claim.qualifiers ?? {}]);
    if (seen.has(signature)) add('claim.duplicate_fact', 'candidateSnapshot.claims[' + i + ']');
    seen.add(signature);
    if (claim.supportStatus === 'conflicted') {
      const conflict = snapshot.conflicts.find(c => c.conflictId === claim.conflictGroupId);
      if (!conflict || !conflict.claimRefs.includes(claim.claimId) || conflict.resolutionStatus === 'resolved') add('claim.untracked_conflict', 'candidateSnapshot.claims[' + i + ']');
    }
  }
  for (const conflict of snapshot.conflicts) {
    if (conflict.resolutionStatus === 'resolved') add('conflict.resolution_requires_review', 'candidateSnapshot.conflicts');
    for (const id of conflict.claimRefs) {
      const claim = snapshot.claims.find(c => c.claimId === id);
      if (claim && (claim.supportStatus !== 'conflicted' || claim.conflictGroupId !== conflict.conflictId)) add('conflict.claim_mismatch', 'candidateSnapshot.conflicts');
    }
  }
  // 修正不能通过删除已有事实/问题，或偷偷改掉已合法的事实值来过关。
  const prior = record(record(previous).candidateSnapshot);
  for (const [collection, idField] of [['claims', 'claimId'], ['missing', 'missingId'], ['conflicts', 'conflictId']] as const) {
    const before = prior[collection];
    if (!Array.isArray(before)) continue;
    for (const old of before) {
      const item = record(old), id = item[idField];
      if (typeof id !== 'string') continue;
      const next = (snapshot[collection] as Array<Record<string, unknown>>).find(c => c[idField] === id);
      if (!next) { add('repair.removed_item', 'candidateSnapshot.' + collection); continue; }
      if (collection === 'claims' && registry.validate('urn:tju-mas:contracts:evidence-snapshot#/$defs/claim', old).valid) {
        for (const field of ['entityId', 'predicate', 'value', 'qualifiers']) {
          if (canonicalize(item[field] ?? null) !== canonicalize(next[field] ?? null)) add('repair.changed_fact', 'candidateSnapshot.claims');
        }
      }
      if (collection === 'conflicts' && canonicalize(item.claimRefs ?? null) !== canonicalize(next.claimRefs ?? null)) add('repair.changed_conflict', 'candidateSnapshot.conflicts');
    }
  }
  // presentedLocators 仅用于内部一致性（存在性），避免未使用变量并保留可诊断性。
  void presentedLocators;
  return { ok: issues.length === 0, issues };
}