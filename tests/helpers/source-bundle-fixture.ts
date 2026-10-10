/**
 * 合成 SourceBundle 夹具构建器（从 source-bundle.test.ts 抽取的可复用辅助声明）。
 * 仅包含构建与加载辅助，不注册任何测试；所有字节均为不透明合成文本，非真实 PDF/PNG。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { loadSourceBundle, type SourceBundle, type LoadSourceBundleOptions } from '../../apps/server/src/domain/source-bundle.ts';

export type { SourceBundle, LoadSourceBundleOptions };

export const hex = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

// 极小合成不透明字节：不是真实 PDF/PNG，只用于字节哈希完整性。
export const PDF_BYTES = Buffer.from('%PDF-FAKE-SYNTHETIC-BYTES-0123456789');
export const PNG_BYTES = Buffer.from('\x89PNG-FAKE-SYNTHETIC-IMAGE');
export const RENDER_BYTES = Buffer.from('RENDER-FAKE-SYNTHETIC-PAGE');

export const COORD = 'physical_page_1_based; rotated_mediabox; top_left; points_1_72_inch';
export const IMG_REASON = 'image_region_only; OCR and image semantics not run';

export interface TableSpec {
  rows: Array<Array<string | null>>;
  cells?: Array<{ row: number; column: number; text: string | null }>;
  warnings?: string[];
}
export interface FixtureOpts {
  tables?: Record<string, TableSpec>;
  mutateIr?: (ir: any) => void;
  mutateManifest?: (m: any) => void;
  mutateTable?: (obj: Record<string, unknown>, blockId: string) => void;
  renderFail?: boolean;
  useSymlinkAsset?: boolean;
  noImageAsset?: boolean;
  extraFiles?: Record<string, Buffer | string>;
  writeFailure?: boolean;
  hugeSource?: boolean;
}

export interface Fixture {
  dir: string;
  auth: { projectId: string; documentId: string; documentVersionId: string; version: number; contentHash: string };
  cleanup: () => void;
}

export function buildFixture(opts: FixtureOpts = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'sb-'));
  mkdirSync(join(dir, 'assets'), { recursive: true });
  mkdirSync(join(dir, 'tables'), { recursive: true });
  mkdirSync(join(dir, 'pages'), { recursive: true });

  const tableSpecs = opts.tables ?? {
    b001: {
      rows: [['Item', 'Value'], ['Year', '2024'], ['Mass', '12.5 kg']],
      cells: [
        { row: 0, column: 0, text: 'Item' }, { row: 0, column: 1, text: 'Value' },
        { row: 1, column: 0, text: 'Year' }, { row: 1, column: 1, text: '2024' },
        { row: 2, column: 0, text: 'Mass' }, { row: 2, column: 1, text: '12.5 kg' },
      ],
      warnings: [],
    },
  };

  const hasTable = Object.keys(tableSpecs).length > 0;
  const tableBlockId = Object.keys(tableSpecs)[0];

  // --- 写表 JSON 资产（先写，取得真实哈希用于 IR extensions / table source_hash）---
  const tableHashes: Record<string, string> = {};
  const tableTexts: Record<string, string> = {};
  const parsedTables: Record<string, Record<string, unknown>> = {};
  const tableBBox = { x: 100, y: 100, width: 300, height: 200 };
  for (const [blockId, spec] of Object.entries(tableSpecs)) {
    const text = spec.rows.map((r) => r.map((c) => c || '').join('\t')).join('\n');
    tableTexts[blockId] = text;
    const cells = (spec.cells ?? []).map((c) => ({
      row: c.row, column: c.column, text: c.text,
      location: { kind: 'page_region', page: 1, bbox: tableBBox },
    }));
    const obj: Record<string, unknown> = {
      block_id: blockId, source_hash: hex(PDF_BYTES), status: 'candidate_not_reviewed',
      location: { kind: 'page_region', page: 1, bbox: tableBBox },
      rows: spec.rows, cells, warnings: spec.warnings ?? [],
    };
    opts.mutateTable?.(obj, blockId);
    const bytes = Buffer.from(JSON.stringify(obj));
    tableHashes[blockId] = hex(bytes);
    writeFileSync(join(dir, `tables/${blockId}.json`), bytes);
    parsedTables[blockId] = obj;
  }

  const tablePath = hasTable ? `tables/${tableBlockId}.json` : undefined;
  const tableWarnings = hasTable ? (tableSpecs[tableBlockId].warnings ?? []) : [];

  // --- 区块定义 ---
  const extText = { extraction_method: 'native_text', parser_version: 'pdf-local-0.1.0' };
  const blocks: any[] = [
    {
      blockId: 'b000', index: 0, type: 'paragraph', text: '报告年份 2024，质量 12.5 kg。',
      location: { kind: 'page_region', page: 1, bbox: { x: 50, y: 50, width: 400, height: 20 } },
      extensions: extText,
    },
  ];
  const tableAssetPath = hasTable ? `tables/${tableBlockId}.png` : undefined;
  if (hasTable) {
    const tableExt: Record<string, unknown> = {
      ...extText, table_data_path: tablePath, table_data_hash: tableHashes[tableBlockId],
      table_status: 'candidate_not_reviewed',
    };
    if (!opts.renderFail) {
      tableExt.asset_path = tableAssetPath;
      tableExt.asset_hash = hex(PNG_BYTES);
      tableExt.asset_kind = 'rendered_page_region';
    }
    blocks.push({
      blockId: tableBlockId, index: 1, type: 'table', text: tableTexts[tableBlockId],
      location: { kind: 'page_region', page: 1, bbox: tableBBox },
      extensions: tableExt,
    });
  }
  const imgIndex = blocks.length;
  const imgBlockId = `b${String(imgIndex).padStart(3, '0')}`;
  const imageHasAsset = !opts.renderFail && !opts.noImageAsset;
  blocks.push({
    blockId: imgBlockId, index: imgIndex, type: 'image', text: '',
    location: { kind: 'image_region', page: 1, bbox: { x: 20, y: 300, width: 100, height: 100 } },
    extensions: imageHasAsset
      ? { ...extText, asset_path: `assets/${imgBlockId}.png`, asset_hash: hex(PNG_BYTES), asset_kind: 'rendered_page_region' }
      : { ...extText },
  });

  const unsupported: Array<{ blockId: string; reason: string }> = [
    { blockId: imgBlockId, reason: IMG_REASON },
  ];
  for (const [bid, spec] of Object.entries(tableSpecs)) {
    if ((spec.warnings ?? []).length > 0) unsupported.push({ blockId: bid, reason: spec.warnings!.join('; ') });
  }
  if (opts.renderFail) unsupported.unshift({ blockId: blocks[0].blockId, reason: 'page_render_failed' });

  const ir: any = {
    protocolVersion: '1.0', projectId: 'project_test', documentId: 'doc_test',
    documentVersionId: 'docv_test', version: 1, contentHash: hex(PDF_BYTES),
    mimeType: 'application/pdf', sourceName: 'sample.pdf',
    blocks,
    parseInfo: { parser: 'pdf-local-0.1.0', quality: 'partial', unsupported },
    extensions: { coordinate_system: COORD, inspection_manifest: 'manifest.json' },
  };
  opts.mutateIr?.(ir);

  const counts = { paragraph: 1, table: hasTable ? 1 : 0, image: 1, other: 0 };

  const items = [
    { ...blocks[0], status: 'parsed', asset: null },
    ...(hasTable ? [{ ...blocks[1], status: opts.renderFail ? 'failed' : 'candidate_not_reviewed', asset: opts.renderFail ? null : tableAssetPath, table: parsedTables[tableBlockId] }] : []),
    {
      ...blocks[imgIndex],
      status: imageHasAsset ? 'extracted_not_understood' : 'failed',
      asset: imageHasAsset ? `assets/${imgBlockId}.png` : null,
      image_object: { object_index: 0, image_name: 'Im1', original_size: [10, 10], is_mask: false },
    },
  ];

  const pageIssues = opts.renderFail ? [{ stage: 'render', status: 'failed', code: 'page_render_failed' }] : [];
  const manifest: any = {
    format: 'local_pdf_inspection_v1', parser: 'pdf-local-0.1.0',
    source: { name: 'sample.pdf', sha256: hex(PDF_BYTES), bytes: PDF_BYTES.length, file: 'source.pdf', page_count: 1 },
    document_ir: 'document-ir.json', coordinates: COORD,
    dependencies: { pdf_renderer: 'internal', text_extractor: 'internal' },
    network: 'no_network_required',
    table_settings: { candidate_only: true },
    limitations: ['tables_not_reviewed'],
    pages: [{
      page: 1, width: 595, height: 842, rotation: 0, mediabox: [0, 0, 595, 842], cropbox: null,
      status: opts.renderFail ? 'partial_failure' : 'parsed',
      issues: pageIssues, blocks: items,
      render: opts.renderFail ? null : 'pages/page-001.png',
      ...(opts.renderFail ? {} : { render_sha256: hex(RENDER_BYTES), pixel_size: [595, 842] }),
      counts, table_status: hasTable ? 'candidates_found' : 'no_vector_grid_candidate',
      text_status: 'native_text_extracted',
    }],
    counts, status: opts.renderFail ? 'partial_failure' : 'parsed_with_limitations',
  };
  opts.mutateManifest?.(manifest);

  writeFileSync(join(dir, 'source.pdf'), opts.hugeSource ? Buffer.alloc(PDF_BYTES.length + 1, 1) : PDF_BYTES);
  writeFileSync(join(dir, 'document-ir.json'), JSON.stringify(ir));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  if (!opts.noImageAsset) {
    if (opts.useSymlinkAsset) {
      writeFileSync(join(dir, 'real-asset.bin'), PNG_BYTES);
      symlinkSync(join(dir, 'real-asset.bin'), join(dir, `assets/${imgBlockId}.png`));
    } else {
      writeFileSync(join(dir, `assets/${imgBlockId}.png`), PNG_BYTES);
    }
  }
  if (!opts.renderFail) writeFileSync(join(dir, 'pages/page-001.png'), RENDER_BYTES);
  if (hasTable && !opts.renderFail) writeFileSync(join(dir, `tables/${tableBlockId}.png`), PNG_BYTES);
  if (opts.writeFailure) writeFileSync(join(dir, 'failure.json'), '{}');
  for (const [rel, data] of Object.entries(opts.extraFiles ?? {})) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, typeof data === 'string' ? Buffer.from(data) : data);
  }

  return {
    dir,
    auth: { projectId: 'project_test', documentId: 'doc_test', documentVersionId: 'docv_test', version: 1, contentHash: hex(PDF_BYTES) },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export async function load(dir: string, auth: any, opts?: LoadSourceBundleOptions) {
  return loadSourceBundle(dir, auth, opts);
}

