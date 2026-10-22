import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registry } from '../helpers/fixtures.ts';
import { extendedPageFixture, refreshExtendedFixture, findPageNode } from '../helpers/pagespec-fixtures.ts';
import { checkDesign } from '../../packages/contracts/src/design-checks.ts';
import { checkDesignInput, checkDesignOutput } from '../../packages/contracts/src/design-agent-checks.ts';
import { percentChange } from '../../packages/contracts/src/page-spec-extensions.ts';
import { fingerprint } from '../../packages/contracts/src/fingerprint.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../helpers/fixtures.ts';
type Fixture=ReturnType<typeof extendedPageFixture>;
const check=(f:Fixture)=>checkDesign(f.plan,f.page,f.snapshot,registry,f.context);
test('PageSpec 1.1 supports composed content, responsive design, source bindings and state without mutating input',()=>{
  const f=extendedPageFixture(),before=JSON.stringify(f);assert.deepEqual(check(f),{ok:true,issues:[]});assert.equal(JSON.stringify(f),before);
});
const cases:Array<[string,(f:Fixture)=>void,string]>=[
 ['legacy version rejects new nodes',f=>{f.page.protocolVersion='1.0';},'schema.page-spec'],
 ['service has not enabled 1.1',f=>{delete f.context.pageSpecVersion;},'design.page_protocol'],
 ['missing responsive declaration',f=>{delete f.page.root.responsiveLayout;},'schema.page-spec'],
 ['unknown color token',f=>{f.page.root.style.colorToken='absent_token';},'design.theme_token'],
 ['unavailable component',f=>{f.context.catalog.components=f.context.catalog.components.filter(c=>c.id!=='timeline');},'design.component_unavailable'],
 ['raw CSS',f=>{f.page.root.style.css='position:fixed';},'schema.page-spec'],
 ['unbound paragraph',f=>{findPageNode(f,'node_summary').bindings.paragraphs[0].sourceRefs=[];},'schema.page-spec'],
 ['invented paragraph evidence',f=>{findPageNode(f,'node_summary').bindings.paragraphs[0].sourceRefs[0].id='claim_missing';},'design.source_missing'],
 ['unsupported narrative claim',f=>{f.snapshot.claims[0].supportStatus='conflicted';},'design.claim_not_usable'],
 ['no asset service grant',f=>{delete f.context.resources;},'design.asset_unavailable'],
 ['malformed asset service grant',f=>{(f.context as any).resources={assets:{}};},'design.context_invalid'],
 ['stale asset document',f=>{f.context.resources!.assets[0].documentVersionId='version_other';},'design.asset_unavailable'],
 ['model asset URL',f=>{findPageNode(f,'node_image').props.url='https://example.invalid/a.png';},'schema.page-spec'],
 ['missing event evidence',f=>{f.snapshot.events[0].evidenceRefs=['evidence_absent'];},'design.evidence_missing'],
 ['forbidden relation endpoint',f=>{f.context.allowedSources=f.context.allowedSources.filter(r=>r.id!=='entity_company_test');},'design.entity_forbidden'],
 ['missing relation endpoint',f=>{f.snapshot.relations[0].toEntityId='entity_missing';},'design.entity_forbidden'],
 ['unapproved event',f=>{f.context.allowedSources=f.context.allowedSources.filter(r=>r.kind!=='event');},'design.source_forbidden'],
 ['mixed chart units',f=>{f.snapshot.claims[2].value.unit='kg';},'design.chart_incomparable'],
 ['mixed chart periods',f=>{f.snapshot.claims[2].qualifiers.time={year:2021};},'design.chart_incomparable'],
 ['invented chart number',f=>{findPageNode(f,'node_chart').bindings.points[0].value=99;},'schema.page-spec'],
 ['wrong source slot',f=>{f.page.actions.find((a:any)=>a.sourceNodeId==='node_chart').target.bindingSlot='asset';},'design.source_target'],
 ['enum outside allowed values',f=>{f.page.state[1].initialValue='tab_missing';},'design.selection_state'],
 ['tab points outside children',f=>{findPageNode(f,'node_tabs').bindings.items[0].childNodeId='node_chart';},'design.selection_children'],
 ['wrong action state',f=>{f.page.actions.find((a:any)=>a.type==='selectValue').targetStateId='state_service_expanded';},'design.selection_action'],
 ['boolean component bound to enum',f=>{findPageNode(f,'node_services').bindings.expanded.stateId='state_tab';},'design.state_missing'],
 ['arbitrary calculation',f=>{f.page.calculations[0].method='eval';},'schema.page-spec'],
 ['forged calculation result',f=>{f.page.calculations[0].result=50;},'schema.page-spec'],
 ['missing calculation',f=>{f.page.calculations=[];},'design.calculation_missing'],
 ['zero denominator',f=>{f.snapshot.claims.find((c:any)=>c.claimId==='claim_old').value.normalized=0;},'design.calculation_domain'],
 ['different calculation subject',f=>{f.snapshot.claims.find((c:any)=>c.claimId==='claim_new').entityId='entity_company_test';},'design.calculation_incomparable'],
 ['reversed calculation years',f=>{f.snapshot.claims.find((c:any)=>c.claimId==='claim_new').qualifiers.time.year=2019;},'design.calculation_incomparable'],
 ['missing semantic check',f=>{f.page.checks=f.page.checks.filter((c:any)=>c.type!=='semanticFidelity');},'design.required_check'],
 ['missing keyboard check',f=>{f.page.checks=f.page.checks.filter((c:any)=>c.type!=='keyboardAccess');},'design.required_check'],
 ['check uses unrelated component',f=>{f.page.checks.find((c:any)=>c.type==='assetAvailable').nodeId='node_chart';},'design.check_target'],
 ['check claims passed',f=>{f.page.checks[0].status='passed';},'schema.page-spec'],
];
for(const [name,mutate,code]of cases)test('PageSpec 1.1 rejects '+name,()=>{const f=extendedPageFixture();mutate(f);refreshExtendedFixture(f);const r=check(f);assert.equal(r.ok,false);assert.ok(r.issues.some(i=>i.code===code),JSON.stringify(r));});
test('PageSpec 1.1 checks actual chronological order',()=>{
 const f=extendedPageFixture();const event={...f.snapshot.events[0],eventId:'event_earlier',time:{year:2019}};f.snapshot.events.push(event);f.context.allowedSources.push({kind:'event',id:event.eventId});f.plan.sections[0].sourceRefs.push({kind:'event',id:event.eventId});
 const items=findPageNode(f,'node_timeline').bindings.items;items.push({itemId:'item_earlier',eventRef:{kind:'event',id:event.eventId}});refreshExtendedFixture(f);
 assert.ok(check(f).issues.some(i=>i.code==='design.timeline_order'));items.reverse();assert.deepEqual(check(f),{ok:true,issues:[]});
});
test('registered calculation computes from inputs and rejects invalid numeric domain',()=>{
 assert.equal(percentChange(40,60),50);assert.equal(percentChange(40,20),-50);
 for(const [a,b]of [[0,1],[-1,1],[Infinity,1],[1,NaN],[Number.MIN_VALUE,Number.MAX_VALUE]])assert.throws(()=>percentChange(a,b));
});
test('extended input and output require identical trusted resource grants and negotiated version',()=>{
 const f=extendedPageFixture();const input={protocolVersion:'1.0',projectId:f.context.projectId,taskId:f.context.taskId,attemptId:f.context.attemptId,taskType:'generate',snapshot:f.snapshot,snapshotRef:f.plan.snapshotRef,audience:f.plan.audience,goal:f.plan.goal,visualGuidance:[],constraints:{language:'zh-CN',maxSections:10,maxNodes:50},catalog:f.context.catalog,theme:f.context.theme,resources:structuredClone(f.context.resources),pageSpecVersion:'1.1'};
 const trusted={inputHash:fingerprint(input),design:f.context};const output={protocolVersion:'1.0',projectId:input.projectId,taskId:input.taskId,attemptId:input.attemptId,inputHash:trusted.inputHash,status:'completed',informationPlan:f.plan,pageSpec:f.page,producedBy:{role:'design',protocolVersion:'1.0'}};
 assert.deepEqual(checkDesignOutput(output,input,registry,trusted),{ok:true,issues:[]});input.resources!.assets[0].resourceId='resource_other';trusted.inputHash=fingerprint(input);
 assert.ok(checkDesignInput(input,registry,trusted).issues.some(i=>i.code==='design.resources_mismatch'));
});
test('checked-in 1.1 examples are complete, version-bound and valid without fixture repair',()=>{
 const read=(name:string)=>JSON.parse(readFileSync(join(repoRoot,'docs/examples/design-contracts-v1.1',name+'.json'),'utf8'));
 const input=read('design-input'),trusted=read('trusted-context'),plan=read('information-plan'),page=read('page-spec');
 assert.deepEqual(checkDesignInput(input,registry,trusted),{ok:true,issues:[]});
 assert.deepEqual(checkDesign(plan,page,input.snapshot,registry,trusted.design),{ok:true,issues:[]});
});
