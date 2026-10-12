// B4 review-result validator (this file only). Protected checkReviewOutput is invoked unchanged.
type Dict = Record<string, unknown>;
import { canonicalize } from '../../../../packages/contracts/src/validator.ts';
import type { SchemaRegistry } from '../../../../packages/contracts/src/schema-registry.ts';
import type { CheckResult, CheckIssue } from '../../../../packages/contracts/src/service-checks.ts';
import { checkReviewOutput } from '../../../../packages/contracts/src/service-checks.ts';
import type { ReadDocumentResult } from '../../../../packages/contracts/generated/read-document-result.ts';
import type { ReadSourceResult } from '../../../../packages/contracts/generated/read-source-result.ts';
import type { EvidenceSnapshot, EvidenceSnapshotClaim } from '../../../../packages/contracts/generated/evidence-snapshot.ts';
import type { ReviewReport, ReviewReportCheckResult } from '../../../../packages/contracts/generated/review-report.ts';
import type { ReviewInput } from '../../../../packages/contracts/generated/review-input.ts';
import type { ReviewEnvelope } from '../agents/review/context.ts';

const READ_DOCUMENT_RESULT_ID = 'urn:tju-mas:contracts:read-document-result';
const READ_SOURCE_RESULT_ID = 'urn:tju-mas:contracts:read-source-result';

type Receipt = ReadDocumentResult | ReadSourceResult;

// The five claim-level checks that are required for every candidate claim.
const PER_CLAIM_REQUIRED: string[] = ['support', 'entity_match', 'value', 'source_locator', 'traceability'];
const ALL_CHECK_TYPES = new Set<string>(['support', 'entity_match', 'value', 'unit', 'time', 'basis', 'source_locator', 'missing', 'conflict', 'traceability']);
const FACT_CHECK_TYPES = new Set<string>(['support', 'entity_match', 'value', 'unit', 'time', 'basis', 'source_locator', 'traceability']);
const GLOBAL_CHECK_TYPES = new Set<string>(['missing', 'conflict']);
const BLOCKING_SEVERITIES = new Set<string>(['critical', 'error', 'blocker', 'high']);

/* ---------- generic helpers ---------- */

function isObj(v: unknown): v is Dict { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function arr(v: unknown): unknown[] { return Array.isArray(v) ? v : []; }
function strArr(v: unknown): string[] { return arr(v).filter((x): x is string => typeof x === 'string'); }
function asDict(v: unknown): Dict { return isObj(v) ? v : {}; }
function nonEmptyStr(v: unknown): v is string { return typeof v === 'string' && v.trim().length > 0; }
function eq(a: unknown, b: unknown): boolean { return canonicalize(a) === canonicalize(b); }

/* ---------- evidence / snapshot value helpers (type + normalized/unit/raw only) ---------- */

function valueType(v: unknown): string | undefined { const d = asDict(v); return typeof d.type === 'string' ? d.type : undefined; }
function valueUnit(v: unknown): string | undefined { const d = asDict(v); return typeof d.unit === 'string' ? d.unit : undefined; }
function valueNormalized(v: unknown): unknown { return asDict(v).normalized; }

function claimHasUnit(claim: EvidenceSnapshotClaim): boolean {
  const t = valueType(claim?.value);
  if (t === 'quantity') return true;
  if (t === 'number') return typeof valueUnit(claim?.value) === 'string' && (valueUnit(claim?.value) as string).length > 0;
  return false;
}
function claimIsQuantity(claim: EvidenceSnapshotClaim): boolean { return valueType(claim?.value) === 'quantity'; }
function claimIsDate(claim: EvidenceSnapshotClaim): boolean { return valueType(claim?.value) === 'date'; }
function claimHasTimeQualifier(claim: EvidenceSnapshotClaim): boolean {
  const q = asDict(claim?.qualifiers);
  const t = asDict(q.time);
  return t.year !== undefined || t.period !== undefined || t.asOf !== undefined;
}
function claimHasTime(claim: EvidenceSnapshotClaim): boolean { return claimIsDate(claim) || claimHasTimeQualifier(claim); }
function claimHasBasis(claim: EvidenceSnapshotClaim): boolean {
  const q = asDict(claim?.qualifiers);
  return typeof q.basis === 'string' && q.basis.length > 0;
}

/* ---------- envelope ---------- */

function envelopeMismatch(output: Dict, report: Dict, envelope: ReviewEnvelope): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const cmp = (a: unknown, b: unknown, code: string, path: string) => {
    if (!eq(a, b)) issues.push({ code, message: `${path} 与服务信封不一致`, path });
  };
  cmp(report.reportId, envelope.reportId, 'report.reportId_mismatch', 'report.reportId');
  cmp(report.reportVersionId, envelope.reportVersionId, 'report.reportVersionId_mismatch', 'report.reportVersionId');
  cmp(report.createdAt, envelope.createdAt, 'report.createdAt_mismatch', 'report.createdAt');
  const envProvenance = canonicalize(envelope.reviewedBy as unknown);
  if (canonicalize(report.reviewedBy) !== envProvenance) issues.push({ code: 'report.reviewedBy_mismatch', message: 'report.reviewedBy 与服务信封不一致', path: 'report.reviewedBy' });
  if (canonicalize(output.producedBy) !== envProvenance) issues.push({ code: 'output.producedBy_mismatch', message: 'output.producedBy 与服务信封不一致', path: 'producedBy' });
  return issues;
}

/* ---------- receipts ---------- */

interface AuthorizedReceipt {
  isSource: boolean;
  documentId: string;
  documentVersionId: string;
  blockId: string;
  projectId?: string;
  text: string;
  location: unknown;
  blockType?: string;
  semanticStatus?: string;
  unsupportedReasons: string[];
  tableWarnings: string[];
}

function getText(o: Dict): string { return typeof o.text === 'string' ? o.text : ''; }

function normalizeReceipt(rec: unknown): AuthorizedReceipt | null {
  const o = asDict(rec);
  const isSource = typeof o.projectId === 'string' && typeof o.blockType === 'string' && typeof o.status === 'string';
  const documentId = o.documentId;
  const documentVersionId = o.documentVersionId;
  const blockId = o.blockId;
  if (typeof documentId !== 'string' || typeof documentVersionId !== 'string' || typeof blockId !== 'string') return null;
  let tableWarnings: string[] = [];
  const table = o.table;
  if (isObj(table)) tableWarnings = strArr(table.warnings);
  return {
    isSource,
    documentId,
    documentVersionId,
    blockId,
    projectId: typeof o.projectId === 'string' ? o.projectId : undefined,
    text: getText(o),
    location: o.location,
    blockType: typeof o.blockType === 'string' ? o.blockType : undefined,
    semanticStatus: typeof o.semanticStatus === 'string' ? o.semanticStatus : undefined,
    unsupportedReasons: strArr(o.unsupportedReasons),
    tableWarnings,
  };
}

function receiptKey(r: AuthorizedReceipt): string { return `${r.documentId}::${r.documentVersionId}::${r.blockId}`; }

/* ---------- main entry ---------- */

export function validateReviewReport(
  raw: unknown,
  input: ReviewInput,
  snapshot: EvidenceSnapshot,
  envelope: ReviewEnvelope,
  receipts: Array<ReadDocumentResult | ReadSourceResult>,
  registry: SchemaRegistry,
): CheckResult {
  const issues: CheckIssue[] = [];
  const push = (code: string, message: string, path?: string) => issues.push({ code, message, path });

  try {
    // 0. Schema guard before any typed traversal; never throw on malformed raw.
    if (!isObj(raw)) {
      push('report.not_object', 'ReviewOutput 不是对象');
      return { ok: false, issues };
    }
    const output = raw as Dict;
    if (!isObj(output.report)) {
      push('report.not_object', 'ReviewOutput.report 不是对象');
      return { ok: false, issues };
    }

    // 1. Protected outer check unchanged; preserve its issues verbatim.
    try {
      const outer = checkReviewOutput(output, input as unknown as Dict, snapshot as unknown as Dict, registry);
      for (const i of outer.issues) issues.push(i);
    } catch {
      push('report.outer_check_error', '既有输出校验器执行异常');
    }

    const report = output.report as Dict;

    // 2. Exact envelope / provenance equality.
    for (const i of envelopeMismatch(output, report, envelope)) issues.push(i);

    // 3. Typed traversal of actual fields.
    const checks = arr(report.checks).filter(isObj) as ReviewReportCheckResult[];
    const reportIssues = arr(report.issues).filter(isObj) as Array<Dict>;
    const claims = arr((snapshot as unknown as Dict)?.claims).filter(isObj) as EvidenceSnapshotClaim[];
    const claimById = new Map<string, EvidenceSnapshotClaim>();
    for (const c of claims) if (typeof c?.claimId === 'string') claimById.set(c.claimId, c);

    const verdict = typeof report.verdict === 'string' ? report.verdict : undefined;

    // 4. Unique check / issue IDs.
    const seenCheck = new Set<string>();
    for (const c of checks) {
      if (typeof c.checkId !== 'string') continue;
      if (seenCheck.has(c.checkId)) push('check.duplicate_id', `检查 ID 重复：${c.checkId}`, 'report.checks');
      seenCheck.add(c.checkId);
    }
    const seenIssue = new Set<string>();
    for (const it of reportIssues) {
      if (typeof it.issueId !== 'string') continue;
      if (seenIssue.has(it.issueId)) push('issue.duplicate_id', `问题 ID 重复：${it.issueId}`, 'report.issues');
      seenIssue.add(it.issueId);
    }

    // 5. Required check TYPES = exactly input.checksRequired, present for every verdict.
    const requiredTypes = strArr((input as unknown as Dict)?.checksRequired);
    const presentTypes = new Set<string>();
    for (const c of checks) if (typeof c.checkType === 'string') presentTypes.add(c.checkType);
    for (const t of requiredTypes) {
      if (!presentTypes.has(t)) push('report.required_check_type_absent', `未出现要求的知识检查类型 ${t}`, 'report.checks');
    }

    // 6. Status semantics: not_run needs explicit finding; not_applicable needs explanation.
    for (const c of checks) {
      if (c.status === 'not_run' && !nonEmptyStr(c.finding)) {
        if (verdict === 'pass') push('check.not_run_on_pass', `pass 报告不允许检查 ${c.checkId} 处于 not_run`, 'report.checks');
        else push('check.not_run_without_reason', `not_run 检查 ${c.checkId} 必须给出明确原因`, 'report.checks');
      }
      if (c.status === 'not_applicable' && !nonEmptyStr(c.finding)) {
        push('check.not_applicable_without_explanation', `not_applicable 检查 ${c.checkId} 必须解释不适用原因`, 'report.checks');
      }
    }

    // 7. Per-claim coverage: claimRefs grouping.
    const byClaim = new Map<string, ReviewReportCheckResult[]>();
    for (const c of checks) {
      for (const ref of strArr(c.claimRefs)) {
        if (!byClaim.has(ref)) byClaim.set(ref, []);
        byClaim.get(ref)!.push(c);
      }
    }

    const isUnreadNonpass = (c: ReviewReportCheckResult): boolean =>
      c.status === 'not_run' && verdict !== 'pass' && nonEmptyStr(c.finding);
    const effective = (c: ReviewReportCheckResult | undefined): boolean =>
      !!c && c.status !== 'not_applicable' && (c.status === 'pass' || c.status === 'fail' || isUnreadNonpass(c));

    // Required per-claim types + conditional applicability (unit/time/basis).
    for (const claim of claims) {
      const cid = claim?.claimId;
      if (typeof cid !== 'string') continue;
      const covering = byClaim.get(cid) ?? [];
      const byType = new Map<string, ReviewReportCheckResult>();
      for (const c of covering) if (typeof c.checkType === 'string') byType.set(c.checkType, c);
      for (const type of PER_CLAIM_REQUIRED) {
        if (!requiredTypes.includes(type)) continue;
        if (!effective(byType.get(type))) push('report.claim_check_missing', `候选事实 ${cid} 缺少实际生效的检查类型 ${type}`, 'report.checks');
      }
      if (requiredTypes.includes('unit') && claimHasUnit(claim) && !effective(byType.get('unit'))) push('report.claim_check_missing', `候选事实 ${cid} 缺少实际生效的单位检查 unit`, 'report.checks');
      if (requiredTypes.includes('time') && claimHasTime(claim) && !effective(byType.get('time'))) push('report.claim_check_missing', `候选事实 ${cid} 缺少实际生效的时间检查 time`, 'report.checks');
      if (requiredTypes.includes('basis') && claimHasBasis(claim) && !effective(byType.get('basis'))) push('report.claim_check_missing', `候选事实 ${cid} 缺少实际生效的依据检查 basis`, 'report.checks');
    }

    // Applicability: not_applicable rejected when the check is in fact applicable.
    for (const c of checks) {
      if (c.status !== 'not_applicable') continue;
      const t = c.checkType;
      for (const ref of strArr(c.claimRefs)) {
        const claim = claimById.get(ref);
        if (!claim) continue;
        if (t === 'value' && claimIsQuantity(claim)) push('check.applicable_not_applicable', `检查 ${c.checkId} 对数量型候选事实 ${ref} 不可标记 not_applicable`, 'report.checks');
        if (t === 'unit' && claimHasUnit(claim)) push('check.applicable_not_applicable', `检查 ${c.checkId} 对带单位候选事实 ${ref} 不可标记 not_applicable`, 'report.checks');
        if (t === 'time' && claimHasTime(claim)) push('check.applicable_not_applicable', `检查 ${c.checkId} 对含时间语义的候选事实 ${ref} 不可标记 not_applicable`, 'report.checks');
        if (t === 'basis' && claimHasBasis(claim)) push('check.applicable_not_applicable', `检查 ${c.checkId} 对含依据修饰的候选事实 ${ref} 不可标记 not_applicable`, 'report.checks');
      }
    }

    // 8. pass cannot hide a required fail/not_run; direct required-type guard.
    if (verdict === 'pass') {
      for (const c of checks) {
        if (!requiredTypes.includes(c.checkType)) continue;
        if (c.status === 'fail' || c.status === 'not_run') {
          push('check.required_check_failed', `检查 ${c.checkId}（类型 ${c.checkType}）为必查项但状态为 ${c.status}`, 'report.checks');
        }
      }
    }

    // 9. Receipts: schema-validate, keep only valid authorized receipts.
    const projectId = (input as unknown as Dict)?.projectId;
    const scopeRefs = scopeDocumentRefs(input);
    const scopeByDoc = new Map<string, string>();
    for (const r of scopeRefs) scopeByDoc.set(r.documentId, r.documentVersionId);

    const authorized: AuthorizedReceipt[] = [];
    for (const rec of arr(receipts)) {
      const o = asDict(rec);
      const isSource = typeof o.projectId === 'string' && typeof o.blockType === 'string';
      const id = isSource ? READ_SOURCE_RESULT_ID : READ_DOCUMENT_RESULT_ID;
      let valid = false;
      try { valid = registry.validate(id, o as unknown as Dict).valid; } catch { valid = false; }
      if (!valid) { push('receipt.invalid_schema', `读取回执不符合 ${id} 结构`, 'receipts'); continue; }
      const norm = normalizeReceipt(rec);
      if (!norm) { push('receipt.invalid_schema', `读取回执缺少定位字段`, 'receipts'); continue; }
      const doc = input.documents.find((d) => d.documentId === norm.documentId && d.documentVersionId === norm.documentVersionId);
      const block = doc?.blocks.find((b) => b.blockId === norm.blockId);
      let authOk = false;
      if (
        doc && block &&
        input.scope.projectId === input.projectId &&
        doc.projectId === input.projectId &&
        scopeRefs.some((r) => r.documentId === norm.documentId && r.documentVersionId === norm.documentVersionId) &&
        o.contentHash === doc.contentHash &&
        norm.text === block.text &&
        eq(norm.location, block.location) &&
        (!norm.isSource || (norm.projectId === input.projectId && norm.blockType === block.type))
      ) {
        authOk = true;
      }
      if (!authOk) { push('receipt.authority_mismatch', `读取回执 ${norm.documentId}/${norm.documentVersionId}/${norm.blockId} 未通过授权核对`, 'receipts'); continue; }
      authorized.push(norm);
    }

    const authorizedKeys = new Set<string>();
    for (const r of authorized) authorizedKeys.add(receiptKey(r));

    // 10. Evidence index + actual-read determination (authorized receipt + exact block text/location).
    const evidenceById = new Map<string, Dict>();
    for (const e of arr((snapshot as unknown as Dict)?.evidence)) { const d = asDict(e); if (typeof d.evidenceId === 'string') evidenceById.set(d.evidenceId, d); }

    const readEvidenceIds = new Set<string>();
    for (const [eid, ev] of evidenceById) {
      const key = receiptKey({
        documentId: String(ev.documentId), documentVersionId: String(ev.documentVersionId), blockId: String(ev.blockId),
        isSource: false, text: '', location: undefined, unsupportedReasons: [], tableWarnings: [],
      });
      if (authorizedKeys.has(key)) readEvidenceIds.add(eid);
    }

    // 11. Report issues: evidenceRefs must be actually read and correlated when claimId present.
    for (const it of reportIssues) {
      const claimId = it.claimId;
      const evRefs = strArr(it.evidenceRefs);
      for (const ref of evRefs) {
        if (!evidenceById.has(ref)) { push('issue.evidence_missing', `问题 ${it.issueId} 引用不存在的证据 ${ref}`, 'report.issues'); continue; }
        if (!readEvidenceIds.has(ref)) push('issue.evidence_not_read', `问题 ${it.issueId} 引用的证据 ${ref} 实际未被成功读取`, 'report.issues');
        if (typeof claimId === 'string') {
          const claim = claimById.get(claimId);
          const claimEvs = strArr(claim?.evidenceRefs);
          if (claimEvs.length && !claimEvs.includes(ref)) push('issue.evidence_not_correlated', `问题 ${it.issueId} 的证据 ${ref} 与候选事实 ${claimId} 不相关`, 'report.issues');
        }
      }
      if (typeof claimId === 'string' && !claimById.has(claimId)) push('issue.claim_missing', `问题 ${it.issueId} 引用不存在的候选事实 ${claimId}`, 'report.issues');
    }

    // 12. Completed checks must cite actually-read, relevant evidence per claim.
    for (const c of checks) {
      if (c.status !== 'pass' && c.status !== 'fail') continue;
      const refs = strArr(c.claimRefs);
      const evRefs = strArr(c.evidenceRefs);
      const isGlobal = GLOBAL_CHECK_TYPES.has(c.checkType);

      // Global completed missing/conflict with no refs: at least one authorized read.
      if (refs.length === 0 && evRefs.length === 0) {
        if (isGlobal && readEvidenceIds.size === 0 && authorized.length === 0) {
          push('check.completed_without_read', `完成的检查 ${c.checkId} 无引用但仍需至少一次成功且授权范围内的读取`, 'report.checks');
        }
        continue;
      }

      // Every cited evidence must exist, be actually read (unless global missing issue-less omission), and in scope.
      for (const evRef of evRefs) {
        const ev = evidenceById.get(evRef);
        if (!ev) { push('check.evidence_missing', `检查 ${c.checkId} 引用不存在的证据 ${evRef}`, 'report.checks'); continue; }
        if (!readEvidenceIds.has(evRef)) push('check.evidence_not_read', `检查 ${c.checkId} 引用未被成功读取的证据 ${evRef}`, 'report.checks');
        if (!verifyEvidenceScope(ev, projectId, scopeByDoc)) push('check.evidence_scope_mismatch', `证据 ${evRef} 不在审查范围内`, 'report.checks');
      }

      if (refs.length > 0) {
        const coveredByRef = new Set<string>();
        for (const evRef of evRefs) {
          for (const ref of refs) {
            const claim = claimById.get(ref);
            if (!claim) continue;
            const claimEvs = strArr(claim.evidenceRefs);
            if (claimEvs.length === 0 || claimEvs.includes(evRef)) coveredByRef.add(ref);
          }
        }
        for (const ref of refs) {
          if (!claimById.has(ref)) { push('check.claim_missing', `检查 ${c.checkId} 引用不存在的候选事实 ${ref}`, 'report.checks'); continue; }
          if (!coveredByRef.has(ref)) push('check.claim_evidence_insufficient', `检查 ${c.checkId} 未为候选事实 ${ref} 提供实际读取的相关证据`, 'report.checks');
        }
      }
    }

    // 13. PASS: every relevant evidenceRef of every claim must have an authorized receipt.
    if (verdict === 'pass') {
      for (const claim of claims) {
        for (const evRef of strArr(claim?.evidenceRefs)) {
          if (!readEvidenceIds.has(evRef)) push('report.pass_evidence_not_read', `pass 报告中候选事实 ${claim.claimId} 的证据 ${evRef} 未被成功授权读取`, 'report.verdict');
        }
      }
    }

    // 14. PASS: reject unsupported/conflicted claims and blocking snapshot.missing.
    if (verdict === 'pass') {
      for (const claim of claims) {
        if (nonEmptyStr(claim?.supportStatus) && claim.supportStatus !== 'supported') {
          push('report.pass_unsupported_claim', `候选事实 ${claim.claimId} 证据状态为 ${claim.supportStatus}，不能 pass`, 'report.verdict');
        }
      }
      for (const m of arr((snapshot as unknown as Dict)?.missing)) {
        const sev = asDict(m).severity;
        if (typeof sev === 'string' && BLOCKING_SEVERITIES.has(sev)) push('report.pass_on_missing', `存在阻塞级缺失项，不能 pass`, 'report.verdict');
      }
    }

    // 15. Open/deferred conflicts: evaluate actual claim refs by normalized value ignoring raw.
    for (const conf of arr((snapshot as unknown as Dict)?.conflicts)) {
      const cd = asDict(conf);
      const st = cd.resolutionStatus;
      if (st !== 'open' && st !== 'deferred') continue;
      const refs = strArr(cd.claimRefs);
      const claimObjs = refs.map((r) => claimById.get(r)).filter((x): x is EvidenceSnapshotClaim => !!x);
      if (claimObjs.length < 2 || !hasUnresolvedContradiction(claimObjs)) continue;
      if (verdict === 'pass') {
        // Any real unresolved contradiction always blocks pass; program conflict resolution is separate.
        push('report.pass_on_unresolved_conflict', `存在未解决的实质矛盾 ${cd.conflictId}，不能 pass`, 'report.verdict');
      }
    }

    // 16. Source positive verdicts cannot rest on blank/unsupported/not_run/unreadable source.
    for (const r of authorized) {
      const blank = r.text.trim().length === 0;
      const imgOrNotRun = r.blockType === 'image' || r.semanticStatus === 'not_run';
      const unsupported = r.unsupportedReasons.length > 0;
      const tableWarn = r.tableWarnings.length > 0;
      if (!(blank || imgOrNotRun || unsupported || tableWarn)) continue;
      const citedEvidence = [...evidenceById.entries()].filter(([, ev]) =>
        String(ev.documentId) === r.documentId && String(ev.documentVersionId) === r.documentVersionId && String(ev.blockId) === r.blockId,
      ).map(([id]) => id);
      if (citedEvidence.length === 0) continue;
      for (const c of checks) {
        if (c.status !== 'pass' || !FACT_CHECK_TYPES.has(c.checkType)) continue;
        if (strArr(c.evidenceRefs).some((x) => citedEvidence.includes(x))) {
          push('check.pass_on_unsupported_source', `检查 ${c.checkId} 依据空白/不支持/未运行的来源内容给出 pass`, 'report.checks');
        }
      }
    }

    return finalize(issues);
  } catch {
    // Stable generic issue; never leak raw error text.
    push('report.validator_internal_error', '校验器内部错误');
    return { ok: false, issues };
  }
}

/* ---------- helpers ---------- */

function finalize(issues: CheckIssue[]): CheckResult {
  return { ok: issues.length === 0, issues };
}

function scopeDocumentRefs(input: ReviewInput): Array<{ documentId: string; documentVersionId: string }> {
  const out: Array<{ documentId: string; documentVersionId: string }> = [];
  const rawScope = arr(asDict(asDict(input as unknown as Dict).scope).documentRefs);
  for (const r of rawScope) {
    const d = asDict(r);
    if (typeof d.documentId === 'string' && typeof d.documentVersionId === 'string') out.push({ documentId: d.documentId, documentVersionId: d.documentVersionId });
  }
  return out;
}

function verifyEvidenceScope(ev: Dict, projectId: unknown, scopeByDoc: Map<string, string>): boolean {
  if (typeof projectId === 'string' && typeof ev.projectId === 'string' && ev.projectId !== projectId) return false;
  if (typeof ev.documentId !== 'string') return true;
  if (scopeByDoc.size === 0) return true;
  const expectedVersion = scopeByDoc.get(ev.documentId);
  if (expectedVersion === undefined) return false;
  if (typeof ev.documentVersionId === 'string' && ev.documentVersionId !== expectedVersion) return false;
  return true;
}

// Canonical value ignoring raw presentation; unit is part of the comparison key.
function canonicalValue(v: unknown): string {
  const t = valueType(v);
  const d = asDict(v);
  const clone: Dict = { ...d };
  delete clone.raw;
  const norm = canonicalize(clone);
  if (t === 'quantity') return `qty:${norm}@${valueUnit(clone) ?? ''}`;
  if (t === 'number') return `num:${norm}@${valueUnit(clone) ?? ''}`;
  return `${t ?? 'raw'}:${norm}`;
}

function qualifierTimeBasis(claim: EvidenceSnapshotClaim): string {
  const q = asDict(claim?.qualifiers);
  return canonicalize({ time: q.time ?? null, basis: q.basis ?? null });
}

function hasUnresolvedContradiction(claimObjs: EvidenceSnapshotClaim[]): boolean {
  const groups = new Map<string, Set<string>>();
  for (const c of claimObjs) {
    const key = `${c?.entityId}::${c?.predicate}::${qualifierTimeBasis(c)}::${valueType(c?.value) ?? 'raw'}::${valueUnit(c?.value) ?? ''}`;
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key)!.add(canonicalValue(c?.value));
  }
  for (const values of groups.values()) if (values.size > 1) return true;
  return false;
}

// Keep ALL_CHECK_TYPES referenced for downstream clarity without dead code.
void ALL_CHECK_TYPES;