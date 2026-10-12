/**
 * B5 设计交接包适配器集成回归（SYNTHETIC MOCK）。
 * 正向场景运行既有 B5 工作流夹具（defaultScript，含一次 600→60 语义返修），
 * 使用实际产出的 FactRunRecord；反向/变异场景只对可信 store 中记录的 detached 副本做突变，
 * 绝不改动原始记录。可信上下文钉仅从夹具记录派生；生产实现使用独立授权。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  produceDesignHandoff,
  verifyDesignHandoff,
  summarizeDesignHandoff,
  DESIGN_HANDOFF_PACKAGE_VERSION,
  DESIGN_TEAM_STATUS,
  type HandoffContextPins,
  type DesignHandoffReadyPackage,
} from '../../apps/server/src/domain/design-handoff.ts';
import {
  MemoryFactRunStore,
  type FactRunRecord,
  type FactRunStore,
} from '../../apps/server/src/domain/fact-run.service.ts';
import { loadSchemasFromDir } from '../../packages/contracts/src/schema-registry.ts';
import { DEFAULT_REVIEW_CHECKS } from '../../apps/server/src/orchestration/fact-workflow.ts';
import {
  runFactScenario,
  defaultScript,
  makeEvidenceInput,
  type ScenarioOptions,
} from '../helpers/fact-workflow-harness.ts';

const registry = loadSchemasFromDir('packages/contracts/schemas');

type RichRecord = FactRunRecord & {
  artifacts: NonNullable<FactRunRecord['artifacts']>;
  inputSnapshot: NonNullable<FactRunRecord['inputSnapshot']>;
};

interface RichHandle {
  record: RichRecord;
  counts: { review: number } & Record<string, number>;
}

/**
 * 运行真实夹具并断言工件字段存在，返回显式窄化后的 record。
 * 这是运行时判定而非类型断言：record/artifacts/inputSnapshot 在这些场景下必然存在。
 */
async function runRich(options: Partial<ScenarioOptions> = {}): Promise<RichHandle> {
  const { result, counts } = await runFactScenario({ script: defaultScript(), ...options });
  assert.ok(result.record, '夹具必须产出 record');
  const record = result.record as FactRunRecord;
  assert.ok(record.artifacts, '夹具记录必须包含 artifacts');
  assert.ok(record.inputSnapshot, '夹具记录必须包含 inputSnapshot');
  const rich = record as RichRecord;
  return { record: rich, counts: counts as RichHandle['counts'] };
}

/** 从真实夹具记录派生可信上下文钉；生产实现另行独立授权，不依赖被提交包。 */
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

/** 深拷贝为 detached 副本写入独立 MemoryFactRunStore，绝不改动原始记录。 */
function detachedStore(record: RichRecord): { store: FactRunStore; copy: RichRecord } {
  const copy = structuredClone(record);
  const store = new MemoryFactRunStore();
  store.save(copy);
  return { store, copy };
}

/** 对 detached 副本突变后再以 save(copy) 回写（MemoryFactRunStore.save 会克隆）。 */
function mutateStore(
  record: RichRecord,
  mutate: (copy: RichRecord) => void,
): { store: FactRunStore; copy: RichRecord } {
  const { store, copy } = detachedStore(record);
  mutate(copy);
  store.save(copy);
  return { store, copy };
}

/** 断言包被阻断且不含任何可消费事实/原始来源。 */
function assertBlockedNoLeak(pkg: unknown, label: string): void {
  assert.ok(pkg && typeof pkg === 'object', `${label}: 包结构非法`);
  const blocked = pkg as { kind?: unknown; reasons?: unknown; evidenceOutput?: unknown; reviewOutput?: unknown; sourceLocations?: unknown; documents?: unknown };
  assert.equal(blocked.kind, 'blocked', `${label}: 应被阻断`);
  assert.ok(Array.isArray(blocked.reasons) && blocked.reasons.length > 0, `${label}: 阻断必须给出稳定原因码`);
  assert.equal(blocked.evidenceOutput, undefined, `${label}: 阻断分支不得泄露候选输出`);
  assert.equal(blocked.reviewOutput, undefined, `${label}: 阻断分支不得泄露审查输出`);
  assert.equal(blocked.sourceLocations, undefined, `${label}: 阻断分支不得泄露来源位置`);
  assert.equal(blocked.documents, undefined, `${label}: 阻断分支不得泄露文档`);
}

/* ── 记录形状自检 ────────────────────────────────────────────────────────────── */

test('[SYNTHETIC MOCK] 正向夹具产出真实 passed 记录：终态/阶段/工件与题意一致', async () => {
  const { record } = await runRich();
  assert.equal(record.status, 'passed');
  assert.equal(record.passed, true);
  assert.equal(record.executionStatus, 'succeeded');
  assert.equal(record.stopReason, 'passed_all_checks');
  assert.equal(record.stage, 'done');
  assert.equal(record.rounds.at(-1)?.stage, 'reviewing', '实际成功记录的最终轮 stage 保持 reviewing');
  const candidateArtifact = record.artifacts.find(a => a.kind === 'candidate' && a.versionId === record.currentVersionId)!;
  assert.equal(candidateArtifact.state, 'pending_review');
  const reportArtifact = record.artifacts.find(a => a.kind === 'report')!;
  assert.equal(reportArtifact.state, 'reviewed');
});

/* ── 1. 修复后就绪：最终 60/2018，旧 600 保留在历史 ─────────────────────────── */

test('[SYNTHETIC MOCK] 返修后就绪：最终 60/2018，旧 600 版本保留在待审历史', async () => {
  const { record } = await runRich({
    script: defaultScript({
      evidence: () => ({ values: { rd: 600, founded: 2018 } }),
      repair: () => ({ rd: 60, founded: 2018 }),
    }),
  });
  const pins = deriveTrustedPins(record);

  assert.ok(record.candidateVersions.length >= 2, '返修应产生旧候选版本历史');
  const oldVersions = record.candidateVersions.filter(v => v !== record.currentVersionId);
  assert.ok(oldVersions.length >= 1, '应保留旧候选版本');
  for (const v of oldVersions) {
    const art = record.artifacts.find(a => a.kind === 'candidate' && a.versionId === v);
    if (art) assert.equal(art.state, 'pending_review', '历史候选不得被自动采纳');
  }

  const pkg = produceDesignHandoff(new MemoryFactRunStore(), registry, pins);
  assert.equal(pkg.kind, 'blocked', '空 store 必须 fail-closed（此处仅作对照）');

  const { store } = detachedStore(record);
  const ready = produceDesignHandoff(store, registry, pins) as DesignHandoffReadyPackage;
  assert.equal(ready.kind, 'ready');
  assert.equal(ready.packageVersion, DESIGN_HANDOFF_PACKAGE_VERSION);
  assert.equal(ready.designTeamStatus, DESIGN_TEAM_STATUS);
  assert.equal(ready.identity.candidateVersionId, pins.expectedCandidateVersionId);
  assert.equal(ready.identity.reportVersionId, pins.expectedReportVersionId);

  const snapshot = ready.evidenceOutput.candidateSnapshot;
  const rdValue = snapshot.claims.find(c => c.claimId === 'claim_rd')!.value;
  const foundedValue = snapshot.claims.find(c => c.claimId === 'claim_founded')!.value;
  assert.ok(rdValue.type === 'number' || rdValue.type === 'quantity');
  assert.ok(foundedValue.type === 'number' || foundedValue.type === 'quantity');
  const rd = rdValue as { normalized: number };
  const founded = foundedValue as { normalized: number };
  assert.equal(rd.normalized, 60, '最终候选应为修复后的 60');
  assert.equal(founded.normalized, 2018);
});

test('[SYNTHETIC MOCK] 就绪包携带来源位置、文档版本与报告版本投影', async () => {
  const { record } = await runRich();
  const pins = deriveTrustedPins(record);
  const { store } = detachedStore(record);
  const ready = produceDesignHandoff(store, registry, pins) as DesignHandoffReadyPackage;
  assert.equal(ready.kind, 'ready');

  assert.ok(ready.sourceLocations.length > 0, '应投影来源位置');
  for (const loc of ready.sourceLocations) {
    assert.ok(typeof loc.evidenceId === 'string' && loc.evidenceId.length > 0);
    assert.ok(typeof loc.documentId === 'string' && loc.documentId.length > 0);
    assert.ok(typeof loc.documentVersionId === 'string' && loc.documentVersionId.length > 0);
    assert.ok(typeof loc.blockId === 'string' && loc.blockId.length > 0);
    assert.ok(loc.locator && typeof loc.locator === 'object');
  }
  assert.equal(ready.documents[0].documentId, 'doc_repair');
  assert.equal(ready.documents[0].documentVersionId, 'docv_repair_1');
  assert.equal(ready.reviewOutput.report.reportVersionId, pins.expectedReportVersionId);
  assert.equal(ready.evidenceOutput.candidateSnapshot.snapshotVersionId, pins.expectedCandidateVersionId);
});

/* ── 2. 正确即不返修 ────────────────────────────────────────────────────────── */

test('[SYNTHETIC MOCK] 立即正确：无返修，单候选版本，直接 passed', async () => {
  const { record, counts } = await runRich();
  assert.equal(record.status, 'passed');
  assert.equal(record.candidateVersions.length, 1, '正确候选不应产生返修历史');
  assert.equal(counts.review, 1, '应仅一次独立审查');
  const pins = deriveTrustedPins(record);
  const { store } = detachedStore(record);
  const ready = produceDesignHandoff(store, registry, pins) as DesignHandoffReadyPackage;
  assert.equal(ready.kind, 'ready');
});

/* ── 3. missing / conflict 阻断：无可消费载荷 ──────────────────────────────── */

test('[SYNTHETIC MOCK] 缺少资料阻断：needs_input 且无可消费载荷', async () => {
  const script = defaultScript({
    review: () => ({ verdict: 'needs_input', issues: [{ category: 'missing', description: '缺少资料' }] }),
  });
  const { result } = await runFactScenario({ script });
  assert.ok(result.record);
  const record = result.record as RichRecord;
  assert.notEqual(record.status, 'passed', 'needs_input 不得判为 passed');
  const pins = deriveTrustedPins(record);
  const { store } = detachedStore(record);
  const pkg = produceDesignHandoff(store, registry, pins);
  assertBlockedNoLeak(pkg, 'missing');
  assert.equal(summarizeDesignHandoff(pkg, store, registry, pins), null, '摘要不得对阻断包放行');
});

test('[SYNTHETIC MOCK] 来源冲突阻断：needs_input 且无可消费载荷', async () => {
  const script = defaultScript({
    review: () => ({ verdict: 'needs_input', issues: [{ category: 'conflict', description: '来源冲突' }] }),
  });
  const { result } = await runFactScenario({ script });
  assert.ok(result.record);
  const record = result.record as RichRecord;
  assert.notEqual(record.status, 'passed', 'conflict 不得判为 passed');
  const pins = deriveTrustedPins(record);
  const { store } = detachedStore(record);
  const pkg = produceDesignHandoff(store, registry, pins);
  assertBlockedNoLeak(pkg, 'conflict');
});

/* ── 4. 返修上限阻断 ────────────────────────────────────────────────────────── */

test('[SYNTHETIC MOCK] 返修上限阻断：executionStatus succeeded 不等于 ready', async () => {
  const script = defaultScript({
    evidence: () => ({ values: { rd: 600, founded: 2018 } }),
    repair: () => ({ rd: 600, founded: 2018 }),
    review: () => ({ verdict: 'revise', issues: [{ category: 'value', claimId: 'claim_rd', expected: '60 人', actual: '600 人' }] }),
  });
  const { result } = await runFactScenario({ script, maxRepairRounds: 0 });
  assert.ok(result.record);
  const record = result.record as RichRecord;
  assert.notEqual(record.status, 'passed', '触及返修上限不得判为 passed');
  assert.equal(record.stopReason, 'repair_limit_reached', '停止原因应为返修上限');
  assert.equal(record.executionStatus, 'succeeded', '执行本身成功并不等于就绪');
  const pins = deriveTrustedPins(record);
  const { store } = detachedStore(record);
  const pkg = produceDesignHandoff(store, registry, pins);
  assertBlockedNoLeak(pkg, 'repair_limit');
});

/* ── 4b. 显式 600 种子返修 → 最终 60/2018，原始候选 600 保留待审 ─────────────── */

test('[SYNTHETIC MOCK] 显式 600 种子返修：最终值 60/2018，原始候选 600 全部待审', async () => {
  const { result } = await runFactScenario({
    script: defaultScript({
      evidence: () => ({ values: { rd: 600, founded: 2018 } }),
      repair: () => ({ rd: 60, founded: 2018 }),
    }),
  });
  assert.ok(result.record);
  const record = result.record as RichRecord;
  const pins = deriveTrustedPins(record);
  const snapshot = (() => {
    const { store } = detachedStore(record);
    const ready = produceDesignHandoff(store, registry, pins) as DesignHandoffReadyPackage;
    assert.equal(ready.kind, 'ready');
    return ready.evidenceOutput.candidateSnapshot;
  })();
  const rdSeedValue = snapshot.claims.find(c => c.claimId === 'claim_rd')!.value;
  assert.ok(rdSeedValue.type === 'number' || rdSeedValue.type === 'quantity');
  assert.equal(rdSeedValue.normalized, 60);
  const foundedSeedValue = snapshot.claims.find(c => c.claimId === 'claim_founded')!.value;
  assert.ok(foundedSeedValue.type === 'number' || foundedSeedValue.type === 'quantity');
  assert.equal(foundedSeedValue.normalized, 2018);

  const originalCandidate = record.artifacts.find(
    a => a.kind === 'candidate' && a.versionId !== record.currentVersionId,
  )!;
  assert.ok(originalCandidate, '原始候选版本应保留');
  const parsed = JSON.parse(originalCandidate.rawOutput as string);
  assert.equal(parsed.candidateSnapshot.claims.find((c: { claimId: string }) => c.claimId === 'claim_rd').value.normalized, 600, '原始候选仍为 600');
  assert.equal(originalCandidate.state, 'pending_review', '原始候选必须保持 pending_review');

  for (const v of record.candidateVersions) {
    const art = record.artifacts.find(a => a.kind === 'candidate' && a.versionId === v);
    if (art) assert.equal(art.state, 'pending_review', '所有候选版本不得被自动采纳');
  }
});

/* ── 4c. 就绪包 claim 证据绑定与来源块映射 ─────────────────────────────────── */

test('[SYNTHETIC MOCK] 就绪包 claim_rd 证据绑定精确且来源块映射正确', async () => {
  const { record } = await runRich();
  const pins = deriveTrustedPins(record);
  const { store } = detachedStore(record);
  const ready = produceDesignHandoff(store, registry, pins) as DesignHandoffReadyPackage;
  assert.equal(ready.kind, 'ready');

  const snapshot = ready.evidenceOutput.candidateSnapshot;
  const claimRd = snapshot.claims.find(c => c.claimId === 'claim_rd')!;
  assert.deepEqual(claimRd.evidenceRefs, ['ev_rd'], 'claim_rd 必须精确绑定 ev_rd');
  const summary = summarizeDesignHandoff(ready, store, registry, pins);
  assert.deepEqual(
    summary?.claims.find(c => c.claimId === 'claim_rd')?.evidenceIds,
    ['ev_rd'],
    'summary 投影应使用 evidenceIds 并精确绑定 ev_rd',
  );
  const evidence = snapshot.evidence.find(e => e.evidenceId === 'ev_rd')!;
  assert.equal(evidence.blockId, 'b001', 'ev_rd 必须引用来源块 b001');
  const sourceLoc = ready.sourceLocations.find(l => l.evidenceId === 'ev_rd')!;
  assert.equal(sourceLoc.blockId, 'b001', '来源位置应映射到 b001');
  assert.ok(ready.documents.some(d => d.documentId === sourceLoc.documentId), '来源文档必须在文档映射内');
});

/* ── 5. 技术审查失败阻断 ────────────────────────────────────────────────────── */

test('[SYNTHETIC MOCK] 技术审查失败：报告格式非法不得就绪', async () => {
  const { result } = await runFactScenario({
    script: defaultScript(),
    reviewOverride: () => ({ status: 'completed', report: { nonsense: true } }),
  });
  assert.ok(result.record);
  const record = result.record as RichRecord;
  const pins = deriveTrustedPins(record);
  const { store } = detachedStore(record);
  const pkg = produceDesignHandoff(store, registry, pins);
  assertBlockedNoLeak(pkg, 'technical');
});

/* ── 6. 身份/版本钉不符 ─────────────────────────────────────────────────────── */

test('[SYNTHETIC MOCK] 错误项目/任务/尝试/白名单/版本钉一律阻断', async () => {
  const { record } = await runRich();
  const base = deriveTrustedPins(record);
  const { store } = detachedStore(record);

  const cases: Array<[string, HandoffContextPins]> = [
    ['错误项目', { ...base, projectId: 'project_other' }],
    ['错误任务', { ...base, taskId: 'task_other' }],
    ['错误尝试', { ...base, attemptId: 'attempt_other' }],
    ['空白名单非法条目', { ...base, allowedDocumentRefs: [] as HandoffContextPins['allowedDocumentRefs'] }],
    ['陈旧候选钉', { ...base, expectedCandidateVersionId: 'cand_does_not_exist' }],
    ['陈旧报告钉', { ...base, expectedReportVersionId: 'report_does_not_exist' }],
    ['候选钉为空', { ...base, expectedCandidateVersionId: null }],
  ];
  for (const [label, pins] of cases) {
    const pkg = produceDesignHandoff(store, registry, pins);
    assertBlockedNoLeak(pkg, label);
  }
});

/* ── 7. 缺失/重复/非法状态工件 ─────────────────────────────────────────────── */

test('[SYNTHETIC MOCK] 候选工件缺失/重复/状态非法均阻断', async () => {
  const { record } = await runRich();
  const pins = deriveTrustedPins(record);

  {
    const { store } = mutateStore(record, (c) => {
      c.artifacts = c.artifacts.filter(a => !(a.kind === 'candidate' && a.versionId === pins.expectedCandidateVersionId));
    });
    assertBlockedNoLeak(produceDesignHandoff(store, registry, pins), '候选工件缺失');
  }
  {
    const { store } = mutateStore(record, (c) => {
      const dup = structuredClone(c.artifacts.find(a => a.kind === 'candidate' && a.versionId === pins.expectedCandidateVersionId)!);
      c.artifacts.push(dup);
    });
    assertBlockedNoLeak(produceDesignHandoff(store, registry, pins), '候选工件重复');
  }
  {
    const { store } = mutateStore(record, (c) => {
      const art = c.artifacts.find(a => a.kind === 'candidate' && a.versionId === pins.expectedCandidateVersionId)!;
      (art.state as string) = 'adopted';
    });
    assertBlockedNoLeak(produceDesignHandoff(store, registry, pins), '候选状态非法');
  }
  {
    const { store } = mutateStore(record, (c) => {
      const art = c.artifacts.find(a => a.kind === 'report')!;
      (art.state as string) = 'pending_review';
    });
    assertBlockedNoLeak(produceDesignHandoff(store, registry, pins), '报告状态非法');
  }
});

/* ── 8. 篡改 rawOutput 与必需检查缺失 ──────────────────────────────────────── */

test('[SYNTHETIC MOCK] 篡改候选 rawOutput 与已解析输出不一致即阻断', async () => {
  const { record } = await runRich();
  const pins = deriveTrustedPins(record);
  const { store } = mutateStore(record, (c) => {
    const art = c.artifacts.find(a => a.kind === 'candidate' && a.versionId === pins.expectedCandidateVersionId)!;
    const parsed = JSON.parse(art.rawOutput as string);
    parsed.candidateSnapshot.claims[0].value.normalized = 999;
    (art.rawOutput as string) = JSON.stringify(parsed);
  });
  assertBlockedNoLeak(produceDesignHandoff(store, registry, pins), '候选 rawOutput 篡改');
});

test('[SYNTHETIC MOCK] 篡改报告 rawOutput 与 missing 检查缺失一并阻断（哈希闸门不掩盖报告检查）', async () => {
  const { record } = await runRich();
  const pins = deriveTrustedPins(record);
  const { store } = mutateStore(record, (c) => {
    const art = c.artifacts.find(a => a.kind === 'report')!;
    const parsed = JSON.parse(art.rawOutput as string);
    parsed.report.checks = parsed.report.checks.filter((ch: { checkType: string }) => ch.checkType !== 'missing');
    (art.rawOutput as string) = JSON.stringify(parsed);
    (art.output as unknown) = parsed;
  });
  const pkg = produceDesignHandoff(store, registry, pins);
  assertBlockedNoLeak(pkg, '报告缺失必需检查');
});

/* ── 9. 伪造 ready 包 ──────────────────────────────────────────────────────── */

test('[SYNTHETIC MOCK] 伪造 ready 包一律无法通过校验', async () => {
  const { record } = await runRich();
  const pins = deriveTrustedPins(record);
  const { store } = detachedStore(record);
  const genuine = produceDesignHandoff(store, registry, pins) as DesignHandoffReadyPackage;
  assert.equal(genuine.kind, 'ready');

  const forgeries: Array<[string, (pkg: DesignHandoffReadyPackage) => void]> = [
    ['篡改事实值', (p) => { (p.evidenceOutput.candidateSnapshot.claims[0].value as { normalized: number }).normalized = 999; }],
    ['篡改身份 attemptId', (p) => { p.identity.attemptId = 'attempt_forged'; }],
    ['篡改来源文档引用', (p) => { p.sourceLocations[0].documentId = 'doc_forged'; }],
    ['篡改绑定指纹', (p) => { p.bindingFingerprint = 'sha256:deadbeef'; }],
    ['新增额外字段', (p) => { (p as unknown as Record<string, unknown>).extraForge = true; }],
  ];
  for (const [label, forge] of forgeries) {
    const submitted = structuredClone(genuine);
    forge(submitted);
    const verified = verifyDesignHandoff(submitted, store, registry, pins);
    assert.equal(verified.ok, false, `${label}: 伪造包不得验证通过`);
    assert.ok(verified.reasons.length > 0, `${label}: 必须给出原因`);
    assert.equal(summarizeDesignHandoff(submitted, store, registry, pins), null, `${label}: 摘要不得放行伪造包`);
  }

  const { store: blockedStore } = mutateStore(record, (c) => { (c.status as string) = 'failed'; });
  assert.equal(verifyDesignHandoff(genuine, blockedStore, registry, pins).ok, false, '可信派生阻断时不得验证为就绪');
});

/* ── 10. store 缺失/不可读/数组畸形/注册表异常 fail-closed ─────────────────── */

test('[SYNTHETIC MOCK] store 缺失/不可读时 fail-closed 且不抛异常', async () => {
  const { record } = await runRich();
  const pins = deriveTrustedPins(record);

  const missing = new MemoryFactRunStore();
  assertBlockedNoLeak(produceDesignHandoff(missing, registry, pins), 'store 缺失');

  const throwing: FactRunStore = {
    save() { throw new Error('synthetic store failure'); },
    get() { throw new Error('synthetic store failure'); },
    list() { throw new Error('synthetic store failure'); },
  };
  assertBlockedNoLeak(produceDesignHandoff(throwing, registry, pins), 'store 不可读');
});

test('[SYNTHETIC MOCK] 记录数组畸形与注册表异常均 fail-closed 且不抛异常', async () => {
  const { record } = await runRich();
  const pins = deriveTrustedPins(record);

  const malformedCases: Array<[string, (c: RichRecord) => void]> = [
    ['rounds 非数组', (c) => { (c.rounds as never) = 'not-an-array' as never; }],
    ['artifacts 非数组', (c) => { (c.artifacts as never) = 42 as never; }],
    ['candidateVersions 非数组', (c) => { (c.candidateVersions as never) = null as never; }],
    ['reportVersions 非数组', (c) => { (c.reportVersions as never) = {} as never; }],
    ['remainingIssues 非数组', (c) => { (c.remainingIssues as never) = 'bad' as never; }],
    ['rounds 空', (c) => { (c.rounds as never) = [] as never; }],
  ];
  for (const [label, mutate] of malformedCases) {
    const { store } = mutateStore(record, mutate);
    assertBlockedNoLeak(produceDesignHandoff(store, registry, pins), label);
  }

  const badRegistry = {
    validate() { throw new Error('synthetic registry failure'); },
    list() { return []; },
    has() { return true; },
  } as unknown as Parameters<typeof produceDesignHandoff>[1];
  const { store } = detachedStore(record);
  const pkg = produceDesignHandoff(store, badRegistry, pins);
  assert.doesNotThrow(() => produceDesignHandoff(store, badRegistry, pins), '注册表异常不得上抛');
  assertBlockedNoLeak(pkg, '注册表异常');
});

/* ── 11. checksRequired 缺失/为空/非法 ─────────────────────────────────────── */

test('[SYNTHETIC MOCK] checksRequired 缺失/为空/非法一律阻断', async () => {
  const { record } = await runRich();
  const base = deriveTrustedPins(record);
  const { store } = detachedStore(record);

  const cases: Array<[string, HandoffContextPins]> = [
    ['缺字段', { ...base, checksRequired: undefined as unknown as HandoffContextPins['checksRequired'] }],
    ['空列表', { ...base, checksRequired: [] }],
    ['非法检查码', { ...base, checksRequired: ['value', 'not_a_real_check'] as unknown as HandoffContextPins['checksRequired'] }],
  ];
  for (const [label, pins] of cases) {
    assertBlockedNoLeak(produceDesignHandoff(store, registry, pins), label);
  }
});

/* ── 12. currentVersionId 与报告版本不一致 ─────────────────────────────────── */

test('[SYNTHETIC MOCK] record.currentVersionId 与 report.reportVersionId 错配即阻断', async () => {
  const { record } = await runRich();
  const pins = deriveTrustedPins(record);
  const { store } = mutateStore(record, (c) => {
    const art = c.artifacts.find(a => a.kind === 'report')!;
    const parsed = JSON.parse(art.rawOutput as string);
    parsed.report.reportVersionId = 'report_forged_version';
    parsed.report.candidateVersionId = 'cand_mismatched_version';
    (art.rawOutput as string) = JSON.stringify(parsed);
    (art.output as unknown) = parsed;
  });
  assertBlockedNoLeak(produceDesignHandoff(store, registry, pins), '报告版本错配');
});

/* ── 13. 未授权来源文档 / 来源块引用错误 ───────────────────────────────────── */

test('[SYNTHETIC MOCK] 原始输入含未在白名单的额外文档即阻断', async () => {
  const { record } = await runRich();
  const pins = deriveTrustedPins(record);
  const { store } = mutateStore(record, (c) => {
    const input = c.inputSnapshot as unknown as Record<string, unknown>;
    const docs = input.documents as Array<Record<string, unknown>>;
    const extra = structuredClone(docs[0]);
    extra.documentId = 'doc_unauthorized';
    extra.documentVersionId = 'docv_unauthorized_1';
    docs.push(extra);
  });
  assertBlockedNoLeak(produceDesignHandoff(store, registry, pins), '未授权额外文档');
});

test('[SYNTHETIC MOCK] 来源快照证据块引用错误（未持久化块）即阻断', async () => {
  const { record } = await runRich();
  const pins = deriveTrustedPins(record);
  const { store } = mutateStore(record, (c) => {
    const art = c.artifacts.find(a => a.kind === 'candidate' && a.versionId === pins.expectedCandidateVersionId)!;
    const parsed = JSON.parse(art.rawOutput as string);
    parsed.candidateSnapshot.evidence[0].blockId = 'b_does_not_exist';
    (art.rawOutput as string) = JSON.stringify(parsed);
    (art.output as unknown) = parsed;
  });
  assertBlockedNoLeak(produceDesignHandoff(store, registry, pins), '来源块引用错误');
});

/* ── 14. 历史 pending 不变 & DesignInput 仍拒绝 {} ────────────────────────── */

test('[SYNTHETIC MOCK] 历史 pending 事实不被就绪流程改动', async () => {
  const { record } = await runRich();
  const pins = deriveTrustedPins(record);
  const { store, copy } = detachedStore(record);
  const before = structuredClone(await store.list());
  const ready = produceDesignHandoff(store, registry, pins) as DesignHandoffReadyPackage;
  assert.equal(ready.kind, 'ready');
  assert.ok(ready.documents.length > 0, '就绪包应携带文档');
  assert.ok(ready.evidenceOutput.candidateSnapshot, '就绪包应携带候选快照');
  // 修改派生返回值以验证与 store 记录完全脱离
  ready.documents[0].blocks[0].text = 'mutated';
  ready.evidenceOutput.candidateSnapshot.claims[0].value = { type: 'number', normalized: -1 } as never;
  const after = structuredClone(await store.list());
  assert.deepEqual(after, before, '交接派生不得改动可信 store 中的记录（含历史 pending）');
  assert.deepEqual(copy, structuredClone(record), 'detached 副本与原始记录内容一致');
});

test('[SYNTHETIC MOCK] DesignInput 校验仍拒绝空对象 {}', () => {
  const outcome = registry.validate('urn:tju-mas:contracts:design-input', {});
  assert.equal(outcome.valid, false, 'DesignInput 必须继续拒绝 {}');
});

/* ── 附加：可复用注册表与生成夹具不可变性 ─────────────────────────────────── */

test('[SYNTHETIC MOCK] 本测试加载的 schema 注册表稳定且可重复校验', () => {
  const a = loadSchemasFromDir('packages/contracts/schemas');
  const b = loadSchemasFromDir('packages/contracts/schemas');
  const input = makeEvidenceInput();
  assert.equal(a.validate('urn:tju-mas:contracts:evidence-input', input).valid, true);
  assert.equal(b.validate('urn:tju-mas:contracts:evidence-input', input).valid, true);
});