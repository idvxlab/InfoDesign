/** Explicitly synthetic demo, without invoking any model. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
export function createDemoOptions(root:string) {
  const read=(name:string)=>JSON.parse(readFileSync(resolve(root,'docs/examples/design-contracts-v1.1',name+'.json'),'utf8'));
  const input=read('design-input'),context=read('trusted-context').design;
  // A real, tiny PNG fixture used solely to verify offline byte embedding.
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=','base64');
  context.resources.assets[0].contentHash='sha256:'+createHash('sha256').update(bytes).digest('hex');
  const page=read('page-spec');
  const tabs=page.root.children.find((n:any)=>n.componentRef.id==='tabs');
  const detail=structuredClone(tabs.children[0].children[0]);detail.nodeId='node_service_compare';detail.events.sourceRequested='action_service_compare';
  tabs.children.push(detail);tabs.bindings.items.push({value:'tab_compare',label:'服务摘要',childNodeId:detail.nodeId});
  page.state.find((s:any)=>s.stateId==='state_tab').allowedValues.push('tab_compare');
  page.actions.push({actionId:'action_service_compare',type:'openEvidence',sourceNodeId:detail.nodeId,target:detail.bindings.body.claimRef});
  page.checks.push({type:'evidenceResolvable',nodeIds:[detail.nodeId]});
  page.checks.find((c:any)=>c.type==='keyboardAccess').nodeIds.push(detail.nodeId);
  page.checks.find((c:any)=>c.type==='responsiveLayout').nodeIds.push(detail.nodeId);
  return {plan:read('information-plan'),page,snapshot:input.snapshot,context,
    evidenceExportIds:[...input.snapshot.evidence.map((e:any)=>e.evidenceId),...input.snapshot.assets.map((a:any)=>a.assetId)],
    themeValues:{space_section:'1.25rem',width_content:'1200px',color_text:'#182c38',type_body:'sans'},
    assets:{resource_test:bytes}};
}
