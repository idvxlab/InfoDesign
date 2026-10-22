/** Model authors design bodies; service assigns identities, versions and hashes. */
import { randomUUID } from 'node:crypto';
import type { DesignInput, DesignOutput } from '../../../../../packages/contracts/generated/index.ts';
import { SchemaRegistry } from '../../../../../packages/contracts/src/schema-registry.ts';
import { fingerprint } from '../../../../../packages/contracts/src/fingerprint.ts';
import { boundedDesignJson } from '../../../../../packages/contracts/src/design-checks.ts';
import type { DesignTaskContext } from '../../../../../packages/contracts/src/design-agent-checks.ts';

export const DRAFT_ID = 'urn:tju-mas:runtime:design-draft';
const base = 'urn:tju-mas:contracts:';
type Obj = Record<string, any>;
export function designDraftProtocol(registry: SchemaRegistry, pageSpecVersion: '1.0' | '1.1' = '1.0') {
  const pickBody = (name: string, fields: string[]) => {
    const original = structuredClone(registry.get(base + name)) as Obj;
    if (name === 'page-spec' && pageSpecVersion === '1.0') Object.assign(original.properties, original.allOf[0].then.properties);
    const properties = Object.fromEntries(fields.map(key => [key, original.properties[key]]));
    function absolute(node: any): void {
      if (!node || typeof node !== 'object') return;
      if (typeof node.$ref === 'string' && node.$ref.startsWith('#')) node.$ref = base + name + node.$ref;
      Object.values(node).forEach(absolute);
    }
    absolute(properties);
    return { type: 'object', properties, required: original.required.filter((k: string) => fields.includes(k)), additionalProperties: false };
  };
  const schema = structuredClone(registry.get(base + 'design-output')) as Obj;
  schema.$id = DRAFT_ID;
  schema.title = 'Model-authored design bodies; not a persisted business output';
  for (const field of ['protocolVersion', 'projectId', 'taskId', 'attemptId', 'inputHash', 'producedBy', 'reviewRef']) delete schema.properties[field];
  schema.required = ['status'];
  schema.properties.informationPlan = pickBody('information-plan', ['audience', 'goal', 'readerQuestions', 'sections', 'omissions', 'openIssues']);
  schema.properties.pageSpec = pickBody('page-spec', ['state', 'root', 'actions', 'checks', ...(pageSpecVersion === '1.1' ? ['calculations'] : [])]);
  if (pageSpecVersion === '1.1') {
    schema.properties.pageSpec.required.push('calculations');
    schema.properties.pageSpec.properties.root.required.push('responsiveLayout', 'style', 'accessibility');
  }
  const validator = new SchemaRegistry();
  for (const entry of registry.entries()) validator.addSchema(entry.file, structuredClone(entry.schema));
  validator.addSchema('trusted-derived-design-draft', schema); validator.compile();
  return { schema, validator };
}

export function designPrompt(input: DesignInput, registry: SchemaRegistry, draftSchema: Obj): string {
  // Send only the reference closure of the authoring body, not full service envelopes
  // and unrelated common definitions. Keep the authoritative validator unchanged.
  const definitions: Obj = {}, refs = new Map<string, string>();
  const compact = (value: any, documentId: string): any => {
    if (Array.isArray(value)) return value.map(item => compact(item, documentId));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => {
      if (key !== '$ref' || typeof child !== 'string') return [key, compact(child, documentId)];
      const absoluteRef = child.startsWith('#') ? documentId + child : child;
      let local = refs.get(absoluteRef);
      if (!local) {
        const [id, fragment = ''] = absoluteRef.split('#');
        let target: any = registry.get(id);
        if (fragment && !fragment.startsWith('/')) throw new Error('unsupported_schema_anchor');
        for (const part of fragment.split('/').slice(1)) target = target?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
        if (!target) throw new Error('missing_prompt_schema_ref');
        const name = 'definition_' + refs.size;
        local = '#/$defs/' + name;
        refs.set(absoluteRef, local); // Register first: page nodes are recursive.
        definitions[name] = compact(target, id);
      }
      return [key, local];
    }));
  };
  const authoringSchema = compact(draftSchema, DRAFT_ID);
  authoringSchema.$defs = definitions;
  return JSON.stringify({
    instruction: '先 read_design catalog，再按需读取 claim。仅返回符合 design-draft 的 JSON。不要提交身份、版本、指纹或完整快照；程序负责封装。引用事实前必须实际读取。',
    task: { audience: input.audience, goal: input.goal, constraints: input.constraints, visualGuidance: input.visualGuidance,
      pageSpecVersion: input.pageSpecVersion ?? '1.0', resources: input.resources },
    index: {
      entities: input.snapshot.entities.map(e => ({ entityId: e.entityId, entityType: e.entityType, label: e.label })),
      claims: input.snapshot.claims.map(c => ({ claimId: c.claimId, entityId: c.entityId, predicate: c.predicate, supportStatus: c.supportStatus, reviewStatus: c.reviewStatus })),
      missing: input.snapshot.missing, conflicts: input.snapshot.conflicts, coverage: input.snapshot.coverage,
      relationCount: input.snapshot.relations?.length ?? 0, eventCount: input.snapshot.events?.length ?? 0, assetCount: input.snapshot.assets?.length ?? 0,
      relations: input.snapshot.relations?.map(r => ({ relationId: r.relationId, fromEntityId: r.fromEntityId, toEntityId: r.toEntityId, relationType: r.relationType })),
      events: input.snapshot.events?.map(e => ({ eventId: e.eventId, entityId: e.entityId, eventType: e.eventType })),
      assets: input.snapshot.assets?.map(a => ({ assetId: a.assetId, documentId: a.documentId })),
    },
    schemas: [authoringSchema],
  });
}

export function materializeDesign(raw: unknown, input: DesignInput, trusted: DesignTaskContext,
  draft: ReturnType<typeof designDraftProtocol>): DesignOutput {
  if (!boundedDesignJson(raw) || !draft.validator.validate(DRAFT_ID, raw).valid) throw new Error('invalid_design_draft');
  const body = structuredClone(raw) as Obj;
  const identity = { protocolVersion: '1.0', projectId: input.projectId, taskId: input.taskId, attemptId: input.attemptId,
    ...(input.reviewRef ? { reviewRef: structuredClone(input.reviewRef) } : {}) };
  const producedBy = { role: 'design', protocolVersion: '1.0' };
  const output = { ...identity, inputHash: trusted.inputHash, producedBy, ...body } as DesignOutput;
  if (body.status === 'completed') {
    const suffix = randomUUID().replaceAll('-', '');
    const envelope = { ...identity, snapshotRef: structuredClone(input.snapshotRef), producedBy, createdAt: new Date().toISOString() };
    const plan = { ...body.informationPlan, ...envelope, planId: 'plan_' + suffix, planVersionId: 'planv_' + suffix };
    output.informationPlan = plan;
    output.pageSpec = { ...body.pageSpec, ...envelope, pageSpecId: 'spec_' + suffix, pageSpecVersionId: 'specv_' + suffix,
      protocolVersion: input.pageSpecVersion ?? '1.0',
      informationPlanRef: { planId: plan.planId, planVersionId: plan.planVersionId, contentHash: fingerprint(plan) },
      componentCatalogRef: { catalogId: input.catalog.catalogId, version: input.catalog.version, contentHash: input.catalog.contentHash },
      themeRef: { themeId: input.theme.themeId, version: input.theme.version, contentHash: input.theme.contentHash } };
  }
  return output;
}
