/**
 * 作用域资料包适配器（scoped source-bundle adapter）。
 *
 * 只读加载由本地 PDF 解析器（pdf-local-0.1.0）产出的资料包目录，并返回
 * 结构化、可校验的元数据/文本/相对资产引用。绝不返回二进制、base64 或
 * 主机绝对路径，也不做语义推断、OCR 或图像理解。
 *
 * 前置条件：目录由调用方服务保证在加载期间不可变且访问受控；本模块只读，
 * 绝不写入。
 *
 * 上传产物一律视为不可信数据，不能提供权限或可执行内容。
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, lstatSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DocumentIr, DocumentIrBlock } from '../../../../packages/contracts/generated/document-ir.ts';
import type { CommonSourceLocation } from '../../../../packages/contracts/generated/common.ts';
import { canonicalize } from '../../../../packages/contracts/src/validator.ts';

export const SOURCE_BUNDLE_ERROR_CODES = [
  'invalid_argument', 'io_error', 'malformed_json', 'schema_invalid', 'identity_mismatch',
  'manifest_invalid', 'artifact_path_unsafe', 'artifact_not_regular_file', 'artifact_missing',
  'size_limit_exceeded', 'hash_mismatch', 'count_mismatch', 'block_mismatch', 'table_invalid',
  'failure_marker_present', 'internal_error', 'invalid_source_bundle',
] as const;

export type SourceBundleErrorCode = (typeof SOURCE_BUNDLE_ERROR_CODES)[number];

export interface SourceBundleError {
  code: SourceBundleErrorCode;
  /** 结构化失败位置（如 'manifest.pages[0]'）；绝不含主机路径或原始内容。 */
  path?: string;
}

/** 由可信上下文提供、必须与已校验 IR 完全一致的授权标识。 */
export interface TrustedAuthorization {
  projectId: string;
  documentId: string;
  documentVersionId: string;
  version: number;
  contentHash: string;
}

export interface BundleFs {
  lstat(p: string): { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean };
  stat(p: string): { isFile(): boolean; size: number };
  readFile(p: string): Uint8Array;
  readdir(p: string): string[];
}

const defaultFs: BundleFs = {
  lstat: (p) => lstatSync(p),
  stat: (p) => { const s = statSync(p); return { isFile: (): boolean => s.isFile(), size: s.size }; },
  readFile: (p) => readFileSync(p),
  readdir: (p) => readdirSync(p),
};

export interface RegistryLike { validate(schemaId: string, data: unknown): { valid: boolean; errors?: unknown }; }

export interface LoadSourceBundleOptions {
  fs?: BundleFs;
  registry?: RegistryLike;
  /** 覆盖上限，仅供测试；始终夹在硬上限内。 */
  limits?: Partial<Record<'json' | 'asset' | 'total' | 'source', number>>;
}

const HARD_PAGE_DIMENSION_MAX = 2400;
const DEFAULT_LIMITS = {
  json: 8 * 1024 * 1024,
  asset: 32 * 1024 * 1024,
  total: 256 * 1024 * 1024,
  source: 25 * 1024 * 1024,
} as const;

export const SOURCE_BUNDLE_LIMITS = {
  jsonBytes: DEFAULT_LIMITS.json,
  assetBytes: DEFAULT_LIMITS.asset,
  totalBytes: DEFAULT_LIMITS.total,
  sourceBytes: DEFAULT_LIMITS.source,
  pageDimension: HARD_PAGE_DIMENSION_MAX,
} as const;

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/contracts/schemas');

function clampLimits(over?: LoadSourceBundleOptions['limits']) {
  const pick = (k: keyof typeof DEFAULT_LIMITS): number => {
    const v = over?.[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return DEFAULT_LIMITS[k];
    return Math.min(v, DEFAULT_LIMITS[k]);
  };
  return { json: pick('json'), asset: pick('asset'), total: pick('total'), source: pick('source') };
}

// ---------------------------------------------------------------------------
// 输出类型
// ---------------------------------------------------------------------------

export interface SourceRef {
  projectId: string;
  documentId: string;
  documentVersionId: string;
  version: number;
  contentHash: string;
  blockId: string;
  location: CommonSourceLocation;
}

export interface SourceBundleAssetRef {
  blockId: string;
  assetKind: string;
  /** 相对资料包根目录的安全路径。 */
  path: string;
  sha256: string;
  bytes: number;
}

export interface SourceBundleBlock {
  blockId: string;
  index: number;
  type: DocumentIrBlock['type'];
  /** 原始文本，逐字节保留（单位/年份不被规范化）。 */
  text: string;
  location: CommonSourceLocation;
  status: string | null;
  asset: SourceBundleAssetRef | null;
  tablePath: string | null;
  semanticStatus?: 'not_run';
}

export interface SourceBundleTableCell {
  row: number;
  column: number;
  text: string | null;
  location: CommonSourceLocation;
}

export interface SourceBundleTable {
  blockId: string;
  tablePath: string;
  sourceHash: string;
  status: 'candidate_not_reviewed';
  rows: Array<Array<string | null>>;
  cells: SourceBundleTableCell[];
  warnings: string[];
}

export interface SourceBundlePage {
  page: number;
  width: number;
  height: number;
  rotation: number;
  mediabox: number[];
  cropbox: number[] | null;
  status: string;
  issues: Array<{ stage: string; status: string; code: string }>;
  counts: Record<string, number>;
  render: { path: string; sha256: string; pixelSize: number[] } | null;
}

export interface SourceBundle {
  projectId: string;
  document: DocumentIr;
  documentId: string;
  documentVersionId: string;
  version: number;
  contentHash: string;
  mimeType: string;
  sourceName: string;
  sourcePath: 'source.pdf';
  parser: string;  quality: string;
  coordinateSystem: string;
  unsupported: Array<{ blockId: string; reason: string }>;
  limitations: string[];
  blocks: SourceBundleBlock[];
  refs: SourceRef[];
  tables: SourceBundleTable[];
  pages: SourceBundlePage[];
  counts: Record<string, number>;
  manifestStatus: string;
}

export type SourceBundleResult = { ok: true; bundle: SourceBundle } | { ok: false; error: SourceBundleError };

const validatedSnapshots = new WeakMap<SourceBundle, { snapshot: SourceBundle; canonical: string }>();

export function getValidatedSourceBundle(bundle: SourceBundle): SourceBundle {
  try {
    const entry = validatedSnapshots.get(bundle);
    if (!entry) throw new Error('invalid_source_bundle');
    if (canonicalize(bundle) !== entry.canonical) throw new Error('invalid_source_bundle');
    return structuredClone(entry.snapshot);
  } catch {
    throw new Error('invalid_source_bundle');
  }
}

class BundleError extends Error {
  readonly code: SourceBundleErrorCode;
  readonly path?: string;
  constructor(code: SourceBundleErrorCode, path?: string) {
    super(code);
    this.name = 'BundleError';
    this.code = code;
    this.path = path;
  }
}
function fail(code: SourceBundleErrorCode, path?: string): never { throw new BundleError(code, path); }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

/** 校验相对、安全、无回溯/绝对/反斜杠，且每段非符号链接的路径。 */
function assertSafeRelativePath(raw: unknown, root: string, path: string, fs: BundleFs): string {
  if (typeof raw !== 'string' || raw.length === 0) fail('artifact_path_unsafe', path);
  const p = raw as string;
  if (p.includes('\\') || isAbsolute(p) || /^[A-Za-z]:/.test(p)) fail('artifact_path_unsafe', path);
  const segments = p.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) fail('artifact_path_unsafe', path);
  let current = root;
  for (let i = 0; i < segments.length; i++) {
    current = join(current, segments[i]);
    let st: ReturnType<BundleFs['lstat']>;
    try { st = fs.lstat(current); } catch { fail('artifact_missing', path); }
    if (st!.isSymbolicLink()) fail('artifact_path_unsafe', path);
    const last = i === segments.length - 1;
    if (!last && !st!.isDirectory()) fail('artifact_not_regular_file', path);
    if (last && !st!.isFile()) fail('artifact_not_regular_file', path);
  }
  return p;
}

interface Budget { used: number; total: number; }

/** 有界读取：先检查大小上限，再做哈希解码。 */
function readBounded(root: string, relPath: string, limit: number, budget: Budget, fs: BundleFs, path: string) {
  const safeRel = assertSafeRelativePath(relPath, root, path, fs);
  const abs = join(root, safeRel);
  let size: number;
  try {
    const st = fs.stat(abs);
    if (!st.isFile()) fail('artifact_not_regular_file', path);
    size = st.size;
  } catch (e) { if (e instanceof BundleError) throw e; fail('artifact_missing', path); }
  if (typeof size! !== 'number' || !Number.isFinite(size!) || !Number.isInteger(size!) || size! < 0) fail('size_limit_exceeded', path);
  if (size! > limit) fail('size_limit_exceeded', path);
  if (budget.used + size! > budget.total) fail('size_limit_exceeded', 'budget');
  let bytes: Uint8Array;
  try { bytes = fs.readFile(abs); } catch { fail('io_error', path); }
  const read = bytes!.length;
  if (typeof read !== 'number' || !Number.isFinite(read) || !Number.isInteger(read) || read < 0 || read !== size! || read > limit || budget.used + read > budget.total) fail('size_limit_exceeded', path);
  budget.used += read;
  return { bytes: bytes!, sha256: sha256Hex(bytes!), size: read };
}

function parseJson(bytes: Uint8Array, path: string): Record<string, unknown> {
  let text: string;
  try { text = Buffer.from(bytes).toString('utf8'); } catch { fail('malformed_json', path); }
  let v: unknown;
  try { v = JSON.parse(text!); } catch { fail('malformed_json', path); }
  if (!isPlainObject(v)) fail('malformed_json', path);
  return v as Record<string, unknown>;
}

async function defaultRegistry(): Promise<RegistryLike> {
  const mod = (await import('../../../../packages/contracts/src/schema-registry.ts')) as {
    loadSchemasFromDir: (dir: string) => RegistryLike;
  };
  return mod.loadSchemasFromDir(SCHEMA_DIR);
}

function checkRegionLocation(loc: unknown, pageSize: Map<number, { w: number; h: number }>, path: string): void {
  if (!isPlainObject(loc)) fail('block_mismatch', path);
  const kind = loc.kind;
  if (kind !== 'page_region' && kind !== 'image_region') fail('block_mismatch', `${path}.kind`);
  const page = loc.page;
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) fail('block_mismatch', `${path}.page`);
  const dims = pageSize.get(page as number);
  if (!dims) fail('block_mismatch', `${path}.page`);
  const bbox = loc.bbox;
  if (!isPlainObject(bbox)) fail('block_mismatch', `${path}.bbox`);
  for (const k of ['x', 'y', 'width', 'height'] as const) {
    if (typeof bbox[k] !== 'number' || !Number.isFinite(bbox[k])) fail('block_mismatch', `${path}.bbox.${k}`);
  }
  const { x, y, width, height } = bbox as { x: number; y: number; width: number; height: number };
  if (width <= 0 || height <= 0 || x < 0 || y < 0) fail('block_mismatch', `${path}.bbox`);
  if (x + width > dims.w + 0.01 || y + height > dims.h + 0.01) fail('block_mismatch', `${path}.bbox`);
}

function assertIrConsistency(ir: DocumentIr): void {
  const seen = new Set<string>();
  ir.blocks.forEach((b, i) => {
    if (b.index !== i) fail('block_mismatch', `ir.blocks[${i}].index`);
    if (seen.has(b.blockId)) fail('block_mismatch', `ir.blocks[${i}].blockId`);
    seen.add(b.blockId);
    if (typeof b.text !== 'string') fail('block_mismatch', `ir.blocks[${i}].text`);
  });
}

function assertCounts(counts: unknown, expected: Record<string, number>, path: string): void {
  if (!isPlainObject(counts)) fail('count_mismatch', path);
  for (const k of ['paragraph', 'image', 'table', 'other'] as const) {
    if (counts[k] !== expected[k]) fail('count_mismatch', `${path}.${k}`);
  }
}

function tableTextFromRows(rows: Array<Array<string | null>>): string {
  return rows.map((row) => row.map((c) => c || '').join('\t')).join('\n');
}
function validateTable(
  table: Record<string, unknown>,
  block: DocumentIrBlock,
  tableBBox: { x: number; y: number; width: number; height: number },
  page: number,
  path: string,
): SourceBundleTable {
  if (table.block_id !== block.blockId) fail('table_invalid', `${path}.block_id`);
  if (typeof table.source_hash !== 'string' || !SHA256_RE.test(table.source_hash)) fail('table_invalid', `${path}.source_hash`);
  if (table.status !== 'candidate_not_reviewed') fail('table_invalid', `${path}.status`);
  if (!Array.isArray(table.rows)) fail('table_invalid', `${path}.rows`);
  const rows = table.rows as unknown[][];
  rows.forEach((row, r) => {
    if (!Array.isArray(row)) fail('table_invalid', `${path}.rows[${r}]`);
    (row as unknown[]).forEach((c, cIdx) => {
      if (c !== null && typeof c !== 'string') fail('table_invalid', `${path}.rows[${r}][${cIdx}]`);
    });
  });
  if (!Array.isArray(table.cells)) fail('table_invalid', `${path}.cells`);
  if (!Array.isArray(table.warnings) || table.warnings.some((w) => typeof w !== 'string' || w.length === 0)) {
    fail('table_invalid', `${path}.warnings`);
  }
  const cells: SourceBundleTableCell[] = [];
  const seenCells = new Set<string>();
  (table.cells as unknown[]).forEach((raw, i) => {
    const cp = `${path}.cells[${i}]`;
    if (!isPlainObject(raw)) fail('table_invalid', cp);
    const row = raw.row, column = raw.column;
    if (typeof row !== 'number' || !Number.isInteger(row) || typeof column !== 'number' || !Number.isInteger(column)) fail('table_invalid', cp);
    if (row < 0 || row >= rows.length) fail('table_invalid', `${cp}.row`);
    if (column < 0 || column >= rows[row].length) fail('table_invalid', `${cp}.column`);
    const key = `${row}:${column}`;
    if (seenCells.has(key)) fail('table_invalid', `${cp}.duplicate`);
    seenCells.add(key);
    if (raw.text !== rows[row][column]) fail('table_invalid', `${cp}.text`);
    const loc = raw.location;
    if (!isPlainObject(loc) || loc.kind !== 'page_region' || loc.page !== page) fail('table_invalid', `${cp}.location`);
    const bb = loc.bbox;
    if (!isPlainObject(bb)) fail('table_invalid', `${cp}.location.bbox`);
    for (const k of ['x', 'y', 'width', 'height'] as const) {
      if (typeof bb[k] !== 'number' || !Number.isFinite(bb[k])) fail('table_invalid', `${cp}.location.bbox.${k}`);
    }
    const cb = bb as { x: number; y: number; width: number; height: number };
    if (cb.width <= 0 || cb.height <= 0) fail('table_invalid', `${cp}.location.bbox`);
    if (cb.x < tableBBox.x - 0.01 || cb.y < tableBBox.y - 0.01) fail('table_invalid', `${cp}.location.bbox`);
    if (cb.x + cb.width > tableBBox.x + tableBBox.width + 0.01) fail('table_invalid', `${cp}.location.bbox`);
    if (cb.y + cb.height > tableBBox.y + tableBBox.height + 0.01) fail('table_invalid', `${cp}.location.bbox`);
    cells.push({ row, column, text: raw.text as string | null, location: loc as unknown as CommonSourceLocation });
  });
  if (block.text !== tableTextFromRows(rows as Array<Array<string | null>>)) fail('table_invalid', `${path}.text`);
  return {
    blockId: block.blockId, tablePath: '', sourceHash: table.source_hash,
    status: 'candidate_not_reviewed', rows: rows as Array<Array<string | null>>, cells, warnings: table.warnings as string[],
  };
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function loadSourceBundle(
  directory: string,
  trustedAuthorization: TrustedAuthorization,
  options: LoadSourceBundleOptions = {},
): Promise<SourceBundleResult> {
  const fs = options.fs ?? defaultFs;
  const limits = clampLimits(options.limits);
  try {
    if (typeof directory !== 'string' || directory.length === 0) fail('invalid_argument', 'directory');
    if (!isPlainObject(trustedAuthorization)) fail('invalid_argument', 'authorization');
    for (const k of ['projectId', 'documentId', 'documentVersionId', 'contentHash'] as const) {
      if (typeof trustedAuthorization[k] !== 'string' || (trustedAuthorization[k] as string).length === 0) fail('invalid_argument', `authorization.${k}`);
    }
    if (typeof trustedAuthorization.version !== 'number' || !Number.isInteger(trustedAuthorization.version) || trustedAuthorization.version < 1) fail('invalid_argument', 'authorization.version');
    if (!SHA256_RE.test(trustedAuthorization.contentHash)) fail('invalid_argument', 'authorization.contentHash');

    const root = resolve(directory);
    let rootSt: ReturnType<BundleFs['lstat']>;
    try { rootSt = fs.lstat(root); } catch { fail('io_error', 'root'); }
    if (rootSt!.isSymbolicLink()) fail('artifact_path_unsafe', 'root');
    if (!rootSt!.isDirectory()) fail('io_error', 'root');

    const present = new Set(fs.readdir(root));
    if (present.has('failure.json')) fail('failure_marker_present', 'failure.json');

    const budget: Budget = { used: 0, total: limits.total };

    const irRead = readBounded(root, 'document-ir.json', limits.json, budget, fs, 'document-ir.json');
    const irRaw = parseJson(irRead.bytes, 'document-ir.json');
    const reg = options.registry ?? (await defaultRegistry());
    let verdict: { valid: boolean };
    try { verdict = reg.validate('urn:tju-mas:contracts:document-ir', irRaw); } catch { fail('internal_error', 'schema_registry'); }
    if (!verdict!.valid) fail('schema_invalid', 'document-ir.json');
    const ir = irRaw as unknown as DocumentIr;

    if (ir.projectId !== trustedAuthorization.projectId || ir.documentId !== trustedAuthorization.documentId ||
        ir.documentVersionId !== trustedAuthorization.documentVersionId || ir.version !== trustedAuthorization.version ||
        ir.contentHash !== trustedAuthorization.contentHash) {
      fail('identity_mismatch', 'authorization');
    }
    if (ir.protocolVersion !== '1.0') fail('identity_mismatch', 'document-ir.json.protocolVersion');
    if (ir.mimeType !== 'application/pdf') fail('schema_invalid', 'document-ir.json.mimeType');
    if (typeof ir.sourceName !== 'string' || ir.sourceName.length === 0) fail('schema_invalid', 'document-ir.json.sourceName');
    if (!isPlainObject(ir.extensions)) fail('schema_invalid', 'document-ir.json.extensions');
    if (ir.extensions.coordinate_system !== 'physical_page_1_based; rotated_mediabox; top_left; points_1_72_inch') fail('schema_invalid', 'document-ir.json.extensions.coordinate_system');
    if (ir.parseInfo?.parser !== 'pdf-local-0.1.0') fail('schema_invalid', 'document-ir.json.parseInfo.parser');
    if (!Array.isArray(ir.blocks) || ir.blocks.length < 1 || ir.blocks.length > 5000) fail('size_limit_exceeded', 'document-ir.json.blocks');
    assertIrConsistency(ir);

    const manRead = readBounded(root, 'manifest.json', limits.json, budget, fs, 'manifest.json');
    const man = parseJson(manRead.bytes, 'manifest.json');
    if (man.format !== 'local_pdf_inspection_v1') fail('manifest_invalid', 'manifest.format');
    if (typeof man.parser !== 'string' || man.parser !== ir.parseInfo?.parser) fail('manifest_invalid', 'manifest.parser');
    if (man.network !== 'no_network_required') fail('manifest_invalid', 'manifest.network');
    if (man.status !== 'parsed_with_limitations' && man.status !== 'partial_failure') fail('manifest_invalid', 'manifest.status');
    if (man.document_ir !== 'document-ir.json') fail('manifest_invalid', 'manifest.document_ir');
    if (man.coordinates !== ir.extensions.coordinate_system) fail('manifest_invalid', 'manifest.coordinates');
    if (!Array.isArray(man.limitations) || man.limitations.length === 0 || man.limitations.some((l) => typeof l !== 'string' || l.length === 0)) fail('manifest_invalid', 'manifest.limitations');
    if (!isPlainObject(man.dependencies) || Object.values(man.dependencies).some((v) => typeof v !== 'string')) fail('manifest_invalid', 'manifest.dependencies');
    if (!isPlainObject(man.table_settings)) fail('manifest_invalid', 'manifest.table_settings');
    if (!Array.isArray(man.pages) || man.pages.length === 0) fail('manifest_invalid', 'manifest.pages');
    if (man.pages.length > 40) fail('size_limit_exceeded', 'manifest.pages');

    const src = man.source;
    if (!isPlainObject(src)) fail('manifest_invalid', 'manifest.source');
    if (src.file !== 'source.pdf') fail('manifest_invalid', 'manifest.source.file');
        if (typeof ir.sourceName !== 'string' || ir.sourceName.length === 0) fail('schema_invalid', 'document-ir.json.sourceName');
    if (ir.sourceName.includes('\u0000') || ir.sourceName.includes('/') || ir.sourceName.includes('\\')) fail('schema_invalid', 'document-ir.json.sourceName');
    if (src.name !== ir.sourceName) fail('manifest_invalid', 'manifest.source.name');
    if (typeof src.page_count !== 'number' || !Number.isInteger(src.page_count) || src.page_count < 1) fail('manifest_invalid', 'manifest.source.page_count');
    if (typeof src.bytes !== 'number' || !Number.isInteger(src.bytes) || src.bytes < 0) fail('manifest_invalid', 'manifest.source.bytes');
    if (typeof src.sha256 !== 'string' || !SHA256_RE.test(src.sha256) || src.sha256 !== ir.contentHash) fail('manifest_invalid', 'manifest.source.sha256');
    if (src.page_count !== man.pages.length) fail('count_mismatch', 'manifest.source.page_count');

    const sourceRead = readBounded(root, 'source.pdf', limits.source, budget, fs, 'source.pdf');
    if (sourceRead.size !== src.bytes) fail('count_mismatch', 'source.bytes');
    if (`sha256:${sourceRead.sha256}` !== ir.contentHash) fail('hash_mismatch', 'source.pdf');

    const pageSize = new Map<number, { w: number; h: number }>();
    const manifestPages = man.pages as unknown[];
    manifestPages.forEach((rawPage, i) => {
      const p = `manifest.pages[${i}]`;
      if (!isPlainObject(rawPage)) fail('manifest_invalid', p);
      const pg = rawPage;
      if (pg.page !== i + 1) fail('manifest_invalid', `${p}.page`);
      for (const k of ['width', 'height'] as const) {
        if (typeof pg[k] !== 'number' || !Number.isFinite(pg[k]) || (pg[k] as number) <= 0 || (pg[k] as number) > HARD_PAGE_DIMENSION_MAX) fail('manifest_invalid', `${p}.${k}`);
      }
      if (typeof pg.rotation !== 'number' || !Number.isFinite(pg.rotation)) fail('manifest_invalid', `${p}.rotation`);
      if (!Array.isArray(pg.mediabox) || pg.mediabox.length !== 4 || pg.mediabox.some((n) => typeof n !== 'number' || !Number.isFinite(n))) fail('manifest_invalid', `${p}.mediabox`);
      if (pg.cropbox !== null && (!Array.isArray(pg.cropbox) || pg.cropbox.length !== 4 || pg.cropbox.some((n) => typeof n !== 'number' || !Number.isFinite(n)))) fail('manifest_invalid', `${p}.cropbox`);
      if (pg.status !== 'parsed' && pg.status !== 'partial_failure') fail('manifest_invalid', `${p}.status`);
      if (!Array.isArray(pg.issues)) fail('manifest_invalid', `${p}.issues`);
      pageSize.set(i + 1, { w: pg.width as number, h: pg.height as number });
    });

    const blocksOut: SourceBundleBlock[] = [];
    const refs: SourceRef[] = [];
    const tables: SourceBundleTable[] = [];
    const pagesOut: SourceBundlePage[] = [];
    const refContext = { projectId: ir.projectId, documentId: ir.documentId, documentVersionId: ir.documentVersionId, version: ir.version, contentHash: ir.contentHash };
    const totalCounts: Record<string, number> = { paragraph: 0, image: 0, table: 0, other: 0 };
    let blockCursor = 0;
    const unsupportedAll = ir.parseInfo?.unsupported ?? [];

    manifestPages.forEach((rawPage, i) => {
      const p = `manifest.pages[${i}]`;
      const pg = rawPage as Record<string, unknown>;
      const pageNo = i + 1;
      const dims = pageSize.get(pageNo)!;
      const items = pg.blocks;
      if (!Array.isArray(items)) fail('manifest_invalid', `${p}.blocks`);
      const pageCounts: Record<string, number> = { paragraph: 0, image: 0, table: 0, other: 0 };

      (items as unknown[]).forEach((rawItem, j) => {
        const ip = `${p}.blocks[${j}]`;
        if (!isPlainObject(rawItem)) fail('block_mismatch', ip);
        const item = rawItem;
        const irBlock = ir.blocks[blockCursor];
        if (!irBlock) fail('block_mismatch', `${ip}.index`);
        blockCursor += 1;

        if (item.blockId !== irBlock.blockId || item.index !== irBlock.index || item.type !== irBlock.type) fail('block_mismatch', `${ip}.identity`);
        if (item.text !== irBlock.text) fail('block_mismatch', `${ip}.text`);
        if (canonicalize(item.location) !== canonicalize(irBlock.location)) fail('block_mismatch', `${ip}.location`);
        if (canonicalize(item.extensions) !== canonicalize(irBlock.extensions)) fail('block_mismatch', `${ip}.extensions`);
        checkRegionLocation(irBlock.location, pageSize, `ir.blocks[${irBlock.index}].location`);
        {
            const type = irBlock.type;
            if (type !== 'paragraph' && type !== 'image' && type !== 'table' && type !== 'other') {
                fail('block_mismatch', `${ip}.type`);
            }
            const location = irBlock.location;
            if (!('page' in location) || location.page !== pageNo) {
                fail('block_mismatch', `${ip}.location.page`);
            }
            const expectedKind = type === 'image' ? 'image_region' : 'page_region';
            if (location.kind !== expectedKind) {
                fail('block_mismatch', `${ip}.location.kind`);
            }
        }

        if (typeof item.status !== 'string') fail('block_mismatch', `${ip}.status`);

        const type = irBlock.type;
        if (type === 'paragraph') {
          totalCounts.paragraph += 1;
          if (item.status !== 'parsed') fail('block_mismatch', `${ip}.status`);
        } else if (type === 'image') {
          totalCounts.image += 1;
          if (item.status !== 'extracted_not_understood' && item.status !== 'failed') fail('block_mismatch', `${ip}.status`);
          if (item.text !== '') fail('block_mismatch', `${ip}.text`);
          if (!unsupportedAll.some((u) => u.blockId === irBlock.blockId && u.reason !== '')) fail('block_mismatch', `${ip}.unsupported`);
        } else if (type === 'table') {
          totalCounts.table += 1;
          if (item.status !== 'candidate_not_reviewed' && item.status !== 'failed') fail('block_mismatch', `${ip}.status`);
        } else {
          totalCounts.other += 1;
          if (item.status !== 'unsupported') fail('block_mismatch', `${ip}.status`);
          if (!unsupportedAll.some((u) => u.blockId === irBlock.blockId && u.reason !== '')) fail('block_mismatch', `${ip}.unsupported`);
        }
        pageCounts[type === 'paragraph' || type === 'image' || type === 'table' ? type : 'other'] += 1;

        let assetRef: SourceBundleAssetRef | null = null;
        if ((type === 'image' || type === 'table') && item.asset !== null && item.asset !== undefined) {
          if (item.status === 'failed') fail('invalid_source_bundle', `${ip}.status`);
          const arel = assertSafeRelativePath(item.asset, root, `${ip}.asset`, fs);
          const aRead = readBounded(root, arel, limits.asset, budget, fs, `${ip}.asset`);
          const ext = irBlock.extensions ?? {};
          if (ext.asset_path !== item.asset) fail('invalid_source_bundle', `${ip}.asset_path`);
          if (ext.asset_kind !== 'rendered_page_region') fail('invalid_source_bundle', `${ip}.asset_kind`);
          if (typeof ext.asset_hash !== 'string' || !SHA256_RE.test(ext.asset_hash) || ext.asset_hash !== `sha256:${aRead.sha256}`) fail('hash_mismatch', `${ip}.asset`);
          assetRef = { blockId: irBlock.blockId, assetKind: 'rendered_page_region', path: arel, sha256: `sha256:${aRead.sha256}`, bytes: aRead.size };
        } else if (type === 'image' || type === 'table') {
          if (item.status !== 'failed') fail('invalid_source_bundle', `${ip}.status`);
          const absExt = irBlock.extensions ?? {};
          if (absExt.asset_path !== undefined) fail('invalid_source_bundle', `${ip}.asset_path`);
          if (absExt.asset_hash !== undefined) fail('invalid_source_bundle', `${ip}.asset_hash`);
          if (absExt.asset_kind !== undefined) fail('invalid_source_bundle', `${ip}.asset_kind`);
          const issueOk = Array.isArray(pg.issues) && pg.issues.some(
            (iss: unknown) =>
              isPlainObject(iss) &&
              iss.stage === 'render' &&
              iss.status === 'failed' &&
              iss.code === 'page_render_failed',
          );
          const unsupOk = unsupportedAll.some(
            (u) =>
              u.blockId === irBlock.blockId &&
              typeof u.reason === 'string' &&
              u.reason.split('; ').includes('region_render_failed'),
          );
          if (!issueOk && !unsupOk) fail('invalid_source_bundle', `${ip}.status`);
        } else {
          if (item.asset !== null && item.asset !== undefined) fail('invalid_source_bundle', `${ip}.asset`);
          const pext = irBlock.extensions ?? {};
          if (pext.asset_path !== undefined) fail('invalid_source_bundle', `${ip}.asset_path`);
          if (pext.asset_hash !== undefined) fail('invalid_source_bundle', `${ip}.asset_hash`);
          if (pext.asset_kind !== undefined) fail('invalid_source_bundle', `${ip}.asset_kind`);
        }

        let tablePath: string | null = null;
        if (type === 'table') {
          const ext = irBlock.extensions ?? {};
          if (typeof ext.table_data_path !== 'string') fail('table_invalid', `${ip}.table_data_path`);
          tablePath = assertSafeRelativePath(ext.table_data_path, root, `${ip}.table_data_path`, fs);
          const tRead = readBounded(root, tablePath, limits.json, budget, fs, `${ip}.table_data_path`);
          if (typeof ext.table_data_hash !== 'string' || !SHA256_RE.test(ext.table_data_hash)) fail('table_invalid', `${ip}.table_data_hash`);
          if (`sha256:${tRead.sha256}` !== ext.table_data_hash) fail('hash_mismatch', `${ip}.table_data_hash`);
          if (ext.table_status !== 'candidate_not_reviewed') fail('table_invalid', `${ip}.table_status`);
          const tRaw = parseJson(tRead.bytes, `${ip}.table_data_path`);
          if (tRaw.source_hash !== ir.contentHash) fail('table_invalid', `${ip}.table.source_hash`);
          if (canonicalize(tRaw.location) !== canonicalize(irBlock.location)) fail('table_invalid', `${ip}.table.location`);
          if (canonicalize(item.table) !== canonicalize(tRaw)) fail('table_invalid', `${ip}.table`);
          const bbox = (irBlock.location as { bbox?: { x: number; y: number; width: number; height: number } }).bbox;
          if (!bbox) fail('table_invalid', `${ip}.bbox`);
          const table = validateTable(tRaw, irBlock, bbox, (irBlock.location as { page: number }).page, `${ip}.table`);
          table.tablePath = tablePath;
          if (table.warnings.length > 0) {
            const reasons = unsupportedAll.filter((u) => u.blockId === irBlock.blockId).map((u) => u.reason);
            for (const warning of table.warnings) {
              // 精确匹配整条警告，或警告恰为某个 '; ' 分隔片段的完整串；不得子串匹配。
              if (!reasons.some((r) => r === warning || r.startsWith(`${warning}; `) || r.endsWith(`; ${warning}`) || r.includes(`; ${warning}; `))) fail('table_invalid', `${ip}.warnings`);
            }
          }
          tables.push(table);
        }

        blocksOut.push({
          blockId: irBlock.blockId, index: irBlock.index, type, text: irBlock.text,
          location: irBlock.location, status: typeof item.status === 'string' ? item.status : null,
          asset: assetRef, tablePath,
          ...(type === 'image' ? { semanticStatus: 'not_run' as const } : {}),
        });
        refs.push({ ...refContext, blockId: irBlock.blockId, location: irBlock.location });
      });

      // 页面渲染资产
      let render: SourceBundlePage['render'] = null;
      const renderRaw = pg.render;
      // null 视为"已声明但缺失"——在缺失渲染分支须拒绝。
      const hasRenderSha = pg.render_sha256 !== undefined;
      const hasPixelSize = pg.pixel_size !== undefined;
      if (renderRaw !== null && renderRaw !== undefined) {
        const rrel = assertSafeRelativePath(renderRaw, root, `${p}.render`, fs);
        const rRead = readBounded(root, rrel, limits.asset, budget, fs, `${p}.render`);
        const shaClaim = pg.render_sha256;
        if (typeof shaClaim === 'string') {
          if (!SHA256_RE.test(shaClaim) || shaClaim !== `sha256:${rRead.sha256}`) fail('hash_mismatch', `${p}.render_sha256`);
        } else {
          fail('manifest_invalid', `${p}.render_sha256`);
        }
        const px = pg.pixel_size;
        if (!Array.isArray(px) || px.length !== 2) fail('manifest_invalid', `${p}.pixel_size`);
        for (const n of px as unknown[]) {
          if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0 || n > HARD_PAGE_DIMENSION_MAX) fail('manifest_invalid', `${p}.pixel_size`);
        }
        render = { path: rrel, sha256: `sha256:${rRead.sha256}`, pixelSize: px as number[] };
      } else {
        // 缺失渲染仅允许在显式声明的失败 issue 下，且 sha/pixel 均须缺省
        if (hasRenderSha || hasPixelSize) fail('manifest_invalid', `${p}.render`);
        const issues = pg.issues;
        const renderFailed = Array.isArray(issues) && issues.some((issue) => {
          if (!isPlainObject(issue)) return false;
          return issue.stage === 'render' && issue.status === 'failed' && issue.code === 'page_render_failed';
        });
        if (!renderFailed) fail('manifest_invalid', `${p}.render`);
      }

      if (!Array.isArray(pg.blocks) || pg.blocks.length === 0) fail('manifest_invalid', `${p}.blocks`);

      const issues = (pg.issues as unknown[]).map((rawIssue, k) => {
        if (!isPlainObject(rawIssue)) fail('manifest_invalid', `${p}.issues[${k}]`);
        if (typeof rawIssue.stage !== 'string' || rawIssue.status !== 'failed' || typeof rawIssue.code !== 'string' || rawIssue.code.length === 0) {
          fail('manifest_invalid', `${p}.issues[${k}]`);
        }
        return { stage: rawIssue.stage, status: 'failed' as const, code: rawIssue.code };
      });

      const hasIssues = issues.length > 0;
      if ((pg.status === 'partial_failure') !== hasIssues) fail('manifest_invalid', `${p}.status`);

      assertCounts(pg.counts, pageCounts, `${p}.counts`);

      // 页面 issues 导致该页首个区块必须带 unsupported 记录
      if (hasIssues) {
        const firstBlock = blocksOut.find((b) => {
          const loc = b.location as { page?: number };
          return loc.page === pageNo;
        });
        if (!firstBlock || !unsupportedAll.some((u) => u.blockId === firstBlock.blockId)) {
          fail('manifest_invalid', `${p}.issues.unsupported`);
        }
        // 每个 issue code 必须完整出现在该页首个区块的 unsupported reason 中（'; ' 边界，允许重复条目）
        const reasons = unsupportedAll
          .filter((u) => u.blockId === firstBlock.blockId)
          .flatMap((u) => {
            const r = (u as { reason?: unknown }).reason;
            return typeof r === 'string' ? r.split('; ') : [];
          });
        for (const issue of issues) {
          if (!reasons.includes(issue.code)) fail('manifest_invalid', `${p}.issues.unsupported`);
        }
      }

      const pageOut: SourceBundlePage = {
        page: pageNo, width: pg.width as number, height: pg.height as number, rotation: pg.rotation as number,
        mediabox: pg.mediabox as number[], cropbox: (pg.cropbox as number[] | null), status: pg.status as string,
        issues, counts: pageCounts, render,
      };
      pagesOut.push(pageOut);
    });

    if (blockCursor !== ir.blocks.length) fail('count_mismatch', 'blocks');

    // 顶层 manifest.status 必须与是否出现页级 issue 精确一致
    if ((man.status === 'partial_failure') !== pagesOut.some((p) => p.issues.length > 0)) fail('manifest_invalid', 'manifest.status');
    assertCounts(man.counts, totalCounts, 'manifest.counts');

    // 所有 unsupported 引用都必须解析到实际区块
    const blockIds = new Set(ir.blocks.map((b) => b.blockId));
    for (const u of unsupportedAll) {
      if (!isPlainObject(u) || typeof u.blockId !== 'string' || !blockIds.has(u.blockId)) fail('block_mismatch', 'parseInfo.unsupported');
      if (typeof u.reason !== 'string' || u.reason.length === 0) fail('block_mismatch', 'parseInfo.unsupported');
    }

    const bundle: SourceBundle = {
      projectId: ir.projectId, documentId: ir.documentId, documentVersionId: ir.documentVersionId,
      version: ir.version, contentHash: ir.contentHash, document: structuredClone(ir),
      mimeType: ir.mimeType, sourceName: ir.sourceName,
      sourcePath: 'source.pdf', parser: ir.parseInfo?.parser ?? '', quality: ir.parseInfo?.quality ?? '',
      coordinateSystem: ir.extensions.coordinate_system as string,
      unsupported: unsupportedAll.map((u) => ({ blockId: u.blockId, reason: u.reason })),
      limitations: man.limitations as string[], blocks: blocksOut, refs, tables, pages: pagesOut,
      counts: totalCounts, manifestStatus: man.status,
    };
    validatedSnapshots.set(bundle, { snapshot: structuredClone(bundle), canonical: canonicalize(bundle) });
    return { ok: true, bundle };
  } catch (e) {
    if (e instanceof BundleError) return { ok: false, error: { code: e.code, path: e.path } };
    return { ok: false, error: { code: 'internal_error' } };
  }
}
