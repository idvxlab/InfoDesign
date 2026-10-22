import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DesignContext } from '../../contracts/src/design-checks.ts';
import { checkDesign } from '../../contracts/src/design-checks.ts';
import { percentChange } from '../../contracts/src/page-spec-extensions.ts';
import type { SchemaRegistry } from '../../contracts/src/schema-registry.ts';

type Obj = Record<string, any>;
export interface HtmlRenderOptions {
  plan: unknown; page: unknown; snapshot: unknown; registry: SchemaRegistry; context: DesignContext;
  /** Explicit service grant for the evidence excerpts embedded in an offline file. */
  evidenceExportIds: string[];
  themeValues: Record<string, string>;
  /** Resource IDs mapped to actual image bytes by the trusted caller, never the model. */
  assets?: Record<string, Uint8Array>;
}
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

export function renderPageHtml(options: HtmlRenderOptions): string {
  const result = checkDesign(options.plan, options.page, options.snapshot, options.registry, options.context);
  if (!result.ok) throw new Error('invalid_page:' + result.issues.map(i => i.code).join(','));
  const page = options.page as Obj, snapshot = options.snapshot as Obj, plan = options.plan as Obj;
  if (plan.openIssues.length) throw new Error('unresolved_plan_issues');
  const lookup = (kind: string, id: string): Obj => {
    const collection: Record<string, string> = {claim:'claims',entity:'entities',event:'events',relation:'relations',asset:'assets'};
    const record = snapshot[collection[kind]]?.find((r: Obj) => r[kind + 'Id'] === id);
    if (!record) throw new Error('missing_record');
    return record;
  };
  const grant = new Set(options.evidenceExportIds), evidence = new Map<string, Obj>();
  const value = (claim: Obj) => {
    const v = claim.value;
    return ['number','quantity'].includes(v.type) ? `${v.normalized}${v.unit ? ' ' + v.unit : ''}`
      : v.type === 'boolean' ? (v.value ? '是' : '否') : v.type === 'date' ? v.date : v.type === 'enum' ? v.option : v.text;
  };
  const qualifiers = (claim: Obj) => Object.values(claim.qualifiers ?? {}).map(v => typeof v === 'object' ? Object.values(v as Obj).join(' · ') : v).join(' · ');
  function source(refs: Obj[], label = '查看来源', calculation = ''): string {
    const ids: string[] = [];
    const details: string[] = [];
    for (const ref of refs) {
      const record = lookup(ref.kind,ref.id);
      details.push(ref.kind === 'claim' ? `${ref.id} / ${record.claimVersionId}：${value(record)}；${qualifiers(record)}` : `${ref.kind}：${ref.id}`);
      if (ref.kind === 'asset') {
        // Asset records carry a locator directly rather than evidenceRefs.
        const id='asset_source_'+record.assetId;
        if (!grant.has(record.assetId)) throw new Error('evidence_export_denied:' + record.assetId);
        evidence.set(id,{...record,evidenceId:id,locator:record.location,excerpt:record.description});ids.push(id);
      } else for (const id of record.evidenceRefs ?? []) {
        if (!grant.has(id)) throw new Error('evidence_export_denied:' + id);
        const entry=snapshot.evidence.find((e:Obj)=>e.evidenceId===id);
        if (!entry) throw new Error('missing_evidence');
        evidence.set(id,entry);ids.push(id);
      }
    }
    return `<button type="button" class="source" data-evidence="${escape([...new Set(ids)].join(' '))}" data-reference="${escape(details.join('\n') + (calculation ? '\n'+calculation : ''))}">${escape(label)}<span aria-hidden="true"> ↗</span></button>`;
  }
  function token(name: string, category: string): string {
    const v=options.themeValues[name];
    const valid=category==='color' ? /^#[0-9a-fA-F]{3,8}$/.test(v) && [4,5,7,9].includes(v.length)
      : category==='font' ? ['sans','serif','mono'].includes(v) : /^(0|[0-9]+(\.[0-9]+)?(px|rem|%))$/.test(v);
    if (!options.context.theme.tokens.includes(name) || !valid) throw new Error('invalid_theme_value:'+name);
    return category==='font' ? ({sans:'system-ui, sans-serif',serif:'Georgia, serif',mono:'monospace'}[v]!) : v;
  }
  let layoutIndex=0;
  const responsiveRules:string[]=[];
  function layout(l:Obj):string {
    if (!l) return '';
    const columns=l.type==='grid' ? `repeat(${l.columns},minmax(0,1fr))` : l.type==='split' ? l.ratio.split(':').map((x:string)=>x+'fr').join(' ') : 'minmax(0,1fr)';
    return `display:grid;grid-template-columns:${columns};gap:${token(l.gapToken,'length')};max-width:${token(l.widthToken,'length')};`;
  }
  function attrs(n:Obj):string {
    const s=n.style??{}, a=n.accessibility??{};
    let css=layout(n.layout);
    for(const [field,property,category]of [['colorToken','color','color'],['backgroundToken','background-color','color'],['paddingToken','padding','length'],['radiusToken','border-radius','length'],['typographyToken','font-family','font']]) if(s[field]) css+=`${property}:${token(s[field],category)};`;
    if(s.borderToken)css+=`border:1px solid ${token(s.borderToken,'color')};`;
    const className='node layout_'+layoutIndex++;
    if(n.responsiveLayout) {
      responsiveRules.push(`.${className.split(' ')[1]}{${layout(n.responsiveLayout.large)}}`, `@media(max-width:700px){.${className.split(' ')[1]}{${layout(n.responsiveLayout.small)}}}`);
      // Responsive rules own the root layout; avoid inline styles taking precedence.
      css=css.replace(/^display:grid;grid-template-columns:[^;]+;gap:[^;]+;max-width:[^;]+;/,'');
    }
    return `id="render-node-${escape(n.nodeId)}" class="${className}" data-node-id="${escape(n.nodeId)}" data-component="${escape(n.componentRef.id)}" style="${escape(css)}"${a.label?' aria-label="'+escape(a.label)+'"':''}${a.description?' aria-description="'+escape(a.description)+'"':''}${a.role?' role="'+escape(a.role)+'"':''}`;
  }
  const heading=(n:Obj)=>n.props.title?`<h${n.props.headingLevel??2}>${escape(n.props.title)}</h${n.props.headingLevel??2}>`:'';
  const states=new Map(page.state.map((s:Obj)=>[s.stateId,s.initialValue]));
  function node(n:Obj):string {
    const kind=n.componentRef.id, at=attrs(n);
    const children=()=>n.children.map(node).join('');
    if(n.componentRef.version!=='0.1.0')throw new Error('unsupported_component_version');
    if(kind==='page'||kind==='section')return `<${kind==='page'?'main':'section'} ${at}>${heading(n)}${children()}</${kind==='page'?'main':'section'}>`;
    if(kind==='fact_text') {const claim=lookup('claim',n.bindings.body.claimRef.id);return `<section ${at}>${heading(n)}<p class="fact">${escape(value(claim))}</p><p class="qualifiers">${escape(qualifiers(claim))}</p>${source([n.bindings.body.claimRef])}</section>`;}
    if(kind==='narrative')return `<section ${at}>${heading(n)}${n.bindings.paragraphs.map((p:Obj)=>`<div class="paragraph"><p>${escape(p.text)}</p>${source(p.sourceRefs)}</div>`).join('')}</section>`;
    if(kind==='comparison_matrix') {
      const rows=n.bindings.rows;
      return `<section ${at}>${heading(n)}<div class="table-wrap"><table><thead><tr><th scope="col">对象</th>${rows.columns.map((c:Obj)=>`<th scope="col">${escape(c.label)}</th>`).join('')}</tr></thead><tbody>${rows.items.map((row:Obj)=>`<tr><th scope="row">${escape(lookup('entity',row.entityRef.id).label)}</th>${rows.columns.map((column:Obj)=>{const cell=row.cells.find((c:Obj)=>c.columnId===column.columnId);if(!cell)return `<td data-label="${escape(column.label)}">${escape(n.props.missingValueLabel)}</td>`;const claim=lookup('claim',cell.claimRef.id);return `<td data-label="${escape(column.label)}"><strong>${escape(value(claim))}</strong><small>${escape(qualifiers(claim))}</small>${source([cell.claimRef])}</td>`;}).join('')}</tr>`).join('')}</tbody></table></div></section>`;
    }
    if(kind==='disclosure')return `<details ${at} data-boolean-state="${escape(n.bindings.expanded.stateId)}"${states.get(n.bindings.expanded.stateId)?' open':''}><summary>${escape(n.props.title)}<span class="when-closed">${escape(n.props.expandLabel)}</span><span class="when-open">${escape(n.props.collapseLabel)}</span></summary><div class="details-body">${children()}</div></details>`;
    if(kind==='timeline')return `<section ${at}>${heading(n)}<ol class="timeline">${n.bindings.items.map((item:Obj)=>{const event=lookup('event',item.eventRef.id);return `<li><time>${escape(event.time?.asOf??event.time?.year??event.time?.period??'时间未提供')}</time><p>${escape(event.description)}</p>${source([item.eventRef])}</li>`;}).join('')}</ol></section>`;
    if(kind==='relation_graph')return `<section ${at}>${heading(n)}<div class="relations" data-direction="${escape(n.props.direction)}">${n.bindings.edges.map((edge:Obj)=>{const r=lookup('relation',edge.relationRef.id);return `<div class="relation"><strong>${escape(lookup('entity',r.fromEntityId).label)}</strong><span class="edge">${escape(r.relationType)} →</span><strong>${escape(lookup('entity',r.toEntityId).label)}</strong>${source([edge.relationRef])}</div>`;}).join('')}</div></section>`;
    if(kind==='bar_chart') {
      const points=n.bindings.points.map((p:Obj)=>({...p,claim:lookup('claim',p.claimRef.id)}));
      if(points.some((p:Obj)=>p.claim.value.normalized<0))throw new Error('bar_chart_negative_not_supported');
      const max=Math.max(1,...points.map((p:Obj)=>p.claim.value.normalized));
      return `<section ${at}>${heading(n)}<div class="chart">${points.map((p:Obj)=>`<div class="chart-row"><span>${escape(lookup('entity',p.claim.entityId).label)}</span><div class="bar-track"><div class="bar" style="width:${p.claim.value.normalized/max*100}%"></div></div><strong>${escape(value(p.claim))}</strong>${source([p.claimRef])}<small>${escape(qualifiers(p.claim))}</small></div>`).join('')}</div></section>`;
    }
    if(kind==='asset_image') {
      const r=options.context.resources?.assets.find(a=>a.assetId===n.bindings.asset.id), bytes=r&&options.assets?.[r.resourceId];
      if(!r||!bytes||bytes.length>5_000_000||'sha256:'+digest(bytes)!==r.contentHash)throw new Error('asset_bytes_unavailable_or_mismatched');
      const b=Buffer.from(bytes);
      const valid=r.mediaType==='image/png'?b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):r.mediaType==='image/jpeg'?b[0]===255&&b[1]===216&&b[2]===255:b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP';
      if(!valid)throw new Error('asset_media_type_mismatch');
      return `<figure ${at}><img src="data:${r.mediaType};base64,${b.toString('base64')}" alt="${escape(n.props.alt)}" style="object-fit:${n.props.fit}"><figcaption>${source([n.bindings.asset])}</figcaption></figure>`;
    }
    if(kind==='derived_value') {
      const c=page.calculations.find((c:Obj)=>c.calculationId===n.bindings.derived.calculationId), a=lookup('claim',c.base.id),b=lookup('claim',c.current.id),v=percentChange(a.value.normalized,b.value.normalized);
      const formula=`(${b.value.normalized} - ${a.value.normalized}) / ${a.value.normalized} × 100 = ${v}%`;
      return `<section ${at}><h2>${escape(n.props.label)}</h2><p class="metric">${escape(Number(v.toFixed(4)))}%</p><p>基期 ${escape(value(a))} → 本期 ${escape(value(b))}</p><small>${escape(formula)}</small>${source([c.base,c.current],'查看计算依据',formula)}</section>`;
    }
    if(kind==='tabs') {
      const selected=states.get(n.bindings.selected.stateId), items=n.bindings.items;
      return `<section ${at} data-tabs data-enum-state="${escape(n.bindings.selected.stateId)}">${heading(n)}<div role="tablist" aria-label="${escape(n.props.title)}">${items.map((item:Obj)=>`<button type="button" role="tab" data-state-value="${escape(item.value)}" id="render-tab-${escape(item.childNodeId)}" aria-controls="render-panel-${escape(item.childNodeId)}" aria-selected="${item.value===selected}" tabindex="${item.value===selected?0:-1}">${escape(item.label)}</button>`).join('')}</div>${items.map((item:Obj)=>`<div role="tabpanel" id="render-panel-${escape(item.childNodeId)}" aria-labelledby="render-tab-${escape(item.childNodeId)}"${item.value===selected?'':' hidden'}>${node(n.children.find((c:Obj)=>c.nodeId===item.childNodeId))}</div>`).join('')}</section>`;
    }
    throw new Error('component_not_implemented:'+kind);
  }
  const body=node(page.root);
  const templates=[...evidence].map(([id,e])=>`<template id="evidence-template-${escape(id)}"><article><h3>原始资料摘录</h3><p class="source-meta">${escape(e.documentId)} · ${escape(e.documentVersionId)} · ${escape(e.blockId)}</p><pre>${escape(JSON.stringify(e.locator,null,2))}</pre><blockquote>${escape(e.excerpt)}</blockquote></article></template>`).join('');
  const script=readFileSync(new URL('./preview-client.js',import.meta.url),'utf8');
  const css=readFileSync(new URL('./preview.css',import.meta.url),'utf8');
  const hash=createHash('sha256').update(script).digest('base64');
  const policy=`default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'; connect-src 'none'`;
  return `<!doctype html><html lang="${escape(page.root.props.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escape(policy)}"><title>${escape(plan.goal)}</title><style>${css}\n${responsiveRules.join('\n')}</style></head><body><header class="page-header"><span class="brand">InfoDesign / PREVIEW</span><span class="status">候选预览 · 未独立审查</span><h1>${escape(plan.goal)}</h1><p>${escape(plan.audience.role)}</p><small>页面 ${escape(page.pageSpecVersionId)} · 事实 ${escape(page.snapshotRef.snapshotVersionId)}</small></header>${body}<footer>离线预览 · 来源摘录随文件保存，仅含获准导出的已展示依据。</footer><dialog id="evidence-dialog" aria-labelledby="evidence-title"><div class="dialog-head"><h2 id="evidence-title">来源与依据</h2><button type="button" id="close-evidence" aria-label="关闭来源">关闭</button></div><pre id="source-reference"></pre><div id="evidence-content"></div><p class="qualifiers">此处展示固定版本摘录及位置；完整原文附件未包含在本预览中。</p></dialog>${templates}<script>${script}</script></body></html>`;
}
