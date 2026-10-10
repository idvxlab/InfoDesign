/** 全合成回放与人工语义标注；不运行语义审查模型，不调用外网。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { EvidenceInput, EvidenceOutput } from '../../packages/contracts/generated/index.ts';
import { SchemaRegistry } from '../../packages/contracts/src/schema-registry.ts';
import type { JsonValue } from '../../packages/contracts/src/validator.ts';
import { checkEvidenceInput } from '../../packages/contracts/src/service-checks.ts';
import { createDocumentReader } from '../../apps/server/src/runtime/pi/read-document-tool.ts';
import { validateEvidenceCandidate } from '../../apps/server/src/domain/result-validator.ts';
import { evidenceSchemaContext } from '../../apps/server/src/agents/evidence/schema-context.ts';
import { loadFixture, registry } from '../helpers/fixtures.ts';

const input = loadFixture<EvidenceInput>('b3-replay/input.json');
const first = loadFixture<EvidenceOutput>('b3-replay/first-candidate.json');
const recheck = loadFixture<EvidenceOutput>('b3-replay/recheck-candidate.json');
const annotations = loadFixture<{ cases: Array<{ file: string; expectedProgramIssueCodes: string[]; semanticIssues: Array<{ category: string; path: string; reason: string }> }>; unavailableHistoricalEvidence: string[] }>('b3-replay/annotations.json');
function validate(output: EvidenceOutput, taskInput = input) {
  const read = createDocumentReader({ scope: taskInput.scope, documents: taskInput.documents }, registry);
  const receipts = taskInput.documents.flatMap(d => d.blocks.map(b => read({ documentId: d.documentId, documentVersionId: d.documentVersionId, blockId: b.blockId })));
  const { snapshotId, snapshotVersionId, createdAt, producedBy } = output.candidateSnapshot;
  return validateEvidenceCandidate(output, taskInput, { snapshotId, snapshotVersionId, createdAt, producedBy }, receipts, registry);
}
test('B3 合成重建保持两次首版的事实／来源拓扑，程序结果与人工语义标注分开', () => {
  assert.equal(checkEvidenceInput(input, registry).ok, true);
  const doc = input.documents[0];
  assert.equal(doc.contentHash, 'sha256:' + createHash('sha256').update(doc.blocks[0].text!).digest('hex'));
  for (const [output, expected, sources, missing] of [[first, annotations.cases[0], 7, 2], [recheck, annotations.cases[1], 2, 3]] as const) {
    assert.equal(output.candidateSnapshot.claims.length, 7);
    assert.equal(output.candidateSnapshot.evidence.length, sources); assert.equal(output.candidateSnapshot.missing.length, missing);
    assert.deepEqual([...new Set(validate(output).issues.map(i => i.code))], expected.expectedProgramIssueCodes);
    assert.ok(expected.semanticIssues.length > 0);
    assert.equal(output.candidateSnapshot.reviewStatus, 'pending');
    assert.ok(output.candidateSnapshot.evidence.every(e => doc.blocks[0].text!.includes(e.excerpt)));
  }
});
test('B3 legal_name 和 partial 范围臆测通过结构检查，仍需独立语义审查', () => {
  assert.equal(first.candidateSnapshot.claims[0].predicate, 'legal_name');
  assert.equal(input.documents[0].parseInfo?.unsupported, undefined);
  assert.equal(validate(first).ok, true);
  assert.deepEqual(annotations.cases[0].semanticIssues.map(i => i.category), ['overstrong_name_predicate', 'partial_scope_overreach']);
});
test('B3 仅修正重复覆盖可通过程序检查，不会消除无依据简称', () => {
  const output = structuredClone(recheck);
  output.candidateSnapshot.coverage.unsupported = [];
  assert.equal(validate(output).ok, true);
  assert.deepEqual(output.candidateSnapshot.entities[0].aliases, ['海岚仪器']);
  // 简称是名称的子串，单纯 includes 检查也不能证明原文明确命名。
  assert.ok(input.documents[0].blocks[0].text!.includes(output.candidateSnapshot.entities[0].aliases![0]));
  assert.equal(annotations.cases[1].semanticIssues[0].category, 'unsupported_alias');
});
test('B3 有明确登记名称／简称的合成正例仍可表达，不能全局禁用属性', () => {
  const taskInput = structuredClone(input), output = structuredClone(first);
  const statement = '登记名称为海岚仪器有限公司，文中简称“海岚仪器”。';
  const doc = taskInput.documents[0]; doc.blocks[0].text = statement + doc.blocks[0].text;
  doc.contentHash = 'sha256:' + createHash('sha256').update(doc.blocks[0].text).digest('hex');
  output.candidateSnapshot.entities[0].aliases = ['海岚仪器'];
  output.candidateSnapshot.evidence[0].excerpt = statement;
  output.stopReason = '已处理当前授权段落，整份资料范围仍为 partial。';
  delete output.candidateSnapshot.extensions;
  assert.equal(output.candidateSnapshot.claims[0].predicate, 'legal_name');
  assert.equal(validate(output, taskInput).ok, true);
});
test('B3 partial 多块目录按真实读取互斥覆盖，不依赖原段落长度', () => {
  const taskInput = structuredClone(input), output = structuredClone(recheck), doc = taskInput.documents[0];
  doc.blocks.push({ blockId: 'b102', index: 1, type: 'paragraph', text: '这是另一段合成资料。'.repeat(31), location: { kind: 'paragraph', paragraphIndex: 1 } });
  output.candidateSnapshot.coverage.documentsProcessed[0].blockIds.push('b102');
  output.candidateSnapshot.coverage.unsupported = [];
  assert.equal(validate(output, taskInput).ok, true);
  output.candidateSnapshot.coverage.unsupported.push({ documentId: doc.documentId, blockId: 'b102', reason: 'partial' });
  assert.ok(validate(output, taskInput).issues.some(i => i.code === 'coverage.duplicate_block'));
});
test('B3 首次生成省略重复 added 清单不改变快照，校验结果保持一致', () => {
  const output = structuredClone(recheck); const before = validate(output);
  assert.equal(output.changes?.length, 7); delete output.changes;
  assert.deepEqual(output.candidateSnapshot, recheck.candidateSnapshot);
  assert.deepEqual(validate(output), before);
});

const outputId = 'urn:tju-mas:contracts:evidence-output';
test('B3 精简上下文只删除不可达定义，保留根和可达约束及描述，引用可编译', () => {
  const before = JSON.stringify(registry.entries());
  const bundled = new SchemaRegistry();
  const context = evidenceSchemaContext(registry);
  for (const schema of context) {
    const current = schema as Record<string, JsonValue>, id = current.$id as string;
    const { $defs: originalDefs, ...originalRoot } = registry.get(id) as Record<string, JsonValue>;
    const { $defs: kept, ...root } = current;
    assert.deepEqual(root, originalRoot);
    for (const [name, definition] of Object.entries(kept as Record<string, JsonValue>)) assert.deepEqual(definition, (originalDefs as Record<string, JsonValue>)[name]);
    bundled.addSchema(id, schema);
  }
  assert.deepEqual(bundled.checkRefs().problems, []); bundled.compile();
  assert.equal(JSON.stringify(registry.entries()), before);
  const full = context.map(s => registry.get((s as { $id: string }).$id));
  assert.ok(Buffer.byteLength(JSON.stringify(context)) < Buffer.byteLength(JSON.stringify(full)));
  const variants: unknown[] = [first, recheck, loadFixture('b3-evidence-expected.json'), null, [], {}, { ...first, rogue: true }];
  for (const key of Object.keys(first)) { const variant = structuredClone(first) as unknown as Record<string, unknown>; delete variant[key]; variants.push(variant); }
  const accepted = structuredClone(first); (accepted.candidateSnapshot as { reviewStatus: string }).reviewStatus = 'passed'; variants.push(accepted);
  const forged = structuredClone(first); forged.producedBy.role = 'review' as 'evidence'; variants.push(forged);
  for (const variant of variants) assert.deepEqual(bundled.validate(outputId, variant), registry.validate(outputId, variant));
});
test('B3 新增可达公共定义自动进入上下文，裁剪不靠硬编码删除名单', () => {
  const extended = new SchemaRegistry();
  for (const entry of registry.entries()) {
    const schema = structuredClone(entry.schema) as Record<string, JsonValue>;
    if (entry.id === outputId) (schema.properties as Record<string, JsonValue>).testFingerprint = { $ref: 'urn:tju-mas:contracts:common#/$defs/contentHash' };
    extended.addSchema(entry.file, schema);
  }
  const common = evidenceSchemaContext(extended)[0] as { $defs: Record<string, unknown> };
  assert.deepEqual(common.$defs.contentHash, (registry.get('urn:tju-mas:contracts:common') as { $defs: Record<string, unknown> }).$defs.contentHash);
});


test('B3 关系确定程度：归属不能证明操作角色，明确操作者的正例仍可表达', () => {
  const taskInput = loadFixture<EvidenceInput>('b3-quality/coverage-input.json');
  const output = loadFixture<EvidenceOutput>('b3-quality/coverage-reference.json');
  // Keep this separate annotation focused on relation semantics, within supported paragraph input.
  const second = taskInput.documents[1]; second.blocks.pop();
  second.parseInfo = { parser: 'synthetic_fixture', quality: 'complete' };
  second.contentHash = 'sha256:' + createHash('sha256').update(second.blocks[0].text).digest('hex');
  output.candidateSnapshot.coverage.unsupported = [];
  assert.deepEqual(validate(output, taskInput).issues, []);
  const stronger = structuredClone(output);
  stronger.candidateSnapshot.relations![0].relationType = 'operates';
  assert.equal(validate(stronger, taskInput).ok, true, 'program source checks cannot establish operator identity; manual source review must flag this stronger relation');
  assert.equal(stronger.candidateSnapshot.reviewStatus, 'pending');
  const explicit = structuredClone(taskInput), doc = explicit.documents[0];
  doc.blocks[0].text += '该装置由青禾服务站负责操作。';
  doc.contentHash = 'sha256:' + createHash('sha256').update(doc.blocks[0].text).digest('hex');
  const relationSource = stronger.candidateSnapshot.relations![0].evidenceRefs[0];
  stronger.candidateSnapshot.evidence.find(e => e.evidenceId === relationSource)!.excerpt = doc.blocks[0].text;
  assert.deepEqual(validate(stronger, explicit).issues, [], 'operates is valid when explicitly supported; do not blacklist the predicate');
});
