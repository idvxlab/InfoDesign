import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { loadSourceBundle, getValidatedSourceBundle, type SourceBundle, type LoadSourceBundleOptions } from '../../apps/server/src/domain/source-bundle.ts';

const hex = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const bare = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// 极小合成不透明字节：不是真实 PDF/PNG，只用于字节哈希完整性。
const PDF_BYTES = Buffer.from('%PDF-FAKE-SYNTHETIC-BYTES-0123456789');
const PNG_BYTES = Buffer.from('\x89PNG-FAKE-SYNTHETIC-IMAGE');
const RENDER_BYTES = Buffer.from('RENDER-FAKE-SYNTHETIC-PAGE');

const COORD = 'physical_page_1_based; rotated_mediabox; top_left; points_1_72_inch';
const IMG_REASON = 'image_region_only; OCR and image semantics not run';

interface TableSpec {
  rows: Array<Array<string | null>>;
  cells?: Array<{ row: number; column: number; text: string | null }>;
  warnings?: string[];
}
interface FixtureOpts {
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

interface Fixture {
  dir: string;
  auth: { projectId: string; documentId: string; documentVersionId: string; version: number; contentHash: string };
  cleanup: () => void;
}

function buildFixture(opts: FixtureOpts = {}): Fixture {
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

async function load(dir: string, auth: any, opts?: LoadSourceBundleOptions) {
  return loadSourceBundle(dir, auth, opts);
}

function expectError(res: Awaited<ReturnType<typeof loadSourceBundle>>, code: string) {
  assert.equal(res.ok, false, `expected error ${code}`);
  if (!res.ok) assert.equal(res.error.code, code);
  // 稳定错误码必须无原始内容/主机路径泄漏
  if (!res.ok && res.error.path) assert.ok(!res.error.path.includes('/'), 'path must be structured');
}

/** 断言失败并校验结构化路径（前缀匹配），不捕获断言失败。 */
function expectErrorAt(res: Awaited<ReturnType<typeof loadSourceBundle>>, code: string, pathPrefix: string) {
  assert.equal(res.ok, false, `expected error ${code} at ${pathPrefix}`);
  if (res.ok) return;
  assert.equal(res.error.code, code);
  assert.ok(res.error.path?.startsWith(pathPrefix), `expected path ${pathPrefix}, got ${res.error.path}`);
}

async function loadOk(f: Fixture) {
  const res = await load(f.dir, f.auth);
  assert.equal(res.ok, true, `expected ok, got ${!res.ok ? res.error.code : ''}`);
  if (!res.ok) throw new Error('unreachable');
  return res.bundle;
}

// ---------------------------------------------------------------------------

test('positive: text+table+empty image bundle with preserved raw units', async () => {
  const f = buildFixture({ tables: { b001: { rows: [['Year', '2024'], ['Mass', '12.5 kg']], cells: [{ row: 0, column: 0, text: 'Year' }, { row: 0, column: 1, text: '2024' }, { row: 1, column: 0, text: 'Mass' }, { row: 1, column: 1, text: '12.5 kg' }] } } });
  try {
    const res = await load(f.dir, f.auth);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const b = res.bundle;
    assert.equal(b.blocks[0].text, '报告年份 2024，质量 12.5 kg。');
    assert.equal(b.tables.length, 1);
    assert.equal(b.tables[0].rows[1][1], '12.5 kg');
    assert.equal(b.tables[0].status, 'candidate_not_reviewed');
    assert.equal(b.blocks[2].type, 'image');
    assert.equal(b.blocks[2].text, '');
    assert.equal(b.blocks[2].status, 'extracted_not_understood');
    assert.equal(b.refs.length, b.blocks.length);
    assert.equal(b.pages[0].render?.path, 'pages/page-001.png');
    assert.equal(b.counts.table, 1);
    assert.ok(b.unsupported.some((u) => u.blockId === 'b002' && u.reason === IMG_REASON));
    assert.ok(b.limitations.includes('tables_not_reviewed'));
    assert.equal(b.coordinateSystem, COORD);
    assert.equal(typeof b.sourcePath, 'string');
  } finally { f.cleanup(); }
});

test('positive: null cell, explicit render/crop failure retained', async () => {
  const f = buildFixture({
    renderFail: true,
    tables: { b001: { rows: [['A', null], ['B', 'x']], cells: [{ row: 0, column: 0, text: 'A' }, { row: 0, column: 1, text: null }, { row: 1, column: 0, text: 'B' }, { row: 1, column: 1, text: 'x' }], warnings: ['merged cell detected'] } },
  });
  try {
    const res = await load(f.dir, f.auth);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.bundle.tables[0].rows[0][1], null);
    assert.equal(res.bundle.blocks[0].status, 'parsed');
    assert.equal(res.bundle.pages[0].render, null);
    assert.equal(res.bundle.pages[0].status, 'partial_failure');
    assert.equal(res.bundle.manifestStatus, 'partial_failure');
    assert.deepEqual(res.bundle.tables[0].warnings, ['merged cell detected']);
    assert.ok(res.bundle.unsupported.some((u) => u.reason.includes('merged cell detected')));
    assert.equal(res.bundle.pages[0].issues[0].code, 'page_render_failed');
  } finally { f.cleanup(); }
});

test('no input mutation: bundle rebuilds identically after load', async () => {
  const f = buildFixture();
  try {
    const r1 = await load(f.dir, f.auth);
    const r2 = await load(f.dir, f.auth);
    assert.equal(r1.ok && r2.ok, true);
    if (r1.ok && r2.ok) assert.deepEqual(r1.bundle.blocks, r2.bundle.blocks);
  } finally { f.cleanup(); }
});

// ---------------------------------------------------------------------------
// 安全读取：固定文件符号链接绕过 / 失败标记 / 字节篡改 / 上限
// ---------------------------------------------------------------------------

for (const fixed of ['source.pdf', 'document-ir.json', 'manifest.json']) {
  test(`symlink bypass rejected for fixed file ${fixed}`, async () => {
    const f = buildFixture();
    try {
      renameSync(join(f.dir, fixed), join(f.dir, `real-${fixed}`));
      symlinkSync(join(f.dir, `real-${fixed}`), join(f.dir, fixed));
      expectError(await load(f.dir, f.auth), 'artifact_path_unsafe');
    } finally { f.cleanup(); }
  });
}

test('failure marker present', async () => {
  const f = buildFixture({ writeFailure: true });
  try {
    expectError(await load(f.dir, f.auth), 'failure_marker_present');
  } finally { f.cleanup(); }
});

test('tampered source bytes rejected as hash_mismatch', async () => {
  const f = buildFixture();
  try {
    writeFileSync(join(f.dir, 'source.pdf'), Buffer.alloc(PDF_BYTES.length, 7));
    expectError(await load(f.dir, f.auth), 'hash_mismatch');
  } finally { f.cleanup(); }
});

test('lowered json limit rejected', async () => {
  const f = buildFixture();
  try {
    expectError(await load(f.dir, f.auth, { limits: { json: 8 } }), 'size_limit_exceeded');
  } finally { f.cleanup(); }
});

test('lowered source limit rejected', async () => {
  const f = buildFixture();
  try {
    expectError(await load(f.dir, f.auth, { limits: { source: PDF_BYTES.length - 1 } }), 'size_limit_exceeded');
  } finally { f.cleanup(); }
});

test('lowered total limit rejected', async () => {
  const f = buildFixture();
  try {
    expectError(await load(f.dir, f.auth, { limits: { total: 8 } }), 'size_limit_exceeded');
  } finally { f.cleanup(); }
});

test('identity: each trusted auth identity field mismatch yields identity_mismatch', async () => {
  const f = buildFixture();
  try {
    const cases: any[] = [
      { ...f.auth, projectId: 'project_other' },
      { ...f.auth, documentId: 'doc_other' },
      { ...f.auth, documentVersionId: 'docv_other' },
      { ...f.auth, version: f.auth.version + 1 },
      { ...f.auth, contentHash: hex(Buffer.from('other-fake-bytes')) },
    ];
    for (const auth of cases) {
      expectError(await load(f.dir, auth), 'identity_mismatch');
    }
  } finally { f.cleanup(); }
});

test('ir metadata: wrong mimeType/parser/coordinate_system -> schema_invalid', async () => {
  const fm = buildFixture({ mutateIr: (ir) => { ir.mimeType = 'text/plain'; } });
  try { expectError(await load(fm.dir, fm.auth), 'schema_invalid'); } finally { fm.cleanup(); }

  const fp = buildFixture({
    mutateIr: (ir) => { ir.parseInfo.parser = 'pdf-local-9.9.9'; },
    mutateManifest: (m) => { m.parser = 'pdf-local-9.9.9'; },
  });
  try { expectError(await load(fp.dir, fp.auth), 'schema_invalid'); } finally { fp.cleanup(); }

  const fc = buildFixture({
    mutateIr: (ir) => { ir.extensions.coordinate_system = 'other_system'; },
    mutateManifest: (m) => { m.coordinates = 'other_system'; },
  });
  try { expectError(await load(fc.dir, fc.auth), 'schema_invalid'); } finally { fc.cleanup(); }
});

test('limits: 5001 ir blocks -> size_limit_exceeded', async () => {
  const f = buildFixture({ mutateIr: (ir) => { const b = ir.blocks[0]; ir.blocks = Array.from({ length: 5001 }, () => structuredClone(b)); } });
  try { expectError(await load(f.dir, f.auth), 'size_limit_exceeded'); } finally { f.cleanup(); }
});

test('limits: 41 manifest pages -> size_limit_exceeded', async () => {
  const f = buildFixture({ mutateManifest: (m) => { const p = m.pages[0]; m.pages = Array.from({ length: 41 }, () => structuredClone(p)); } });
  try { expectError(await load(f.dir, f.auth), 'size_limit_exceeded'); } finally { f.cleanup(); }
});

// ---------------------------------------------------------------------------
// 已验证快照 capability：getValidatedSourceBundle
// ---------------------------------------------------------------------------

test('capability: original accepted; structural clone/forged/mutated rejected', async () => {
  const f = buildFixture();
  try {
    const b = await loadOk(f);
    const snap = getValidatedSourceBundle(b);
    assert.notStrictEqual(snap, b);
    assert.deepEqual(snap.blocks, b.blocks);

    snap.blocks[0].text = 'TAMPERED';
    snap.counts.paragraph = 999;
    const snap2 = getValidatedSourceBundle(b);
    assert.notEqual(snap2.blocks[0].text, 'TAMPERED');
    assert.equal(snap2.counts.paragraph, b.counts.paragraph);

    assert.throws(() => getValidatedSourceBundle(structuredClone(b)), /invalid_source_bundle/);
    assert.throws(() => getValidatedSourceBundle({ ...b } as SourceBundle), /invalid_source_bundle/);
    b.blocks[0].text = 'MUTATED-AFTER-LOAD';
    assert.throws(() => getValidatedSourceBundle(b), /invalid_source_bundle/);
  } finally { f.cleanup(); }
});

test('capability: cyclic structure rejected without crashing', () => {
  const cyclic: any = { projectId: 'p' };
  cyclic.self = cyclic;
  assert.throws(() => getValidatedSourceBundle(cyclic), /invalid_source_bundle/);
});

test('capability: registered bundle mutated into a cycle rejected', async () => {
  const f = buildFixture();
  try {
    const b = await loadOk(f);
    assert.ok(b.blocks.length > 0);
    (b as any).self = b as any;
    assert.throws(() => getValidatedSourceBundle(b), /invalid_source_bundle/);
  } finally { f.cleanup(); }
});

// ---------------------------------------------------------------------------
// 语义/结构行为
// ---------------------------------------------------------------------------

test('key-order-independent equality succeeds; document detached; image not_run; table crop ref', async () => {
  const f = buildFixture({
    mutateManifest: (m) => {
      const loc = m.pages[0].blocks[0].location;
      m.pages[0].blocks[0].location = { bbox: loc.bbox, page: loc.page, kind: loc.kind };
    },
  });
  try {
    const b = await loadOk(f);
    const again = await loadOk(f);
    assert.notStrictEqual(b.document, again.document);
    assert.deepEqual(b.document, again.document);

    const img = b.blocks.find((x) => x.type === 'image')!;
    assert.equal(img.semanticStatus, 'not_run');
    assert.equal(img.asset?.assetKind, 'rendered_page_region');

    const tbl = b.blocks.find((x) => x.type === 'table')!;
    assert.equal(tbl.asset?.assetKind, 'rendered_page_region');
    assert.match(tbl.tablePath ?? '', /^tables\//);
    assert.equal(b.tables[0].tablePath, tbl.tablePath);
    assert.equal(b.tables[0].status, 'candidate_not_reviewed');
  } finally { f.cleanup(); }
});

test('page ownership / wrong location kind / image text rejected', async () => {
  const fm = buildFixture({ mutateIr: (ir) => { ir.blocks[1].location = { kind: 'page_region', page: 2, bbox: { x: 100, y: 100, width: 300, height: 200 } }; } });
  try { expectErrorAt(await load(fm.dir, fm.auth), 'block_mismatch', 'ir.blocks[1].location'); } finally { fm.cleanup(); }

  const fk = buildFixture({ mutateIr: (ir) => { ir.blocks[0].location = { kind: 'image_region', page: 1, bbox: { x: 50, y: 50, width: 400, height: 20 } }; } });
  try { expectErrorAt(await load(fk.dir, fk.auth), 'block_mismatch', 'manifest.pages[0].blocks[0].location.kind'); } finally { fk.cleanup(); }

  const ft = buildFixture({ mutateIr: (ir) => { ir.blocks[2].text = 'not-empty-image-text'; } });
  try { expectErrorAt(await load(ft.dir, ft.auth), 'block_mismatch', 'manifest.pages[0].blocks[2]'); } finally { ft.cleanup(); }
});

// ---------------------------------------------------------------------------
// 表格 JSON 语义交叉校验
// ---------------------------------------------------------------------------

const T1: TableSpec = { rows: [['A', 'B']], cells: [{ row: 0, column: 0, text: 'A' }, { row: 0, column: 1, text: 'B' }] };

test('table JSON source_hash mismatch isolates semantic crosscheck', async () => {
  const f = buildFixture({ tables: { b001: T1 }, mutateTable: (obj) => { obj.source_hash = hex(Buffer.from('not-the-source')); } });
  try { expectErrorAt(await load(f.dir, f.auth), 'table_invalid', 'manifest.pages[0].blocks[1].table.source_hash'); } finally { f.cleanup(); }
});

test('table JSON location mismatch isolates semantic crosscheck', async () => {
  const f = buildFixture({ tables: { b001: T1 }, mutateTable: (obj) => { (obj.location as any).bbox = { x: 1, y: 1, width: 10, height: 10 }; } });
  try { expectErrorAt(await load(f.dir, f.auth), 'table_invalid', 'manifest.pages[0].blocks[1].table.location'); } finally { f.cleanup(); }
});

test('table cell consistency (cells text vs rows) isolates semantic crosscheck', async () => {
  const f = buildFixture({ tables: { b001: T1 }, mutateTable: (obj) => { (obj.cells as any)[0].text = 'ZZZ'; } });
  try { expectErrorAt(await load(f.dir, f.auth), 'table_invalid', 'manifest.pages[0].blocks[1].table'); } finally { f.cleanup(); }
});

test('table inline mismatch (manifest rows vs table file) isolates semantic crosscheck', async () => {
  const f = buildFixture({
    tables: { b001: T1 },
    mutateManifest: (m) => {
      const tbl = m.pages[0].blocks[1].table as any;
      const clone = structuredClone(tbl);
      clone.rows = [['A', 'Z']];
      m.pages[0].blocks[1].table = clone;
    },
  });
  try { expectErrorAt(await load(f.dir, f.auth), 'table_invalid', 'manifest.pages[0].blocks[1].table'); } finally { f.cleanup(); }
});

test('raw cells retained; null merged cell needs no geometry; warnings kept', async () => {
  const f = buildFixture({
    tables: { b001: { rows: [['A', null], ['B', 'x']], cells: [{ row: 0, column: 0, text: 'A' }, { row: 1, column: 0, text: 'B' }, { row: 1, column: 1, text: 'x' }], warnings: ['merged cell detected'] } },
  });
  try {
    const b = await loadOk(f);
    assert.equal(b.tables[0].rows[0][1], null);
    assert.equal(b.tables[0].rows[1][1], 'x');
    assert.equal(b.tables[0].cells.length, 3);
    assert.ok(b.tables[0].warnings.includes('merged cell detected'));
  } finally { f.cleanup(); }
});

// ---------------------------------------------------------------------------
// 表警告边界匹配
// ---------------------------------------------------------------------------

const WARN_COMPOUND = 'merged cell detected; inconsistent column count';
const WARN_LAST = 'inconsistent column count';

test('table warnings: exact compound warning accepted', async () => {
  const f = buildFixture({ tables: { b001: { ...T1, warnings: [WARN_COMPOUND] } } });
  try { assert.deepEqual((await loadOk(f)).tables[0].warnings, [WARN_COMPOUND]); } finally { f.cleanup(); }
});

test('table warnings: complete segment match accepted', async () => {
  const f = buildFixture({ tables: { b001: { ...T1, warnings: [WARN_COMPOUND, WARN_LAST] } } });
  try { assert.deepEqual((await loadOk(f)).tables[0].warnings, [WARN_COMPOUND, WARN_LAST]); } finally { f.cleanup(); }
});

test('table warnings: suffix/prefix tampering rejected (no substring match)', async () => {
  const fsuf = buildFixture({
    tables: { b001: { ...T1, warnings: [WARN_LAST] } },
    mutateIr: (ir) => { const u = ir.parseInfo.unsupported.find((x: any) => x.blockId === 'b001'); u.reason = `${WARN_LAST} extra`; },
  });
  try { expectErrorAt(await load(fsuf.dir, fsuf.auth), 'table_invalid', 'manifest.pages[0].blocks[1].warnings'); } finally { fsuf.cleanup(); }

  const fpre = buildFixture({
    tables: { b001: { ...T1, warnings: [WARN_LAST] } },
    mutateIr: (ir) => { const u = ir.parseInfo.unsupported.find((x: any) => x.blockId === 'b001'); u.reason = `extra ${WARN_LAST}`; },
  });
  try { expectErrorAt(await load(fpre.dir, fpre.auth), 'table_invalid', 'manifest.pages[0].blocks[1].warnings'); } finally { fpre.cleanup(); }
});

test('table warnings: fake longer segment rejected', async () => {
  const fake = buildFixture({
    tables: { b001: { ...T1, warnings: [WARN_LAST] } },
    mutateIr: (ir) => { const u = ir.parseInfo.unsupported.find((x: any) => x.blockId === 'b001'); u.reason = 'inconsistent column count xyz'; },
  });
  try { expectErrorAt(await load(fake.dir, fake.auth), 'table_invalid', 'manifest.pages[0].blocks[1].warnings'); } finally { fake.cleanup(); }
});
// --- 参数化：缺失覆盖 A) 表裁剪资产篡改 / 路径 / 种类 / 逃逸 ---
test('A table crop asset: tamper/hash/path/kind/escape', async () => {
  // 篡改裁剪字节 -> hash_mismatch
  {
    const f = buildFixture();
    try {
      writeFileSync(join(f.dir, 'tables/b001.png'), Buffer.from('TAMPERED-CROP-BYTES'));
      expectErrorAt(await load(f.dir, f.auth), 'hash_mismatch', 'manifest.pages[0].blocks[1].asset');
    } finally { f.cleanup(); }
  }
  // 删除 ext.asset_hash -> hash_mismatch
  {
    const f = buildFixture({ mutateIr: (ir) => { delete ir.blocks[1].extensions.asset_hash; } });
    try { expectErrorAt(await load(f.dir, f.auth), 'hash_mismatch', 'manifest.pages[0].blocks[1].asset'); } finally { f.cleanup(); }
  }
  // asset_path 与 item.asset 不一致 -> invalid_source_bundle
  {
    const f = buildFixture({ mutateIr: (ir) => { ir.blocks[1].extensions.asset_path = 'tables/other.png'; } });
    try { expectErrorAt(await load(f.dir, f.auth), 'invalid_source_bundle', 'manifest.pages[0].blocks[1].asset_path'); } finally { f.cleanup(); }
  }
  // 错误的 asset_kind -> invalid_source_bundle
  {
    const f = buildFixture({ mutateIr: (ir) => { ir.blocks[1].extensions.asset_kind = 'original_image'; } });
    try { expectErrorAt(await load(f.dir, f.auth), 'invalid_source_bundle', 'manifest.pages[0].blocks[1].asset_kind'); } finally { f.cleanup(); }
  }
  // item.asset 逃逸目录 -> artifact_path_unsafe
  {
    const f = buildFixture({ mutateManifest: (m) => { m.pages[0].blocks[1].asset = '../escape.png'; } });
    try { expectErrorAt(await load(f.dir, f.auth), 'artifact_path_unsafe', 'manifest.pages[0].blocks[1].asset'); } finally { f.cleanup(); }
  }
});

// --- 参数化：缺失覆盖 B) 页面渲染 sha/pixel 缺失、像素上限、render null 声明 ---
test('B render: sha/pixel missing, pixel bounds, declared-null render', async () => {
  // 删除 render_sha256（render 存在）-> manifest_invalid
  {
    const f = buildFixture({ mutateManifest: (m) => { delete m.pages[0].render_sha256; } });
    try { expectErrorAt(await load(f.dir, f.auth), 'manifest_invalid', 'manifest.pages[0].render_sha256'); } finally { f.cleanup(); }
  }
  // render_sha256:null -> manifest_invalid（null 是"已声明但缺失"）
  {
    const f = buildFixture({ mutateManifest: (m) => { m.pages[0].render_sha256 = null; } });
    try { expectErrorAt(await load(f.dir, f.auth), 'manifest_invalid', 'manifest.pages[0].render_sha256'); } finally { f.cleanup(); }
  }
  // pixel_size 越界/非整数 -> manifest_invalid
  for (const px of [[0, 842], [595.5, 842], [2401, 842]]) {
    const f = buildFixture({ mutateManifest: (m) => { m.pages[0].pixel_size = px; } });
    try { expectErrorAt(await load(f.dir, f.auth), 'manifest_invalid', 'manifest.pages[0].pixel_size'); } finally { f.cleanup(); }
  }
  // renderFail 下 render 缺失但声明 render_sha256:null -> manifest_invalid
  {
    const f = buildFixture({ renderFail: true, mutateManifest: (m) => { m.pages[0].render_sha256 = null; } });
    try { expectErrorAt(await load(f.dir, f.auth), 'manifest_invalid', 'manifest.pages[0].render'); } finally { f.cleanup(); }
  }
  // renderFail 下 pixel_size:null -> manifest_invalid
  {
    const f = buildFixture({ renderFail: true, mutateManifest: (m) => { m.pages[0].pixel_size = null; } });
    try { expectErrorAt(await load(f.dir, f.auth), 'manifest_invalid', 'manifest.pages[0].render'); } finally { f.cleanup(); }
  }
});

// --- 参数化：缺失覆盖 C) failed 区块扩展字段 null、noImageAsset reason 精确匹配 ---
test('C failed block extensions null; unsupported reason exact region_render_failed', async () => {
  // 段落（非图/表失败不允许 asset 变体）—— 改用 image 失败区块扩展字段设 null
  for (const field of ['asset_path', 'asset_hash', 'asset_kind']) {
    const f = buildFixture({
      renderFail: true,
      mutateIr: (ir) => {
        const img = ir.blocks.find((b: any) => b.type === 'image');
        img.extensions[field] = null;
      },
    });
    try { expectErrorAt(await load(f.dir, f.auth), 'invalid_source_bundle', `manifest.pages[0].blocks[2].${field}`); } finally { f.cleanup(); }
  }
  // noImageAsset: image 无资产 + unsupported.reason 恰为 region_render_failed -> 成功
  {
    const f = buildFixture({
      noImageAsset: true,
      mutateIr: (ir) => {
        const u = ir.parseInfo.unsupported.find((x: any) => x.blockId === 'b002');
        u.reason = 'region_render_failed';
      },
      mutateManifest: (m) => { m.pages[0].blocks[2].status = 'failed'; },
    });
    try { await loadOk(f); } finally { f.cleanup(); }
  }
  // fake_region_render_failed_suffix 非精确片段 -> invalid_source_bundle
  {
    const f = buildFixture({
      noImageAsset: true,
      mutateIr: (ir) => {
        const u = ir.parseInfo.unsupported.find((x: any) => x.blockId === 'b002');
        u.reason = 'fake_region_render_failed_suffix';
      },
      mutateManifest: (m) => { m.pages[0].blocks[2].status = 'failed'; },
    });
    try { expectErrorAt(await load(f.dir, f.auth), 'invalid_source_bundle', 'manifest.pages[0].blocks[2].status'); } finally { f.cleanup(); }
  }
});

// --- 参数化：缺失覆盖 D) manifest.status 一致性、issues 首个区块 reason、未知 unsupported blockId ---
test('D manifest status consistency and unsupported block references', async () => {
  // status partial_failure 但无页级 issue -> manifest_invalid
  {
    const f = buildFixture({ mutateManifest: (m) => { m.status = 'partial_failure'; } });
    try { expectErrorAt(await load(f.dir, f.auth), 'manifest_invalid', 'manifest.status'); } finally { f.cleanup(); }
  }
  // parsed_with_limitations 但 renderFail:true（页有 issue）-> manifest_invalid
  {
    const f = buildFixture({ renderFail: true, mutateManifest: (m) => { m.status = 'parsed_with_limitations'; } });
    try { expectErrorAt(await load(f.dir, f.auth), 'manifest_invalid', 'manifest.status'); } finally { f.cleanup(); }
  }
  // renderFail: 首个区块丢失 page_render_failed reason -> manifest_invalid
  {
    const f = buildFixture({
      renderFail: true,
      mutateIr: (ir) => { ir.parseInfo.unsupported = ir.parseInfo.unsupported.filter((u: any) => u.blockId !== 'b000'); },
    });
    try { expectErrorAt(await load(f.dir, f.auth), 'manifest_invalid', 'manifest.pages[0].issues.unsupported'); } finally { f.cleanup(); }
  }
  // 未知 unsupported blockId -> block_mismatch
  {
    const f = buildFixture({ mutateIr: (ir) => { ir.parseInfo.unsupported.push({ blockId: 'b999', reason: 'x' }); } });
    try { expectErrorAt(await load(f.dir, f.auth), 'block_mismatch', 'parseInfo.unsupported'); } finally { f.cleanup(); }
  }
  // 变异辅助不得破坏正常夹具
  {
    const f = buildFixture({ mutateManifest: (m) => { m.limitations = m.limitations.slice(); }, mutateIr: (ir) => { ir.blocks.slice(); } });
    try { await loadOk(f); } finally { f.cleanup(); }
  }
});
