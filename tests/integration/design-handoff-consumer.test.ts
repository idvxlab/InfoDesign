/**
 * B5 设计交底消费适配层集成测试（SYNTHETIC）。
 * 复用真实上游 produceDesignHandoff/verifyDesignHandoff、MemoryFactRunStore
 * 与既有 B5 harness；绝不使用总返回 ok 的假核验器。
 * runRich 通过 defaultScript 同步驱动夹具，属合成装配：其“成功”只是夹具自洽，
 * 不构成真实模型质量证据，也不代表真实语义验收；失败分支证明零设计调用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  produceDesignHandoff,
  verifyDesignHandoff,
  DESIGN_HANDOFF_PACKAGE_VERSION,
  type HandoffContextPins,
  type DesignHandoffReadyPackage,
} from '../../apps/server/src/domain/design-handoff.ts';
import {
  MemoryFactRunStore,
  type FactRunRecord,
  type FactRunStore,
} from '../../apps/server/src/domain/fact-run.service.ts';
import { loadSchemasFromDir } from '../../packages/contracts/src/schema-registry.ts';
import { fingerprint } from '../../packages/contracts/src/fingerprint.ts';
import { DEFAULT_REVIEW_CHECKS } from '../../apps/server/src/orchestration/fact-workflow.ts';
import { checkDesignInput } from '../../packages/contracts/src/design-agent-checks.ts';
import {
  runFactScenario,
  defaultScript,
  type ScenarioOptions,
} from '../helpers/fact-workflow-harness.ts';
import { designFixture } from '../helpers/design-fixtures.ts';
import {
  consumeDesignHandoff,
  type HandoffConsumerTrustedContext,
} from '../../apps/server/src/domain/design-handoff-consumer.ts';

const registry = loadSchemasFromDir('packages/contracts/schemas');

type RichRecord = FactRunRecord & {
  artifacts: NonNullable<FactRunRecord['artifacts']>;
  inputSnapshot: NonNullable<FactRunRecord['inputSnapshot']>;
};

/** 合成夹具成功；不声称真实模型质量。 */
async function runRich(options: Partial<ScenarioOptions> = {}): Promise<RichRecord> {
  const { result } = await runFactScenario({ script: defaultScript(), ...options });
  assert.ok(result.record, '夹具必须产出 record');
  const record = result.record as FactRunRecord;
  assert.ok(record.artifacts, '记录必须包含 artifacts');
  assert.ok(record.inputSnapshot, '记录必须包含 inputSnapshot');
  return record as RichRecord;
}

/** 从真实夹具记录派生可信上下文钉；生产实现另行独立授权。 */
function deriveTrustedPins(record: RichRecord): HandoffContextPins {
  const documentRefs = record.inputSnapshot.scope.documentRefs ?? [];
  return {
    runId: record.runId,
    projectId: record.projectId,
    taskId: record.taskId,
    attemptId: record.attemptId,
    expectedCandidateVersionId: record.currentVersionId ?? null,
    expectedReportVersionId: record.rounds.at(-1)?.reportVersionId ?? null,
    allowedDocumentRefs: documentRefs as HandoffContextPins['allowedDocumentRefs'],
    checksRequired: [...DEFAULT_REVIEW_CHECKS],
  };
}

/**
 * 从「可信 record 的当前候选 artifact」独立构造设计上下文：
 * 权限快照只来自 store 中已核验候选的 output.candidateSnapshot，
 * 绝不从 submitted 交接包（或包内自述）反推授权。
 */
function trustedContextFor(record: RichRecord): HandoffConsumerTrustedContext {
  const candidateArtifact = record.artifacts.find(
    a => a.kind === 'candidate' && a.versionId === record.currentVersionId,
  );
  assert.ok(candidateArtifact, '当前候选 artifact 必须存在');
  const snapshot = structuredClone(
    (candidateArtifact as any).output.candidateSnapshot,
  ) as Record<string, any>;
  const allowedSources: HandoffConsumerTrustedContext['design']['allowedSources'] = [
    ...(snapshot.entities ?? []).map((e: any) => ({ kind: 'entity', id: e.entityId })),
    ...(snapshot.claims ?? []).map((c: any) => ({ kind: 'claim', id: c.claimId })),
    ...(snapshot.relations ?? []).map((r: any) => ({ kind: 'relation', id: r.relationId })),
    ...(snapshot.events ?? []).map((e: any) => ({ kind: 'event', id: e.eventId })),
    ...(snapshot.assets ?? []).map((a: any) => ({ kind: 'asset', id: a.assetId })),
  ];
  // 真实 Schema 要求 audience:{role,needs}、goal:string；catalog/theme/audience/goal
  // 复制 designFixture 的有效值（hash 不写假 b/c 值，而沿用夹具真实 contentHash）。
  const fixture = designFixture();
  return {
    design: {
      projectId: record.projectId,
      taskId: record.taskId,
      attemptId: record.attemptId,
      snapshotHash: fingerprint(snapshot),
      allowedSources,
      catalog: structuredClone(fixture.context.catalog),
      theme: structuredClone(fixture.context.theme),
    },
    audience: structuredClone(fixture.plan.audience),
    goal: fixture.plan.goal,
    visualGuidance: ['使用清晰的信息层级'],
    constraints: { language: 'zh-CN', maxSections: 5, maxNodes: 10 },
  };
}

function detachedStore(record: RichRecord): { store: FactRunStore; copy: RichRecord } {
  const copy = structuredClone(record);
  const store = new MemoryFactRunStore();
  store.save(copy);
  return { store, copy };
}

function mutateStore(
  record: RichRecord,
  mutate: (copy: RichRecord) => void,
): { store: FactRunStore; copy: RichRecord } {
  const { store, copy } = detachedStore(record);
  mutate(copy);
  store.save(copy);
  return { store, copy };
}

/** 零设计调用的探针：由 caller gate `if (result.ok)` 真实驱动。 */
function makeDesignCallCounter() {
  const state = { calls: 0 };
  return { state, call: () => { state.calls += 1; } };
}

function readyPackageFor(record: RichRecord): { store: FactRunStore; copy: RichRecord; pins: HandoffContextPins; ready: DesignHandoffReadyPackage } {
  const pins = deriveTrustedPins(record);
  const { store, copy } = detachedStore(record);
  const ready = produceDesignHandoff(store, registry, pins) as DesignHandoffReadyPackage;
  assert.equal(ready.kind, 'ready', '夹具必须产出真实 ready 包');
  // 真实核验路径必须通过；这是正例基线，失败即测试装配错误。
  assert.equal(verifyDesignHandoff(ready, store, registry, pins).ok, true);
  return { store, copy, pins, ready };
}

/* ── ready 正例 ───────────────────────────────────────────────────────────── */

test('[SYNTHETIC MOCK] ready 正例：严格成功、指纹一致、绑定一致、snapshot/claims 仍 pending', async () => {
  const record = await runRich();
  const { store, copy, pins, ready } = readyPackageFor(record);

  const counter = makeDesignCallCounter();
  const trusted = trustedContextFor(record);
  // 调用前保存真实 store 状态；调用后必须与原记录完全一致（不得回写）。
  const storeBefore = structuredClone(store.get(record.runId));
  assert.ok(storeBefore, '夹具 record 必须已登记于 store');
  const result = consumeDesignHandoff(ready, store, registry, pins, trusted);
  if (result.ok) counter.call();
  assert.equal(result.ok, true, JSON.stringify(result.ok ? [] : result.reasons));

  // 现有检查器必须对返回输入与独立上下文通过。
  assert.equal(checkDesignInput(result.input, registry, result.context).ok, true);
  // 指纹必须为本次组装后由服务自算的真实指纹。
  assert.equal(fingerprint(result.input), result.context.inputHash);
  // 根级 bindingFingerprint 必须一致（仅存在于包根/引用根级，不在 identity 内）。
  assert.equal(result.reviewRef.bindingFingerprint, (ready as any).bindingFingerprint);
  assert.equal(result.reviewRef.bindingFingerprint, ready.bindingFingerprint);
  // 成功路径 allowedSources 必须覆盖全部 supplied source（含非显示来源）。
  const recheck = checkDesignInput(result.input, registry, result.context);
  assert.equal(recheck.issues.some(i => i.code === 'design.input_source_forbidden'), false);
  // 快照/claims 仍为待审：消费不构成采纳。
  assert.equal((result.input.snapshot as any).reviewStatus, 'pending');
  for (const claim of (result.input.snapshot as any).claims ?? []) {
    assert.equal(claim.reviewStatus, 'pending');
  }
  assert.equal(counter.state.calls, 1);
  // 成功不得回写：真实 store 记录必须与调用前一致。
  const storeAfter = store.get(record.runId);
  assert.ok(storeAfter, 'store 记录必须仍然存在');
  assert.deepEqual(storeAfter, storeBefore);
});

test('[SYNTHETIC MOCK] 同一 ready/store/pins/trusted 重复消费：inputHash 与 reviewRef/input 稳定', async () => {
  const record = await runRich();
  const { store, pins, ready } = readyPackageFor(record);
  const trusted = trustedContextFor(record);

  const first = consumeDesignHandoff(ready, store, registry, pins, trusted);
  assert.equal(first.ok, true, JSON.stringify(first.ok ? [] : first.reasons));
  const second = consumeDesignHandoff(ready, store, registry, pins, trusted);
  assert.equal(second.ok, true, JSON.stringify(second.ok ? [] : second.reasons));

  assert.equal(first.context.inputHash, second.context.inputHash);
  assert.equal(fingerprint(first.input), fingerprint(second.input));
  assert.deepEqual(first.reviewRef, second.reviewRef);
  assert.deepEqual(first.input, second.input);

  // 深拷贝对象键序不影响指纹（序列化规范化）。
  const reordered = JSON.parse(JSON.stringify(second.input));
  reordered.snapshot = Object.fromEntries(Object.entries(reordered.snapshot).reverse());
  reordered.reviewRef = Object.fromEntries(Object.entries(reordered.reviewRef).reverse());
  assert.equal(fingerprint(reordered), first.context.inputHash);
});

test('[SYNTHETIC MOCK] 提交、trusted、store 前后 deepEqual；修改返回对象不回写', async () => {
  const record = await runRich();
  const { store, pins, ready } = readyPackageFor(record);
  const trusted = trustedContextFor(record);

  // 调用前保存真实 store 记录快照（copy 是 save 前快照，不能替代真实读取）。
  const storeBefore = structuredClone(store.get(record.runId));
  assert.ok(storeBefore, '夹具 record 必须已登记于 store');

  const submittedBefore = structuredClone(ready);
  const trustedBefore = structuredClone(trusted);

  const result = consumeDesignHandoff(ready, store, registry, pins, trusted);
  assert.equal(result.ok, true, JSON.stringify(result.ok ? [] : result.reasons));

  assert.deepEqual(ready, submittedBefore);
  assert.deepEqual(trusted, trustedBefore);
  // 真实 store 记录与调用前完全一致。
  const storeAfter = store.get(record.runId);
  assert.ok(storeAfter, 'store 记录必须仍然存在');
  assert.deepEqual(storeAfter, storeBefore);

  // 不变性：修改返回对象的嵌套成员，特别是 input.snapshot.claims[0].qualifiers
  // 中的新测试字段（或其 value 对象），以及 context.design.allowedSources[0].id。
  const claims = (result.input.snapshot as any).claims ?? [];
  assert.ok(Array.isArray(claims) && claims.length > 0, '返回 input.snapshot.claims 必须非空');
  const qualifiers = claims[0].qualifiers;
  assert.ok(qualifiers !== undefined && qualifiers !== null, '返回 claims[0].qualifiers 必须存在方可测试嵌套不变性');
  assert.equal(typeof qualifiers, 'object', 'claims[0].qualifiers 必须为对象');
  assert.equal(Array.isArray(qualifiers), false, 'claims[0].qualifiers 不得为数组');
  qualifiers.syntheticMutationProbe = 'mutated_by_test';
  qualifiers.basis = 'synthetic_mutated_basis';
  assert.ok(claims[0].value && typeof claims[0].value === 'object', 'claims[0].value 必须为对象');
  (claims[0].value as any).syntheticMutationProbe = 'mutated_by_test';
  const allowedSources = result.context.design.allowedSources;
  assert.ok(Array.isArray(allowedSources) && allowedSources.length > 0, 'allowedSources 必须非空');
  allowedSources[0].id = 'synthetic_mutated_source_id';

  // 修改返回对象后，submitted/trusted/实际 store 记录仍与调用前完全一致。
  assert.deepEqual(ready, submittedBefore);
  assert.deepEqual(trusted, trustedBefore);
  const storeAfterMutation = store.get(record.runId);
  assert.ok(storeAfterMutation, 'store 记录必须仍然存在');
  assert.deepEqual(storeAfterMutation, storeBefore);

  // 再次消费仍然严格成功，且指纹稳定。
  const again = consumeDesignHandoff(ready, store, registry, pins, trusted);
  assert.equal(again.ok, true, JSON.stringify(again.ok ? [] : again.reasons));
  assert.equal(again.context.inputHash, result.context.inputHash);
});

test('[SYNTHETIC MOCK] 历史旧候选保留：消费不改变旧候选状态，正例真的成功', async () => {
  const record = await runRich({
    script: defaultScript({
      evidence: () => ({ values: { rd: 600, founded: 2018 } }),
      repair: () => ({ rd: 60, founded: 2018 }),
    }),
  });
  const { store, pins, ready } = readyPackageFor(record);
  const trusted = trustedContextFor(record);

  const historyBefore = record.candidateVersions
    .filter(v => v !== record.currentVersionId)
    .map(v => ({
      versionId: v,
      state: record.artifacts.find(a => a.kind === 'candidate' && a.versionId === v)?.state,
    }));
  assert.ok(historyBefore.length > 0, '夹具必须含至少一个历史旧候选方可测试保留');

  const result = consumeDesignHandoff(ready, store, registry, pins, trusted);
  assert.equal(result.ok, true, JSON.stringify(result.ok ? [] : result.reasons));

  // 从真实 store 记录读取 after，而非从 save 前 copy 读取。
  const afterRecord = store.get(record.runId);
  assert.ok(afterRecord, 'store 记录必须仍然存在');
  const historyAfter = (afterRecord.candidateVersions ?? [])
    .filter(v => v !== afterRecord.currentVersionId)
    .map(v => ({
      versionId: v,
      state: afterRecord.artifacts?.find(a => a.kind === 'candidate' && a.versionId === v)?.state,
    }));
  assert.deepEqual(historyAfter, historyBefore);
  for (const entry of historyAfter) {
    if (entry.state !== undefined) assert.equal(entry.state, 'pending_review');
  }
});

/* ── 拒绝路径：每个都断言无 input、reasons 非空、零设计调用 ───────────────── */

function assertRejected(
  result: ReturnType<typeof consumeDesignHandoff>,
  counter: { state: { calls: number } },
  label: string,
): asserts result is { ok: false; reasons: any[] } {
  assert.equal(result.ok, false, `${label} 必须拒绝`);
  assert.equal('input' in result, false, `${label} 不得返回可消费输入`);
  assert.ok(result.reasons.length > 0, `${label} 必须给出非空原因`);
  assert.equal(counter.state.calls, 0, `${label} 不得触发设计调用`);
}

test('[SYNTHETIC MOCK] 拒绝：blocked 派生（有效 record + 独立 trusted）', async () => {
  const record = await runRich();
  const pins = deriveTrustedPins(record);
  const emptyStore = new MemoryFactRunStore();
  const submitted = produceDesignHandoff(emptyStore, registry, pins) as DesignHandoffReadyPackage;
  assert.equal(submitted.kind, 'blocked');
  const counter = makeDesignCallCounter();
  const trusted = trustedContextFor(record);
  const result = consumeDesignHandoff(submitted, emptyStore, registry, pins, trusted);
  if (result.ok) counter.call();
  assertRejected(result, counter, 'blocked 派生');
});

test('[SYNTHETIC MOCK] 拒绝：空 store（未在 store 中登记）', async () => {
  const record = await runRich();
  const { pins, ready } = readyPackageFor(record);
  const emptyStore = new MemoryFactRunStore();
  const counter = makeDesignCallCounter();
  const result = consumeDesignHandoff(ready, emptyStore, registry, pins, trustedContextFor(record));
  if (result.ok) counter.call();
  assertRejected(result, counter, '空 store');
});

test('[SYNTHETIC MOCK] 拒绝：错 run（pins.runId 与提交/store 不一致）', async () => {
  const record = await runRich();
  const { store, pins, ready } = readyPackageFor(record);
  const foreignPins: HandoffContextPins = { ...pins, runId: 'run_foreign_consumer_synthetic' };
  const counter = makeDesignCallCounter();
  const result = consumeDesignHandoff(ready, store, registry, foreignPins, trustedContextFor(record));
  if (result.ok) counter.call();
  assertRejected(result, counter, '错 run');
});

test('[SYNTHETIC MOCK] 拒绝：项目身份被篡改', async () => {
  const record = await runRich();
  const { store, pins, ready } = readyPackageFor(record);
  const forged = structuredClone(ready);
  (forged.identity as any).projectId = 'project_forged_consumer_synthetic';
  const counter = makeDesignCallCounter();
  const result = consumeDesignHandoff(forged, store, registry, pins, trustedContextFor(record));
  if (result.ok) counter.call();
  assertRejected(result, counter, '项目身份');
});

test('[SYNTHETIC MOCK] 拒绝：候选版本与报告版本被篡改', async () => {
  const record = await runRich();
  const { store, pins, ready } = readyPackageFor(record);

  {
    const forged = structuredClone(ready);
    (forged.identity as any).candidateVersionId = 'candv_forged_consumer_synthetic';
    const counter = makeDesignCallCounter();
    const result = consumeDesignHandoff(forged, store, registry, pins, trustedContextFor(record));
    if (result.ok) counter.call();
    assertRejected(result, counter, '候选版本');
  }
  {
    const forged = structuredClone(ready);
    (forged.identity as any).reportVersionId = 'reportv_forged_consumer_synthetic';
    const counter = makeDesignCallCounter();
    const result = consumeDesignHandoff(forged, store, registry, pins, trustedContextFor(record));
    if (result.ok) counter.call();
    assertRejected(result, counter, '报告版本');
  }
});

test('[SYNTHETIC MOCK] 拒绝：允许文档集合外的文档引用', async () => {
  const record = await runRich();
  const { store, pins, ready } = readyPackageFor(record);
  assert.ok(ready.documents.length > 0, '夹具 ready 必须含文档引用方可测试越权');
  const forged = structuredClone(ready);
  (forged.documents[0] as any).documentVersionId = 'docv_forbidden_consumer_synthetic';
  const counter = makeDesignCallCounter();
  const result = consumeDesignHandoff(forged, store, registry, pins, trustedContextFor(record));
  if (result.ok) counter.call();
  assertRejected(result, counter, '允许文档集合');
});

test('[SYNTHETIC MOCK] 拒绝：候选快照篡改（核验拒绝）', async () => {
  const record = await runRich();
  const { store, pins, ready } = readyPackageFor(record);
  const forged = structuredClone(ready);
  ((forged.evidenceOutput.candidateSnapshot as any).claims[0] as any).value = {
    type: 'text',
    text: 'tampered synthetic',
  };
  const counter = makeDesignCallCounter();
  const result = consumeDesignHandoff(forged, store, registry, pins, trustedContextFor(record));
  if (result.ok) counter.call();
  assertRejected(result, counter, '候选篡改');
});

test('[SYNTHETIC MOCK] 拒绝：实际改动报告内容（非仅改回 pass）', async () => {
  const record = await runRich();
  const { store, pins, ready } = readyPackageFor(record);
  const forged = structuredClone(ready);
  const report = (forged.reviewOutput as any).report;
  // 真实内容变更：修改报告内问题文本，而非把旧结论重设为 pass。
  assert.ok(Array.isArray(report.issues), '报告必须含 issues 数组');
  if (report.issues.length > 0) {
    report.issues[0].message = 'synthetic tampered report message';
  } else {
    report.summary = 'synthetic tampered report summary';
  }
  const counter = makeDesignCallCounter();
  const result = consumeDesignHandoff(forged, store, registry, pins, trustedContextFor(record));
  if (result.ok) counter.call();
  assertRejected(result, counter, '实际改报告');
});

test('[SYNTHETIC MOCK] 拒绝：根级 bindingFingerprint 被篡改', async () => {
  const record = await runRich();
  const { store, pins, ready } = readyPackageFor(record);
  const forged = structuredClone(ready);
  (forged as any).bindingFingerprint = 'sha256:' + 'f'.repeat(64);
  const counter = makeDesignCallCounter();
  const result = consumeDesignHandoff(forged, store, registry, pins, trustedContextFor(record));
  if (result.ok) counter.call();
  assertRejected(result, counter, '根级 bindingFingerprint');
});

test('[SYNTHETIC MOCK] 拒绝：缺失 checksRequired', async () => {
  const record = await runRich();
  const { store, pins, ready } = readyPackageFor(record);
  const forged = structuredClone(ready);
  (forged as any).checksRequired = [];
  const counter = makeDesignCallCounter();
  const result = consumeDesignHandoff(forged, store, registry, pins, trustedContextFor(record));
  if (result.ok) counter.call();
  assertRejected(result, counter, '缺失 checks');
});

test('[SYNTHETIC MOCK] 拒绝：伪 ready（结构合法但未过可信核验）', async () => {
  const record = await runRich();
  const { store, pins, ready } = readyPackageFor(record);
  const fakeReady = { ...structuredClone(ready), kind: 'ready' as const, bindingFingerprint: 'sha256:' + 'f'.repeat(64) };
  const counter = makeDesignCallCounter();
  const result = consumeDesignHandoff(fakeReady, store, registry, pins, trustedContextFor(record));
  if (result.ok) counter.call();
  assertRejected(result, counter, '伪 ready');
});

test('[SYNTHETIC MOCK] 拒绝：expected inputHash 错误（新接口保留期望钉时）', async () => {
  const record = await runRich();
  const { store, pins, ready } = readyPackageFor(record);
  const trusted = trustedContextFor(record);
  (trusted as any).expectedInputHash = 'sha256:' + '0'.repeat(64);
  const counter = makeDesignCallCounter();
  const result = consumeDesignHandoff(ready, store, registry, pins, trusted);
  if (result.ok) counter.call();
  assertRejected(result, counter, 'expected inputHash');
  assert.ok(
    (result as any).reasons.some((r: any) => String(r.code).includes('input_hash')),
    '必须给出 input_hash 相关原因',
  );
});

test('[SYNTHETIC MOCK] 正例：正确 expectedInputHash 严格成功且 hash 不变', async () => {
  const record = await runRich();
  const { store, pins, ready } = readyPackageFor(record);

  // 先 consume 得到真实 context.inputHash。
  const baseTrusted = trustedContextFor(record);
  const base = consumeDesignHandoff(ready, store, registry, pins, baseTrusted);
  assert.equal(base.ok, true, JSON.stringify(base.ok ? [] : base.reasons));
  const realHash = base.context.inputHash;
  assert.equal(typeof realHash, 'string', '真实 inputHash 必须为字符串');
  assert.ok(realHash.length > 0, '真实 inputHash 必须非空');

  // clone trusted 并设置 expectedInputHash 为真实 hash，重新 consume 必须严格成功且 hash 不变。
  const trusted = structuredClone(baseTrusted);
  trusted.expectedInputHash = realHash;
  const result = consumeDesignHandoff(ready, store, registry, pins, trusted);
  assert.equal(result.ok, true, JSON.stringify(result.ok ? [] : result.reasons));
  assert.equal(result.context.inputHash, realHash, '正确 expectedInputHash 下 hash 必须不变');
  // 附加：返回输入指纹与 context.inputHash 一致。
  assert.equal(fingerprint(result.input), result.context.inputHash);
});

test('[SYNTHETIC MOCK] 拒绝：snapshotHash 错（可信上下文与候选指纹不一致）', async () => {
  const record = await runRich();
  const { store, pins, ready } = readyPackageFor(record);
  const trusted = trustedContextFor(record);
  (trusted.design as any).snapshotHash = 'sha256:' + '1'.repeat(64);
  const counter = makeDesignCallCounter();
  const result = consumeDesignHandoff(ready, store, registry, pins, trusted);
  if (result.ok) counter.call();
  assertRejected(result, counter, 'snapshotHash');
});

test('[SYNTHETIC MOCK] 拒绝：allowedSources 缺项（遗漏非显示来源）', async () => {
  const record = await runRich();
  const { store, pins, ready } = readyPackageFor(record);
  const trusted = trustedContextFor(record);
  // 只保留实体，故意遗漏 claim 等来源；须被消费/检查层拒绝。
  trusted.design.allowedSources = trusted.design.allowedSources.filter(s => s.kind === 'entity').slice(0, 1);
  const counter = makeDesignCallCounter();
  const result = consumeDesignHandoff(ready, store, registry, pins, trusted);
  if (result.ok) counter.call();
  assertRejected(result, counter, 'allowedSources 缺项');
  // 基线正常，故必须给出确切禁止来源原因；禁止弱化其他反例。
  assert.ok(
    (result as any).reasons.some((r: any) => r.code === 'design.input_source_forbidden'),
    '必须给出 reason.code === design.input_source_forbidden',
  );
});