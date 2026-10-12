/**
 * 证据源策略（B3-source）：把“已验证匹配 PDF SourceBundle”的信任判定集中到一处。
 *
 * 设计目标：
 *  - 只允许来自可信服务的 genuine bundle 参与豁免；模型无法通过数组/标志/mime/locator 伪造。
 *  - 真伪判定必须复用 getValidatedSourceBundle（WeakMap 身份），禁止在能力校验前 structuredClone，
 *    否则会破坏身份、把伪造物洗白。
 *  - 只对“确为 PDF 且与授权文档规范相等”的文档路径豁免 B1 的 paragraph-only 遗留定位码
 *    （location.not_verified / location.kind_mismatch），其余 schema/identity/index/重复全部保留。
 *  - 候选证据/素材的物理定位必须与受信块位置规范相等，且原文摘录必须是原文子串。
 *
 * 这里不做 OCR/视觉推断，也不产生图片语义。
 */
import type { DocumentIr } from '../../../../packages/contracts/generated/index.ts';
import type { CommonSourceLocation } from '../../../../packages/contracts/generated/common.ts';
import { canonicalize } from '../../../../packages/contracts/src/validator.ts';
import type { SourceBundle } from './source-bundle.ts';
import { getValidatedSourceBundle } from './source-bundle.ts';

const docKey = (d: { documentId: string; documentVersionId: string }): string =>
  JSON.stringify([d.documentId, d.documentVersionId]);

/** 已验证匹配的 PDF 文档（授权文档 ↔ genuine bundle）。 */
export interface VerifiedPdfSource {
  /** genuine bundle 对象本身（已通过 getValidatedSourceBundle）。 */
  bundle: SourceBundle;
  /** 对应的授权 DocumentIR（来自可信输入）。 */
  document: DocumentIr;
}

export class SourcePolicyError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'SourcePolicyError'; this.code = code; }
}

/**
 * 对提供的 sourceBundles 逐一做 genuine 校验并与授权文档匹配。
 *
 * 关键：对传入数组本身不做 structuredClone（浅拷贝数组不改变元素对象身份即可）。
 * getValidatedSourceBundle 只对真实、未被改动的 bundle 成功；伪造/改动/循环都会失败。
 */
export function verifyPdfSources(
  bundles: readonly SourceBundle[] | undefined,
  documents: readonly DocumentIr[],
): Map<string, VerifiedPdfSource> {
  const verified = new Map<string, VerifiedPdfSource>();
  if (!bundles) return verified;
  if (!Array.isArray(bundles)) throw new SourcePolicyError('invalid_source_bundles');

  const index = new Map(documents.map(d => [docKey(d), d]));
  if (index.size !== documents.length) throw new SourcePolicyError('duplicate_document_version');

  for (const candidate of bundles) {
    let validated: SourceBundle;
    try {
      // 真伪能力校验：必须在任何克隆/改写之前对原始对象调用。
      validated = getValidatedSourceBundle(candidate);
    } catch {
      throw new SourcePolicyError('invalid_source_bundle');
    }
    const key = docKey(validated);
    const document = index.get(key);
    if (!document) throw new SourcePolicyError('foreign_source_bundle');
    if (validated.projectId !== document.projectId) throw new SourcePolicyError('bundle_project_mismatch');
    if (validated.contentHash !== document.contentHash) throw new SourcePolicyError('bundle_hash_mismatch');
    // 规范文档完全相等：bundle.document 必须等同授权 DocumentIR，不授予额外权限。
    if (canonicalize(validated.document) !== canonicalize(document)) {
      throw new SourcePolicyError('bundle_document_mismatch');
    }
    if (verified.has(key)) throw new SourcePolicyError('duplicate_source_bundle');
    verified.set(key, { bundle: validated, document });
  }
  return verified;
}

/** 该文档是否拥有 genuine 且敢为 PDF 的匹配源。 */
export function hasPdfSource(verified: Map<string, VerifiedPdfSource>, doc: { documentId: string; documentVersionId: string; mimeType?: string }): boolean {
  const entry = verified.get(docKey(doc));
  return !!entry && entry.bundle.mimeType === 'application/pdf' && doc.mimeType === 'application/pdf';
}

/** 只在“已验证匹配 PDF”的文档路径上豁免的 B1 遗留定位码。 */
export const PDF_LOCATION_EXEMPT_CODES = new Set<string>([
  'location.not_verified',
  'location.kind_mismatch',
]);

/**
 * 输入校验过滤：对给定了已验证匹配 PDF 的文档路径，去掉两条遗留定位码；其余问题全部保留。
 * 不修改入参 issue 数组（返回新数组）。
 */
export function filterInputIssues<Issue extends { code: string; path?: string }>(
  issues: readonly Issue[],
  verified: Map<string, VerifiedPdfSource>,
  documents: readonly DocumentIr[],
): Issue[] {
  if (!verified.size) return [...issues];
  const pdfDocPrefixes: string[] = [];
  documents.forEach((doc, i) => {
    if (hasPdfSource(verified, doc)) pdfDocPrefixes.push(`documents[${i}]`);
  });
  if (!pdfDocPrefixes.length) return [...issues];
  return issues.filter(issue => {
    if (!PDF_LOCATION_EXEMPT_CODES.has(issue.code)) return true;
    const path = issue.path ?? '';
    return !pdfDocPrefixes.some(prefix => path.startsWith(prefix));
  });
}

/** 找到授权文档中某块的物理定位（来自 DocumentIR）。 */
export function documentBlockLocation(
  documents: readonly DocumentIr[],
  documentId: string,
  documentVersionId: string,
  blockId: string,
): CommonSourceLocation | undefined {
  const doc = documents.find(d => d.documentId === documentId && d.documentVersionId === documentVersionId);
  return doc?.blocks.find(b => b.blockId === blockId)?.location as CommonSourceLocation | undefined;
}

/**
 * 候选物理定位判定：只有当文档拥有 genuine 匹配 PDF 源、且候选 locator 与该块 DocumentIR 定位
 * 规范相等时才算“物理已验证”。错误页/bbox、伪造 PDF、过期版本都不满足。
 */
export function physicalLocatorMatches(
  verified: Map<string, VerifiedPdfSource>,
  documents: readonly DocumentIr[],
  entry: { documentId: string; documentVersionId: string; blockId: string; locator?: unknown },
): boolean {
  const doc = documents.find(d => d.documentId === entry.documentId && d.documentVersionId === entry.documentVersionId);
  if (!doc || !hasPdfSource(verified, doc)) return false;
  const block = doc.blocks.find(b => b.blockId === entry.blockId);
  if (!block) return false;
  const actual: CommonSourceLocation | undefined = block.location as CommonSourceLocation | undefined;
  if (!actual || entry.locator == null) return false;
  return canonicalize(actual) === canonicalize(entry.locator);
}

/**
 * 验证读取收据是否覆盖某事实条目：收据身份（doc/version/block）+ 内容哈希 + 物理定位。
 * 收据只能由真实成功的工具执行生成；minimal 收据需含 contentHash 与 physical location。
 */
export interface ReceiptIdentity {
  documentId: string;
  documentVersionId: string;
  blockId: string;
  contentHash?: string;
  text?: string | null;
  location?: unknown;
}

export function receiptCovers(
  receipts: readonly ReceiptIdentity[],
  documents: readonly DocumentIr[],
  entry: { documentId: string; documentVersionId: string; blockId: string; locator?: unknown; excerpt?: string },
): boolean {
  const candidates = receipts.filter(r =>
    r.documentId === entry.documentId &&
    r.documentVersionId === entry.documentVersionId &&
    r.blockId === entry.blockId);
  if (!candidates.length) return false;
  const doc = documents.find(d => d.documentId === entry.documentId && d.documentVersionId === entry.documentVersionId);
  if (doc) {
    for (const r of candidates) {
      if (r.contentHash !== undefined && r.contentHash !== doc.contentHash) return false;
    }
  }
  // 物理定位：至少存在一条收据其 location 与候选 locator 规范相等。
  const loc = candidates.some(r => r.location != null && canonicalize(r.location) === canonicalize(entry.locator));
  if (!loc) return false;
  // 原文摘录必须是真实读取原文的连续子串（若提供 excerpt）。
  if (typeof entry.excerpt === 'string' && entry.excerpt.length > 0) {
    const text = candidates.map(r => (typeof r.text === 'string' ? r.text : '')).find(t => t.length > 0) ?? '';
    if (text && !text.includes(entry.excerpt)) return false;
  }
  return true;
}