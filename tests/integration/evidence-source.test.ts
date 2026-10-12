/**
 * B3-source 程序回归：真实 Pi SDK + 本地模拟 SSE 网关 + 合成 SourceBundle 夹具。
 *
 * 只做结构性验证：证明 runEvidenceAgent 能把已验证的 SourceBundle/read_source 能力接到证据 Agent，
 * 并保持 legacy read_document、输入/输出不可变、伪造/过期/越权拒绝等既有约束。
 * 语义 mock 输出明确为“模拟”，不代表真实模型质量。无 OCR/视觉，无真实 PDF，无 live API。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { readModelConfig } from '../../apps/server/src/config/env.ts';
import { runEvidenceAgent } from '../../apps/server/src/agents/evidence/agent.ts';
import { prepareEvidenceInput, newCandidateEnvelope } from '../../apps/server/src/agents/evidence/context.ts';
import { MemoryCandidateStore } from '../../apps/server/src/domain/evidence.service.ts';
import { validateEvidenceCandidate } from '../../apps/server/src/domain/result-validator.ts';
import { EVIDENCE_LIMITS } from '../../apps/server/src/runtime/pi/execution-limits.ts';
import { registry, loadFixture } from '../helpers/fixtures.ts';
import type { EvidenceInput, EvidenceOutput } from '../../packages/contracts/generated/index.ts';
import { RuntimeTrace } from '../../apps/server/src/runtime/pi/event-bridge.ts';
import { buildFixture, load } from '../helpers/source-bundle-fixture.ts';
import { getValidatedSourceBundle, type SourceBundle } from '../../apps/server/src/domain/source-bundle.ts';
import type { DocumentIr } from '../../packages/contracts/generated/document-ir.ts';

const limits = { ...EVIDENCE_LIMITS, timeoutMs: 5000 };

// loadSourceBundle 是 async 且返回判别联合 { ok, bundle }：必须在顶层 await 并解包，
// 绝不能把 Promise 当作 SourceBundle 使用。
const fixture = buildFixture();
const loaded = await load(fixture.dir, fixture.auth, { registry });
assert.equal(loaded.ok, true);
const bundle: SourceBundle = loaded.bundle;
const pdfIr = bundle.document;

function makeInput(overrides: Record<string, unknown> = {}) {
  const scope = {
    projectId: pdfIr.projectId,
    documentRefs: [{ documentId: pdfIr.documentId, documentVersionId: pdfIr.documentVersionId }],
    allowedOperations: ['read_document', 'submit_candidate'],
  };
  return {
    protocolVersion: '1.0', taskId: 'task_src', attemptId: 'attempt_src', projectId: pdfIr.projectId,
    taskType: 'generate', stage: 'facts', scope,
    documents: [structuredClone(pdfIr)],
    constraints: { preserveFacts: true, forbiddenNewFacts: true, notes: 'synthetic' },
    executionPolicyRef: 'policy_facts_v1', ...overrides,
  } as any;
}

type Body = { messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>; tools: Array<{ function: { name: string } }> };
function task(body: Body): any {
  const content = body.messages.findLast(m => m.role === 'user')!.content;
  return JSON.parse(typeof content === 'string' ? content : content.map(c => c.text ?? '').join(''));
}
let sseRes: ServerResponse | undefined;
function chunk(payload: unknown, finishReason: string | null) {
  const delta = finishReason === null
    ? payload
    : (payload && typeof payload === 'object' && 'role' in (payload as any) ? payload : {});
  const choice: Record<string, unknown> = { index: 0, delta };
  if (finishReason !== null) choice.finish_reason = finishReason;
  sseRes!.write('data: ' + JSON.stringify({ choices: [choice], usage: null }) + '\n\n');
}
function complete(res: ServerResponse, data: string | unknown[], finishReason = 'stop', usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }, toolName = 'read_source') {
  sseRes = res;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (delta: unknown, fr: string | null) => res.write('data: ' + JSON.stringify({ id: 's', object: 'chat.completion.chunk', model: 'synthetic-model', choices: [{ index: 0, delta, finish_reason: fr }] }) + '\n\n');
  if (Array.isArray(data)) {
    chunk({ role: 'assistant', tool_calls: (data as any[]).map((args, index) => ({ index, id: 'r' + index, type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } })) }, null);
    chunk({}, 'tool_calls');
  } else { chunk({ role: 'assistant', content: data }, null); chunk({}, finishReason); }
  res.write('data: ' + JSON.stringify({ choices: [], usage }) + '\n\n');
  res.end('data: [DONE]\n\n');
}

type Handler = (body: Body, res: ServerResponse, i: number) => void;
// bundles 显式缺省表示“无 bundle（legacy read_document 路径）”；只有真正传入时才覆盖 sourceBundles。
type ScenarioBundles = { bundles?: SourceBundle[] | undefined };
async function scenario(handler: Handler, changes: Record<string, unknown> = {}, input = makeInput(), opts: ScenarioBundles = { bundles: [bundle] }) {
  const requests: Body[] = [], store = new MemoryCandidateStore();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Body;
    requests.push(body); handler(body, res, requests.length);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const config = readModelConfig({ APP_MODEL_PROVIDER: 'src-test', APP_MODEL_ID: 'synthetic-model', APP_MODEL_BASE_URL: 'http://127.0.0.1:' + address.port + '/v1', APP_MODEL_API_KEY: 'src-synthetic-secret' }, { allowLoopbackHttp: true });
  try {
    const hasBundles = Object.prototype.hasOwnProperty.call(opts, 'bundles');
    const outcome = await runEvidenceAgent({ input, config, registry, store, limits, ...(hasBundles ? { sourceBundles: opts.bundles } : {}), ...changes });
    assert.equal(JSON.stringify(outcome).includes('src-synthetic-secret'), false);
    return { outcome, requests, records: store.list() };
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
}

const allRequests = [pdfIr.blocks.map(b => ({ documentId: pdfIr.documentId, documentVersionId: pdfIr.documentVersionId, blockId: b.blockId }))];

/** 合成物理收据：来自真实块定位，用于直接调用 validateEvidenceCandidate。 */
const physicalReceipts = allRequests[0].map(r => ({ ...r, contentHash: pdfIr.contentHash, text: '', location: pdfIr.blocks.find(b => b.blockId === r.blockId)!.location }));

/** 合成（模拟）候选：paragraph 块给出年份/单位事实，table 给候选，image 登记 unsupported。 */
function makeCandidate(body: Body): EvidenceOutput {
  const env = task(body).envelope;
  const paraBlock = pdfIr.blocks.find(b => b.type === 'paragraph')!;
  const tableBlock = pdfIr.blocks.find(b => b.type === 'table');
  const imageBlock = pdfIr.blocks.find(b => b.type === 'image')!;
  const processed = [paraBlock, ...(tableBlock ? [tableBlock] : [])].map(b => b.blockId);
  return {
    protocolVersion: '1.0', taskId: 'task_src', attemptId: 'attempt_src', projectId: pdfIr.projectId,
    status: 'needs_information', stopReason: '图片语义 not_run；表格候选未复核；解析 partial。',
    candidateSnapshot: {
      protocolVersion: '1.0', snapshotId: env.snapshotId, snapshotVersionId: env.snapshotVersionId,
      projectId: pdfIr.projectId, taskId: 'task_src', attemptId: 'attempt_src',
      entities: [{ entityId: 'ent_x', entityType: 'organization', label: '报告主体' }],
      claims: [{
        claimId: 'claim_year', claimVersionId: 'claimv_1', entityId: 'ent_x', predicate: 'report_year',
        value: { type: 'quantity', normalized: 2024, unit: '年', raw: '2024' },
        qualifiers: { time: { year: 2024 } }, supportStatus: 'supported', reviewStatus: 'pending', evidenceRefs: ['ev_para'],
      }],
      evidence: [{
        evidenceId: 'ev_para', documentId: pdfIr.documentId, documentVersionId: pdfIr.documentVersionId,
        blockId: paraBlock.blockId, locator: structuredClone(paraBlock.location), excerpt: '报告年份 2024',
      }],
      relations: [], events: [], conflicts: [],
      missing: [{ missingId: 'missing_img', expectedPredicate: 'figure_value', description: '图片语义未运行', severity: 'warning' }],
      coverage: {
        documentsProcessed: [{ documentId: pdfIr.documentId, documentVersionId: pdfIr.documentVersionId, blockIds: processed }],
        unsupported: [{ documentId: pdfIr.documentId, blockId: imageBlock.blockId, reason: 'image_region_only; OCR and image semantics not run' }],
      },
      reviewStatus: 'pending', producedBy: env.producedBy, createdAt: env.createdAt,
    },
    producedBy: env.producedBy,
  };
}

/** 用真实 envelope 包出一份候选，供直接调用 validateEvidenceCandidate。 */
function wrappedCandidate() {
  const env = newCandidateEnvelope({ role: 'evidence', protocolVersion: '1.0', model: 'synthetic-model', sessionId: 'session_x', promptVersion: 'evidence_b3_v4' });
  const cand = makeCandidate({ messages: [{ role: 'user', content: JSON.stringify({ envelope: env }) }] } as any);
  Object.assign(cand.candidateSnapshot, env);
  cand.producedBy = env.producedBy;
  return { cand, env };
}

const successHandler: Handler = (body, res, i) => complete(res, i === 1 ? allRequests[0] : JSON.stringify(makeCandidate(body)));

test('B3-source：准备输入接受 genuine PDF 源，构造期占位码被豁免但其余检查保留', () => {
  const input = makeInput();
  assert.doesNotThrow(() => prepareEvidenceInput(input, registry, [bundle]));
  // 无 bundle 时保留 legacy 严格行为：PDF page_region 输入应被拒。
  assert.throws(() => prepareEvidenceInput(input, registry as any));
  // 伪造（克隆）bundle 必须失败。
  assert.throws(() => prepareEvidenceInput(input, registry, [structuredClone(bundle)]));
});

test('B3-source：真实 SDK 用 read_source 读取物理块并保存保留物理定位的待审候选', async () => {
  const { outcome, records, requests } = await scenario(successHandler);
  assert.equal(outcome.status, 'needs_information', JSON.stringify(outcome));
  assert.equal(outcome.reason, undefined);
  assert.equal(outcome.successfulReads, pdfIr.blocks.length);
  assert.equal(outcome.repairAttempts, 0);
  assert.equal(records[0].state, 'pending_review');
  const stored = records[0].output!;
  // 存储候选保留原始物理定位（page_region），未被映射为 paragraph。
  assert.equal(stored.candidateSnapshot.evidence[0].locator.kind, 'page_region');
  assert.equal((stored.candidateSnapshot.evidence[0].locator as any).page, 1);
  // 保留单位/年份。
  assert.deepEqual(stored.candidateSnapshot.claims[0].value, { type: 'quantity', normalized: 2024, unit: '年', raw: '2024' });
  assert.deepEqual(stored.candidateSnapshot.claims[0].qualifiers, { time: { year: 2024 } });
  for (const body of requests) assert.deepEqual(body.tools.map(t => t.function.name), ['read_source']);
  // 首次上下文为 metadata-only：不含原文。
  assert.equal(JSON.stringify(requests[0]).includes('报告年份 2024'), false);
  assert.equal(JSON.stringify(requests[0]).includes('source.pdf'), false);
  assert.match(JSON.stringify(task(requests[0])), /"images":"not_run"/);
  // read_source 运行轨迹。
  assert.ok(outcome.events.some(e => e.type === 'tool_start' && e.toolName === 'read_source'));
  assert.ok(outcome.events.some(e => e.type === 'tool_end' && e.toolName === 'read_source' && e.ok));
  assert.equal(outcome.events.some(e => e.toolName === 'unrecognized'), false);
});

test('B3-source：legacy 无 bundle + 合成 text/plain paragraph 输入走 read_document 且行为不变', async () => {
  // 真正的 legacy 正向路径：合法 fixture 输入，无任何 bundle。
  const legacyInput = loadFixture<EvidenceInput>('b3-evidence-input.json');
  const legacyExpected = loadFixture<EvidenceOutput>('b3-evidence-expected.json');
  const readReq = legacyInput.documents.flatMap(doc =>
    doc.blocks.map(block => ({ documentId: doc.documentId, documentVersionId: doc.documentVersionId, blockId: block.blockId })),
  );
  const totalBlocks = readReq.length;

  const handler: Handler = (body, res, i) => {
    if (i === 1) return complete(res, readReq, 'stop', undefined as any, 'read_document');
    const env = task(body).envelope;
    const candidate = structuredClone(legacyExpected) as any;
    candidate.candidateSnapshot = { ...candidate.candidateSnapshot, ...env, producedBy: env.producedBy };
    candidate.producedBy = env.producedBy;
    complete(res, JSON.stringify(candidate));
  };

  const { outcome, records, requests } = await scenario(handler, {}, legacyInput, { bundles: undefined });
  // 该 fixture 内仍存在真实冲突/缺失字段，因此 golden.status 正确为 needs_information。
  assert.equal(legacyExpected.status, 'needs_information');
  assert.equal(outcome.status, legacyExpected.status);
  assert.equal(outcome.successfulReads, totalBlocks);
  assert.equal(records.length, 1);
  assert.equal(records[0].state, 'pending_review');
  assert.equal(requests.length, 2);
  for (const body of requests) assert.deepEqual(body.tools.map(t => t.function.name), ['read_document']);
  assert.ok(outcome.events.some(e => e.type === 'tool_start' && e.toolName === 'read_document'));
  assert.ok(outcome.events.some(e => e.type === 'tool_end' && e.toolName === 'read_document' && e.ok));

  // PDF 无 bundle 仍是单独的零请求拒绝。
  const { outcome: pdfNoBundle, requests: pdfRequests } = await scenario(successHandler, {}, makeInput(), { bundles: undefined });
  assert.equal(pdfNoBundle.reason, 'invalid_input');
  assert.equal(pdfRequests.length, 0);
});

test('B3-source：伪造/篡改/缺失 bundle 在首个 HTTP 请求前拒绝', async () => {
  const input = makeInput();
  for (const bad of [
    () => prepareEvidenceInput(input, registry, [{ ...bundle } as SourceBundle]),
    () => prepareEvidenceInput(input, registry, [{ ...bundle, contentHash: 'sha256:' + '0'.repeat(64) } as SourceBundle]),
    () => prepareEvidenceInput(input, registry, [bundle, bundle] as SourceBundle[]),
  ]) {
    assert.throws(bad);
  }
  // 通过 runEvidenceAgent（bundles 缺省）用 page_region 输入 → 非法输入，0 次模型调用。
  const { outcome, requests } = await scenario(successHandler, {}, input, { bundles: undefined });
  assert.equal(outcome.reason, 'invalid_input');
  assert.equal(requests.length, 0);
});

test('B3-source：同类证据两条引用同一 PDF 块都必须被映射并通过（第二处错误定位被拒）', async () => {
  const src = makeCandidate({ messages: [{ role: 'user', content: JSON.stringify({ envelope: newCandidateEnvelope({ role: 'evidence', protocolVersion: '1.0', model: 'synthetic-model', sessionId: 's', promptVersion: 'p' }) }) }] } as any);
  const env = newCandidateEnvelope({ role: 'evidence', protocolVersion: '1.0', model: 'synthetic-model', sessionId: 'session_x', promptVersion: 'evidence_b3_v4' });
  const cand = makeCandidate({ messages: [{ role: 'user', content: JSON.stringify({ envelope: env }) }] } as any);
  Object.assign(cand.candidateSnapshot, env);
  cand.producedBy = env.producedBy;
  const para = pdfIr.blocks.find(b => b.type === 'paragraph')!;
  // 同块两条合法证据：第二条与第一条引用同一 blockId、同一物理定位。
  const second = structuredClone(cand.candidateSnapshot.evidence[0]);
  second.evidenceId = 'ev_para_2';
  second.excerpt = '质量 12.5 kg';
  cand.candidateSnapshot.evidence.push(second);
  // 补齐引用（合法）。
  cand.candidateSnapshot.claims[0].evidenceRefs = ['ev_para', 'ev_para_2'];

  const okResult = validateEvidenceCandidate(cand, makeInput(), env, physicalReceipts as any, registry, undefined, [bundle]);
  assert.equal(okResult.ok, true, JSON.stringify(okResult.issues));

  // 第二处错误物理定位（改页）必须被拒：不能因为第一条已映射就跳过第二条。
  const bad = structuredClone(cand);
  bad.candidateSnapshot.evidence[1].locator = { kind: 'page_region', page: 9, bbox: { x: 0, y: 0, width: 1, height: 1 } };
  const badResult = validateEvidenceCandidate(bad, makeInput(), env, physicalReceipts as any, registry, undefined, [bundle]);
  assert.equal(badResult.ok, false);
  assert.ok(badResult.issues.some(i => i.code === 'evidence.physical_location_mismatch' && i.path === 'candidateSnapshot.evidence[1]'), JSON.stringify(badResult.issues));
});

test('B3-source：越权 scope、过期版本、错误物理定位、编造摘录、无读取均被拒', async () => {
  // 越权 scope：documentRefs 不含授权文档 → 输入拒绝。
  const unauthorized = makeInput({ scope: { projectId: pdfIr.projectId, documentRefs: [], allowedOperations: ['read_document', 'submit_candidate'] } });
  assert.throws(() => prepareEvidenceInput(unauthorized, registry, [bundle]));

  // 过期版本：bundle 与文档版本不匹配（documentVersionId 不同）→ verifyPdfSources 失败。
  const staleDoc = structuredClone(pdfIr); staleDoc.documentVersionId = 'docv_new';
  const staleInput = makeInput({ documents: [staleDoc], scope: { projectId: pdfIr.projectId, documentRefs: [{ documentId: staleDoc.documentId, documentVersionId: staleDoc.documentVersionId }], allowedOperations: ['read_document', 'submit_candidate'] } });
  assert.throws(() => prepareEvidenceInput(staleInput, registry, [bundle]));

  // 错误物理定位：候选 locator 改页/bbox → physical mismatch。
  const { cand, env } = wrappedCandidate();
  cand.candidateSnapshot.evidence[0].locator = { kind: 'page_region', page: 9, bbox: { x: 0, y: 0, width: 1, height: 1 } };
  const badLocResult = validateEvidenceCandidate(cand, makeInput(), env, physicalReceipts as any, registry, undefined, [bundle]);
  assert.equal(badLocResult.ok, false);
  assert.ok(badLocResult.issues.some(i => i.code === 'evidence.physical_location_mismatch'), JSON.stringify(badLocResult.issues));

  // 编造摘录：合法物理定位 + 不存在的 excerpt → 拒绝。
  const invented = structuredClone(cand);
  invented.candidateSnapshot.evidence[0].locator = structuredClone(pdfIr.blocks[0].location);
  invented.candidateSnapshot.evidence[0].excerpt = '宇宙无敌字数 999 人';
  const invResult = validateEvidenceCandidate(invented, makeInput(), env, physicalReceipts as any, registry, undefined, [bundle]);
  assert.equal(invResult.ok, false);

  // 无读取：不发任何工具调用直接给候选 → evidence.not_read。
  const { outcome: noRead } = await scenario((body, res) => complete(res, JSON.stringify(makeCandidate(body))), { maxRepairRounds: 0 });
  assert.equal(noRead.reason, 'invalid_candidate');
  assert.ok(noRead.issues.some(i => i.code === 'evidence.not_read'));
  assert.equal(noRead.successfulReads, 0);
});

test('B3-source：输入与 genuine bundle 在运行期间不被改动', async () => {
  const input = makeInput();
  const inputSnapshot = JSON.stringify(input);
  const bundleSnapshot = JSON.stringify(bundle);
  const bundleRef = bundle;
  assert.doesNotThrow(() => prepareEvidenceInput(input, registry, [bundle]));
  await scenario(successHandler, {}, input, { bundles: [bundle] });
  assert.equal(JSON.stringify(input), inputSnapshot, 'input 未被改动');
  assert.equal(JSON.stringify(bundle), bundleSnapshot, 'bundle 内容未被改动');
  // genuine 身份保持：getValidatedSourceBundle 仍然接受同一对象引用。
  assert.deepEqual(getValidatedSourceBundle(bundleRef), bundleRef);
});

test('B3-source：read_source 运行时轨迹白名单，其他工具名折叠为 unrecognized', () => {
  const trace = new RuntimeTrace();
  trace.observe({ type: 'tool_execution_start', toolName: 'read_source' } as any);
  trace.observe({ type: 'tool_execution_end', toolName: 'read_source', isError: false } as any);
  trace.observe({ type: 'tool_execution_start', toolName: 'shell' } as any);
  assert.deepEqual(trace.events.map(e => e.toolName), ['read_source', 'read_source', 'unrecognized']);
});

test('B3-source：真实带警告表格的处理必须被 coverage.unsupported_block_processed 拒绝，且证据来自 unsupported 块', async () => {
  // 构建一个带 genuine warnings 的临时夹具：表格资产 JSON 内 warnings 非空。
  const warnTables = {
    b001: {
      rows: [["Item", "Value"], ["Year", "2024"], ["Mass", "12.5 kg"]],
      cells: [
        { row: 0, column: 0, text: "Item" }, { row: 0, column: 1, text: "Value" },
        { row: 1, column: 0, text: "Year" }, { row: 1, column: 1, text: "2024" },
        { row: 2, column: 0, text: "Mass" }, { row: 2, column: 1, text: "12.5 kg" },
      ],
      warnings: ["possible_alignment_issue"],
    },
  } as const;
  const warnFixture = buildFixture({ tables: warnTables as any });
  try {
    const warnLoaded = await load(warnFixture.dir, warnFixture.auth, { registry });
    assert.equal(warnLoaded.ok, true, JSON.stringify(warnLoaded.ok ? {} : (warnLoaded as any).error));
    const warnBundle: SourceBundle = warnLoaded.bundle;
    const warnDoc = warnBundle.document;
    // genuine 权威来源是 SourceBundle.tables[*].warnings（数组），而非 IR extensions.table_warnings（标量字符串）。
    const warnTable = warnBundle.tables.find(t => t.blockId === 'b001')!;
    assert.ok(Array.isArray(warnTable.warnings) && warnTable.warnings.includes('possible_alignment_issue'));

    // 从 otherwise valid 正向基线开始：复用 wrappedCandidate() 的 BOTH cand 与 env。
    const { cand, env } = wrappedCandidate();
    const warnTableBlock = warnDoc.blocks.find(b => b.blockId === 'b001')!;
    const paraBlock = warnDoc.blocks.find(b => b.type === 'paragraph')!;
    const imageBlock = warnDoc.blocks.find(b => b.type === 'image')!;
    const warnReceipts = warnDoc.blocks.map(b => ({
      documentId: warnDoc.documentId, documentVersionId: warnDoc.documentVersionId, blockId: b.blockId,
      contentHash: warnDoc.contentHash, text: '', location: b.location,
    }));

    // 用 genuine 文档替换 documents，但保持同一 IDs/scope，且复用 wrappedCandidate() 的 env（避免 envelope 不匹配）。
    const warnInput = makeInput({
      documents: [structuredClone(warnDoc)],
      scope: {
        projectId: warnDoc.projectId,
        documentRefs: [{ documentId: warnDoc.documentId, documentVersionId: warnDoc.documentVersionId }],
        allowedOperations: ['read_document', 'submit_candidate'],
      },
    });

    // 将覆盖范围与证据重定位到 genuine 警告文档。
    cand.candidateSnapshot.coverage.documentsProcessed = [{
      documentId: warnDoc.documentId, documentVersionId: warnDoc.documentVersionId,
      blockIds: warnDoc.blocks.map(b => b.blockId),
    }];
    cand.candidateSnapshot.evidence = [{
      evidenceId: 'ev_para', documentId: warnDoc.documentId, documentVersionId: warnDoc.documentVersionId,
      blockId: paraBlock.blockId, locator: structuredClone(paraBlock.location), excerpt: '报告年份 2024',
    }];
    cand.candidateSnapshot.claims[0].entityId = cand.candidateSnapshot.entities[0].entityId;
    cand.candidateSnapshot.claims[0].evidenceRefs = ['ev_para'];
    cand.candidateSnapshot.coverage.unsupported = [{ documentId: warnDoc.documentId, blockId: imageBlock.blockId, reason: 'image_region_only; OCR and image semantics not run' }];

    // 正向基线：仅 process paragraph；image 与警告表格均 unsupported。
    const base = structuredClone(cand);
    base.candidateSnapshot.coverage.documentsProcessed = [{
      documentId: warnDoc.documentId, documentVersionId: warnDoc.documentVersionId,
      blockIds: [paraBlock.blockId],
    }];
    base.candidateSnapshot.coverage.unsupported = [
      { documentId: warnDoc.documentId, blockId: imageBlock.blockId, reason: 'image_region_only; OCR and image semantics not run' },
      { documentId: warnDoc.documentId, blockId: warnTableBlock.blockId, reason: 'table_warnings_present' },
    ];
    const baseResult = validateEvidenceCandidate(base, warnInput, env, warnReceipts as any, registry, undefined, [warnBundle]);
    assert.equal(baseResult.ok, true, JSON.stringify(baseResult.issues));

    // 负例一：把警告表格从 unsupported 移除并加入 documentsProcessed → coverage.unsupported_block_processed。
    const processedTable = structuredClone(base);
    processedTable.candidateSnapshot.coverage.unsupported = [
      { documentId: warnDoc.documentId, blockId: imageBlock.blockId, reason: 'image_region_only; OCR and image semantics not run' },
    ];
    processedTable.candidateSnapshot.coverage.documentsProcessed[0].blockIds.push(warnTableBlock.blockId);
    const processedResult = validateEvidenceCandidate(processedTable, warnInput, env, warnReceipts as any, registry, undefined, [warnBundle]);
    assert.equal(processedResult.ok, false);
    assert.ok(
      processedResult.issues.some(i => i.code === 'coverage.unsupported_block_processed' &&
        i.path === 'candidateSnapshot.coverage.documentsProcessed[0]'),
      JSON.stringify(processedResult.issues),
    );

    // 负例二：保留表格 unsupported，但新增指向该表格的 evidence → evidence.from_unsupported_block。
    const withTableEvidence = structuredClone(base);
    withTableEvidence.candidateSnapshot.evidence.push({
      evidenceId: 'ev_table', documentId: warnDoc.documentId, documentVersionId: warnDoc.documentVersionId,
      blockId: warnTableBlock.blockId, locator: structuredClone(warnTableBlock.location), excerpt: 'Year\t2024',
    });
    const evResult = validateEvidenceCandidate(withTableEvidence, warnInput, env, warnReceipts as any, registry, undefined, [warnBundle]);
    assert.equal(evResult.ok, false);
    assert.ok(
      evResult.issues.some(i => i.code === 'evidence.from_unsupported_block' &&
        i.path === 'candidateSnapshot.evidence[1]'),
      JSON.stringify(evResult.issues),
    );
  } finally {
    warnFixture.cleanup();
  }

  // 干净表格默认仍由既有成功 PDF 场景覆盖。
  const cleanWrapped = wrappedCandidate();
  const cleanResult = validateEvidenceCandidate(cleanWrapped.cand, makeInput(), cleanWrapped.env, physicalReceipts as any, registry, undefined, [bundle]);
  assert.equal(cleanResult.ok, true, JSON.stringify(cleanResult.issues));
});

test('B3-source：真实 PDF+native text 混合走真实 SDK mock，PDF 物理规则不外溢到 native', async () => {
  // 克隆一份合法 text 文档，projectId 对齐到 PDF；不修改 fixture。
  const textDoc = structuredClone(loadFixture<EvidenceInput>('b3-evidence-input.json').documents[0]) as DocumentIr;
  textDoc.projectId = pdfIr.projectId;
  const originalBlockIds = textDoc.blocks.map(b => b.blockId);
  assert.equal(originalBlockIds.length, 3);

  const mixedInput = makeInput({
    documents: [structuredClone(pdfIr), textDoc],
    scope: {
      projectId: pdfIr.projectId,
      documentRefs: [
        { documentId: pdfIr.documentId, documentVersionId: pdfIr.documentVersionId },
        { documentId: textDoc.documentId, documentVersionId: textDoc.documentVersionId },
      ],
      allowedOperations: ['read_document', 'submit_candidate'],
    },
  });

  // 第一次：分别读取 PDF 与 native 文档的所有块（同一 read_source helper）。
  const pdfReq = pdfIr.blocks.map(b => ({ documentId: pdfIr.documentId, documentVersionId: pdfIr.documentVersionId, blockId: b.blockId }));
  const textReq = textDoc.blocks.map(b => ({ documentId: textDoc.documentId, documentVersionId: textDoc.documentVersionId, blockId: b.blockId }));
  const nativeBlock0 = textDoc.blocks[0];

  const handler: Handler = (body, res, i) => {
    if (i === 1) return complete(res, [...pdfReq, ...textReq]);
    const env = task(body).envelope;
    const candidate: EvidenceOutput = makeCandidate(body);
    // native 证据：引用 native block0 的原文子串，使用 paragraph 定位器。
    candidate.candidateSnapshot.evidence.push({
      evidenceId: 'ev_native', documentId: textDoc.documentId, documentVersionId: textDoc.documentVersionId,
      blockId: nativeBlock0.blockId, locator: structuredClone(nativeBlock0.location), excerpt: '星河制造有限公司',
    });
    candidate.candidateSnapshot.entities.push({ entityId: 'ent_native', entityType: 'organization', label: '星河制造有限公司' });
    candidate.candidateSnapshot.claims.push({
      claimId: 'claim_native_name', claimVersionId: 'claimv_native_1', entityId: 'ent_native', predicate: 'legal_name',
      value: { type: 'text', text: '星河制造有限公司', raw: '星河制造有限公司' },
      supportStatus: 'supported', reviewStatus: 'pending', evidenceRefs: ['ev_native'],
    });
    candidate.candidateSnapshot.coverage.documentsProcessed.push({
      documentId: textDoc.documentId, documentVersionId: textDoc.documentVersionId, blockIds: textReq.map(r => r.blockId),
    });
    Object.assign(candidate.candidateSnapshot, env);
    candidate.producedBy = env.producedBy;
    complete(res, JSON.stringify(candidate));
  };

  // genuine bundle 列表仅含原始 PDF bundle。
  const { outcome, records, requests } = await scenario(handler, {}, mixedInput, { bundles: [bundle] });
  assert.equal(outcome.status, 'needs_information', JSON.stringify(outcome));
  assert.equal(outcome.reason, undefined);
  assert.equal(outcome.repairAttempts, 0);
  assert.equal(outcome.successfulReads, pdfReq.length + textReq.length);
  assert.equal(records[0].state, 'pending_review');

  const stored = records[0].output!.candidateSnapshot;
  const pdfEv = stored.evidence.find(e => e.evidenceId === 'ev_para')!;
  const nativeEv = stored.evidence.find(e => e.evidenceId === 'ev_native')!;
  // PDF 证据仍被强制为 page_region；native 证据保持 paragraph。
  assert.equal(pdfEv.locator.kind, 'page_region');
  assert.equal(nativeEv.locator.kind, 'paragraph');
  for (const body of requests) assert.deepEqual(body.tools.map(t => t.function.name), ['read_source']);
});

test.after(() => fixture.cleanup());