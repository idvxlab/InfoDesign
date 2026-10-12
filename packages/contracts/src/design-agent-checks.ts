/** First-generation design task contracts. No model execution, review or adoption. */
import type { SchemaRegistry } from './schema-registry.ts';
import type { CheckResult, CheckIssue } from './service-checks.ts';
import { boundedDesignJson, checkDesign, hasVerifiedDesignReview, type DesignContext } from './design-checks.ts';
import { fingerprint } from './fingerprint.ts';
import type { DesignInput, DesignOutput } from '../generated/index.ts';

export interface DesignTaskContext {
  /** Computed and retained by the service before giving the task to the model. */
  inputHash: string;
  design: DesignContext;
}
const base = 'urn:tju-mas:contracts:';

function structure(value: unknown, name: string, registry: SchemaRegistry): CheckIssue[] {
  if (!boundedDesignJson(value)) return [{ code: 'design.input_budget', path: name, message: 'Invalid JSON or exceeded input budget' }];
  return registry.validate(base + name, value).errors.map(e => ({ code: 'schema.' + name, path: name + e.instancePath, message: e.message ?? 'Invalid structure' }));
}

export function checkDesignInput(value: unknown, registry: SchemaRegistry, trusted: DesignTaskContext): CheckResult {
  const issues = structure(value, 'design-input', registry);
  if (issues.length) return { ok: false, issues };
  const input = value as DesignInput;
  const fail = (code: string, path: string) => issues.push({ code, path, message: code });
  if (!trusted || !boundedDesignJson(trusted) || !/^sha256:[0-9a-f]{64}$/.test(trusted.inputHash)
    || !trusted.design || !Array.isArray(trusted.design.allowedSources)
    || trusted.design.allowedSources.some(s => !s || typeof s.kind !== 'string' || typeof s.id !== 'string')
    || !trusted.design.catalog || !trusted.design.theme) {
    return { ok: false, issues: [{ code: 'design.context_invalid', message: 'Missing trusted design task context' }] };
  }
  const context = trusted.design;
  if (fingerprint(input) !== trusted.inputHash) fail('design.input_hash', 'input');
  for (const field of ['projectId', 'taskId', 'attemptId'] as const)
    if (input[field] !== context[field]) fail('design.context_mismatch', field);
  if (input.snapshot.projectId !== context.projectId || fingerprint(input.snapshot) !== context.snapshotHash)
    fail('design.snapshot_context', 'snapshot');
  const snapshotRef = { snapshotId: input.snapshot.snapshotId, snapshotVersionId: input.snapshot.snapshotVersionId, contentHash: context.snapshotHash };
  if (fingerprint(input.snapshotRef) !== fingerprint(snapshotRef)) fail('design.snapshot_mismatch', 'snapshotRef');
  const reviewedCandidate = hasVerifiedDesignReview(input.snapshot, context, registry);
  if (fingerprint(input.reviewRef ?? null) !== fingerprint(context.reviewRef ?? null) || (context.reviewRef && !reviewedCandidate)) fail('design.review_binding', 'reviewRef');
  if (input.snapshot.reviewStatus !== 'passed' && !(reviewedCandidate && input.snapshot.reviewStatus === 'pending')) fail('design.snapshot_not_reviewed', 'snapshot.reviewStatus');
  if (fingerprint(input.catalog) !== fingerprint(context.catalog)) fail('design.catalog_mismatch', 'catalog');
  if (fingerprint(input.theme) !== fingerprint(context.theme)) fail('design.theme_mismatch', 'theme');
  const components = input.catalog.components.map(c => `${c.id}@${c.version}`);
  if (new Set(components).size !== components.length) fail('design.duplicate_component', 'catalog.components');
  if (new Set(input.theme.tokens).size !== input.theme.tokens.length) fail('design.duplicate_token', 'theme.tokens');
  // A complete snapshot is supplied in v1. Every supplied source must be in the
  // server grant, including context records not ultimately chosen for display.
  const allowed = new Set(context.allowedSources.map(r => `${r.kind}:${r.id}`));
  const collections: Array<[string, Array<Record<string, any>>, string]> = [
    ['entity', input.snapshot.entities, 'entityId'], ['claim', input.snapshot.claims, 'claimId'],
    ['relation', input.snapshot.relations ?? [], 'relationId'], ['event', input.snapshot.events ?? [], 'eventId'],
    ['asset', input.snapshot.assets ?? [], 'assetId'],
  ];
  for (const [kind, records, field] of collections) {
    const seen = new Set<string>();
    for (const record of records) {
      const key = `${kind}:${record[field]}`;
      if (!allowed.has(key)) fail('design.input_source_forbidden', key);
      if (seen.has(key)) fail('design.duplicate_source', key);
      seen.add(key);
    }
  }
  return { ok: issues.length === 0, issues };
}

export function checkDesignOutput(
  value: unknown, inputValue: unknown, registry: SchemaRegistry, trusted: DesignTaskContext,
): CheckResult {
  const inputCheck = checkDesignInput(inputValue, registry, trusted);
  const issues = [...inputCheck.issues, ...structure(value, 'design-output', registry)];
  if (issues.length) return { ok: false, issues };
  const output = value as DesignOutput, input = inputValue as DesignInput;
  const fail = (code: string, path: string) => issues.push({ code, path, message: code });
  if (fingerprint(output.reviewRef ?? null) !== fingerprint(input.reviewRef ?? null)) fail('design.review_binding', 'reviewRef');
  for (const field of ['projectId', 'taskId', 'attemptId'] as const)
    if (output[field] !== input[field]) fail('design.output_context', field);
  if (output.inputHash !== trusted.inputHash) fail('design.output_input_hash', 'inputHash');
  if (output.status === 'completed') {
    // Schema requires the pair in this branch; generated types keep them optional.
    const plan = output.informationPlan!, page = output.pageSpec!;
    issues.push(...checkDesign(plan, page, input.snapshot, registry, trusted.design).issues);
    if (plan.goal !== input.goal) fail('design.goal_changed', 'informationPlan.goal');
    if (fingerprint(plan.audience) !== fingerprint(input.audience)) fail('design.audience_changed', 'informationPlan.audience');
    if (plan.sections.length > input.constraints.maxSections) fail('design.section_limit', 'informationPlan.sections');
    if (page.root.props.lang !== input.constraints.language) fail('design.language_changed', 'pageSpec.root.props.lang');
    let nodeCount = 0;
    const stack: any[] = [page.root];
    while (stack.length) {
      const node = stack.pop(); nodeCount++;
      for (const child of node.children ?? []) stack.push(child);
    }
    if (nodeCount > input.constraints.maxNodes) fail('design.node_limit', 'pageSpec.root');
    if (plan.openIssues.length) fail('design.unresolved_issues', 'informationPlan.openIssues');
  }
  // ok means a valid response, including a valid stop response. Only status
  // completed is a design candidate; neither result is a publication decision.
  return { ok: issues.length === 0, issues };
}
