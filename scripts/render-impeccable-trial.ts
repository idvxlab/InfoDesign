/** Human-authored trial using adapted Impeccable principles, not a model invocation. */
import { createDemoOptions } from './render-preview-demo.ts';
import { fingerprint } from '../packages/contracts/src/fingerprint.ts';
export function createImpeccableTrial(root:string) {
  const o=createDemoOptions(root),{page,plan}=o;
  page.root.responsiveLayout.large={type:'stack',gapToken:'space_section',widthToken:'width_content'};
  page.root.layout={type:'stack',gapToken:'space_section',widthToken:'width_content'};
  const group=page.root.children[0];
  group.layout={type:'stack',gapToken:'space_section',widthToken:'width_content'};
  group.props.title='业务与能力';
  for(const n of group.children) {
    if(n.componentRef.id==='fact_text'&&n.props.headingLevel===1)n.props.headingLevel=2;
    if(n.componentRef.id==='narrative')n.props.title='资料摘要';
    if(n.componentRef.id==='timeline')n.props.title='关键事件';
    if(n.componentRef.id==='relation_graph')n.props.title='业务关联';
  }
  group.children=group.children.filter((n:any)=>n.componentRef.id!=='asset_image');
  const assetRef=plan.sections[0].sourceRefs.find((r:any)=>r.kind==='asset');
  plan.sections[0].sourceRefs=plan.sections[0].sourceRefs.filter((r:any)=>r.kind!=='asset');
  plan.omissions.push({sourceRefs:[assetRef],reason:'1px 合成图片仅用于字节测试，不作为展示素材'});
  page.actions=page.actions.filter((a:any)=>a.sourceNodeId!=='node_image');
  page.checks=page.checks.filter((c:any)=>c.nodeId!=='node_image');
  for(const c of page.checks)if(c.nodeIds)c.nodeIds=c.nodeIds.filter((id:string)=>id!=='node_image');
  page.root.children.find((n:any)=>n.componentRef.id==='bar_chart').props.title='参数对照';
  page.root.children.find((n:any)=>n.componentRef.id==='tabs').props.title='服务信息';
  page.informationPlanRef.contentHash=fingerprint(plan);
  o.themeValues={space_section:'2rem',width_content:'1120px',color_text:'#182733',type_body:'sans'};
  return o;
}
