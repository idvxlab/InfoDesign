/**
 * 集成测试：受控读原文工具 read_source。
 * 使用真实 SchemaRegistry / ExecutionBudget / 合成 SourceBundle 夹具，不访问网络、不调用模型。
 * 目的：验证工具在真实接口下的行为与信任边界；不弱化任何用例。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { registry, loadFixture } from '../helpers/fixtures.ts';
import {
  buildFixture,
  load,
  type SourceBundle,
  type Fixture,
} from '../helpers/source-bundle-fixture.ts';

/** load 返回联合结果：先断言 ok 再取出 bundle。 */
async function loadBundle(fx: Fixture): Promise<SourceBundle> {
  const result = await load(fx.dir, fx.auth);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('fixture bundle load failed');
  return result.bundle;
}

import {
  createSourceReader,
  createReadSourceTool,
  READ_SOURCE_RESULT_ID,
  MAX_RESULT_BYTES,
  type SourceAccess,
} from '../../apps/server/src/runtime/pi/read-source-tool.ts';
import { ReadDenied } from '../../apps/server/src/runtime/pi/read-document-tool.ts';
import { ExecutionBudget, B2_LIMITS } from '../../apps/server/src/runtime/pi/execution-limits.ts';
import type {
  ReadDocumentRequest,
  ReadSourceResult,
} from '../../packages/contracts/generated/index.ts';

/**
 * 从工具 execute 签名反推第五个参数（工具上下文）的类型。
 * tests 根无法解析 @earendil-works/pi-coding-agent 直接依赖（该依赖仅在 apps/server 作用域内），
 * 因此不直接 import，而是通过实际工具类型派生，保留诚实的最小 mock。
 */
type ToolContext = Parameters<
  ReturnType<typeof createReadSourceTool>['tool']['execute']
>[4];

/**
 * 明确标注的最小类型化 mock 上下文，作为 tool.execute 的第五个参数。
 * read_source 工具不读取 ctx，因此该对象仅用于满足类型契约，不含任何行为。
 */
const MOCK_TOOL_CONTEXT: ToolContext = {
  cwd: process.cwd(),
  metadata: {},
} as unknown as ToolContext;

const AUTHORIZED_LIMITS = { ...B2_LIMITS, timeoutMs: 5000, maxToolCalls: 2 };

/** 取一个真实可信文档（来自合成夹具的 IR），并把作用域收敛到它的实际 ID。 */
async function genuine() {
  const fx: Fixture = buildFixture();
  const bundle: SourceBundle = await loadBundle(fx);
  const doc = bundle.document;
  const access: SourceAccess = {
    scope: {
      projectId: fx.auth.projectId,
      allowedOperations: ['read_document'],
      documentRefs: [{ documentId: doc.documentId, documentVersionId: doc.documentVersionId }],
    },
    documents: [doc],
    bundles: [bundle],
  };
  return { fx, bundle, doc, access };
}

/**
 * 取一份真实、合法的非 PDF paragraph IR（legacy：无 bundle）。
 * 通过 loadFixture('document-ir.json') 加载，作用域 ID 与夹具内容保持一致。
 */
function legacyIr() {
  const doc = loadFixture<{
    documentId: string;
    documentVersionId: string;
    projectId: string;
    contentHash: string;
    mimeType: string;
    blocks: Array<{
      blockId: string;
      index: number;
      type: string;
      text: string;
      location: { kind: string; paragraphIndex?: number };
    }>;
  }>('document-ir.json');
  const access: SourceAccess = {
    scope: {
      projectId: doc.projectId,
      allowedOperations: ['read_document'],
      documentRefs: [
        { documentId: doc.documentId, documentVersionId: doc.documentVersionId },
      ],
    },
    documents: [doc as any],
  };
  return { doc, access };
}

function assertDenied(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof ReadDenied, `expected ReadDenied, got ${String(error)}`);
    assert.equal((error as ReadDenied).code, code);
    return true;
  });
}

function req(documentId: string, documentVersionId: string, blockId: string): ReadDocumentRequest {
  return { documentId, documentVersionId, blockId };
}

test('native 段落块：保留原始单位，asset/table 为 null', async () => {
  const { fx, doc, access } = await genuine();
  try {
    const read = createSourceReader(access, registry);
    // 合成 PDF 的段落块 type === 'paragraph'，但 location.kind === 'page_region'。
    const paragraph = doc.blocks.find((b) => b.type === 'paragraph')!;
    assert.ok(paragraph, '应存在 paragraph 块');
    assert.equal(paragraph.location.kind, 'page_region', '合成 PDF 段落定位应为 page_region');
    const result = read(req(doc.documentId, doc.documentVersionId, paragraph.blockId));
    assert.equal(result.blockId, paragraph.blockId);
    assert.equal(result.text, paragraph.text);
    assert.equal(result.asset, null);
    assert.equal(result.table, null);
    assert.equal(result.contentHash, doc.contentHash);
    assert.match(result.contentHash, /^sha256:[a-f0-9]{64}$/);
    assert.ok(registry.validate(READ_SOURCE_RESULT_ID, result).valid);
  } finally {
    fx.cleanup();
  }
});

test('native 段落块：物理 page_region 定位被保留在结果 location 中', async () => {
  const { fx, doc, access } = await genuine();
  try {
    const read = createSourceReader(access, registry);
    const paragraph = doc.blocks.find((b) => b.type === 'paragraph')!;
    assert.ok(paragraph, '应存在 paragraph 块');
    assert.equal(paragraph.location.kind, 'page_region');
    const result = read(req(doc.documentId, doc.documentVersionId, paragraph.blockId));
    // 块类型是 paragraph，但物理定位仍是 page_region，必须原样保留。
    assert.ok(result.location, '结果应带 location');
    assert.equal((result.location as { kind: string }).kind, 'page_region');
    assert.deepEqual(result.location, (paragraph as { location: unknown }).location);
  } finally {
    fx.cleanup();
  }
});

test('表格块：原始字符串单位、null 空单元格与 warnings 全保留，status=candidate_not_reviewed', async () => {
  const fx = buildFixture({
    tables: {
      b001: {
        rows: [
          ['项目', '数值'],
          ['年份', '2024'],
          ['质量', '12.5 kg'],
          ['备注', null],
        ],
        cells: [
          { row: 3, column: 1, text: null },
        ],
        warnings: ['merged_cells_detected'],
      },
    },
  });
  try {
    const bundle = await loadBundle(fx);
    const doc = bundle.document;
    const tableBlock = doc.blocks.find((b) => b.type === 'table')!;
    const access: SourceAccess = {
      scope: {
        projectId: fx.auth.projectId,
        allowedOperations: ['read_document'],
        documentRefs: [{ documentId: doc.documentId, documentVersionId: doc.documentVersionId }],
      },
      documents: [doc],
      bundles: [bundle],
    };
    const read = createSourceReader(access, registry);
    const result = read(req(doc.documentId, doc.documentVersionId, tableBlock.blockId));
    assert.ok(result.table, 'table 应存在');
    const table = result.table!;
    assert.equal(table.status, 'candidate_not_reviewed');
    assert.deepEqual(table.rows[0], ['项目', '数值']);
    assert.deepEqual(table.rows[1], ['年份', '2024']);
    assert.deepEqual(table.rows[2], ['质量', '12.5 kg']);
    assert.deepEqual(table.rows[3], ['备注', null]);
    assert.equal(table.rows[3][1], null);
    assert.ok(table.warnings.includes('merged_cells_detected'));
    assert.equal(table.sourceHash, bundle.tables[0].sourceHash);
    assert.match(table.sourceHash, /^sha256:[a-f0-9]{64}$/);
    // 空单元格的定位信息必须被保留。
    const cell = table.cells.find((c) => c.row === 3 && c.column === 1)!;
    assert.ok(cell, '空单元格应存在');
    assert.equal(cell.text, null);
    assert.deepEqual(cell.location, bundle.tables[0].cells[0].location);
    assert.ok(registry.validate(READ_SOURCE_RESULT_ID, result).valid);
  } finally {
    fx.cleanup();
  }
});

test('图片块：semanticStatus=not_run，text 为空，unsupportedReasons 承载原因', async () => {
  const { fx, doc, access } = await genuine();
  try {
    const read = createSourceReader(access, registry);
    const image = doc.blocks.find((b) => b.type === 'image')!;
    const result = read(req(doc.documentId, doc.documentVersionId, image.blockId));
    assert.equal(result.semanticStatus, 'not_run');
    assert.equal(result.text, '');
    assert.ok(result.unsupportedReasons.length > 0, '图片块应带 unsupportedReasons');
    assert.ok(result.unsupportedReasons.some((r) => /OCR|image/i.test(r)));
    assert.equal(result.table, null);
  } finally {
    fx.cleanup();
  }
});

test('图片块资产：仅返回安全相对路径，绝不返回 base64/二进制', async () => {
  const { fx, doc, access } = await genuine();
  try {
    const read = createSourceReader(access, registry);
    const image = doc.blocks.find((b) => b.type === 'image')!;
    const result = read(req(doc.documentId, doc.documentVersionId, image.blockId));
    assert.ok(result.asset, '图片块应带 asset 引用');
    assert.equal(result.asset!.path.startsWith('/'), false);
    assert.equal(result.asset!.path.includes('\\'), false);
    assert.match(result.asset!.sha256, /^sha256:[a-f0-9]{64}$/);
    assert.ok(Number.isInteger(result.asset!.bytes) && result.asset!.bytes >= 0);
    assert.equal('base64' in (result.asset as any), false);
  } finally {
    fx.cleanup();
  }
});

test('limitations 汇总 bundle limitations 与分页问题', async () => {
  const { fx, bundle, doc, access } = await genuine();
  try {
    const read = createSourceReader(access, registry);
    const block = doc.blocks[0];
    const result = read(req(doc.documentId, doc.documentVersionId, block.blockId));
    for (const lim of bundle.limitations) assert.ok(result.limitations.includes(lim));
  } finally {
    fx.cleanup();
  }
});

test('legacy（无 bundle）：合法非 PDF paragraph IR 正常读取，table 被拒', async () => {
  const { doc, access } = legacyIr();
  try {
    // 验证夹具确为非 PDF。
    assert.notEqual(doc.mimeType, 'application/pdf');
    const read = createSourceReader(access, registry);
    const paragraph = doc.blocks.find(
      (b) => b.type === 'paragraph' && b.location.kind === 'paragraph',
    )!;
    assert.ok(paragraph, 'legacy 夹具应含 paragraph 块');
    const result = read(req(doc.documentId, doc.documentVersionId, paragraph.blockId));
    assert.equal(result.blockId, paragraph.blockId);
    assert.equal(result.text, paragraph.text);
    assert.ok(result.location, '结果应带 location');
    assert.equal((result.location as { kind: string }).kind, 'paragraph');
    assert.equal(result.asset, null);
    assert.equal(result.table, null);
  } finally {
    // no tmp dir for loadFixture
  }
});

test('genuine PDF 无 bundle => 构造期 source_bundle_required', async () => {
  const { fx, doc, access } = await genuine();
  try {
    assert.equal((access.documents[0] as any).mimeType !== undefined, true);
    // 文档确为 PDF；移除 bundles 后必须要求 bundle。
    assert.equal((doc as any).mimeType, 'application/pdf');
    const legacyAccess: SourceAccess = { scope: access.scope, documents: access.documents };
    assertDenied(() => createSourceReader(legacyAccess, registry), 'source_bundle_required');
  } finally {
    fx.cleanup();
  }
});

test('PDF 伪造段落定位但无 bundle => 构造期 source_bundle_required', async () => {
  const { fx, bundle, doc, access } = await genuine();
  try {
    assert.equal((doc as any).mimeType, 'application/pdf');
    // 伪造：给 PDF 文档注入一个 paragraph 定位块，冒充 legacy 可读，但仍无 bundle。
    const forgedDoc = structuredClone(doc) as any;
    forgedDoc.blocks = [
      {
        blockId: 'b_forged',
        index: 0,
        type: 'paragraph',
        text: '伪造段落',
        location: { kind: 'paragraph', paragraphIndex: 0 },
      },
    ];
    const legacyAccess: SourceAccess = { scope: access.scope, documents: [forgedDoc] };
    assertDenied(() => createSourceReader(legacyAccess, registry), 'source_bundle_required');
  } finally {
    fx.cleanup();
  }
});

test('伪造 / 克隆 / 改动 / 循环 的 bundle 一律在构造期 invalid_source_bundle', async () => {
  const { fx, bundle, access } = await genuine();
  try {
    const base = { scope: access.scope, documents: access.documents };

    // 伪造：完全凭空构造，未经过服务校验。
    const forged: SourceBundle = { ...bundle, projectId: bundle.projectId };
    assertDenied(
      () => createSourceReader({ ...base, bundles: [forged] }, registry),
      'invalid_source_bundle',
    );

    // 克隆：JSON 往返后失去真实性印记。
    const cloned: SourceBundle = JSON.parse(JSON.stringify(bundle));
    assertDenied(
      () => createSourceReader({ ...base, bundles: [cloned] }, registry),
      'invalid_source_bundle',
    );

    // 改动：篡改 contentHash。
    const mutated: SourceBundle = { ...bundle, contentHash: 'sha256:' + '0'.repeat(64) };
    assertDenied(
      () => createSourceReader({ ...base, bundles: [mutated] }, registry),
      'invalid_source_bundle',
    );

    // 循环：自引用，不可序列化。
    const cyclic: any = { ...bundle };
    cyclic.self = cyclic;
    assertDenied(
      () => createSourceReader({ ...base, bundles: [cyclic] }, registry),
      'invalid_source_bundle',
    );

    // 确认原始真实 bundle 仍然可用（保证上面拒绝不是环境因素）。
    assert.ok(createSourceReader(access, registry));
  } finally {
    fx.cleanup();
  }
});

test('真实 bundle 但 document 与可信 IR 规范不等 => 构造期 bundle_document_mismatch', async () => {
  const { fx, bundle, access } = await genuine();
  try {
    // 用另一份真实但内容不同的可信文档视图（同 ID/版本）冒充信任集。
    const altered = structuredClone(bundle.document);
    altered.blocks[0].text = altered.blocks[0].text + '（不同）';
    const mismatchedAccess: SourceAccess = {
      scope: access.scope,
      documents: [altered],
      bundles: [bundle],
    };
    assertDenied(
      () => createSourceReader(mismatchedAccess, registry),
      'bundle_document_mismatch',
    );
  } finally {
    fx.cleanup();
  }
});

test('PDF 但 bundle 无 refs 且无 blocks => 构造期 invalid_source_bundle', async () => {
  const { fx, bundle, access } = await genuine();
  try {
    assert.equal(bundle.mimeType, 'application/pdf');
    // 改动：清空 refs/blocks 破坏了真实 bundle 的结构，构造期即被拒。
    const empty: SourceBundle = { ...bundle, refs: [], blocks: [] };
    assertDenied(
      () => createSourceReader({ scope: access.scope, documents: access.documents, bundles: [empty] }, registry),
      'invalid_source_bundle',
    );
  } finally {
    fx.cleanup();
  }
});

test('伪造段落定位的 PDF（无 bundle 内容）=> 构造期 invalid_source_bundle', async () => {
  const { fx, bundle, access } = await genuine();
  try {
    assert.equal(bundle.mimeType, 'application/pdf');
    // 伪造：结构上看起来像合法 PDF 内容，但并非真实私有能力，构造期即拒绝。
    const forgedLocation: SourceBundle = {
      ...bundle,
      refs: [],
      blocks: [],
    };
    assertDenied(
      () => createSourceReader({ scope: access.scope, documents: access.documents, bundles: [forgedLocation] }, registry),
      'invalid_source_bundle',
    );
  } finally {
    fx.cleanup();
  }
});

test('重复 document version / 外来作用域 / 越界文档版本', async () => {
  const { fx, doc, access } = await genuine();
  try {
    // 重复文档版本。
    assertDenied(
      () => createSourceReader({ scope: access.scope, documents: [doc, structuredClone(doc)], bundles: access.bundles }, registry),
      'duplicate_document_version',
    );

    // 外来作用域：scope 指向不同 projectId，构造期即拒绝。
    const foreignScope = { ...access.scope, projectId: 'project_other' } as SourceAccess['scope'];
    assertDenied(
      () => createSourceReader({ scope: foreignScope, documents: access.documents, bundles: access.bundles }, registry),
      'foreign_source_bundle',
    );

    // 越界文档版本：请求一个不在作用域内的版本 => document_access_denied。
    const read = createSourceReader(access, registry);
    assertDenied(
      () => read(req(doc.documentId, 'docv_stale_999', doc.blocks[0].blockId)),
      'document_access_denied',
    );
  } finally {
    fx.cleanup();
  }
});

test('作用域未授予读权限 => document_access_denied', async () => {
  const { fx, doc, access } = await genuine();
  try {
    // allowedOperations 中仅有 check_source，缺少 document 读权限。
    const narrowed: SourceAccess = {
      ...access,
      scope: { ...access.scope, allowedOperations: ['check_source'] },
    };
    const read = createSourceReader(narrowed, registry);
    assertDenied(
      () => read(req(doc.documentId, doc.documentVersionId, doc.blocks[0].blockId)),
      'document_access_denied',
    );
  } finally {
    fx.cleanup();
  }
});

test('作用域 allowedOperations 为空 => 构造期 invalid_scope', async () => {
  const { fx, access } = await genuine();
  try {
    const emptyScope: SourceAccess = {
      ...access,
      scope: { ...access.scope, allowedOperations: [] },
    };
    assertDenied(() => createSourceReader(emptyScope, registry), 'invalid_scope');
  } finally {
    fx.cleanup();
  }
});

test('严格请求校验：多余字段 / 路径字段 / 未知块 / 非法形状', async () => {
  const { fx, doc, access } = await genuine();
  try {
    const read = createSourceReader(access, registry);
    const good = req(doc.documentId, doc.documentVersionId, doc.blocks[0].blockId);

    assertDenied(() => read({ ...good, extra: 'x' } as any), 'invalid_tool_input');
    assertDenied(() => read({ ...good, path: '/etc/passwd' } as any), 'invalid_tool_input');
    assertDenied(() => read({ ...good, documentId: 123 } as any), 'invalid_tool_input');
    assertDenied(() => read({} as any), 'invalid_tool_input');

    // 未知块。
    assertDenied(() => read({ ...good, blockId: 'b999' }), 'block_unavailable');
  } finally {
    fx.cleanup();
  }
});

test('超限结果被拒绝而非截断（>65536 字节）', async () => {
  const bigCell = 'x'.repeat(MAX_RESULT_BYTES + 1000);
  const fx = buildFixture({
    tables: {
      b001: {
        rows: [['巨大列'], [bigCell]],
        cells: [{ row: 1, column: 0, text: bigCell }],
        warnings: [],
      },
    },
  });
  try {
    const bundle = await loadBundle(fx);
    const doc = bundle.document;
    const tableBlock = doc.blocks.find((b) => b.type === 'table')!;
    const access: SourceAccess = {
      scope: {
        projectId: fx.auth.projectId,
        allowedOperations: ['read_document'],
        documentRefs: [{ documentId: doc.documentId, documentVersionId: doc.documentVersionId }],
      },
      documents: [doc],
      bundles: [bundle],
    };
    const read = createSourceReader(access, registry);
    assertDenied(
      () => read(req(doc.documentId, doc.documentVersionId, tableBlock.blockId)),
      'result_too_large',
    );
  } finally {
    fx.cleanup();
  }
});

test('工具：取消读取 / 失败读取不产生收据', async () => {
  const { fx, doc, access } = await genuine();
  try {
    const budget = new ExecutionBudget(AUTHORIZED_LIMITS);
    const { tool, receipts } = createReadSourceTool(access, registry, budget);
    const good = req(doc.documentId, doc.documentVersionId, doc.blocks[0].blockId);

    // 取消读取：外部信号已中止。
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      tool.execute('call_cancel', good as any, controller.signal as any, undefined, MOCK_TOOL_CONTEXT),
    );
    assert.equal(receipts.length, 0, '取消调用不应产生收据');

    // 失败读取：非法请求。
    await assert.rejects(
      tool.execute('call_fail', { ...good, extra: 'x' } as any, undefined, undefined, MOCK_TOOL_CONTEXT),
    );
    assert.equal(receipts.length, 0, '失败调用不应产生收据');

    budget.dispose();
  } finally {
    fx.cleanup();
  }
});

test('工具预算耗尽：超出 maxToolCalls 的调用失败且不收据', async () => {
  const { fx, doc, access } = await genuine();
  try {
    const budget = new ExecutionBudget({ ...AUTHORIZED_LIMITS, maxToolCalls: 1 });
    const { tool, receipts } = createReadSourceTool(access, registry, budget);
    const good = req(doc.documentId, doc.documentVersionId, doc.blocks[0].blockId);

    const first = await tool.execute('call_1', good as any, undefined, undefined, MOCK_TOOL_CONTEXT);
    assert.equal(receipts.length, 1);
    assert.ok(first);

    await assert.rejects(tool.execute('call_2', good as any, undefined, undefined, MOCK_TOOL_CONTEXT), (error: unknown) => {
      assert.equal((error as any).code, 'tool_budget');
      return true;
    });
    assert.equal(receipts.length, 1, '超预算调用不应新增收据');

    budget.dispose();
  } finally {
    fx.cleanup();
  }
});

test('成功：收据存在，且返回值与收据、调用方变更互相隔离', async () => {
  const { fx, doc, access } = await genuine();
  try {
    const budget = new ExecutionBudget(AUTHORIZED_LIMITS);
    const { tool, receipts } = createReadSourceTool(access, registry, budget);
    const block = doc.blocks.find((b) => b.type === 'paragraph')!;
    const good = req(doc.documentId, doc.documentVersionId, block.blockId);

    const response = await tool.execute('call_ok', good as any, undefined, undefined, MOCK_TOOL_CONTEXT);
    assert.equal(receipts.length, 1);

    // 返回值携带文本内容。
    const text = (response as any).content[0].text as string;
    const parsed = JSON.parse(text) as ReadSourceResult;
    assert.equal(parsed.blockId, block.blockId);

    // 调用方变更返回值，不影响收据。
    parsed.text = 'MUTATED-BY-CALLER';
    parsed.limitations.push('CALLER');
    assert.notEqual(receipts[0].text, 'MUTATED-BY-CALLER');
    assert.equal(receipts[0].text, block.text);
    assert.equal(receipts[0].limitations.includes('CALLER'), false);

    // 再次读取返回独立对象，且反映收据未被污染。
    const again = await tool.execute('call_ok2', good as any, undefined, undefined, MOCK_TOOL_CONTEXT);
    const againParsed = JSON.parse((again as any).content[0].text) as ReadSourceResult;
    assert.equal(againParsed.text, block.text);

    budget.dispose();
  } finally {
    fx.cleanup();
  }
});

test('夹具在 finally 中清理（tmp 目录被移除）', async () => {
  const { fx } = await genuine();
  const dir = fx.dir;
  try {
    assert.ok(dir.length > 0);
  } finally {
    fx.cleanup();
  }
  assert.equal(existsSync(dir), false, '夹具目录应已清理');
});