/**
 * design-review-ref 权威 Schema 与生成类型绑定的协议测试（SYNTHETIC）。
 * 仅作可信服务核验后结构的合成协议单元夹具：通过状态为测试装配，
 * 不代表真实语义验收；真实 verifyDesignHandoff 路径由消费专项覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadSchemasFromDir } from '../../packages/contracts/src/schema-registry.ts';
import { fingerprint } from '../../packages/contracts/src/fingerprint.ts';
import { designFixture, designTaskFixture } from '../helpers/design-fixtures.ts';
import { checkDesignInput, checkDesignOutput } from '../../packages/contracts/src/design-agent-checks.ts';
import type { DesignTaskContext } from '../../packages/contracts/src/design-agent-checks.ts';
import type { DesignReviewRef } from '../../packages/contracts/generated/index.ts';

const registry = loadSchemasFromDir('packages/contracts/schemas');
const SCHEMA_ID = 'urn:tju-mas:contracts:design-review-ref';
const HASH = 'sha256:' + 'a'.repeat(64);
const REVIEW_CHECKS = ['support', 'traceability'];

function validRef(): Record<string, unknown> {
  return {
    packageVersion: '1.0',
    runId: 'run_design_review_test',
    projectId: 'project_design_review_test',
    taskId: 'task_design_review_test',
    attemptId: 'attempt_design_review_test',
    candidateVersionId: 'candv_design_review_test',
    reportVersionId: 'reportv_design_review_test',
    candidateFingerprint: HASH,
    reportFingerprint: HASH,
    bindingFingerprint: HASH,
    reviewVerdict: 'pass',
    stopReason: 'passed_all_checks',
    checksRequired: [...REVIEW_CHECKS],
  };
}

function validate(ref: unknown) {
  return registry.validate(SCHEMA_ID, ref);
}

/* ── Schema 正负例 ─────────────────────────────────────────────────────────── */

test('[SYNTHETIC] design-review-ref 正例通过权威 Schema', () => {
  const result = validate(validRef());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('[SYNTHETIC] 未知版本 99.99 被拒绝', () => {
  assert.equal(validate({ ...validRef(), packageVersion: '99.99' }).valid, false);
});

test('[SYNTHETIC] 非额外属性被拒绝（additionalProperties=false）', () => {
  assert.equal(validate({ ...validRef(), isTrusted: true }).valid, false);
  assert.equal(validate({ ...validRef(), bindingFingerprintExtra: HASH }).valid, false);
});

test('[SYNTHETIC] 缺任一必填字段被拒绝（13 字段）', () => {
  const keys = Object.keys(validRef());
  assert.equal(keys.length, 13, '引用必须恰为 13 个字段');
  for (const field of keys) {
    const ref = validRef();
    delete (ref as Record<string, unknown>)[field];
    assert.equal(validate(ref).valid, false, `缺少 ${field} 应被拒绝`);
  }
});

test('[SYNTHETIC] 非法 hash/ID/版本被拒绝', () => {
  const cases: Array<[string, unknown]> = [
    ['candidateFingerprint', { ...validRef(), candidateFingerprint: 'sha256:XYZ' }],
    ['reportFingerprint', { ...validRef(), reportFingerprint: 'not-a-hash' }],
    ['bindingFingerprint', { ...validRef(), bindingFingerprint: 'sha256:' + 'A'.repeat(64) }],
    ['runId', { ...validRef(), runId: 'Run-Bad' }],
    ['projectId', { ...validRef(), projectId: 'project-1' }],
    ['taskId', { ...validRef(), taskId: 'task_ok!' }],
    ['attemptId', { ...validRef(), attemptId: 'attempt_ok!' }],
    ['packageVersion', { ...validRef(), packageVersion: 'v1' }],
    ['candidateVersionId', { ...validRef(), candidateVersionId: 'CandvBad' }],
    ['reportVersionId', { ...validRef(), reportVersionId: 'ReportvBad' }],
  ];
  for (const [label, ref] of cases) {
    assert.equal(validate(ref).valid, false, `${label} 非法值应被拒绝`);
  }
});

test('[SYNTHETIC] 非 pass 结论或错误 stopReason 被拒绝', () => {
  assert.equal(validate({ ...validRef(), reviewVerdict: 'revise' }).valid, false);
  assert.equal(validate({ ...validRef(), reviewVerdict: 'needs_input' }).valid, false);
  // 上游要求 passed_all_checks，不能写成 passed。
  assert.equal(validate({ ...validRef(), stopReason: 'passed' }).valid, false);
  assert.equal(validate({ ...validRef(), stopReason: 'blocked' }).valid, false);
});

test('[SYNTHETIC] 空或重复检查集合被拒绝', () => {
  assert.equal(validate({ ...validRef(), checksRequired: [] }).valid, false);
  assert.equal(validate({ ...validRef(), checksRequired: ['support', 'support'] }).valid, false);
});

/* ── 完整可信绑定夹具（随变更重算所有 hash） ───────────────────────────────── */

interface BindingFixture {
  input: any;
  trusted: DesignTaskContext;
  output: any;
}

/**
 * 由 designTaskFixture 派生 pending 快照 + pending claims，并构造与审批绑定一致
 * 的完整可信 context。任何变更后必须整体重算 snapshotRef/context.snapshotHash/
 * inputHash/plan 与 page 的 snapshotRef/page.informationPlanRef.contentHash。
 */
function buildBindingFixture(): BindingFixture {
  const f = designFixture();
  const base = designTaskFixture();

  // pending 快照：内容与 fixture 一致，仅 reviewStatus 转 pending，claims 亦 pending。
  const snapshot = structuredClone(f.snapshot);
  snapshot.reviewStatus = 'pending';
  for (const claim of snapshot.claims ?? []) claim.reviewStatus = 'pending';

  const snapshotHash = fingerprint(snapshot);

  // 展开 validRef() 后必须覆盖全部真实身份字段：仅覆盖 candidateVersionId/hash
  // 会保留 fixture 的假 projectId/taskId/attemptId，导致 hasVerifiedDesignReview 不成立。
  const ref: DesignReviewRef = {
    ...(validRef() as unknown as DesignReviewRef),
    runId: base.input.projectId ? (validRef() as any).runId : (validRef() as any).runId,
    projectId: snapshot.projectId,
    taskId: snapshot.taskId,
    attemptId: snapshot.attemptId,
    candidateVersionId: snapshot.snapshotVersionId,
    candidateFingerprint: snapshotHash,
  };

  const context = {
    projectId: snapshot.projectId,
    taskId: snapshot.taskId,
    attemptId: snapshot.attemptId,
    snapshotHash,
    reviewRef: ref,
    allowedSources: [
      ...snapshot.entities.map((e: any) => ({ kind: 'entity', id: e.entityId })),
      ...snapshot.claims.map((c: any) => ({ kind: 'claim', id: c.claimId })),
      ...(snapshot.relations ?? []).map((r: any) => ({ kind: 'relation', id: r.relationId })),
      ...(snapshot.events ?? []).map((e: any) => ({ kind: 'event', id: e.eventId })),
      ...(snapshot.assets ?? []).map((a: any) => ({ kind: 'asset', id: a.assetId })),
    ],
    catalog: structuredClone(f.context.catalog),
    theme: structuredClone(f.context.theme),
  };

  const snapshotRef = {
    snapshotId: snapshot.snapshotId,
    snapshotVersionId: snapshot.snapshotVersionId,
    contentHash: snapshotHash,
  };

  // plan：绑定 snapshotRef 与 reviewRef。
  const plan = structuredClone(f.plan);
  plan.snapshotRef = structuredClone(snapshotRef);
  plan.reviewRef = structuredClone(ref);
  plan.projectId = snapshot.projectId;
  plan.taskId = snapshot.taskId;
  plan.attemptId = snapshot.attemptId;

  // page：绑定 snapshotRef、reviewRef，并按最终 plan 重算 informationPlanRef。
  const page = structuredClone(f.page);
  page.snapshotRef = structuredClone(snapshotRef);
  page.reviewRef = structuredClone(ref);
  page.projectId = snapshot.projectId;
  page.taskId = snapshot.taskId;
  page.attemptId = snapshot.attemptId;
  page.informationPlanRef = {
    planId: plan.planId,
    planVersionId: plan.planVersionId,
    contentHash: fingerprint(plan),
  };

  const input = {
    protocolVersion: '1.0',
    projectId: snapshot.projectId,
    taskId: snapshot.taskId,
    attemptId: snapshot.attemptId,
    taskType: 'generate',
    snapshot,
    snapshotRef,
    reviewRef: structuredClone(ref),
    audience: structuredClone(f.plan.audience),
    goal: structuredClone(f.plan.goal),
    visualGuidance: [...base.input.visualGuidance],
    constraints: structuredClone(base.input.constraints),
    catalog: structuredClone(context.catalog),
    theme: structuredClone(context.theme),
  };

  const trusted: DesignTaskContext = { inputHash: fingerprint(input), design: context };

  const output = {
    protocolVersion: '1.0',
    projectId: input.projectId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    inputHash: trusted.inputHash,
    status: 'completed',
    reviewRef: structuredClone(ref),
    informationPlan: plan,
    pageSpec: page,
    producedBy: { role: 'design', protocolVersion: '1.0' },
  };

  return { input, trusted, output };
}

/** 基线有效：任何负例前后都必须存在。 */
function assertBaselineValid(fx: BindingFixture) {
  const inputResult = checkDesignInput(fx.input, registry, fx.trusted);
  assert.equal(inputResult.ok, true, '基线 checkDesignInput 必须成功：' + JSON.stringify(inputResult.issues));
  const outputResult = checkDesignOutput(fx.output, fx.input, registry, fx.trusted);
  assert.equal(outputResult.ok, true, '基线 checkDesignOutput 必须成功：' + JSON.stringify(outputResult.issues));
}

function hasBindingIssue(result: { issues: Array<{ code: string }> }): boolean {
  return result.issues.some(i => i.code === 'design.review_binding' || i.code.includes('review_binding'));
}

/* ── pending 与无可信 reviewRef ────────────────────────────────────────────── */

test('[SYNTHETIC] pending 且无可信 reviewRef：checkDesignInput 明确拒绝', () => {
  const f = designFixture();
  const base = designTaskFixture();
  const snapshot = structuredClone(f.snapshot);
  snapshot.reviewStatus = 'pending';
  for (const claim of snapshot.claims ?? []) claim.reviewStatus = 'pending';
  const context = { ...structuredClone(f.context), snapshotHash: fingerprint(snapshot) };
  delete (context as any).reviewRef;
  const input = {
    ...structuredClone(base.input),
    snapshot,
    snapshotRef: {
      snapshotId: snapshot.snapshotId,
      snapshotVersionId: snapshot.snapshotVersionId,
      contentHash: context.snapshotHash,
    },
  };
  delete (input as any).reviewRef;
  const trusted: DesignTaskContext = { inputHash: fingerprint(input), design: context };
  const result = checkDesignInput(input, registry, trusted);
  assert.equal(result.ok, false, 'pending 且无 reviewRef 必须拒绝');
  assert.ok(result.issues.some(i => i.code === 'design.snapshot_not_reviewed'));
});

test('[SYNTHETIC] pending 配结构合法但与 trusted 不同的 ref 被拒绝', () => {
  const fx = buildBindingFixture();
  assertBaselineValid(fx);
  const otherRef: DesignReviewRef = {
    ...(fx.trusted.design.reviewRef as DesignReviewRef),
    bindingFingerprint: 'sha256:' + '7'.repeat(64),
  };
  // 只伪造提交侧 input.ref；trusted 侧保留可信服务自行赋予的原绑定。
  const input = structuredClone(fx.input);
  input.reviewRef = structuredClone(otherRef);
  const trusted: DesignTaskContext = {
    inputHash: fingerprint(input),
    design: structuredClone(fx.trusted.design),
  };
  // 快照与 trusted.design 均未变，仅 input.ref 更替 → 与可信绑定不一致，必须拒绝。
  const result = checkDesignInput(input, registry, trusted);
  assert.equal(result.ok, false);
  assert.ok(
    result.issues.some(i => i.code === 'design.review_binding' || i.code.includes('review_binding')),
    JSON.stringify(result.issues),
  );
});

test('[SYNTHETIC] 正确完整可信绑定：checkDesignInput 与 checkDesignOutput 严格成功', () => {
  const fx = buildBindingFixture();
  assertBaselineValid(fx);
});

/* ── 篡改目标 reviewRef 并重算非目标 hash ──────────────────────────────────── */

test('[SYNTHETIC] 篡改 input.reviewRef：重算 inputHash 后仍被拒绝', () => {
  const fx = buildBindingFixture();
  assertBaselineValid(fx);
  const forgedRef = {
    ...(fx.input.reviewRef as Record<string, unknown>),
    reportVersionId: 'reportv_forged_binding_synthetic',
  };
  const input = structuredClone(fx.input);
  input.reviewRef = forgedRef;
  // 重算 inputHash，避免仅指纹过期造成的伪覆盖。
  const trusted: DesignTaskContext = { inputHash: fingerprint(input), design: structuredClone(fx.trusted.design) };
  const result = checkDesignInput(input, registry, trusted);
  assert.equal(result.ok, false);
  assert.ok(hasBindingIssue(result), JSON.stringify(result.issues));
  assertBaselineValid(fx);
});

test('[SYNTHETIC] 篡改 output.reviewRef：重算 inputHash 无关，仍被拒绝', () => {
  const fx = buildBindingFixture();
  assertBaselineValid(fx);
  const output = structuredClone(fx.output);
  output.reviewRef = { ...fx.output.reviewRef, reportVersionId: 'reportv_forged_output_synthetic' };
  const result = checkDesignOutput(output, fx.input, registry, fx.trusted);
  assert.equal(result.ok, false);
  assert.ok(hasBindingIssue(result), JSON.stringify(result.issues));
  assertBaselineValid(fx);
});

test('[SYNTHETIC] 篡改 plan.reviewRef：重算 plan 与 page.informationPlanRef 后仍被拒绝', () => {
  const fx = buildBindingFixture();
  assertBaselineValid(fx);
  const output = structuredClone(fx.output);
  output.informationPlan.reviewRef = {
    ...fx.output.informationPlan.reviewRef,
    reportVersionId: 'reportv_forged_plan_synthetic',
  };
  // 重算 page.informationPlanRef.contentHash，避免仅 hash 过期。
  output.pageSpec.informationPlanRef.contentHash = fingerprint(output.informationPlan);
  const result = checkDesignOutput(output, fx.input, registry, fx.trusted);
  assert.equal(result.ok, false);
  assert.ok(hasBindingIssue(result), JSON.stringify(result.issues));
  assertBaselineValid(fx);
});

test('[SYNTHETIC] 篡改 page.reviewRef：重算 informationPlanRef 后仍被拒绝', () => {
  const fx = buildBindingFixture();
  assertBaselineValid(fx);
  const output = structuredClone(fx.output);
  output.pageSpec.reviewRef = {
    ...fx.output.pageSpec.reviewRef,
    reportVersionId: 'reportv_forged_page_synthetic',
  };
  // 目标为 page.reviewRef，informationPlanRef 未变，无需改动 plan。
  const result = checkDesignOutput(output, fx.input, registry, fx.trusted);
  assert.equal(result.ok, false);
  assert.ok(hasBindingIssue(result), JSON.stringify(result.issues));
  assertBaselineValid(fx);
});

/* ── reviewRef 候选版本／hash 必须匹配实际 snapshot ────────────────────────── */

test('[SYNTHETIC] reviewRef.candidateVersionId 与 snapshot 不匹配被拒绝', () => {
  const fx = buildBindingFixture();
  assertBaselineValid(fx);
  const input = structuredClone(fx.input);
  input.reviewRef = { ...input.reviewRef, candidateVersionId: 'snapv_forged_binding_synthetic' };
  const trusted: DesignTaskContext = {
    inputHash: fingerprint(input),
    design: { ...structuredClone(fx.trusted.design), reviewRef: structuredClone(input.reviewRef) },
  };
  const result = checkDesignInput(input, registry, trusted);
  assert.equal(result.ok, false);
  assert.ok(result.issues.length > 0);
});

test('[SYNTHETIC] reviewRef.candidateFingerprint 与 snapshotHash 不匹配被拒绝', () => {
  const fx = buildBindingFixture();
  assertBaselineValid(fx);
  const input = structuredClone(fx.input);
  input.reviewRef = { ...input.reviewRef, candidateFingerprint: 'sha256:' + '6'.repeat(64) };
  const trusted: DesignTaskContext = {
    inputHash: fingerprint(input),
    design: { ...structuredClone(fx.trusted.design), reviewRef: structuredClone(input.reviewRef) },
  };
  const result = checkDesignInput(input, registry, trusted);
  assert.equal(result.ok, false);
  assert.ok(result.issues.length > 0);
});