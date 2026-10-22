/** Synthetic fixtures only: resource/component grants do not establish deployed implementations. */
import { designFixture } from './design-fixtures.ts';
import { fingerprint } from '../../packages/contracts/src/fingerprint.ts';
import type { DesignInput } from '../../packages/contracts/generated/index.ts';
export function extendedPageFixture() {
  const f=designFixture(), {page,plan,snapshot,context}=f;
  page.protocolVersion='1.1'; context.pageSpecVersion='1.1';page.calculations=[];
  const source=snapshot.evidence[0];
  snapshot.events=[{eventId:'event_start',entityId:snapshot.entities[0].entityId,eventType:'established',description:'合成事件',time:{year:2020},evidenceRefs:[source.evidenceId]}];
  snapshot.relations=[{relationId:'relation_test',fromEntityId:snapshot.entities[0].entityId,toEntityId:snapshot.entities[1].entityId,relationType:'provides',evidenceRefs:[source.evidenceId]}];
  snapshot.assets=[{assetId:'asset_test',documentId:source.documentId,documentVersionId:source.documentVersionId,blockId:source.blockId,location:source.locator,description:'合成图片'}];
  context.resources={assets:[{assetId:'asset_test',documentId:source.documentId,documentVersionId:source.documentVersionId,blockId:source.blockId,resourceId:'resource_test',mediaType:'image/png',contentHash:'sha256:'+'a'.repeat(64)}]};
  for(const [kind,id] of [['event','event_start'],['relation','relation_test'],['asset','asset_test']]) {
    const ref={kind,id};context.allowedSources.push(ref);plan.sections[0].sourceRefs.push(ref);
  }
  const claim=(id:string)=>({kind:'claim',id,claimVersionId:id+'_v1'});
  const oldClaim=structuredClone(snapshot.claims[1]);oldClaim.claimId='claim_old';oldClaim.claimVersionId='claim_old_v1';oldClaim.qualifiers={basis:'年度末同口径',time:{year:2020}};
  const newClaim=structuredClone(oldClaim);newClaim.claimId='claim_new';newClaim.claimVersionId='claim_new_v1';newClaim.value.normalized=15;newClaim.qualifiers.time.year=2021;
  snapshot.claims.push(oldClaim,newClaim);
  for(const c of [oldClaim,newClaim]) {context.allowedSources.push({kind:'claim',id:c.claimId});plan.sections[0].sourceRefs.push({kind:'claim',id:c.claimId});}
  page.calculations=[{calculationId:'calc_growth',method:'percentChange',base:claim('claim_old'),current:claim('claim_new'),unit:'%'}];
  const make=(id:string,kind:string,props:any,bindings:any)=>({nodeId:id,planSectionId:plan.sections[0].sectionId,componentRef:{id:kind,version:'0.1.0'},props,bindings,events:{sourceRequested:'action_'+id}});
  const heading={title:'合成内容',headingLevel:2};
  const added=[
    make('node_summary','narrative',heading,{paragraphs:[{paragraphId:'paragraph_test',text:'仅用于测试的资料概括',sourceRefs:[claim('claim_business_placeholder')]}]}),
    make('node_image','asset_image',{alt:'合成图片',fit:'contain'},{asset:{kind:'asset',id:'asset_test'}}),
    make('node_timeline','timeline',{...heading,order:'ascending',missingTime:'separate'},{items:[{itemId:'item_start',eventRef:{kind:'event',id:'event_start'}}]}),
    make('node_relations','relation_graph',{...heading,direction:'leftToRight'},{edges:[{edgeId:'edge_test',relationRef:{kind:'relation',id:'relation_test'}}]}),
    make('node_derived','derived_value',{label:'相对变化率'},{derived:{calculationId:'calc_growth',showInputs:true}}),
  ];
  const slots=['paragraphs','asset','items','edges','derived'];
  const checks=['semanticFidelity','assetAvailable','timelineOrder','relationIntegrity','derivedInputs'];
  for(let i=0;i<added.length;i++) {page.actions.push({actionId:'action_'+added[i].nodeId,type:'openEvidence',sourceNodeId:added[i].nodeId,target:{kind:'eventBoundSource',bindingSlot:slots[i]}});page.checks.push({type:checks[i],nodeId:added[i].nodeId});}
  page.root.children.splice(1,0,...added);
  const chart=make('node_chart','bar_chart',{...heading,baseline:'zero',missingValue:'omit'},{points:[{pointId:'point_a',claimRef:claim('claim_parameter_a_placeholder')},{pointId:'point_b',claimRef:claim('claim_parameter_b_placeholder')}]});
  chart.planSectionId=plan.sections[1].sectionId;
  page.root.children.splice(page.root.children.length-1,0,chart);
  page.actions.push({actionId:'action_node_chart',type:'openEvidence',sourceNodeId:'node_chart',target:{kind:'eventBoundSource',bindingSlot:'points'}});
  page.checks.push({type:'chartComparability',nodeId:'node_chart'});
  const details=page.root.children.pop();
  const tabs={nodeId:'node_tabs',planSectionId:plan.sections[2].sectionId,componentRef:{id:'tabs',version:'0.1.0'},props:heading,bindings:{selected:{kind:'state',stateId:'state_tab'},items:[{value:'tab_service',label:'服务',childNodeId:details.nodeId}]},events:{selectionRequested:'action_select'},children:[details]};
  page.root.children.push(tabs);page.state.push({stateId:'state_tab',type:'enum',allowedValues:['tab_service'],initialValue:'tab_service'});
  page.actions.push({actionId:'action_select',type:'selectValue',sourceNodeId:'node_tabs',targetStateId:'state_tab',valueFrom:'event.value'});
  page.checks.push({type:'selectionRoundTrip',nodeId:'node_tabs'});
  const first=page.root.children.splice(0,6);
  page.root.children.unshift({nodeId:'node_section',planSectionId:plan.sections[0].sectionId,componentRef:{id:'section',version:'0.1.0'},props:heading,bindings:{},layout:{type:'grid',columns:2,gapToken:'space_section',widthToken:'width_content'},children:first});
  page.root.style={colorToken:'color_text',typographyToken:'type_body'};page.root.accessibility={label:'合成页面'};
  page.root.responsiveLayout={small:{type:'stack',gapToken:'space_section',widthToken:'width_content'},large:{type:'split',ratio:'1:2',gapToken:'space_section',widthToken:'width_content'}};
  context.theme.tokens.push('color_text','type_body');
  for(const id of ['section','narrative','asset_image','timeline','relation_graph','bar_chart','tabs','derived_value'])context.catalog.components.push({id,version:'0.1.0'});
  const flat:any[]=[];function walk(n:any){flat.push(n);n.children?.forEach(walk);}walk(page.root);
  page.checks.push({type:'evidenceResolvable',nodeIds:[...added.map(n=>n.nodeId),'node_chart']},
    {type:'responsiveLayout',nodeIds:flat.map(n=>n.nodeId),viewports:['small','large']},
    {type:'keyboardAccess',nodeIds:flat.filter(n=>n.events).map(n=>n.nodeId)});
  refreshExtendedFixture(f);return f;
}
export function refreshExtendedFixture(f:ReturnType<typeof designFixture>) {
  f.context.snapshotHash=fingerprint(f.snapshot);f.page.snapshotRef.contentHash=f.context.snapshotHash;f.plan.snapshotRef.contentHash=f.context.snapshotHash;
  f.page.informationPlanRef.contentHash=fingerprint(f.plan);
  f.context.catalog.contentHash=fingerprint(f.context.catalog.components);f.page.componentCatalogRef.contentHash=f.context.catalog.contentHash;
  f.context.theme.contentHash=fingerprint(f.context.theme.tokens);f.page.themeRef.contentHash=f.context.theme.contentHash;
}
export function findPageNode(f:ReturnType<typeof designFixture>,id:string):any {
  const stack=[f.page.root];while(stack.length){const n=stack.pop();if(n.nodeId===id)return n;stack.push(...(n.children??[]));}throw new Error('missing test node');
}
export function extendedDesignTaskFixture() {
  const f=extendedPageFixture();
  const input={protocolVersion:'1.0' as const,projectId:f.context.projectId,taskId:f.context.taskId,attemptId:f.context.attemptId,
    taskType:'generate' as const,snapshot:f.snapshot,snapshotRef:f.plan.snapshotRef,audience:f.plan.audience,goal:f.plan.goal,visualGuidance:[],
    constraints:{language:'zh-CN' as const,maxSections:10,maxNodes:50},catalog:f.context.catalog,theme:f.context.theme,resources:f.context.resources,pageSpecVersion:'1.1' as const};
  const pick=(obj:any,keys:string[])=>Object.fromEntries(keys.map(k=>[k,structuredClone(obj[k])]));
  return {...f,input: input as unknown as DesignInput,trusted:{inputHash:fingerprint(input),design:f.context},draft:{status:'completed',
    informationPlan:pick(f.plan,['audience','goal','readerQuestions','sections','omissions','openIssues']),
    pageSpec:pick(f.page,['state','root','actions','checks','calculations'])}};
}
