/** 审核校验器单元矩阵：离线纯校验，不触网、不跑 SDK。
 *  合成夹具，仅验证 validateReviewReport 的程序性契约。生产存在已知缺陷，部分测试为诚实失败断言。*/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateReviewReport } from '../../apps/server/src/domain/review-result-validator.ts';
import { newReviewEnvelope } from '../../apps/server/src/agents/review/context.ts';
import type { ReviewEnvelope } from '../../apps/server/src/agents/review/context.ts';
import { createDocumentReader } from '../../apps/server/src/runtime/pi/read-document-tool.ts';
import type { ReadDocumentResult, ReadSourceResult } from '../../packages/contracts/generated/index.ts';
import { loadFixture, registry } from '../helpers/fixtures.ts';
import { fingerprint } from '../../packages/contracts/src/fingerprint.ts';
import type { EvidenceSnapshot, ReviewInput, ReviewOutput, CommonAgentProvenance } from '../../packages/contracts/generated/index.ts';

const rawInput = loadFixture<ReviewInput>('review-input.json');
const rawSnapshot = loadFixture<EvidenceSnapshot>('snapshot.json');

const ALL_TEN = ['support','entity_match','value','unit','time','basis','source_locator','missing','conflict','traceability'] as const;
const SNAP_URN='urn:tju-mas:contracts:evidence-snapshot';
const INPUT_URN='urn:tju-mas:contracts:review-input';
const REPORT_URN='urn:tju-mas:contracts:review-report';
const OUTPUT_URN='urn:tju-mas:contracts:review-output';
const DOC_URN='urn:tju-mas:contracts:read-document-result';

type Req = { documentId: string; documentVersionId: string; blockId: string };
type CheckStatus = ReviewOutput['report']['checks'][number]['status'];
type CheckType = ReviewOutput['report']['checks'][number]['checkType'];
type Report = ReviewOutput['report'];
type Receipt = ReadDocumentResult | ReadSourceResult;

const PROVENANCE: CommonAgentProvenance = { role: 'review', model: 'synthetic-model', sessionId: 'session_matrix', protocolVersion: '1.0' };
function envelopeFor(): ReviewEnvelope { return newReviewEnvelope(PROVENANCE); }

/** registry.validate 返回 {valid,errors}（非 ok/issues）；缺失或非法即失败。 */
function assertSchema(urn: string, value: unknown, label: string): void {
  const res = registry.validate(urn, value) as { valid?: boolean; errors?: unknown };
  assert.equal(res.valid, true, label + ' 应 schema 合法：' + JSON.stringify(res.errors));
}

/** 仅保留 claim_rd_60 / ev_rd_60 / ent_rd，清空冲突/缺失/可选集合。 */
function baseSnapshot(): EvidenceSnapshot {
  const snap = structuredClone(rawSnapshot);
  snap.entities = snap.entities.filter(e => e.entityId === 'ent_rd');
  snap.claims = snap.claims.filter(c => c.claimId === 'claim_rd_60');
  snap.evidence = snap.evidence.filter(e => e.evidenceId === 'ev_rd_60');
  snap.conflicts = [];
  snap.missing = [];
  delete (snap as { relations?: unknown }).relations;
  delete (snap as { events?: unknown }).events;
  delete (snap as { assets?: unknown }).assets;
  for (const c of snap.claims) c.reviewStatus = 'pending';
  snap.reviewStatus = 'pending';
  snap.coverage = { ...snap.coverage, documentsProcessed: [{ documentId: 'doc_profile', documentVersionId: 'docv_profile_1', blockIds: ['b001','b002','b003','b004'] }] };
  delete snap.coverage.unsupported;
  return snap;
}

/** 合法输入：documents/scope 限 doc_profile，显式声明全部十项 checksRequired，重算 hash。 */
function makeInput(snapshot: EvidenceSnapshot): ReviewInput {
  const input = structuredClone(rawInput);
  const doc = input.documents.find(d => d.documentId === 'doc_profile')!;
  input.documents = [doc];
  input.scope.documentRefs = input.scope.documentRefs.filter(r => r.documentId === 'doc_profile');
  snapshot.coverage.documentsProcessed = [{ documentId: 'doc_profile', documentVersionId: 'docv_profile_1', blockIds: doc.blocks.map(b => b.blockId) }];
  input.checksRequired = [...ALL_TEN];
  input.subject.contentHash = fingerprint(snapshot);
  return input;
}
function reconcile(input: ReviewInput, snapshot: EvidenceSnapshot): void {
  input.subject.contentHash = fingerprint(snapshot);
  input.subject.snapshotId = snapshot.snapshotId;
  input.subject.snapshotVersionId = snapshot.snapshotVersionId;
}
function allReadReqs(input: ReviewInput): Req[] {
  const reqs: Req[] = [];
  for (const doc of input.documents) for (const b of doc.blocks)
    reqs.push({ documentId: doc.documentId, documentVersionId: doc.documentVersionId, blockId: b.blockId });
  return reqs;
}
function readAll(input: ReviewInput): Receipt[] {
  const reader = createDocumentReader({ scope: input.scope, documents: input.documents }, registry);
  return allReadReqs(input).map(r => reader(r));
}
type CheckSpec = [CheckType, CheckStatus, string, string[], string[]];

function makeReportOutput(
  data: { envelope: ReviewEnvelope; subject: ReviewInput['subject']; task: { projectId: string; taskId: string; attemptId: string } },
  verdict: ReviewOutput['report']['verdict'] = 'pass',
): ReviewOutput {
  const env = data.envelope;
  const reviewedBy = { ...env.reviewedBy, role: 'review' } as const;
  const specs: CheckSpec[] = [
    ['support','pass','已按 support 规则核对。',['claim_rd_60'],['ev_rd_60']],
    ['entity_match','pass','已按 entity_match 规则核对。',['claim_rd_60'],['ev_rd_60']],
    ['value','pass','已按 value 规则核对。',['claim_rd_60'],['ev_rd_60']],
    ['unit','pass','已按 unit 规则核对。',['claim_rd_60'],['ev_rd_60']],
    ['time','pass','已按 time 规则核对。',['claim_rd_60'],['ev_rd_60']],
    ['basis','pass','已按 basis 规则核对。',['claim_rd_60'],['ev_rd_60']],
    ['source_locator','pass','已按 source_locator 规则核对。',['claim_rd_60'],['ev_rd_60']],
    ['missing','pass','无缺失。',[],[]],
    ['conflict','pass','无冲突。',[],[]],
    ['traceability','pass','已按 traceability 规则核对。',['claim_rd_60'],['ev_rd_60']],
  ];
  const checks: Report['checks'] = specs.map(([checkType, status, finding, claimRefs, evidenceRefs]) => ({
    checkId: 'check_' + checkType, checkType, status, finding,
    severity: status === 'fail' ? 'error' : 'info', claimRefs, evidenceRefs,
  }));
  const report: Report = {
    protocolVersion: '1.0', reportId: env.reportId, reportVersionId: env.reportVersionId,
    projectId: data.task.projectId, taskId: data.task.taskId, attemptId: data.task.attemptId,
    reviewMode: 'fact', subject: data.subject, verdict, checks, issues: [],
    summary: '候选快照与原始资料逐条核对。', executionStatus: 'completed', reviewedBy, createdAt: env.createdAt,
  };
  return { protocolVersion: '1.0', projectId: data.task.projectId, taskId: data.task.taskId, attemptId: data.task.attemptId, status: 'completed', report, producedBy: reviewedBy };
}
function checkOf(report: Report, type: CheckType): Report['checks'][number] {
  const c = report.checks.find(x => x.checkType === type);
  assert.ok(c, 'missing check ' + type);
  return c;
}
interface Bctx {
  input: ReviewInput; snapshot: EvidenceSnapshot; envelope: ReviewEnvelope;
  data: { envelope: ReviewEnvelope; subject: ReviewInput['subject']; task: { projectId: string; taskId: string; attemptId: string } };
  receipts: Receipt[];
}
/** 由已 reconcile 的 input+snapshot 构造完整上下文。 */
function ctxFrom(input: ReviewInput, snapshot: EvidenceSnapshot): Bctx {
  const envelope = envelopeFor();
  return { input, snapshot, envelope,
    data: { envelope, subject: structuredClone(input.subject), task: { projectId: input.projectId, taskId: input.taskId, attemptId: input.attemptId } },
    receipts: readAll(input) };
}
function context(): Bctx { const s = baseSnapshot(); return ctxFrom(makeInput(s), s); }
function run(raw: unknown, ctx: Bctx) { return validateReviewReport(raw, ctx.input, ctx.snapshot, ctx.envelope, ctx.receipts, registry); }
function codesOf(result: { ok: boolean; issues: Array<{ code: string }> }): string[] { return result.issues.map(i => i.code); }
function expectReject(result: { ok: boolean; issues: Array<{ code: string }> }, label: string): string[] {
  const codes = codesOf(result);
  assert.equal(result.ok, false, label + ' 应拒绝；实际通过：' + JSON.stringify(result.issues));
  assert.ok(result.issues.length > 0, label + ' 应至少 1 条 issue');
  return codes;
}

// ---------- 夹具自检 ----------
test('夹具自检：baseSnapshot/makeInput 通过 schema，checksRequired 为全部十项', () => {
  const snapshot = baseSnapshot();
  const input = makeInput(snapshot);
  assertSchema(SNAP_URN, snapshot, 'baseSnapshot');
  assertSchema(INPUT_URN, input, 'makeInput');
  assert.equal(input.documents.length, 1);
  assert.equal(input.documents[0].blocks.length, 4);
  assert.deepEqual(input.checksRequired, [...ALL_TEN]);
});

// ---------- 基线 ----------
test('01 基线：完整读取与合规报告应通过', () => {
  const ctx = context();
  const report = makeReportOutput(ctx.data, 'pass');
  assertSchema(OUTPUT_URN, report, 'baseline output');
  const result = run(report, ctx);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(codesOf(result), []);
});
test('02 未读取原始资料：空 receipts 应拒绝', () => {
  const ctx = context();
  const report = makeReportOutput(ctx.data, 'pass');
  const result = validateReviewReport(report, ctx.input, ctx.snapshot, ctx.envelope, [], registry);
  const codes = expectReject(result, '无读取凭据');
  assert.ok(codes.some(c => /read|evidence|receipt|support/i.test(c)), JSON.stringify(codes));
});
test('03 溯源伪造：reviewedBy 与 envelope 不一致应拒绝', () => {
  const ctx = context();
  const report = makeReportOutput(ctx.data, 'pass');
  report.report.reviewedBy = { ...report.report.reviewedBy, sessionId: 'session_forged' };
  const result = run(report, ctx);
  const codes = expectReject(result, '伪造 provenance');
  assert.ok(codes.some(c => /provenance|session|trace|reviewedBy|review/i.test(c)), JSON.stringify(codes));
});
test('04 报告时间戳：createdAt 与 envelope 不一致应拒绝', () => {
  const ctx = context();
  const report = makeReportOutput(ctx.data, 'pass');
  report.report.createdAt = '1999-01-01T00:00:00.000Z';
  const result = run(report, ctx);
  const codes = expectReject(result, 'createdAt 篡改');
  assert.ok(codes.some(c => /createdAt|timestamp|time|envelope/i.test(c)), JSON.stringify(codes));
});
test('05 主体过期哈希：合法 64hex 错误哈希应拒绝(fingerprint)', () => {
  const ctx = context();
  const report = makeReportOutput(ctx.data, 'pass');
  report.report.subject = { ...report.report.subject, contentHash: 'sha256:' + 'a'.repeat(64) };
  const result = run(report, ctx);
  const codes = expectReject(result, '过期 subject hash');
  assert.ok(codes.some(c => /fingerprint/i.test(c)), JSON.stringify(codes));
});
test('06 重复 checkId：应拒绝', () => {
  const ctx = context();
  const report = makeReportOutput(ctx.data, 'pass');
  report.report.checks[1] = { ...report.report.checks[1], checkId: report.report.checks[0].checkId };
  const result = run(report, ctx);
  const codes = expectReject(result, '重复 checkId');
  assert.ok(codes.some(c => /check|duplicate|unique/i.test(c)), JSON.stringify(codes));
});
test('07 重复 issueId：schema 合法的非 pass 报告应拒绝', () => {
  const ctx = context();
  const report = makeReportOutput(ctx.data, 'revise');
  checkOf(report.report, 'value').status = 'fail';
  report.report.issues = [
    { issueId: 'issue_dup', claimId: 'claim_rd_60', evidenceRefs: ['ev_rd_60'], severity: 'error', category: 'value', description: '数值不一致。', expected: '60 人', actual: '600 人', suggestedStage: 'needs_input' },
    { issueId: 'issue_dup', claimId: 'claim_rd_60', evidenceRefs: ['ev_rd_60'], severity: 'error', category: 'value', description: '重复 issueId。', expected: '60 人', actual: '600 人', suggestedStage: 'needs_input' },
  ];
  assertSchema(REPORT_URN, report.report, 'dup issueId report');
  const result = run(report, ctx);
  const codes = expectReject(result, '重复 issueId');
  assert.ok(codes.some(c => /issue|duplicate|unique/i.test(c)), JSON.stringify(codes));
});
test('08 修订报告移除实际必需类型 value（checksRequired 仍含）应拒绝', () => {
  const ctx = context();
  assert.ok(ctx.input.checksRequired.includes('value'), 'checksRequired 必须含 value');
  const report = makeReportOutput(ctx.data, 'revise');
  report.report.checks = report.report.checks.filter(c => c.checkType !== 'value');
  report.report.issues = [
    { issueId: 'issue_value_rd', claimId: 'claim_rd_60', evidenceRefs: ['ev_rd_60'], severity: 'error', category: 'value', description: '数值不一致。', expected: '60 人', actual: '600 人', suggestedStage: 'needs_input' },
  ];
  const result = run(report, ctx);
  const codes = expectReject(result, '缺失 required 检查 value');
  assert.ok(codes.some(c => /check|required|missing|type/i.test(c)), JSON.stringify(codes));
});
test('09 缩减 checks：required=[support] 且仅 support 应通过', () => {
  const snapshot = baseSnapshot();
  const input = makeInput(snapshot);
  input.checksRequired = ['support'];
  reconcile(input, snapshot);
  const ctx = ctxFrom(input, snapshot);
  const report = makeReportOutput(ctx.data, 'pass');
  report.report.checks = [checkOf(report.report, 'support')];
  const result = run(report, ctx);
  assert.equal(snapshot.coverage.documentsProcessed.length, 1);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(codesOf(result), []);
});
test('10 claim 覆盖缺失：checksRequired 含 value 却缺 claimRefs 应拒绝', () => {
  const ctx = context();
  const report = makeReportOutput(ctx.data, 'pass');
  checkOf(report.report, 'value').claimRefs = [];
  const result = run(report, ctx);
  const codes = expectReject(result, 'claim 覆盖缺失');
  assert.ok(codes.some(c => /claim|coverage|ref/i.test(c)), JSON.stringify(codes));
});
test('11 第二条 claim 缺自身读取/证据应拒绝', () => {
  const snapshot = baseSnapshot();
  const claim2 = structuredClone(snapshot.claims[0]);
  claim2.claimId = 'claim_rd_61';
  claim2.claimVersionId = 'claimv_rd_61';
  snapshot.claims.push(claim2);
  const input = makeInput(snapshot);
  input.checksRequired = ['support', 'value'];
  reconcile(input, snapshot);
  const ctx = ctxFrom(input, snapshot);
  const report = makeReportOutput(ctx.data, 'pass');
  report.report.checks = report.report.checks.filter(c => c.checkType === 'support' || c.checkType === 'value');
  checkOf(report.report, 'support').claimRefs = ['claim_rd_60'];
  checkOf(report.report, 'value').claimRefs = ['claim_rd_60'];
  const result = run(report, ctx);
  const codes = expectReject(result, '第二条 claim 未被覆盖');
  assert.ok(codes.some(c => /claim|coverage|evidence|support/i.test(c)), JSON.stringify(codes));
});

// 12/13/14：全局 unit/time/basis 保留 pass（claimRefs=[]/evidenceRefs=[]），仅缺 per-claim 覆盖应拒绝。
for (const chk of ['unit', 'time', 'basis'] as const) {
  test('12/13/14 全局 ' + chk + '=pass(claimRefs=[]) 但 per-claim 覆盖缺失应拒绝', () => {
    const ctx = context();
    const report = makeReportOutput(ctx.data, 'pass');
    const g = checkOf(report.report, chk);
    g.claimRefs = [];
    g.evidenceRefs = [];
    assert.equal(g.status, 'pass');
    const result = run(report, ctx);
    const codes = expectReject(result, 'per-claim ' + chk + ' 覆盖缺失');
    assert.ok(codes.some(c => new RegExp(chk, 'i').test(c) || /require|claim|missing|coverage/i.test(c)), JSON.stringify(codes));
  });
}
test('12/13/14 夹具自检：快照含 quantity/time/basis applicability', () => {
  const snapshot = baseSnapshot();
  assert.equal(snapshot.claims[0].value.type, 'quantity');
  assert.ok(snapshot.claims[0].qualifiers?.time);
  assert.ok(snapshot.claims[0].qualifiers?.basis);
});

// 15：坏状态置于首个（后接原有 pass）不得放行；not_run 带 reason。
for (const chk of ['unit', 'time', 'basis', 'conflict'] as const) {
  test('15 隐藏坏状态：' + chk + ' 先坏后 pass 不得放行', () => {
    const ctx = context();
    const report = makeReportOutput(ctx.data, 'pass');
    const bad = structuredClone(checkOf(report.report, chk));
    bad.checkId = 'check_' + chk + '_hidden_bad';
    if (chk === 'conflict') {
      bad.status = 'fail'; bad.severity = 'error'; bad.finding = '隐藏冲突失败。';
    } else {
      bad.status = 'not_run'; bad.severity = 'info'; bad.finding = '隐藏未运行。';
    }
    report.report.checks.unshift(bad);
    const ids = report.report.checks.map(c => c.checkId);
    assert.equal(new Set(ids).size, ids.length, 'checkId 唯一');
    assertSchema(REPORT_URN, report.report, '隐藏坏状态报告');
    const result = run(report, ctx);
    const codes = expectReject(result, chk + ' 隐藏坏状态');
    assert.ok(codes.some(c => new RegExp(chk, 'i').test(c) || /conflict|status|not_run|check/i.test(c)), JSON.stringify(codes));
  });
}

test('16 非 pass(needs_input)：global missing 缺证 issue 应接受且不伪造 ID', () => {
  const ctx = context();
  const report = makeReportOutput(ctx.data, 'needs_input');
  for (const c of report.report.checks) {
    c.status = 'not_run'; c.severity = 'info'; c.finding = '未运行：等待人工补证。';
    if (c.checkType === 'missing' || c.checkType === 'conflict') { c.claimRefs = []; c.evidenceRefs = []; }
    else { c.claimRefs = ['claim_rd_60']; c.evidenceRefs = []; }
  }
  ctx.receipts = [];
  report.report.issues = [
    { issueId: 'issue_global_missing', severity: 'error', category: 'missing', description: '关键缺失。', suggestedStage: 'needs_input' },
  ];
  report.report.summary = '证据不足，需补充原始资料。';
  assertSchema(REPORT_URN, report.report, 'needs_input report');
  const result = run(report, ctx);
  assert.equal(result.ok, true, '合法非 pass 报告应接受：' + JSON.stringify(result.issues));
  assert.deepEqual(codesOf(result), []);
  assert.deepEqual(checkOf(report.report, 'missing').claimRefs, []);
  assert.deepEqual(checkOf(report.report, 'support').claimRefs, ['claim_rd_60']);
});

test('17 版本错误的读取凭据应拒绝', () => {
  const ctx = context();
  const report = makeReportOutput(ctx.data, 'pass');
  const receipts = ctx.receipts.map(r => ({ ...r, documentVersionId: 'docv_stale_9' } as Receipt));
  const result = validateReviewReport(report, ctx.input, ctx.snapshot, ctx.envelope, receipts, registry);
  const codes = expectReject(result, '读取版本过期');
  assert.ok(codes.some(c => /version|document|read|evidence/i.test(c)), JSON.stringify(codes));
});
test('18 哈希错误的读取凭据应拒绝(fingerprint)', () => {
  const ctx = context();
  const report = makeReportOutput(ctx.data, 'pass');
  const receipts = ctx.receipts.map(r => ({ ...r, contentHash: 'sha256:' + 'b'.repeat(64) } as Receipt));
  const result = validateReviewReport(report, ctx.input, ctx.snapshot, ctx.envelope, receipts, registry);
  const codes = expectReject(result, '读取哈希被篡改');
  assert.ok(codes.some(c => /fingerprint|hash|read|evidence|receipt/i.test(c)), JSON.stringify(codes));
});
test('19 读取文本/段落索引与原始块不一致应拒绝（schema 仍合法）', () => {
  const ctx = context();
  for (const r of ctx.receipts) assertSchema(DOC_URN, r, 'receipt 应 schema 合法');
  const report = makeReportOutput(ctx.data, 'pass');
  const receipts = ctx.receipts.map((r, i) => {
    if (i !== 0) return r;
    const p = structuredClone(r) as unknown as Record<string, unknown>;
    if (typeof p.text === 'string') p.text = '被篡改的块文本';
    const loc = p.location as { kind?: string; paragraphIndex?: number } | undefined;
    if (loc && loc.kind === 'paragraph') loc.paragraphIndex = (loc.paragraphIndex ?? 0) + 777;
    assertSchema(DOC_URN, p, 'mutated receipt 应 schema 合法');
    return p as unknown as Receipt;
  });
  const result = validateReviewReport(report, ctx.input, ctx.snapshot, ctx.envelope, receipts, registry);
  const codes = expectReject(result, '读取文本/索引不一致');
  assert.ok(codes.includes('receipt.authority_mismatch'), JSON.stringify(codes));
});

test('20 快照含 error 级 missing 且全部检查 pass：仍应拒绝 pass', () => {
  const snapshot = baseSnapshot();
  snapshot.missing = [{ missingId: 'missing_required', entityId: 'ent_rd', description: '关键缺失', severity: 'error' }];
  const input = makeInput(snapshot);
  reconcile(input, snapshot);
  const ctx = ctxFrom(input, snapshot);
  const report = makeReportOutput(ctx.data, 'pass');
  for (const c of report.report.checks) { c.status = 'pass'; c.severity = 'info'; }
  assertSchema(SNAP_URN, snapshot, 'snapshot error missing');
  const result = run(report, ctx);
  const codes = expectReject(result, '存在 error 级缺失仍判 pass');
  assert.ok(codes.length > 0, JSON.stringify(codes));
});
test('21 快照含 warning 级 missing：required 全 pass 应接受 pass', () => {
  const snapshot = baseSnapshot();
  snapshot.missing = [{ missingId: 'missing_optional', entityId: 'ent_rd', description: '非阻塞缺失', severity: 'warning' }];
  const input = makeInput(snapshot);
  reconcile(input, snapshot);
  const ctx = ctxFrom(input, snapshot);
  const report = makeReportOutput(ctx.data, 'pass');
  for (const c of report.report.checks) { c.status = 'pass'; c.severity = 'info'; }
  report.report.issues = [
    { issueId: 'issue_warn', claimId: 'claim_rd_60', severity: 'warning', category: 'missing', description: '非阻塞缺失。', suggestedStage: 'facts_review' },
  ];
  assertSchema(SNAP_URN, snapshot, 'snapshot warning missing');
  assertSchema(REPORT_URN, report.report, 'pass report warning');
  const result = run(report, ctx);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(codesOf(result), []);
});
// ---------- 22..28：冲突/多证据/语义偏离/不变性/健壮性 ----------
type CountClaim = EvidenceSnapshot['claims'][number];

/** 克隆 claim_rd_60，加入第二个 value 相冲突的 claim（claim_rd_600），并保留原有 claim。 */
function snapshotWithConflict(
  mutateSecond?: (c: CountClaim) => void,
  mutateConflict?: (conf: EvidenceSnapshot['conflicts'][number]) => void,
): EvidenceSnapshot {
  const snapshot = baseSnapshot();
  const first = snapshot.claims[0];
  const second = structuredClone(first);
  second.claimId = 'claim_rd_600';
  second.claimVersionId = 'claimv_rd_600';
  second.entityId = first.entityId;
  second.predicate = first.predicate;
  second.qualifiers = structuredClone(first.qualifiers);
  second.value = { type: 'quantity', normalized: 600, unit: '人', raw: '600人' };
  second.reviewStatus = 'pending';
  if (mutateSecond) mutateSecond(second);
  snapshot.claims.push(second);
  const conflict: EvidenceSnapshot['conflicts'][number] = {
    conflictId: 'conf_rd',
    claimRefs: ['claim_rd_60', 'claim_rd_600'],
    description: '同一主体同一谓词的数值冲突。',
    resolutionStatus: 'open',
  };
  if (mutateConflict) mutateConflict(conflict);
  snapshot.conflicts = [conflict];
  return snapshot;
}

/** 构造 2-claim 冲突场景上下文；两个 claim 均被 support/value 等覆盖并引用 ev_rd_60。 */
function conflictCtx(snapshot: EvidenceSnapshot): Bctx {
  const input = makeInput(snapshot);
  reconcile(input, snapshot);
  return ctxFrom(input, snapshot);
}

/** 覆盖冲突场景的双 claim：全部非全局检查均引用两个 claim 与 ev_rd_60；conflict 全局 pass。 */
function conflictReport(ctx: Bctx, verdict: ReviewOutput['report']['verdict'] = 'pass'): ReviewOutput {
  const report = makeReportOutput(ctx.data, verdict);
  for (const c of report.report.checks) {
    if (c.checkType === 'conflict') { c.status = 'pass'; c.severity = 'info'; c.claimRefs = []; c.evidenceRefs = []; continue; }
    if (c.checkType === 'missing') { c.status = 'pass'; c.severity = 'info'; c.claimRefs = []; c.evidenceRefs = []; continue; }
    c.claimRefs = ['claim_rd_60', 'claim_rd_600'];
    c.evidenceRefs = ['ev_rd_60'];
  }
  return report;
}

test('22 未解决冲突（normalized 600 vs 60）：schema 合法但程序应拒绝 pass', () => {
  const snapshot = snapshotWithConflict();
  assert.equal(snapshot.claims.length, 2);
  assert.equal(snapshot.claims[1].claimId, 'claim_rd_600');
  assert.equal(snapshot.claims[1].claimVersionId, 'claimv_rd_600');
  assert.equal(snapshot.claims[1].entityId, snapshot.claims[0].entityId);
  assert.equal(snapshot.claims[1].predicate, snapshot.claims[0].predicate);
  assert.deepEqual(snapshot.claims[1].qualifiers, snapshot.claims[0].qualifiers);
  assert.equal(snapshot.conflicts[0].conflictId, 'conf_rd');
  assert.deepEqual(snapshot.conflicts[0].claimRefs, ['claim_rd_60', 'claim_rd_600']);
  assert.equal(snapshot.conflicts[0].resolutionStatus, 'open');
  for (const c of snapshot.claims) assert.equal(c.reviewStatus, 'pending');
  assertSchema(SNAP_URN, snapshot, 'conflict snapshot');
  const ctx = conflictCtx(snapshot);
  const report = conflictReport(ctx, 'pass');
  for (const c of report.report.checks) {
    if (c.checkType === 'conflict' || c.checkType === 'missing') continue;
    assert.deepEqual(c.claimRefs, ['claim_rd_60', 'claim_rd_600']);
    assert.deepEqual(c.evidenceRefs, ['ev_rd_60']);
  }
  assert.equal(checkOf(report.report, 'conflict').status, 'pass');
  assertSchema(REPORT_URN, report.report, 'conflict report');
  const result = run(report, ctx);
  const codes = expectReject(result, '未解决冲突仍判 pass');
  assert.ok(codes.some(c => /conflict/i.test(c)), JSON.stringify(codes));
});

test('23 同键 open 冲突但 normalized 无实质数值差异：应接受 pass', () => {
  const snapshot = snapshotWithConflict(second => {
    second.value = { type: 'quantity', normalized: 60, unit: '人', raw: '六十人左右' };
  });
  assert.ok(snapshot.claims[0].value.type === 'quantity');
  assert.ok(snapshot.claims[1].value.type === 'quantity');
  assert.equal(snapshot.conflicts[0].resolutionStatus, 'open');
  assertSchema(SNAP_URN, snapshot, 'same-key conflict snapshot');
  const ctx = conflictCtx(snapshot);
  const report = conflictReport(ctx, 'pass');
  assertSchema(REPORT_URN, report.report, 'same-key conflict report');
  const result = run(report, ctx);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(codesOf(result), []);
});

test('24 同值但 time.year 不同（2025 vs 2023）：应接受为不同时间', () => {
  const snapshot = snapshotWithConflict(second => {
    second.value = { type: 'quantity', normalized: 600, unit: '人', raw: '600人' };
    assert.ok(second.qualifiers, 'second qualifiers 存在');
    assert.ok(second.qualifiers!.time, 'second time 存在');
    second.qualifiers!.time!.year = 2023;
  });
  assert.equal(snapshot.claims[0].qualifiers?.time?.year, 2025);
  assert.equal(snapshot.claims[1].qualifiers?.time?.year, 2023);
  assertSchema(SNAP_URN, snapshot, 'different-time snapshot');
  const ctx = conflictCtx(snapshot);
  const report = conflictReport(ctx, 'pass');
  assertSchema(REPORT_URN, report.report, 'different-time report');
  const result = run(report, ctx);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(codesOf(result), []);
  assert.equal(ctx.input.subject.contentHash, fingerprint(ctx.snapshot));
});

test('25 pass 必须读取全部相关证据：第二条相关证据未读应拒绝（非缺失检查/非 schema 非法）', () => {
  const snapshot = baseSnapshot();
  const second = structuredClone(snapshot.claims[0]);
  second.claimId = 'claim_rd_600';
  second.claimVersionId = 'claimv_rd_600';
  second.value = { type: 'quantity', normalized: 600, unit: '人', raw: '600人' };
  second.reviewStatus = 'pending';
  snapshot.claims.push(second);
  const b003 = rawInput.documents.find(d => d.documentId === 'doc_profile')!.blocks.find(b => b.blockId === 'b003')!;
  const evSecond = structuredClone(snapshot.evidence[0]);
  evSecond.evidenceId = 'ev_second';
  evSecond.blockId = 'b003';
  evSecond.locator = structuredClone(b003.location);
  evSecond.excerpt = b003.text;
  snapshot.evidence.push(evSecond);
  snapshot.claims[1].evidenceRefs = ['ev_rd_60', 'ev_second'];
  assertSchema(SNAP_URN, snapshot, 'unread-second-evidence snapshot');
  const input = makeInput(snapshot);
  reconcile(input, snapshot);
  // 仅请求 doc_profile/b004，导致 b003 的第二条相关证据未被读取。
  const reader = createDocumentReader({ scope: input.scope, documents: input.documents }, registry);
  const receipts = [reader({ documentId: 'doc_profile', documentVersionId: 'docv_profile_1', blockId: 'b004' })];
  assertSchema(DOC_URN, receipts[0], 'b004 receipt');
  const envelope = envelopeFor();
  const data = { envelope, subject: structuredClone(input.subject), task: { projectId: input.projectId, taskId: input.taskId, attemptId: input.attemptId } };
  const report = makeReportOutput(data, 'pass');
  for (const c of report.report.checks) {
    if (c.checkType === 'missing' || c.checkType === 'conflict') { c.claimRefs = []; c.evidenceRefs = []; continue; }
    c.claimRefs = ['claim_rd_60', 'claim_rd_600'];
    c.evidenceRefs = ['ev_rd_60'];
  }
  assert.equal(report.report.checks.length, 10);
  for (const c of report.report.checks) if (!(c.checkType === 'missing' || c.checkType === 'conflict')) assert.equal(c.status, 'pass');
  assertSchema(REPORT_URN, report.report, 'unread-second-evidence report');
  const result = validateReviewReport(report, input, snapshot, envelope, receipts, registry);
  const codes = expectReject(result, '第二条相关证据未读取');
  assert.ok(codes.some(c => /read|receipt|evidence|support/i.test(c)), JSON.stringify(codes));
});

test('26 semantic-wrong 但 schema 合法的 valid revise：程序不做法学/语义判决，应接受', () => {
  const snapshot = baseSnapshot();
  const input = makeInput(snapshot);
  input.checksRequired = ['support'];
  reconcile(input, snapshot);
  const ctx = ctxFrom(input, snapshot);
  const report = makeReportOutput(ctx.data, 'revise');
  report.report.checks = [checkOf(report.report, 'support')];
  checkOf(report.report, 'support').status = 'fail';
  checkOf(report.report, 'support').severity = 'error';
  checkOf(report.report, 'support').finding = '候选值与来源不符。';
  checkOf(report.report, 'support').claimRefs = ['claim_rd_60'];
  checkOf(report.report, 'support').evidenceRefs = ['ev_rd_60'];
  const cand = ctx.snapshot.claims[0];
  cand.value = { type: 'quantity', normalized: 999, unit: '吨', raw: '999吨' };
  cand.qualifiers = { ...cand.qualifiers, time: { ...(cand.qualifiers?.time ?? { year: 1901 }), year: 1901 } };
  ctx.snapshot.evidence[0].excerpt = '这段摘录与来源不符。';
  ctx.snapshot.evidence[0].locator = { kind: 'paragraph', paragraphIndex: 999 };
  assertSchema(SNAP_URN, ctx.snapshot, 'semantic-wrong snapshot');
  report.report.issues = [
    { issueId: 'issue_semantic_wrong', claimId: 'claim_rd_60', evidenceRefs: ['ev_rd_60'], severity: 'error', category: 'support', description: '候选语义偏离，需修订。', expected: '60 人', actual: '999 吨', suggestedStage: 'facts_review' },
  ];
  assertSchema(REPORT_URN, report.report, 'semantic-wrong revise report');
  reconcile(input, ctx.snapshot);
  report.report.subject = structuredClone(input.subject);
  const result = run(report, ctx);
  assert.equal(result.ok, true, 'schema 合法的 valid revise 应被接受：' + JSON.stringify(result.issues));
  assert.deepEqual(codesOf(result), []);
  assert.equal(ctx.input.subject.contentHash, fingerprint(ctx.snapshot));
  for (const r of ctx.receipts) assertSchema(DOC_URN, r, 'ctxFrom 读取凭据');
});

test('27 校验为纯函数：input/snapshot/report/receipts 在校验前后不变', () => {
  const ctx = context();
  const report = makeReportOutput(ctx.data, 'pass');
  const before = {
    input: structuredClone(ctx.input),
    snapshot: structuredClone(ctx.snapshot),
    report: structuredClone(report),
    receipts: structuredClone(ctx.receipts),
  };
  const result = run(report, ctx);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(ctx.input, before.input);
  assert.deepEqual(ctx.snapshot, before.snapshot);
  assert.deepEqual(report, before.report);
  assert.deepEqual(ctx.receipts, before.receipts);
});

test('28 缺少 report 的输出：应拒绝且不抛异常', () => {
  const ctx = context();
  const malformed = { protocolVersion: '1.0', projectId: ctx.input.projectId, taskId: ctx.input.taskId, attemptId: ctx.input.attemptId, status: 'completed' };
  let result: ReturnType<typeof run> | undefined;
  assert.doesNotThrow(() => { result = run(malformed, ctx); }, '缺少 report 不得抛异常');
  assert.ok(result, '应返回结果');
  const codes = expectReject(result!, '缺少 report');
  assert.ok(codes.length > 0, JSON.stringify(codes));
});
