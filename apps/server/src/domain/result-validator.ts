/** B3 确定性检查：结构/来源/实际读取/覆盖/修正保留，不替代语义审查。 */
import type { EvidenceInput, EvidenceOutput, ReadDocumentResult } from '../../../../packages/contracts/generated/index.ts';
import { checkEvidenceOutput, EVIDENCE_OUTPUT_ID, type CheckResult, type CheckIssue } from '../../../../packages/contracts/src/service-checks.ts';
import type { SchemaRegistry } from '../../../../packages/contracts/src/schema-registry.ts';
import { canonicalize } from '../../../../packages/contracts/src/validator.ts';
import type { CandidateEnvelope } from '../agents/evidence/context.ts';

const key = (d: { documentId: string; documentVersionId: string; blockId: string }) => JSON.stringify([d.documentId, d.documentVersionId, d.blockId]);
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function validateEvidenceCandidate(raw: unknown, input: EvidenceInput, envelope: CandidateEnvelope, receipts: ReadDocumentResult[], registry: SchemaRegistry, previous?: unknown): CheckResult {
  const checked = checkEvidenceOutput(record(raw), input, registry);
  const issues: CheckIssue[] = [...checked.issues];
  const add = (code: string, path: string) => issues.push({ code, path, message: code });
  if (!registry.validate(EVIDENCE_OUTPUT_ID, raw).valid) return { ok: false, issues };
  const output = raw as EvidenceOutput;
  const snapshot = output.candidateSnapshot;
  if (!['completed', 'needs_information', 'blocked', 'failed'].includes(output.status)) add('candidate.unsupported_status', 'status');
  for (const field of ['snapshotId', 'snapshotVersionId', 'createdAt', 'producedBy'] as const) {
    if (canonicalize(snapshot[field]) !== canonicalize(envelope[field])) add('candidate.envelope_mismatch', 'candidateSnapshot.' + field);
  }
  if (canonicalize(output.producedBy) !== canonicalize(envelope.producedBy)) add('candidate.provenance_mismatch', 'producedBy');
  if (snapshot.basedOnSnapshotVersionId !== undefined || output.changes?.some(c => c.changeType !== 'added')) add('candidate.update_not_supported', 'candidateSnapshot');
  const read = new Set(receipts.map(key));
  for (const [i, entry] of snapshot.evidence.entries()) if (!read.has(key(entry))) add('evidence.not_read', 'candidateSnapshot.evidence[' + i + ']');
  for (const [i, asset] of (snapshot.assets ?? []).entries()) if (!read.has(key(asset))) add('asset.not_read', 'candidateSnapshot.assets[' + i + ']');

  const processed = new Set<string>(), unsupported = new Set<string>(), documents = new Set<string>();
  for (const [i, entry] of snapshot.coverage.documentsProcessed.entries()) {
    const docKey = JSON.stringify([entry.documentId, entry.documentVersionId]);
    if (documents.has(docKey)) add('coverage.duplicate_document', 'candidateSnapshot.coverage.documentsProcessed[' + i + ']');
    documents.add(docKey);
    for (const blockId of entry.blockIds) {
      const blockKey = key({ ...entry, blockId });
      if (processed.has(blockKey)) add('coverage.duplicate_block', 'candidateSnapshot.coverage');
      if (!read.has(blockKey)) add('coverage.not_read', 'candidateSnapshot.coverage');
      processed.add(blockKey);
    }
  }
  for (const entry of snapshot.coverage.unsupported ?? []) {
    const doc = input.documents.find(d => d.documentId === entry.documentId);
    if (!doc || !doc.blocks.some(b => b.blockId === entry.blockId)) { add('coverage.unknown_unsupported', 'candidateSnapshot.coverage.unsupported'); continue; }
    const blockKey = key({ ...doc, blockId: entry.blockId });
    if (unsupported.has(blockKey) || processed.has(blockKey)) add('coverage.duplicate_block', 'candidateSnapshot.coverage.unsupported');
    unsupported.add(blockKey);
  }
  for (const doc of input.documents) {
    for (const block of doc.blocks) {
      const blockKey = key({ ...doc, blockId: block.blockId });
      if (!processed.has(blockKey) && !unsupported.has(blockKey)) add('coverage.omitted_block', 'candidateSnapshot.coverage');
      if (doc.parseInfo?.unsupported?.some(u => u.blockId === block.blockId) && !unsupported.has(blockKey)) add('coverage.parser_limitation_omitted', 'candidateSnapshot.coverage');
    }
  }
  for (const entry of [...snapshot.evidence, ...(snapshot.assets ?? [])]) {
    if (!processed.has(key(entry))) add('evidence.outside_processed_coverage', 'candidateSnapshot.coverage');
  }
  const unresolved = snapshot.conflicts.some(c => c.resolutionStatus !== 'resolved');
  if (output.status === 'completed' && input.documents.some(d => d.parseInfo && d.parseInfo.quality !== 'complete')) add('coverage.partial_parse', 'status');
  if (output.status === 'completed' && (unsupported.size || snapshot.missing.length || unresolved)) add('candidate.incomplete_status', 'status');
  if (output.status === 'completed' && !receipts.length) add('candidate.no_read', 'status');
  // 相同的显式值、主体和口径才是程序能确定的重复；不把多值属性或不同口径强判为冲突。
  const seen = new Set<string>();
  for (const [i, claim] of snapshot.claims.entries()) {
    const { raw: _raw, ...value } = claim.value as unknown as Record<string, unknown>;
    const signature = canonicalize([claim.entityId, claim.predicate, value, claim.qualifiers ?? {}]);
    if (seen.has(signature)) add('claim.duplicate_fact', 'candidateSnapshot.claims[' + i + ']');
    seen.add(signature);
    if (claim.supportStatus === 'conflicted') {
      const conflict = snapshot.conflicts.find(c => c.conflictId === claim.conflictGroupId);
      if (!conflict || !conflict.claimRefs.includes(claim.claimId) || conflict.resolutionStatus === 'resolved') add('claim.untracked_conflict', 'candidateSnapshot.claims[' + i + ']');
    }
  }
  for (const conflict of snapshot.conflicts) {
    if (conflict.resolutionStatus === 'resolved') add('conflict.resolution_requires_review', 'candidateSnapshot.conflicts');
    for (const id of conflict.claimRefs) {
      const claim = snapshot.claims.find(c => c.claimId === id);
      if (claim && (claim.supportStatus !== 'conflicted' || claim.conflictGroupId !== conflict.conflictId)) add('conflict.claim_mismatch', 'candidateSnapshot.conflicts');
    }
  }
  // 修正不能通过删除已有事实/问题，或偷偷改掉已合法的事实值来过关。
  const prior = record(record(previous).candidateSnapshot);
  for (const [collection, idField] of [['claims', 'claimId'], ['missing', 'missingId'], ['conflicts', 'conflictId']] as const) {
    const before = prior[collection];
    if (!Array.isArray(before)) continue;
    for (const old of before) {
      const item = record(old), id = item[idField];
      if (typeof id !== 'string') continue;
      const next = (snapshot[collection] as Array<Record<string, unknown>>).find(c => c[idField] === id);
      if (!next) { add('repair.removed_item', 'candidateSnapshot.' + collection); continue; }
      if (collection === 'claims' && registry.validate('urn:tju-mas:contracts:evidence-snapshot#/$defs/claim', old).valid) {
        for (const field of ['entityId', 'predicate', 'value', 'qualifiers']) {
          if (canonicalize(item[field] ?? null) !== canonicalize(next[field] ?? null)) add('repair.changed_fact', 'candidateSnapshot.claims');
        }
      }
      if (collection === 'conflicts' && canonicalize(item.claimRefs ?? null) !== canonicalize(next.claimRefs ?? null)) add('repair.changed_conflict', 'candidateSnapshot.conflicts');
    }
  }
  return { ok: issues.length === 0, issues };
}
