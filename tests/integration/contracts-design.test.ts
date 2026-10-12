import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registry, IDS } from '../helpers/fixtures.ts';
import { designFixture, designTaskFixture } from '../helpers/design-fixtures.ts';
import { checkDesign } from '../../packages/contracts/src/design-checks.ts';
import { checkDesignInput, checkDesignOutput } from '../../packages/contracts/src/design-agent-checks.ts';
import { fingerprint } from '../../packages/contracts/src/fingerprint.ts';

type Fixture = ReturnType<typeof designFixture>;
const check = (f: Fixture) => checkDesign(f.plan, f.page, f.snapshot, registry, f.context);
test('design: complete synthetic candidate passes without changing inputs', () => {
  const f = designFixture(), before = JSON.stringify(f);
  assert.deepEqual(check(f), { ok: true, issues: [] });
  assert.equal(JSON.stringify(f), before);
});
const cases: Array<[string, (f: Fixture) => void, string]> = [
  ['forged permission', f => { f.page.permissions = ['all']; }, 'schema.page-spec'],
  ['injected HTML', f => { f.page.root.children[0].props.html = '<script>bad()</script>'; }, 'schema.page-spec'],
  ['hidden qualifiers', f => { f.page.root.children[0].bindings.body.format.qualifiers = 'hidden'; }, 'schema.page-spec'],
  ['missing envelope', f => { delete f.plan.projectId; }, 'schema.information-plan'],
  ['forged role', f => { f.plan.producedBy.role = 'review'; }, 'schema.information-plan'],
  ['unknown component', f => { f.page.root.children[0].componentRef.id = 'arbitrary'; }, 'schema.page-spec'],
  ['wrong project', f => { f.page.projectId = 'project_other'; }, 'design.context_mismatch'],
  ['stale snapshot', f => { f.page.snapshotRef.snapshotVersionId = 'version_old'; }, 'design.snapshot_mismatch'],
  ['stale plan', f => { f.plan.goal += ' changed'; }, 'design.plan_mismatch'],
  ['snapshot tamper', f => { f.snapshot.claims[0].value.text = 'changed'; }, 'design.snapshot_context'],
  ['unreviewed snapshot', f => { f.snapshot.reviewStatus = 'pending'; }, 'design.snapshot_not_reviewed'],
  ['unreviewed claim', f => { f.snapshot.claims[0].reviewStatus = 'pending'; }, 'design.claim_not_usable'],
  ['conflicted claim', f => { f.snapshot.claims[0].supportStatus = 'conflicted'; }, 'design.claim_not_usable'],
  ['missing evidence', f => { f.snapshot.claims[0].evidenceRefs = ['ev_absent']; }, 'design.evidence_missing'],
  ['forbidden source', f => { f.context.allowedSources = []; }, 'design.source_forbidden'],
  ['missing claim', f => { f.page.root.children[0].bindings.body.claimRef.id = 'claim_absent'; }, 'design.source_missing'],
  ['stale claim', f => { f.page.root.children[0].bindings.body.claimRef.claimVersionId = 'version_old'; }, 'design.claim_version'],
  ['duplicate node', f => { f.page.root.children[1].nodeId = f.page.root.children[0].nodeId; }, 'design.duplicate_id'],
  ['unknown section', f => { f.page.root.children[0].planSectionId = 'section_absent'; }, 'design.section_missing'],
  ['unknown question', f => { f.plan.sections[0].questionIds = ['question_absent']; }, 'design.question_missing'],
  ['wrong product', f => { f.page.root.children[1].bindings.rows.items[0].entityRef.id = 'entity_product_b_placeholder'; }, 'design.cell_mismatch'],
  ['wrong predicate', f => { f.page.root.children[1].bindings.rows.columns[0].predicate = 'another_parameter'; }, 'design.cell_mismatch'],
  ['unknown column', f => { f.page.root.children[1].bindings.rows.items[0].cells[0].columnId = 'column_absent'; }, 'design.column_missing'],
  ['missing component implementation', f => { f.context.catalog.components = []; }, 'design.component_unavailable'],
  ['wrong catalog version', f => { f.page.componentCatalogRef.version = '9.0.0'; }, 'design.resource_version'],
  ['unknown theme token', f => { f.page.root.layout.gapToken = 'token_absent'; }, 'design.theme_token'],
  ['wrong action node', f => { f.page.actions[0].sourceNodeId = 'node_products'; }, 'design.action_binding'],
  ['missing state', f => { f.page.state = []; }, 'design.state_missing'],
  ['wrong source target', f => { f.page.actions[1].target.id = 'claim_service_placeholder'; }, 'design.source_target'],
  ['bad check node', f => { f.page.checks[0].nodeId = 'node_absent'; }, 'design.check_target'],
  ['omitted checks', f => { f.page.checks = []; }, 'design.required_check'],
  ['wrong reading order', f => { f.page.root.children.reverse(); }, 'design.section_order'],
  ['unanswered question', f => { f.plan.readerQuestions.push({ questionId: 'question_extra', text: 'test' }); }, 'design.question_unanswered'],
  ['dropped section', f => { f.page.root.children.pop(); }, 'design.section_unrendered'],
  ['selected and omitted', f => { f.plan.omissions = [{ sourceRefs: f.plan.sections[0].sourceRefs, reason: 'test' }]; }, 'design.selected_and_omitted'],
];
for (const [name, mutate, code] of cases) test('design rejects ' + name, () => {
  const f = designFixture(); mutate(f);
  const result = check(f);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(i => i.code === code), JSON.stringify(result.issues));
});
test('design: another content order is accepted when version and nodes match', () => {
  const f = designFixture();
  f.plan.sections.reverse(); f.page.root.children.reverse();
  f.page.informationPlanRef.contentHash = fingerprint(f.plan);
  assert.equal(check(f).ok, true);
});
test('design: an authorized unusable claim may be explicitly omitted, not displayed', () => {
  const f = designFixture();
  f.snapshot.claims.push({ ...structuredClone(f.snapshot.claims[0]), claimId: 'claim_omitted', claimVersionId: 'claim_omitted_v1', supportStatus: 'pending', reviewStatus: 'pending' });
  f.context.allowedSources.push({ kind: 'claim', id: 'claim_omitted' });
  f.plan.omissions.push({ sourceRefs: [{ kind: 'claim', id: 'claim_omitted' }], reason: '未审查，不作确定事实展示' });
  f.context.snapshotHash = fingerprint(f.snapshot);
  f.plan.snapshotRef.contentHash = f.context.snapshotHash;
  f.page.snapshotRef.contentHash = f.context.snapshotHash;
  f.page.informationPlanRef.contentHash = fingerprint(f.plan);
  assert.deepEqual(check(f), { ok: true, issues: [] });
});
test('design rejects malformed, cyclic and excessively deep inputs without throwing', () => {
  const f = designFixture();
  const cycle: any = {}; cycle.self = cycle;
  let deep: any = {}; for (let i = 0; i < 50; i++) deep = { nested: deep };
  for (const input of [null, [], 1, {}, cycle, deep]) {
    assert.equal(checkDesign(input, f.page, f.snapshot, registry, f.context).ok, false);
  }
  assert.equal(checkDesign(f.plan, f.page, f.snapshot, registry, null as never).ok, false);
});
test('empty design tasks and unavailable publishing protocols are rejected', () => {
  for (const id of [IDS.designInput, IDS.designOutput, IDS.pageVersion]) assert.equal(registry.validate(id, {}).valid, false);
});

type TaskFixture = ReturnType<typeof designTaskFixture>;
const taskCheck = (f: TaskFixture) => checkDesignOutput(f.output, f.input, registry, f.trusted);
const sealInput = (f: TaskFixture) => {
  f.trusted.inputHash = fingerprint(f.input); f.output.inputHash = f.trusted.inputHash;
};
test('design task: complete input and output pass without changing data', () => {
  const f = designTaskFixture(), before = JSON.stringify(f);
  assert.deepEqual(checkDesignInput(f.input, registry, f.trusted), { ok: true, issues: [] });
  assert.deepEqual(taskCheck(f), { ok: true, issues: [] });
  assert.equal(JSON.stringify(f), before);
});
for (const status of ['needs_information', 'blocked', 'failed']) {
  test('design task: valid stop response ' + status, () => {
    const f = designTaskFixture();
    const output: any = { ...f.output, status, stopReason: '测试停止原因' };
    delete output.informationPlan; delete output.pageSpec;
    if (status !== 'failed') output.requirements = [{ kind: status === 'blocked' ? 'component' : 'information', description: '测试需求' }];
    assert.deepEqual(checkDesignOutput(output, f.input, registry, f.trusted), { ok: true, issues: [] });
    delete output.stopReason;
    assert.equal(checkDesignOutput(output, f.input, registry, f.trusted).ok, false);
  });
}
const taskCases: Array<[string, (f: TaskFixture) => void, string]> = [
  ['unsupported revise', f => { f.input.taskType = 'revise'; }, 'schema.design-input'],
  ['missing input snapshot', f => { delete (f.input as any).snapshot; }, 'schema.design-input'],
  ['permissions in output', f => { (f.output as any).permissions = ['write_facts']; }, 'schema.design-output'],
  ['facts in output', f => { (f.output as any).snapshot = f.input.snapshot; }, 'schema.design-output'],
  ['input hash tampered', f => { f.input.goal = 'changed'; }, 'design.input_hash'],
  ['wrong output input', f => { f.output.inputHash = 'sha256:' + '0'.repeat(64); }, 'design.output_input_hash'],
  ['wrong attempt', f => { f.output.attemptId = 'attempt_other'; }, 'design.output_context'],
  ['missing successful page', f => { delete (f.output as any).pageSpec; }, 'schema.design-output'],
  ['missing successful plan', f => { delete (f.output as any).informationPlan; }, 'schema.design-output'],
  ['stop reason on success', f => { (f.output as any).stopReason = 'test'; }, 'schema.design-output'],
  ['false review role', f => { f.output.producedBy.role = 'review'; }, 'schema.design-output'],
  ['changed goal', f => { f.output.informationPlan.goal = '另一个目标'; f.output.pageSpec.informationPlanRef.contentHash = fingerprint(f.output.informationPlan); }, 'design.goal_changed'],
  ['changed audience', f => { f.output.informationPlan.audience.role = '另一种受众'; f.output.pageSpec.informationPlanRef.contentHash = fingerprint(f.output.informationPlan); }, 'design.audience_changed'],
  ['too many sections', f => { f.input.constraints.maxSections = 1; sealInput(f); }, 'design.section_limit'],
  ['too many nodes', f => { f.input.constraints.maxNodes = 1; sealInput(f); }, 'design.node_limit'],
  ['changed language', f => { f.output.pageSpec.root.props.lang = 'en'; }, 'design.language_changed'],
  ['unresolved issue on success', f => { f.output.informationPlan.openIssues.push({ issueId: 'issue_test', kind: 'missing_input', description: 'test' }); f.output.pageSpec.informationPlanRef.contentHash = fingerprint(f.output.informationPlan); }, 'design.unresolved_issues'],
  ['unauthorized input records', f => { f.trusted.design.allowedSources = []; }, 'design.input_source_forbidden'],
  ['catalog differs from trusted', f => { f.input.catalog.components = []; sealInput(f); }, 'design.catalog_mismatch'],
  ['theme differs from trusted', f => { f.input.theme.tokens = []; sealInput(f); }, 'design.theme_mismatch'],
  ['unreviewed input', f => { f.input.snapshot.reviewStatus = 'pending'; sealInput(f); }, 'design.snapshot_not_reviewed'],
  ['duplicate catalog entry', f => { f.input.catalog.components[1] = structuredClone(f.input.catalog.components[0]); f.trusted.design.catalog = structuredClone(f.input.catalog); sealInput(f); }, 'design.duplicate_component'],
  ['duplicate theme token', f => { f.input.theme.tokens.push(f.input.theme.tokens[0]); f.trusted.design.theme = structuredClone(f.input.theme); sealInput(f); }, 'design.duplicate_token'],
];
for (const [name, mutate, code] of taskCases) test('design task rejects ' + name, () => {
  const f = designTaskFixture(); mutate(f);
  const result = taskCheck(f);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(i => i.code === code), JSON.stringify(result.issues));
});
test('design task: stops cannot contain candidates or incorrect requirement kinds', () => {
  const f = designTaskFixture();
  for (const status of ['needs_information', 'blocked', 'failed']) {
    const stop: any = { ...f.output, status, stopReason: 'test' };
    assert.equal(checkDesignOutput(stop, f.input, registry, f.trusted).ok, false);
    delete stop.informationPlan; delete stop.pageSpec;
    stop.requirements = [{ kind: status === 'blocked' ? 'information' : 'component', description: 'test' }];
    assert.equal(checkDesignOutput(stop, f.input, registry, f.trusted).ok, false);
  }
});
test('design task: malformed and cyclic inputs, output or context do not throw', () => {
  const f = designTaskFixture();
  const cycle: any = {}; cycle.self = cycle;
  for (const input of [null, {}, [], cycle]) {
    assert.equal(checkDesignInput(input, registry, f.trusted).ok, false);
    assert.equal(checkDesignOutput(input, f.input, registry, f.trusted).ok, false);
  }
  for (const trusted of [null, {}, cycle]) assert.equal(checkDesignInput(f.input, registry, trusted as never).ok, false);
});
