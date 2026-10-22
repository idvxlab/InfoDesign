/** PageSpec 1.1 deterministic checks. Checks describe work to run, never a pass report. */
import { fingerprint } from './fingerprint.ts';
type Obj = Record<string, any>;
export interface PageExtensionContext {
  resources?: { assets: Array<{ assetId: string; documentId: string; documentVersionId: string; blockId: string;
    resourceId: string; mediaType: string; contentHash: string }> };
}
export const sourcedComponents = ['fact_text', 'comparison_matrix', 'narrative', 'asset_image', 'timeline', 'relation_graph', 'bar_chart', 'derived_value'];
export const sourceSlots: Record<string, string> = { narrative: 'paragraphs', asset_image: 'asset', timeline: 'items', relation_graph: 'edges', bar_chart: 'points', derived_value: 'derived' };
export const componentChecks: Record<string, string> = { narrative: 'semanticFidelity', asset_image: 'assetAvailable', timeline: 'timelineOrder', relation_graph: 'relationIntegrity', bar_chart: 'chartComparability', tabs: 'selectionRoundTrip', derived_value: 'derivedInputs' };

export function percentChange(base: number, current: number): number {
  if (!Number.isFinite(base) || !Number.isFinite(current) || base <= 0) throw new Error('invalid_percent_change');
  const result = (current - base) / base * 100;
  if (!Number.isFinite(result)) throw new Error('invalid_percent_change');
  return result;
}

export function checkPageExtensions(page: Obj, flat: Obj[], states: Map<string, Obj>, context: PageExtensionContext & { theme: { tokens: string[] } },
  bind: (ref: Obj, node: Obj) => Obj | undefined,
  fail: (code: string, path: string) => void): void {
  if (page.protocolVersion !== '1.1') return;
  const calculations = new Map<string, Obj>();
  for (const calculation of page.calculations) {
    if (calculations.has(calculation.calculationId)) fail('design.duplicate_id', calculation.calculationId);
    calculations.set(calculation.calculationId, calculation);
  }
  const usedCalculations = new Set<string>();
  const assetMap = new Map<string, Obj>();
  for (const asset of context.resources?.assets ?? []) {
    if (assetMap.has(asset.assetId)) fail('design.duplicate_asset_resource', asset.assetId);
    assetMap.set(asset.assetId, asset);
  }
  function unique(items: Obj[], field: string, path: string) {
    if (new Set(items.map(x => x[field])).size !== items.length) fail('design.duplicate_id', path);
  }
  function numeric(claim: Obj | undefined, path: string): number | undefined {
    if (!claim || !['number','quantity'].includes(claim.value.type) || !Number.isFinite(claim.value.normalized)) {
      fail('design.numeric_required', path); return;
    }
    return claim.value.normalized;
  }
  function comparable(a: Obj, b: Obj, ignoreTime: boolean) {
    const qualifiers = (x: Obj) => { const q = { ...x.qualifiers }; if (ignoreTime) delete q.time; return q; };
    return a.predicate === b.predicate && a.value.unit === b.value.unit
      && fingerprint(qualifiers(a)) === fingerprint(qualifiers(b));
  }
  for (const node of flat) {
    const kind = node.componentRef.id;
    for (const value of [node.style, node.layout, node.responsiveLayout?.small, node.responsiveLayout?.large]) {
      for (const [key, token] of Object.entries(value ?? {})) if (key.endsWith('Token') && !context.theme.tokens.includes(token as string)) fail('design.theme_token', node.nodeId + '.' + key);
    }
    if (node.accessibility?.headingLevel && node.props.headingLevel && node.accessibility.headingLevel !== node.props.headingLevel) fail('design.heading_mismatch', node.nodeId);
    if (kind === 'narrative') {
      unique(node.bindings.paragraphs, 'paragraphId', node.nodeId);
      for (const p of node.bindings.paragraphs) for (const ref of p.sourceRefs) bind(ref,node);
    }
    if (kind === 'asset_image') {
      const asset = bind(node.bindings.asset,node), resource = assetMap.get(node.bindings.asset.id);
      if (!resource || !asset || ['documentId','documentVersionId','blockId'].some(k => resource[k] !== asset[k])) fail('design.asset_unavailable',node.nodeId);
    }
    if (kind === 'timeline') {
      unique(node.bindings.items,'itemId',node.nodeId);
      const dated: number[] = []; let sawUndated = false;
      for (const item of node.bindings.items) {
        const event = bind(item.eventRef,node);
        const time = event?.time;
        const timestamp = time?.asOf ? Date.parse(time.asOf) : time?.year !== undefined ? Date.UTC(time.year,0,1) : NaN;
        if (!Number.isFinite(timestamp)) sawUndated = true;
        else { if (sawUndated && node.props.order !== 'source') fail('design.timeline_undated_position',node.nodeId); dated.push(timestamp); }
      }
      if (node.props.order !== 'source') for (let i=1;i<dated.length;i++) {
        if (node.props.order === 'ascending' ? dated[i] < dated[i-1] : dated[i] > dated[i-1]) fail('design.timeline_order',node.nodeId);
      }
    }
    if (kind === 'relation_graph') {
      unique(node.bindings.edges,'edgeId',node.nodeId);
      for (const edge of node.bindings.edges) bind(edge.relationRef,node);
    }
    if (kind === 'bar_chart') {
      unique(node.bindings.points,'pointId',node.nodeId);
      let first: Obj | undefined;
      for (const point of node.bindings.points) {
        const claim = bind(point.claimRef,node); numeric(claim,node.nodeId);
        if (claim && first && !comparable(first,claim,false)) fail('design.chart_incomparable',node.nodeId);
        first ??= claim;
      }
    }
    if (kind === 'derived_value') {
      const calc = calculations.get(node.bindings.derived.calculationId);
      if (!calc) { fail('design.calculation_missing',node.nodeId); continue; }
      usedCalculations.add(calc.calculationId);
      const a=bind(calc.base,node), b=bind(calc.current,node);
      const av=numeric(a,node.nodeId), bv=numeric(b,node.nodeId);
      if (a && b) {
        const yearA=a.qualifiers?.time?.year, yearB=b.qualifiers?.time?.year;
        if (a.entityId !== b.entityId || !comparable(a,b,true) || !a.qualifiers?.basis
          || !Number.isInteger(yearA) || !Number.isInteger(yearB) || yearA >= yearB
          || a.qualifiers.time.asOf || a.qualifiers.time.period || b.qualifiers.time.asOf || b.qualifiers.time.period)
          fail('design.calculation_incomparable',node.nodeId);
      }
      if (av !== undefined && bv !== undefined) try { percentChange(av,bv); } catch { fail('design.calculation_domain',node.nodeId); }
    }
    if (kind === 'tabs') {
      const state=states.get(node.bindings.selected.stateId), items=node.bindings.items;
      unique(items,'value',node.nodeId);unique(items,'childNodeId',node.nodeId);
      if (state?.type !== 'enum' || !state.allowedValues.includes(state.initialValue)
        || fingerprint([...state.allowedValues].sort()) !== fingerprint(items.map((x:Obj)=>x.value).sort())) fail('design.selection_state',node.nodeId);
      if (fingerprint(items.map((x:Obj)=>x.childNodeId).sort()) !== fingerprint(node.children.map((x:Obj)=>x.nodeId).sort())) fail('design.selection_children',node.nodeId);
    }
    const expected=componentChecks[kind];
    if (expected && !page.checks.some((c:Obj)=>c.type===expected && c.nodeId===node.nodeId)) fail('design.required_check',node.nodeId);
    if (!page.checks.some((c:Obj)=>c.type==='responsiveLayout' && c.nodeIds.includes(node.nodeId))) fail('design.required_check',node.nodeId);
    if (node.events && !page.checks.some((c:Obj)=>c.type==='keyboardAccess' && c.nodeIds.includes(node.nodeId))) fail('design.required_check',node.nodeId);
  }
  for (const state of states.values()) if (state.type==='enum' && !state.allowedValues.includes(state.initialValue)) fail('design.state_initial',state.stateId);
  for (const id of calculations.keys()) if (!usedCalculations.has(id)) fail('design.unused_calculation',id);
  const nodes=new Map(flat.map(n=>[n.nodeId,n]));
  for (const check of page.checks) {
    if (['responsiveLayout','keyboardAccess'].includes(check.type)) {
      for (const id of check.nodeIds) if (!nodes.has(id) || (check.type==='keyboardAccess' && !nodes.get(id)?.events)) fail('design.check_target',id);
    } else if (Object.values(componentChecks).includes(check.type) && componentChecks[nodes.get(check.nodeId)?.componentRef.id]!==check.type) fail('design.check_target',check.nodeId);
  }
}
