/** Design v1: deterministic candidate checks, not page review or publication. */
import type { SchemaRegistry } from './schema-registry.ts';
import { fingerprint } from './fingerprint.ts';
import type { CheckResult, CheckIssue } from './service-checks.ts';
import type { DesignReviewRef } from '../generated/design-review-ref.ts';

type RecordValue = Record<string, any>;
export interface DesignContext {
  projectId: string;
  taskId: string;
  attemptId: string;
  /** Fixed, server-authorized snapshot hash. Never take this from the candidate. */
  snapshotHash: string;
  /** Set only by a trusted service after handoff verification; not client permission. */
  reviewRef?: DesignReviewRef;
  allowedSources: Array<{ kind: string; id: string }>;
  catalog: {
    catalogId: string; version: string; contentHash: string;
    components: Array<{ id: string; version: string }>;
  };
  theme: { themeId: string; version: string; contentHash: string; tokens: string[] };
}

const base = 'urn:tju-mas:contracts:';

export function hasVerifiedDesignReview(snapshot: RecordValue, context: DesignContext, registry: SchemaRegistry): boolean {
  const ref = context.reviewRef;
  return !!ref && boundedDesignJson(ref) && registry.validate(base + 'design-review-ref', ref).valid
    && ref.projectId === snapshot.projectId && ref.taskId === snapshot.taskId && ref.attemptId === snapshot.attemptId
    && ref.candidateVersionId === snapshot.snapshotVersionId
    && ref.candidateFingerprint === context.snapshotHash && ref.candidateFingerprint === fingerprint(snapshot);
}

/** Bound depth and size before recursive Schema validation; reject cycles/non-JSON. */
export function boundedDesignJson(value: unknown): boolean {
  const stack = [{ value, depth: 0 }];
  let count = 0;
  let characters = 0;
  while (stack.length) {
    const item = stack.pop()!;
    if (++count > 30000 || item.depth > 40) return false;
    if (typeof item.value === 'string') characters += item.value.length;
    else if (typeof item.value === 'number' && !Number.isFinite(item.value)) return false;
    else if (item.value !== null && typeof item.value === 'object') {
      if (!Array.isArray(item.value) && Object.getPrototypeOf(item.value) !== Object.prototype) return false;
      for (const child of Object.values(item.value)) stack.push({ value: child, depth: item.depth + 1 });
    } else if (!['number', 'boolean', 'object'].includes(typeof item.value)) return false;
    if (characters > 500000) return false;
  }
  return true;
}

export function checkDesign(
  planInput: unknown, pageInput: unknown, snapshotInput: unknown,
  registry: SchemaRegistry, context: DesignContext,
): CheckResult {
  const issues: CheckIssue[] = [];
  const fail = (code: string, path: string, message = code) => issues.push({ code, path, message });
  for (const [name, input] of [['information-plan', planInput], ['page-spec', pageInput], ['evidence-snapshot', snapshotInput]] as const) {
    if (!boundedDesignJson(input)) { fail('design.input_budget', name); continue; }
    const result = registry.validate(base + name, input);
    for (const error of result.errors) fail('schema.' + name, name + error.instancePath, error.message ?? 'Invalid structure');
  }
  if (issues.length) return { ok: false, issues };
  if (!context || !boundedDesignJson(context) || !Array.isArray(context.allowedSources)
    || !Array.isArray(context.catalog?.components) || !Array.isArray(context.theme?.tokens)
    || context.allowedSources.some(x => !x || typeof x.kind !== 'string' || typeof x.id !== 'string')
    || context.catalog.components.some(x => !x || typeof x.id !== 'string' || typeof x.version !== 'string')
    || [context.projectId, context.taskId, context.attemptId, context.snapshotHash,
      context.catalog.catalogId, context.catalog.version, context.catalog.contentHash,
      context.theme.themeId, context.theme.version, context.theme.contentHash].some(x => typeof x !== 'string' || !x.length)
    || context.theme.tokens.some(x => typeof x !== 'string')) {
    return { ok: false, issues: [{ code: 'design.context_invalid', message: 'Missing trusted context' }] };
  }
  // Schema-validated data only below this point.
  const plan = planInput as RecordValue, page = pageInput as RecordValue, snapshot = snapshotInput as RecordValue;
  const key = (ref: RecordValue) => `${ref.kind}:${ref.id}`;
  const allowed = new Set(context.allowedSources.map(key));
  const sources = new Map<string, RecordValue>();
  for (const [kind, collection, field] of [
    ['claim', 'claims', 'claimId'], ['entity', 'entities', 'entityId'],
    ['relation', 'relations', 'relationId'], ['event', 'events', 'eventId'], ['asset', 'assets', 'assetId'],
  ]) {
    for (const record of snapshot[collection] ?? []) {
      const k = `${kind}:${record[field]}`;
      if (sources.has(k)) fail('design.duplicate_source', k);
      sources.set(k, record);
    }
  }
  const evidence = new Set(snapshot.evidence.map((entry: RecordValue) => entry.evidenceId));
  const seenEvidence = new Set<string>();
  for (const entry of snapshot.evidence) {
    if (seenEvidence.has(entry.evidenceId)) fail('design.duplicate_evidence', entry.evidenceId);
    seenEvidence.add(entry.evidenceId);
  }
  if (snapshot.projectId !== context.projectId || fingerprint(snapshot) !== context.snapshotHash)
    fail('design.snapshot_context', 'snapshot');
  const reviewedCandidate = hasVerifiedDesignReview(snapshot, context, registry);
  if (context.reviewRef && !reviewedCandidate) fail('design.review_context', 'reviewRef');
  if (snapshot.reviewStatus !== 'passed' && !(reviewedCandidate && snapshot.reviewStatus === 'pending')) fail('design.snapshot_not_reviewed', 'snapshot.reviewStatus');
  const expectedSnapshot = { snapshotId: snapshot.snapshotId, snapshotVersionId: snapshot.snapshotVersionId, contentHash: context.snapshotHash };
  for (const [name, candidate] of [['plan', plan], ['page', page]] as const) {
    if (fingerprint(candidate.reviewRef ?? null) !== fingerprint(context.reviewRef ?? null)) fail('design.review_binding', name + '.reviewRef');
    for (const field of ['projectId', 'taskId', 'attemptId'] as const)
      if (candidate[field] !== context[field]) fail('design.context_mismatch', `${name}.${field}`);
    if (fingerprint(candidate.snapshotRef) !== fingerprint(expectedSnapshot)) fail('design.snapshot_mismatch', name);
  }
  if (fingerprint(page.informationPlanRef) !== fingerprint({ planId: plan.planId, planVersionId: plan.planVersionId, contentHash: fingerprint(plan) }))
    fail('design.plan_mismatch', 'page.informationPlanRef');
  for (const [field, trusted, idField] of [
    ['componentCatalogRef', context.catalog, 'catalogId'], ['themeRef', context.theme, 'themeId'],
  ] as const) {
    for (const attr of [idField, 'version', 'contentHash'])
      if (page[field][attr] !== (trusted as unknown as RecordValue)[attr]) fail('design.resource_version', field + '.' + attr);
  }
  function resolve(ref: RecordValue, path: string, forDisplay = true): RecordValue | undefined {
    const record = sources.get(key(ref));
    if (!record) { fail('design.source_missing', path); return; }
    if (!allowed.has(key(ref))) fail('design.source_forbidden', path);
    if (ref.kind === 'claim' && forDisplay) {
      if (record.supportStatus !== 'supported' || (record.reviewStatus !== 'passed' && !(reviewedCandidate && record.reviewStatus === 'pending'))) fail('design.claim_not_usable', path);
      if (ref.claimVersionId !== undefined && ref.claimVersionId !== record.claimVersionId) fail('design.claim_version', path);
      if (!record.evidenceRefs.length || record.evidenceRefs.some((e: string) => !evidence.has(e))) fail('design.evidence_missing', path);
      if (!sources.has('entity:' + record.entityId) || !allowed.has('entity:' + record.entityId)) fail('design.entity_forbidden', path);
    }
    return record;
  }
  function unique(items: RecordValue[], field: string, path: string): Map<string, RecordValue> {
    const map = new Map<string, RecordValue>();
    for (const item of items) {
      if (map.has(item[field])) fail('design.duplicate_id', path + '.' + item[field]);
      map.set(item[field], item);
    }
    return map;
  }
  const questions = unique(plan.readerQuestions, 'questionId', 'questions');
  const sections = unique(plan.sections, 'sectionId', 'sections');
  unique(plan.openIssues, 'issueId', 'openIssues');
  const selected = new Set<string>();
  const answered = new Set<string>();
  for (const section of plan.sections) {
    for (const question of section.questionIds) {
      answered.add(question);
      if (!questions.has(question)) fail('design.question_missing', section.sectionId);
    }
    for (const ref of section.sourceRefs) { resolve(ref, section.sectionId); selected.add(key(ref)); }
  }
  for (const question of questions.keys()) if (!answered.has(question)) fail('design.question_unanswered', question);
  for (const omission of plan.omissions) for (const ref of omission.sourceRefs) {
    resolve(ref, 'omissions', false);
    if (selected.has(key(ref))) fail('design.selected_and_omitted', key(ref));
  }
  const states = unique(page.state, 'stateId', 'state');
  const actions = unique(page.actions, 'actionId', 'actions');
  const flat: RecordValue[] = [];
  const stack = [{ node: page.root, depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (depth > 8 || flat.length >= 200) { fail('design.node_budget', node.nodeId); break; }
    flat.push(node);
    for (const child of [...(node.children ?? [])].reverse()) stack.push({ node: child, depth: depth + 1 });
  }
  const nodes = unique(flat, 'nodeId', 'nodes');
  const usedActions = new Set<string>(), usedSections = new Set<string>(), rendered = new Set<string>();
  const sectionClaims = new Set<string>();
  const components = new Set(context.catalog.components.map(c => `${c.id}@${c.version}`));
  function bind(ref: RecordValue, node: RecordValue): RecordValue | undefined {
    const record = resolve(ref, node.nodeId);
    const section = sections.get(node.planSectionId);
    if (!section?.sourceRefs.some((s: RecordValue) => key(s) === key(ref))) fail('design.binding_outside_plan', node.nodeId);
    rendered.add(key(ref));
    sectionClaims.add(node.planSectionId + ':' + key(ref));
    return record;
  }
  for (const node of flat) {
    const kind = node.componentRef.id;
    if (!components.has(`${kind}@${node.componentRef.version}`)) fail('design.component_unavailable', node.nodeId);
    if (node !== page.root) {
      if (!sections.has(node.planSectionId)) fail('design.section_missing', node.nodeId);
      usedSections.add(node.planSectionId);
    }
    if (kind === 'fact_text') {
      const claim = bind(node.bindings.body.claimRef, node);
      if (claim && !['text', 'number', 'quantity', 'boolean', 'date', 'enum'].includes(claim.value.type)) fail('design.value_unsupported', node.nodeId);
    }
    if (kind === 'comparison_matrix') {
      const rows = node.bindings.rows;
      const columns = unique(rows.columns, 'columnId', node.nodeId);
      unique(rows.items, 'rowId', node.nodeId);
      for (const row of rows.items) {
        bind(row.entityRef, node);
        unique(row.cells, 'columnId', row.rowId);
        for (const cell of row.cells) {
          const claim = bind(cell.claimRef, node), column = columns.get(cell.columnId);
          if (!column) fail('design.column_missing', row.rowId);
          if (claim && (claim.entityId !== row.entityRef.id || claim.predicate !== column?.predicate)) fail('design.cell_mismatch', row.rowId);
          if (claim && !['number', 'quantity'].includes(claim.value.type)) fail('design.comparison_value', row.rowId);
        }
      }
    }
    if (kind === 'disclosure' && !states.has(node.bindings.expanded.stateId)) fail('design.state_missing', node.nodeId);
    for (const [event, actionId] of Object.entries(node.events ?? {})) {
      const action = actions.get(actionId as string);
      usedActions.add(actionId as string);
      if (!action || action.sourceNodeId !== node.nodeId) { fail('design.action_binding', node.nodeId); continue; }
      if (event === 'toggleRequested') {
        if (action.type !== 'toggleBoolean' || action.targetStateId !== node.bindings.expanded.stateId || !states.has(action.targetStateId)) fail('design.toggle_binding', node.nodeId);
      } else if (action.type !== 'openEvidence') fail('design.source_action', node.nodeId);
      else if (kind === 'comparison_matrix') {
        if (action.target.kind !== 'eventBoundClaim') fail('design.source_target', node.nodeId);
      } else if (fingerprint(action.target) !== fingerprint(node.bindings.body.claimRef)) fail('design.source_target', node.nodeId);
    }
  }
  for (const action of page.actions) if (!usedActions.has(action.actionId)) fail('design.unused_action', action.actionId);
  for (const section of plan.sections) if (!usedSections.has(section.sectionId)) fail('design.section_unrendered', section.sectionId);
  const sectionOrder = [...new Set(flat.filter(n => n.planSectionId).map(n => n.planSectionId))];
  if (JSON.stringify(sectionOrder) !== JSON.stringify(plan.sections.map((s: RecordValue) => s.sectionId))) fail('design.section_order', 'page.root');
  for (const section of plan.sections) for (const ref of section.sourceRefs)
    if (ref.kind === 'claim' && !sectionClaims.has(section.sectionId + ':' + key(ref))) fail('design.section_claim_unrendered', section.sectionId);
  // Non-claim sources may be planning context; every selected claim must be represented.
  for (const ref of selected) if (ref.startsWith('claim:') && !rendered.has(ref)) fail('design.claim_unrendered', ref);
  for (const token of [page.root.layout.gapToken, page.root.layout.widthToken]) if (!context.theme.tokens.includes(token)) fail('design.theme_token', token);
  for (const check of page.checks) {
    if (check.type === 'evidenceResolvable') {
      for (const nodeId of check.nodeIds) if (!['fact_text', 'comparison_matrix'].includes(nodes.get(nodeId)?.componentRef.id)) fail('design.check_target', nodeId);
    } else {
      const node = nodes.get(check.nodeId);
      if (check.type === 'visibleQualifiers' && node?.componentRef.id !== 'comparison_matrix') fail('design.check_target', check.nodeId);
      if (check.type === 'toggleRoundTrip' && (node?.componentRef.id !== 'disclosure' || node.bindings.expanded.stateId !== check.stateId)) fail('design.check_target', check.nodeId);
    }
  }
  // Required checks are derived from component usage, never solely from model requests.
  for (const node of flat) {
    const kind = node.componentRef.id;
    if (['fact_text', 'comparison_matrix'].includes(kind) && !page.checks.some((c: RecordValue) => c.type === 'evidenceResolvable' && c.nodeIds.includes(node.nodeId))) fail('design.required_check', node.nodeId);
    if (kind === 'comparison_matrix' && !page.checks.some((c: RecordValue) => c.type === 'visibleQualifiers' && c.nodeId === node.nodeId)) fail('design.required_check', node.nodeId);
    if (kind === 'disclosure' && !page.checks.some((c: RecordValue) => c.type === 'toggleRoundTrip' && c.nodeId === node.nodeId && c.stateId === node.bindings.expanded.stateId)) fail('design.required_check', node.nodeId);
  }
  return { ok: issues.length === 0, issues };
}
