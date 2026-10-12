/** B4 审查用例回归：7 个固定候选 case（各自注册 test）+ 1 个隔离性/unknown 用例。
 *  纯合成夹具，不代表真实模型评审质量；生产已知缺陷须使断言失败。 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { B4_CASE_IDS, makeB4Case, type B4Case, type B4CaseId } from '../../evals/fixtures/b4-cases.ts';
import { registry } from '../helpers/fixtures.ts';
import { prepareReviewInput } from '../../apps/server/src/agents/review/context.ts';
import { fingerprint } from '../../packages/contracts/src/fingerprint.ts';
import type { EvidenceSnapshot } from '../../packages/contracts/generated/evidence-snapshot.ts';

/** 10 项检查的规范集合（与夹具 ALL_CHECKS 的成员一致）。 */
const ALL_CHECK_TYPES = ['basis', 'conflict', 'entity_match', 'missing', 'source_locator', 'support', 'time', 'traceability', 'unit', 'value'] as const;

/** 依据 claimId 取候选事实；缺失即失败。 */
function claimOf(snapshot: EvidenceSnapshot, claimId: string) {
  const found = snapshot.claims.find(c => c.claimId === claimId);
  assert.ok(found, `缺少 claim ${claimId}`);
  return found;
}

/** 断言该 claim 的取值是数量值，并返回规范化数值与单位。 */
function quantityOf(snapshot: EvidenceSnapshot, claimId: string): { normalized: number; unit: string } {
  const value = claimOf(snapshot, claimId).value as { type?: string; normalized?: number; unit?: string };
  assert.equal(value.type, 'quantity', `${claimId} 的 value 应为 quantity`);
  assert.equal(typeof value.normalized, 'number', `${claimId} 缺少 normalized`);
  assert.equal(typeof value.unit, 'string', `${claimId} 缺少 unit`);
  return { normalized: value.normalized as number, unit: value.unit as string };
}

/** 读取 claim 的时间限定年份。 */
function timeYearOf(snapshot: EvidenceSnapshot, claimId: string): number | undefined {
  const qualifiers = claimOf(snapshot, claimId).qualifiers as { time?: { year?: number } } | undefined;
  return qualifiers?.time?.year;
}

/** 读取 claim 的依据口径。 */
function basisOf(snapshot: EvidenceSnapshot, claimId: string): string | undefined {
  const qualifiers = claimOf(snapshot, claimId).qualifiers as { basis?: string } | undefined;
  return qualifiers?.basis;
}

/** 每个 case 的基础来源都应为 B4 专用单块合成来源（docv_b4_source_1）。 */
function assertB4SourceContract(c: B4Case): void {
  const { input, snapshot } = c;
  const doc = input.documents.find(d => d.documentId === 'doc_profile');
  assert.ok(doc, '缺少 doc_profile 基础来源');
  assert.equal(doc.documentVersionId, 'docv_b4_source_1', '基础来源版本应为 docv_b4_source_1');
  assert.equal(doc.blocks.length, 1, '基础来源应仅含一个块');

  const block = doc.blocks[0] as unknown as {
    blockId: string;
    text: string;
    index: number;
    location: { kind: string; paragraphIndex: number };
  };
  assert.equal(block.blockId, 'b004', '唯一块应为 b004');
  assert.equal(block.index, 0, '唯一块 index 应为 0');
  assert.equal(block.location.kind, 'paragraph', 'b004 location 应为 paragraph');
  assert.equal(block.location.paragraphIndex, 0, 'b004 location.paragraphIndex 应为 0');
  assert.equal(block.text, '截至 2025 年，公司研发人员 60 人。', 'b004 文本应为唯一合成事实');
  assert.equal(doc.contentHash, fingerprint(doc.blocks), '基础来源 contentHash 应为 blocks 指纹');

  // scope/evidence/coverage 的版本与块必须与来源一致。
  assert.ok(
    input.scope.documentRefs.some(r => r.documentId === 'doc_profile' && r.documentVersionId === 'docv_b4_source_1'),
    'scope.documentRefs 应引用 docv_b4_source_1',
  );
  const ev = snapshot.evidence.find(e => e.evidenceId === 'ev_rd_60');
  assert.ok(ev, '缺少 ev_rd_60');
  assert.equal(ev.documentId, 'doc_profile');
  assert.equal(ev.documentVersionId, 'docv_b4_source_1');
  assert.equal(ev.excerpt, '截至 2025 年，公司研发人员 60 人。');
  const evLoc = (ev as unknown as { locator: { kind: string; paragraphIndex: number } }).locator;
  assert.equal(evLoc.kind, 'paragraph', 'ev_rd_60 locator 应为 paragraph');
  assert.equal(evLoc.paragraphIndex, 0, 'ev_rd_60 locator.paragraphIndex 应为 0');
  const cov = snapshot.coverage.documentsProcessed.find(e => e.documentId === 'doc_profile');
  assert.ok(cov, 'coverage 缺少 doc_profile');
  assert.equal(cov.documentVersionId, 'docv_b4_source_1');
  assert.deepEqual(cov.blockIds, ['b004']);
}
/** 每个 case 都必须满足：pending、10 项检查、expected 不混入业务输入、subject 绑定版本与指纹。 */
function assertCommonContract(c: B4Case): void {
  const { input, snapshot } = c;

  // expected 仅供离线评分，严禁混入 input/snapshot。
  assert.equal(Object.prototype.hasOwnProperty.call(input, 'expected'), false, 'input 不得含 expected');
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'expected'), false, 'snapshot 不得含 expected');

  // subject 绑定 snapshotVersionId 与 fingerprint(snapshot)。
  const subject = input.subject as unknown as Record<string, unknown>;
  assert.equal(subject.contentHash, fingerprint(snapshot), 'subject.contentHash 应为 snapshot 指纹');
  assert.ok(JSON.stringify(input.subject).includes(snapshot.snapshotVersionId), 'subject 应绑定 snapshotVersionId');

  // 全部 pending。
  assert.equal(snapshot.reviewStatus, 'pending');
  for (const claim of snapshot.claims) assert.equal(claim.reviewStatus, 'pending');

  // 显式要求 10 项检查。
  assert.equal(input.checksRequired.length, 10);
  assert.deepEqual([...input.checksRequired].sort(), [...ALL_CHECK_TYPES]);
}

/** 按 case 证据事实逐项核对。 */
function assertCaseFacts(id: B4CaseId, c: B4Case): void {
  const { input, snapshot } = c;

  assert.equal(c.expected.verdict, id === 'correct' ? 'pass' : 'nonpass');
  if (id !== 'correct') assert.ok(c.expected.category, `${id} 应给出 expected.category`);

  switch (id) {
    case 'correct': {
      const q = quantityOf(snapshot, 'claim_rd_60');
      assert.equal(q.normalized, 60);
      assert.equal(q.unit, '人');
      assert.equal(timeYearOf(snapshot, 'claim_rd_60'), 2025);
      const entity = snapshot.entities.find(e => e.entityId === 'ent_rd');
      assert.ok(entity, '缺少实体 ent_rd');
      assert.ok(entity.label.includes('研发'), 'correct 实体应指向研发人员数');
      assert.equal(snapshot.conflicts.length, 0);
      assert.equal(snapshot.missing.length, 0);
      break;
    }
    case 'value': {
      assert.equal(quantityOf(snapshot, 'claim_rd_60').normalized, 600);
      break;
    }
    case 'unit': {
      const q = quantityOf(snapshot, 'claim_rd_60');
      assert.equal(q.normalized, 60);
      assert.equal(q.unit, '亿元');
      break;
    }
    case 'time': {
      assert.equal(timeYearOf(snapshot, 'claim_rd_60'), 2023);
      break;
    }
    case 'entity': {
      const entity = snapshot.entities.find(e => e.entityId === 'ent_rd');
      assert.ok(entity, '缺少实体 ent_rd');
      assert.equal(entity.label, '财务人员数');
      break;
    }
    case 'missing': {
      assert.equal(snapshot.missing.length, 1);
      const missing = snapshot.missing.find(m => m.expectedPredicate === 'net_profit');
      assert.ok(missing, '缺少 net_profit 缺失项');
      assert.equal(missing.severity, 'error');
      break;
    }
    case 'conflict': {
      const c60 = claimOf(snapshot, 'claim_rd_60');
      const c55 = claimOf(snapshot, 'claim_rd_55');
      assert.equal(c60.predicate, c55.predicate, '两条 claim 口径（predicate）应相同');
      assert.equal(timeYearOf(snapshot, 'claim_rd_60'), timeYearOf(snapshot, 'claim_rd_55'));
      assert.equal(basisOf(snapshot, 'claim_rd_60'), basisOf(snapshot, 'claim_rd_55'));
      assert.equal(quantityOf(snapshot, 'claim_rd_60').normalized, 60);
      assert.equal(quantityOf(snapshot, 'claim_rd_55').normalized, 55);

      const evidenceOf = (refs: string[]) => snapshot.evidence.find(e => refs.includes(e.evidenceId));
      const ev60 = evidenceOf(c60.evidenceRefs);
      const ev55 = evidenceOf(c55.evidenceRefs);
      assert.ok(ev60 && ev55, '两条 claim 都应有证据');
      assert.notEqual(ev60.documentId, ev55.documentId, '冲突应来自不同授权文档');
      assert.equal(ev55.documentId, 'doc_secondary');

      const secondary = input.documents.find(d => d.documentId === 'doc_secondary');
      assert.ok(secondary, '缺少第二份合成资料');
      const block = secondary.blocks.find(b => b.blockId === 'b004');
      assert.ok(block, '第二份资料缺少 b004');
      assert.equal(secondary.blocks.length, 1, '第二份资料应仅含一个块');
      assert.equal(secondary.documentVersionId, 'docv_secondary_1');
      assert.equal(secondary.contentHash, fingerprint(secondary.blocks), '第二份来源 contentHash 应为 blocks 指纹');
      const secCov = snapshot.coverage.documentsProcessed.find(e => e.documentId === 'doc_secondary');
      assert.ok(secCov, 'coverage 缺少 doc_secondary');
      assert.equal(secCov.documentVersionId, 'docv_secondary_1');
      assert.deepEqual(secCov.blockIds, ['b004']);
      assert.ok(block.text.includes('55'), '第二份来源文本确实为 55');
      break;
    }
  }
}

for (const id of B4_CASE_IDS) {
  test(`b4 case ${id}`, () => {
    const c = makeB4Case(id);
    assert.equal(c.id, id);
    assertCommonContract(c);
    assertB4SourceContract(c);
    assertCaseFacts(id, c);
    // prepareReviewInput(input, snapshot, registry) 成功即可。
    assert.doesNotThrow(() => prepareReviewInput(c.input, c.snapshot, registry));
  });
}

test('b4 cases 隔离性：unknown 抛错、版本唯一、独立克隆互不影响', () => {
  // 未知 id 抛错。
  assert.throws(() => makeB4Case('unknown-case-id'), /unknown B4 case id/);

  // 7 个 case 的 snapshotVersionId 唯一。
  const versions = B4_CASE_IDS.map(id => makeB4Case(id).snapshot.snapshotVersionId);
  assert.equal(new Set(versions).size, B4_CASE_IDS.length, '7 个 case 的 snapshotVersionId 应唯一');
  for (const v of versions) assert.ok(v.startsWith('snapv_b4_'), `版本号异常：${v}`);

  // 同 case 两次独立克隆互不影响。
  const a = makeB4Case('value');
  const b = makeB4Case('value');
  assert.notEqual(a.snapshot, b.snapshot);
  assert.notEqual(a.input, b.input);
  const snapshotBefore = JSON.stringify(b.snapshot);
  const inputBefore = JSON.stringify(b.input);

  a.snapshot.claims = [];
  if (a.snapshot.entities.length > 0) a.snapshot.entities[0].label = 'MUTATED';
  a.snapshot.missing.push({ missingId: 'missing_mutated', description: 'mutated', severity: 'error' });
  a.input.subject.contentHash = 'sha256:mutated';

  assert.equal(JSON.stringify(b.snapshot), snapshotBefore, '克隆 a 的改动不得影响 b 的 snapshot');
  assert.equal(JSON.stringify(b.input), inputBefore, '克隆 a 的改动不得影响 b 的 input');
  assert.equal(a.snapshot.claims.length, 0, 'a 的改动确实生效（非无效操作）');
});
