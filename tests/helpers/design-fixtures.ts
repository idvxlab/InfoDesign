/** Synthetic protocol tests only. Passing status here is test setup, not a review result. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, loadFixture } from './fixtures.ts';
import { fingerprint } from '../../packages/contracts/src/fingerprint.ts';
import type { DesignContext } from '../../packages/contracts/src/design-checks.ts';
import type { DesignTaskContext } from '../../packages/contracts/src/design-agent-checks.ts';

export function designFixture() {
  const read = (name: string) => JSON.parse(readFileSync(join(repoRoot, 'docs/examples/design-contracts-v1', name), 'utf8'));
  const plan = read('information-plan.json'), page = read('page-spec.json');
  const snapshot = loadFixture<Record<string, any>>('snapshot.json');
  snapshot.entities = [
    { entityId: 'entity_company_test', entityType: 'organization', label: '协议测试主体' },
    { entityId: 'entity_product_a_placeholder', entityType: 'product', label: '测试对象 A' },
    { entityId: 'entity_product_b_placeholder', entityType: 'product', label: '测试对象 B' },
  ];
  const evidenceRefs = [snapshot.evidence[0].evidenceId];
  snapshot.claims = [
    ['claim_business_placeholder', 'entity_company_test', 'business', { type: 'text', text: '仅用于协议校验的测试文本' }],
    ['claim_parameter_a_placeholder', 'entity_product_a_placeholder', 'test_parameter', { type: 'quantity', normalized: 10, unit: 'mm' }],
    ['claim_parameter_b_placeholder', 'entity_product_b_placeholder', 'test_parameter', { type: 'quantity', normalized: 20, unit: 'mm' }],
    ['claim_service_placeholder', 'entity_company_test', 'service', { type: 'text', text: '仅用于协议校验的测试服务' }],
  ].map(([claimId, entityId, predicate, value]) => ({ claimId, claimVersionId: String(claimId) + '_v1', entityId, predicate, value,
    qualifiers: { basis: '纯合成测试，不代表客户事实' }, evidenceRefs, supportStatus: 'supported', reviewStatus: 'passed' }));
  snapshot.relations = []; snapshot.events = []; snapshot.assets = []; snapshot.conflicts = []; snapshot.missing = [];
  snapshot.reviewStatus = 'passed';
  const envelope = {
    protocolVersion: '1.0', projectId: snapshot.projectId, taskId: 'task_design_test', attemptId: 'attempt_design_test',
    snapshotRef: { snapshotId: snapshot.snapshotId, snapshotVersionId: snapshot.snapshotVersionId, contentHash: fingerprint(snapshot) },
    producedBy: { role: 'design', protocolVersion: '1.0' }, createdAt: '2026-10-11T12:00:00Z',
  };
  Object.assign(plan, structuredClone(envelope), { planId: 'plan_test', planVersionId: 'plan_test_v1', openIssues: [] });
  Object.assign(page, structuredClone(envelope), { pageSpecId: 'spec_test', pageSpecVersionId: 'spec_test_v1',
    informationPlanRef: { planId: plan.planId, planVersionId: plan.planVersionId, contentHash: fingerprint(plan) } });
  const components = ['page', 'fact_text', 'comparison_matrix', 'disclosure'].map(id => ({ id, version: '0.1.0' }));
  const tokens = ['space_section', 'width_content'];
  page.componentCatalogRef.contentHash = fingerprint(components);
  page.themeRef.contentHash = fingerprint(tokens);
  page.root.children[1].bindings.rows.columns[0].predicate = 'test_parameter';
  function versions(value: any) {
    if (!value || typeof value !== 'object') return;
    if (value.kind === 'claim') value.claimVersionId = value.id + '_v1';
    for (const child of Object.values(value)) versions(child);
  }
  versions(page);
  const context: DesignContext = {
    projectId: envelope.projectId, taskId: envelope.taskId, attemptId: envelope.attemptId,
    snapshotHash: envelope.snapshotRef.contentHash,
    allowedSources: [
      ...snapshot.entities.map((e: any) => ({ kind: 'entity', id: e.entityId })),
      ...snapshot.claims.map((c: any) => ({ kind: 'claim', id: c.claimId })),
    ],
    catalog: { ...page.componentCatalogRef, components }, theme: { ...page.themeRef, tokens },
  };
  return { plan, page, snapshot, context };
}

export function designTaskFixture() {
  const f = designFixture();
  const input = {
    protocolVersion: '1.0', projectId: f.context.projectId, taskId: f.context.taskId, attemptId: f.context.attemptId,
    taskType: 'generate', snapshot: f.snapshot, snapshotRef: structuredClone(f.plan.snapshotRef),
    audience: structuredClone(f.plan.audience), goal: f.plan.goal,
    visualGuidance: ['参数与工况共同展示；使用清晰的信息层级'],
    constraints: { language: 'zh-CN', maxSections: 10, maxNodes: 30 },
    catalog: structuredClone(f.context.catalog), theme: structuredClone(f.context.theme),
  };
  const trusted: DesignTaskContext = { inputHash: fingerprint(input), design: f.context };
  const output = {
    protocolVersion: '1.0', projectId: input.projectId, taskId: input.taskId, attemptId: input.attemptId,
    inputHash: trusted.inputHash, status: 'completed', informationPlan: f.plan, pageSpec: f.page,
    producedBy: { role: 'design', protocolVersion: '1.0' },
  };
  return { input, output, trusted };
}
