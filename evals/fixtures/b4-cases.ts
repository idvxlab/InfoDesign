/** B4 审查验收固定纯虚构候选夹具。
 *
 *  仅创建夹具，不调用任何模型；所有内容均为合成虚构数据，不代表真实资料或真实模型评审质量。
 *  expected 仅供调用方离线评分使用，严禁混入 input 或 snapshot。
 */
import type { ReviewInput, ReviewReport } from '../../packages/contracts/generated/index.ts';
import type { EvidenceSnapshot } from '../../packages/contracts/generated/evidence-snapshot.ts';
import { fingerprint } from '../../packages/contracts/src/fingerprint.ts';
import { baseSnapshot, makeInput } from '../../tests/helpers/review-harness.ts';

/** 与 review checks 共用同一 checkType 联合，避免依赖未知的具名导入路径。 */
type CommonCheckType = ReviewReport['checks'][number]['checkType'];

export const B4_CASE_IDS = ['correct', 'value', 'unit', 'time', 'entity', 'missing', 'conflict'] as const;
export type B4CaseId = (typeof B4_CASE_IDS)[number];

export interface B4Expected {
  verdict: 'pass' | 'nonpass';
  category?: CommonCheckType;
  claimId?: string;
}

export interface B4Case {
  id: B4CaseId;
  input: ReviewInput;
  snapshot: EvidenceSnapshot;
  expected: B4Expected;
}

/** 显式要求全部 10 项检查。 */
const ALL_CHECKS = [
  'support',
  'entity_match',
  'value',
  'unit',
  'time',
  'basis',
  'source_locator',
  'missing',
  'conflict',
  'traceability',
] as const;

const EXPECTED: Record<B4CaseId, B4Expected> = {
  correct: { verdict: 'pass' },
  value: { verdict: 'nonpass', category: 'value' as CommonCheckType, claimId: 'claim_rd_60' },
  unit: { verdict: 'nonpass', category: 'unit' as CommonCheckType, claimId: 'claim_rd_60' },
  time: { verdict: 'nonpass', category: 'time' as CommonCheckType, claimId: 'claim_rd_60' },
  entity: { verdict: 'nonpass', category: 'entity_match' as CommonCheckType, claimId: 'claim_rd_60' },
  missing: { verdict: 'nonpass', category: 'missing' as CommonCheckType },
  conflict: { verdict: 'nonpass', category: 'conflict' as CommonCheckType },
};

/** 按 case 编号与 claim 序号重写 claimVersionId，不使用语义名暗示答案。 */
function renumberClaims(snapshot: EvidenceSnapshot, index: number): void {
  snapshot.claims.forEach((claim, i) => {
    claim.claimVersionId = `claimv_b4_${index}_${i + 1}`;
  });
}

/** 让 input.subject 与 snapshot 的版本/内容身份保持匹配，并重算 contentHash。 */
function syncIdentity(input: ReviewInput, snapshot: EvidenceSnapshot): void {
  const subject = input.subject as unknown as Record<string, unknown>;
  const version = snapshot.snapshotVersionId;
  for (const key of ['snapshotVersionId', 'subjectVersionId', 'versionId']) {
    if (key in subject) subject[key] = version;
  }
  subject.contentHash = fingerprint(snapshot);
}

/** B4 专用合成来源：仅保留 b004 一块，文本不含收入等独立事实。 */
const B4_SOURCE_BLOCK_ID = 'b004';
const B4_SOURCE_VERSION = 'docv_b4_source_1';
const B4_SOURCE_TEXT = '截至 2025 年，公司研发人员 60 人。';

/** 把基础来源收窄为仅含 b004 的合成单块来源，并同步 scope/evidence/coverage 的版本与块。 */
function setB4Source(input: ReviewInput, snapshot: EvidenceSnapshot): void {
  const doc = input.documents[0] as unknown as {
    documentId: string;
    documentVersionId: string;
    contentHash: string;
    blocks: Array<{
      blockId: string;
      text: string;
      index: number;
      location: { kind: string; paragraphIndex: number };
    } & Record<string, unknown>>;
  };
  const block = doc.blocks.find(b => b.blockId === B4_SOURCE_BLOCK_ID);
  if (!block) throw new Error('基础来源缺少 b004');
  block.text = B4_SOURCE_TEXT;
  block.index = 0;
  block.location.paragraphIndex = 0;
  doc.blocks = [block];
  doc.documentVersionId = B4_SOURCE_VERSION;
  doc.contentHash = fingerprint(doc.blocks);

  for (const ref of input.scope.documentRefs) {
    if (ref.documentId === doc.documentId) ref.documentVersionId = B4_SOURCE_VERSION;
  }

  for (const evidence of snapshot.evidence) {
    evidence.documentId = doc.documentId;
    evidence.documentVersionId = B4_SOURCE_VERSION;
    evidence.excerpt = B4_SOURCE_TEXT;
    (evidence as unknown as { locator: { paragraphIndex: number } }).locator.paragraphIndex = 0;
  }

  for (const entry of snapshot.coverage.documentsProcessed) {
    if (entry.documentId === doc.documentId) {
      entry.documentVersionId = B4_SOURCE_VERSION;
      entry.blockIds = [B4_SOURCE_BLOCK_ID];
    }
  }
}

function build(id: B4CaseId, index: number): B4Case {
  // 每次独立深克隆：baseSnapshot 每次从 rawSnapshot 重新克隆。
  const snapshot = baseSnapshot();
  const input = makeInput(snapshot);
  setB4Source(input, snapshot);

  switch (id) {
    case 'correct': {
      // 保持正确，不做候选改动。
      break;
    }
    case 'value': {
      const claim = snapshot.claims.find(c => c.claimId === 'claim_rd_60')!;
      claim.value = { type: 'quantity', normalized: 600, unit: '人', raw: '600 人' };
      break;
    }
    case 'unit': {
      const claim = snapshot.claims.find(c => c.claimId === 'claim_rd_60')!;
      claim.value = { type: 'quantity', normalized: 60, unit: '亿元', raw: '60亿元' };
      break;
    }
    case 'time': {
      const claim = snapshot.claims.find(c => c.claimId === 'claim_rd_60')!;
      claim.qualifiers = { time: { year: 2023 }, basis: '截至2023年' };
      break;
    }
    case 'entity': {
      const entity = snapshot.entities.find(e => e.entityId === 'ent_rd')!;
      entity.label = '财务人员数';
      break;
    }
    case 'missing': {
      snapshot.missing = [
        {
          missingId: 'missing_net_profit',
          expectedPredicate: 'net_profit',
          description: '任务必须披露2025年净利润，现有资料未提供净利润。',
          severity: 'error',
        },
      ];
      break;
    }
    case 'conflict': {
      // 克隆 doc_profile 为合成二级来源，仅把 b004 的 60 改为 55。
      const sourceDoc = input.documents[0];
      const clonedDoc = structuredClone(sourceDoc);
      const docRecord = clonedDoc as unknown as Record<string, unknown>;
      docRecord.documentId = 'doc_secondary';
      docRecord.documentVersionId = 'docv_secondary_1';
      docRecord.sourceName = '合成资料（B4夹具，非真实模型）';
      const block = clonedDoc.blocks.find(b => b.blockId === 'b004');
      if (block) block.text = block.text.replace('60', '55');
      docRecord.contentHash = fingerprint(clonedDoc.blocks);
      input.documents.push(clonedDoc);
      input.scope.documentRefs.push({ documentId: 'doc_secondary', documentVersionId: 'docv_secondary_1' });
      snapshot.coverage.documentsProcessed.push({
        documentId: 'doc_secondary',
        documentVersionId: 'docv_secondary_1',
        blockIds: clonedDoc.blocks.map(b => b.blockId),
      });

      // 新证据指向合成来源，excerpt 取新的 b004 文本。
      const newEvidence = structuredClone(snapshot.evidence.find(e => e.evidenceId === 'ev_rd_60')!);
      newEvidence.evidenceId = 'ev_rd_55';
      newEvidence.documentId = 'doc_secondary';
      newEvidence.documentVersionId = 'docv_secondary_1';
      if (block) newEvidence.excerpt = block.text;
      snapshot.evidence.push(newEvidence);

      // 同年同口径的第二条 claim（2025 / 截至2025年），值 55 人。
      const baseClaim = snapshot.claims.find(c => c.claimId === 'claim_rd_60')!;
      const newClaim = structuredClone(baseClaim);
      newClaim.claimId = 'claim_rd_55';
      newClaim.claimVersionId = 'claimv_rd_55_1';
      newClaim.value = { type: 'quantity', normalized: 55, unit: '人', raw: '55 人' };
      newClaim.evidenceRefs = ['ev_rd_55'];
      newClaim.supportStatus = 'conflicted';
      newClaim.reviewStatus = 'pending';
      snapshot.claims.push(newClaim);

      snapshot.conflicts = [
        {
          conflictId: 'conflict_b4',
          claimRefs: ['claim_rd_60', 'claim_rd_55'],
          description: '同一口径 2025 年研发人员数在两份合成资料中分别为 60 人与 55 人，需人工确认。',
          resolutionStatus: 'open',
        },
      ];
      break;
    }
  }

  // 版本与序号按 case 编号更新，reviewStatus 一律 pending。
  snapshot.snapshotVersionId = `snapv_b4_${index}`;
  renumberClaims(snapshot, index);
  for (const claim of snapshot.claims) claim.reviewStatus = 'pending';
  snapshot.reviewStatus = 'pending';

  snapshot.coverage.documentsProcessed = snapshot.coverage.documentsProcessed.map(entry => ({ ...entry }));
  input.checksRequired = [...ALL_CHECKS] as unknown as ReviewInput['checksRequired'];
  syncIdentity(input, snapshot);

  return { id, input, snapshot, expected: { ...EXPECTED[id] } };
}

/** 返回指定 case 的独立深克隆夹具；未知 id 抛错。 */
export function makeB4Case(id: string): B4Case {
  const index = (B4_CASE_IDS as readonly string[]).indexOf(id);
  if (index < 0) throw new Error(`unknown B4 case id: ${id}`);
  return build(id as B4CaseId, index + 1);
}
