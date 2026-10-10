/** B3 离线质量矩阵：参考答案回放与负例标注，不宣称模型语义正确。 */
import { test, before, after } from 'node:test';
import { mkdtempSync, readdirSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import type { EvidenceOutput } from '../../packages/contracts/generated/index.ts';
import { checkEvidenceInput, checkDocumentHash } from '../../packages/contracts/src/service-checks.ts';
import { documentCatalog, evidenceTaskPrompt } from '../../apps/server/src/agents/evidence/context.ts';
import { loadFixture, registry } from '../helpers/fixtures.ts';
import { cases, fixture, reads, receipts, validate, replay, qualityLimits } from './fixtures/evidence-quality.ts';

// Node runs test files in separate processes but their default /tmp is shared.
// Keep this file's SDK workspaces out of the older suite's global cleanup snapshot.
let testTemp = '';
const originalTemp = process.env.TMPDIR;
before(() => { testTemp = mkdtempSync(join(tmpdir(), 'tju-quality-test-')); process.env.TMPDIR = testTemp; });
after(() => {
  try { assert.deepEqual(readdirSync(testTemp), [], 'all SDK workspaces must be released'); rmdirSync(testTemp); }
  finally { if (originalTemp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTemp; }
});

for (const name of cases) {
  test(`B3 质量矩阵 ${name}：独立合成原文/哈希/全部来源及语义清单`, () => {
    const { input, reference } = fixture(name);
    assert.equal(checkEvidenceInput(input, registry).ok, true, JSON.stringify(checkEvidenceInput(input, registry)));
    for (const doc of input.documents) assert.deepEqual(checkDocumentHash(doc, doc.blocks.map(b => b.text).join('\n')), []);
    assert.equal(reads(input).length, 2);
    assert.deepEqual(validate(input, reference).issues, []);
    const s = reference.candidateSnapshot;
    for (const evidence of s.evidence) {
      const doc = input.documents.find(d => d.documentId === evidence.documentId)!;
      const block = doc.blocks.find(b => b.blockId === evidence.blockId)!;
      assert.equal(evidence.documentVersionId, doc.documentVersionId);
      assert.deepEqual(evidence.locator, block.location); assert.ok(block.text.includes(evidence.excerpt));
    }
    const rubric = loadFixture<{ mode: string; notASemanticClassifier: boolean; checks: Array<{ id: string; requirement: string }>; acceptableAlternatives: string[] }>(`b3-quality/${name}-rubric.json`);
    assert.equal(rubric.mode, 'human_authored_semantic_rubric'); assert.equal(rubric.notASemanticClassifier, true);
    assert.equal(new Set(rubric.checks.map(c => c.id)).size, 5); assert.ok(rubric.acceptableAlternatives.length >= 2);
  });
  test(`B3 质量矩阵 ${name}：SDK 双来源回放保留事实/限定/问题且不泄漏参考答案`, async t => {
    const { input, reference } = fixture(name), before = JSON.stringify(input);
    const { outcome, records, requests, reservations } = await replay(input, reference);
    assert.equal(outcome.status, 'needs_information', JSON.stringify(outcome));
    assert.equal(outcome.modelCalls, 2); assert.equal(outcome.successfulReads, 2); assert.equal(outcome.repairAttempts, 0);
    assert.equal(outcome.finalStopReason, 'stop'); assert.equal(outcome.resourcesDisposed, true);
    assert.deepEqual(outcome.transport.httpStatuses, [200, 200]);
    assert.equal(records.length, 1); assert.equal(records[0].state, 'pending_review');
    const output = records[0].output!;
    for (const field of ['entities', 'claims', 'evidence', 'relations', 'events', 'conflicts', 'missing', 'coverage'] as const) assert.deepEqual(output.candidateSnapshot[field], reference.candidateSnapshot[field]);
    assert.equal(output.candidateSnapshot.reviewStatus, 'pending');
    assert.deepEqual(validate(input, output).issues, []);
    const initial = JSON.stringify(requests[0]);
    for (const doc of input.documents) for (const block of doc.blocks) if (block.text) assert.equal(initial.includes(block.text), false);
    assert.equal(initial.includes('synthetic_reference_only'), false); assert.equal(initial.includes('human_authored_semantic_rubric'), false);
    assert.deepEqual(requests[0].tools.map(t => t.function.name), ['read_document']);
    assert.equal(requests[1].messages.filter(m => m.role === 'tool').length, 2);
    for (const body of requests) assert.equal(body.max_tokens ?? body.max_completion_tokens, 4096);
    assert.equal(reservations.length, 2); assert.ok(reservations.every(r => r.contextBytes <= 60000));
    t.diagnostic(JSON.stringify({ syntheticCase: name, contextBytes: reservations.map(r => r.contextBytes), outputReferenceBytes: Buffer.byteLength(JSON.stringify(reference)), paidRequests: 0 }));
    assert.equal(JSON.stringify(input), before); assert.equal(JSON.stringify(outcome).includes('quality-synthetic-secret'), false);
  });
  test(`B3 质量矩阵 ${name}：顺序、编号和合法同义属性名变化仍可处理`, async () => {
    const original = fixture(name);
    const mapping = new Map<string, string>();
    function collect(value: unknown, field = '') {
      if (typeof value === 'string' && /Id$/.test(field) && !['sessionId'].includes(field)) mapping.set(value, value.startsWith('b00') ? value.replace('b00', 'b80') : value + '_variant');
      else if (Array.isArray(value)) value.forEach(v => collect(v, field));
      else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) collect(v, k);
    }
    collect(original.input); collect(original.reference);
    const remap = <T>(value: T): T => JSON.parse(JSON.stringify(value), (_key, v) => typeof v === 'string' ? mapping.get(v) ?? v : v) as T;
    const input = remap(original.input), output = remap(original.reference);
    input.documents.reverse(); input.scope.documentRefs.reverse();
    output.candidateSnapshot.claims.reverse(); output.candidateSnapshot.evidence.reverse(); output.candidateSnapshot.entities.reverse();
    output.candidateSnapshot.coverage.documentsProcessed.reverse();
    const predicates: Record<string, string> = { maintenance_spend: 'equipment_maintenance_expenditure', rd_headcount: 'research_staff_count', filter_form: 'filter_structure' };
    for (const claim of output.candidateSnapshot.claims) claim.predicate = predicates[claim.predicate] ?? claim.predicate;
    for (const claim of output.candidateSnapshot.claims) claim.evidenceRefs.reverse();
    assert.deepEqual(validate(input, output).issues, []);
    const run = await replay(input, output);
    assert.equal(run.outcome.status, 'needs_information', JSON.stringify(run.outcome));
    assert.deepEqual(run.records[0].output?.candidateSnapshot.claims, output.candidateSnapshot.claims);
  });
}

test('B3 数值：小数/零/百分数和年度/季度限定未被统一为同一口径', () => {
  const s = fixture('quantities').reference.candidateSnapshot;
  assert.deepEqual(s.claims.map(c => [c.predicate, c.value, c.qualifiers]), [
    ['maintenance_spend', { type: 'quantity', normalized: 12.5, unit: '万元', raw: '12.50万元' }, { time: { year: 2023 }, basis: '年度设备维护支出，不含税' }],
    ['maintenance_spend', { type: 'quantity', normalized: 125000, unit: '元', raw: '125000元' }, { time: { year: 2024 }, basis: '年度设备维护支出，含税' }],
    ['planned_downtime', { type: 'quantity', normalized: 0, unit: '小时', raw: '0小时' }, { time: { year: 2024 }, basis: '计划停机' }],
    ['sample_defect_rate', { type: 'quantity', normalized: 0.8, unit: '%', raw: '0.8%' }, { time: { year: 2024, period: '第三季度' }, basis: '成品抽检，样本500件' }],
  ]);
  assert.equal(s.conflicts.length, 0); assert.equal(s.missing[0].expectedPredicate, 'main_business_revenue');
  assert.equal(s.claims.some(c => c.predicate === 'main_business_revenue'), false);
});
test('B3 归并：同年同口径真冲突、跨年/口径假冲突与双来源重复分开保留', () => {
  const s = fixture('reconciliation').reference.candidateSnapshot;
  assert.equal(s.claims.length, 4); assert.equal(s.claims.find(c => c.claimId === 'claim_prior')!.evidenceRefs.length, 2);
  assert.deepEqual(s.conflicts[0].claimRefs, ['claim_registered_a', 'claim_registered_b']);
  assert.equal(s.conflicts[0].resolutionStatus, 'open');
  for (const claim of s.claims) assert.equal(claim.supportStatus, s.conflicts[0].claimRefs.includes(claim.claimId) ? 'conflicted' : 'supported');
  assert.equal(s.claims.find(c => c.claimId === 'claim_project')!.qualifiers!.basis, '全年参与项目');
});
test('B3 非公司简介属性、完整日期、负数范围及未解析块可保留而不猜测内容', () => {
  const { input, reference } = fixture('coverage'), s = reference.candidateSnapshot;
  assert.deepEqual(s.claims.map(c => [c.predicate, c.value]), [
    ['filter_form', { type: 'text', text: '可拆卸滤芯', raw: '采用可拆卸滤芯' }],
    ['rated_temperature_range', { type: 'text', text: '-10至45摄氏度', raw: '-10至45摄氏度' }],
  ]);
  assert.equal(s.events![0].entityId, 'ent_device'); assert.equal(s.events![0].time!.period, '2024年6月15日');
  assert.deepEqual(s.missing.map(m => m.expectedPredicate), ['spare_filter_count', 'temperature_test_conditions']);
  assert.deepEqual(s.coverage.unsupported?.map(u => [u.documentId, u.blockId]), [['doc_c_b', 'b002']]);
  assert.equal(documentCatalog(input)[1].blocks[1].readable, false);
});
test('B3 两资料复用块编号：一份读取不能替另一份来源或版本背书', () => {
  const { input, reference } = fixture('reconciliation');
  const sameBlock = receipts(input); assert.equal(sameBlock[0].blockId, sameBlock[1].blockId);
  const absent = validate(input, reference, sameBlock.slice(0, 1));
  assert.ok(absent.issues.some(i => i.code === 'evidence.not_read'));
  assert.ok(absent.issues.some(i => i.code === 'coverage.not_read'));
  const forged = structuredClone(reference); forged.candidateSnapshot.evidence[1].documentVersionId = 'docv_foreign_1';
  assert.equal(validate(input, forged).ok, false);
});
test('B3 来源覆盖负例：重复processed/unsupported、漏块和假装完整均拒绝', () => {
  const { input, reference } = fixture('coverage');
  const overlap = structuredClone(reference); overlap.candidateSnapshot.coverage.documentsProcessed[1].blockIds.push('b002');
  assert.ok(validate(input, overlap).issues.some(i => i.code === 'coverage.duplicate_block'));
  const omitted = structuredClone(reference); omitted.candidateSnapshot.coverage.unsupported = [];
  assert.ok(validate(input, omitted).issues.some(i => i.code === 'coverage.parser_limitation_omitted'));
  const completed = structuredClone(reference); completed.status = 'completed'; delete completed.stopReason;
  assert.ok(validate(input, completed).issues.some(i => i.code === 'coverage.partial_parse'));
});
test('B3 修正必须保留合法数值、单位、年份、口径，不能靠少报问题通过', () => {
  const { input, reference } = fixture('quantities');
  const mutators: Array<(o: EvidenceOutput) => void> = [
    o => { const c = o.candidateSnapshot.claims[0]; assert.equal(c.value.type, 'quantity'); if (c.value.type === 'quantity') c.value.unit = '元'; },
    o => { o.candidateSnapshot.claims[0].qualifiers!.time!.year = 2024; },
    o => { o.candidateSnapshot.claims[0].qualifiers!.basis = '含税'; },
    o => { o.candidateSnapshot.missing = []; },
  ];
  for (const mutate of mutators) {
    const next = structuredClone(reference); mutate(next);
    assert.ok(validate(input, next, receipts(input), reference).issues.some(i => ['repair.changed_fact', 'repair.removed_item'].includes(i.code)));
  }
});
test('B3 多源结构修正经 SDK 保留两侧冲突及来源；删除冲突会失败并留存两版', async t => {
  const { input, reference } = fixture('reconciliation');
  const pass = await replay(input, reference, (o, n) => n === 2 ? { ...o, extraneous: true } : o);
  assert.equal(pass.outcome.status, 'needs_information'); assert.equal(pass.outcome.repairAttempts, 1);
  assert.equal(pass.records.length, 2); assert.equal(pass.records[0].state, 'invalid');
  assert.deepEqual(pass.records[1].output?.candidateSnapshot.conflicts, reference.candidateSnapshot.conflicts);
  const fail = await replay(input, reference, (o, n) => {
    if (n === 2) return { ...o, extraneous: true };
    o.candidateSnapshot.conflicts = [];
    for (const claim of o.candidateSnapshot.claims) { claim.supportStatus = 'supported'; delete claim.conflictGroupId; }
    return o;
  });
  assert.equal(fail.outcome.reason, 'invalid_candidate'); assert.equal(fail.outcome.repairAttempts, 1);
  assert.ok(fail.outcome.issues.some(i => i.code === 'repair.removed_item'));
  assert.equal(fail.records.length, 2); assert.ok(fail.records.every(r => r.state === 'invalid'));
  assert.equal(fail.outcome.modelCalls, 3);
  assert.ok(pass.reservations.every(r => r.contextBytes <= 60000));
  t.diagnostic(JSON.stringify({ syntheticRepairContextBytes: pass.reservations.map(r => r.contextBytes), paidRequests: 0 }));
});
test('B3 人工语义负例即使程序接受也只能待审，禁止伪造自动语义通过', () => {
  const variants: Array<[string, 'quantities' | 'reconciliation' | 'coverage', (o: EvidenceOutput) => void]> = [
    ['金额错单位', 'quantities', o => { const v = o.candidateSnapshot.claims[0].value; if (v.type === 'quantity') v.unit = '元'; }],
    ['跨年误归类', 'quantities', o => { o.candidateSnapshot.claims[0].qualifiers!.time!.year = 2024; }],
    ['丢失百分比口径', 'quantities', o => { o.candidateSnapshot.claims[3].qualifiers!.basis = '全体成品'; }],
    ['删除重复事实的另一来源', 'reconciliation', o => { o.candidateSnapshot.claims[0].evidenceRefs.pop(); }],
    ['擅自消除真冲突', 'reconciliation', o => { o.candidateSnapshot.conflicts = []; o.candidateSnapshot.claims.splice(2, 1); for (const c of o.candidateSnapshot.claims) { c.supportStatus = 'supported'; delete c.conflictGroupId; } }],
    ['丢负号缩范围', 'coverage', o => { o.candidateSnapshot.claims[1].value = { type: 'text', text: '10至45摄氏度' }; }],
    ['把装置启用当组织成立', 'coverage', o => { o.candidateSnapshot.events![0].entityId = 'ent_org'; o.candidateSnapshot.events![0].eventType = 'founded'; }],
  ];
  for (const [label, name, mutate] of variants) {
    const { input, reference } = fixture(name), wrong = structuredClone(reference); mutate(wrong);
    assert.notDeepEqual(wrong, reference, label);
    assert.equal(validate(input, wrong).ok, true, `${label}: 结构/溯源无法证明此语义，必须留给独立核对`);
    assert.equal(wrong.candidateSnapshot.reviewStatus, 'pending');
  }
});
test('B3 合成矩阵实测输入上限与显式付费禁用声明，目录不带原文或预期答案', () => {
  const manifest = loadFixture<{ paidExecutionAuthorized: boolean; proposedLiveLimits: typeof qualityLimits }>('b3-quality/manifest.json');
  assert.equal(manifest.paidExecutionAuthorized, false);
  assert.equal(manifest.proposedLiveLimits.maxContextBytes, 60000);
  for (const name of cases) {
    const { input, reference } = fixture(name), { snapshotId, snapshotVersionId, createdAt, producedBy } = reference.candidateSnapshot;
    const prompt = evidenceTaskPrompt(input, { snapshotId, snapshotVersionId, createdAt, producedBy }, registry, qualityLimits);
    assert.ok(Buffer.byteLength(prompt) < 30000);
    const catalog = JSON.stringify(documentCatalog(input));
    assert.equal(catalog.includes('normalized'), false);
    for (const d of input.documents) for (const b of d.blocks) if (b.text) assert.equal(catalog.includes(b.text), false);
  }
});

test('B3 未支持页面区域定位在输入阶段拒绝，不降低原有来源规则', async () => {
  const { input, reference } = fixture('coverage');
  input.documents[1].blocks[1].type = 'image';
  input.documents[1].blocks[1].location = { kind: 'page_region', page: 1, bbox: { x: 0, y: 0, width: 100, height: 100 } };
  assert.ok(checkEvidenceInput(input, registry).issues.some(i => i.code === 'location.not_verified'));
  const result = await replay(input, reference);
  assert.equal(result.outcome.reason, 'invalid_input');
  assert.equal(result.requests.length, 0); assert.equal(result.reservations.length, 0); assert.equal(result.records.length, 0);
});
