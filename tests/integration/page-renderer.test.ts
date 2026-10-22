import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { renderPageHtml } from '../../packages/page-renderer/src/index.ts';
import { createDemoOptions } from '../../scripts/render-preview-demo.ts';
import { previewMain } from '../../scripts/render-preview.ts';
import { registry, repoRoot } from '../helpers/fixtures.ts';
import { designFixture } from '../helpers/design-fixtures.ts';
import { fingerprint } from '../../packages/contracts/src/fingerprint.ts';
import { createImpeccableTrial } from '../../scripts/render-impeccable-trial.ts';
const options=()=>({...createDemoOptions(repoRoot),registry});
test('Impeccable trial preserves authoritative data and claim/source interaction coverage',()=>{
 const original=options(),trial=createImpeccableTrial(repoRoot);
 assert.equal(fingerprint(original.snapshot),fingerprint(trial.snapshot));
 const claimRefs=(value:any):string[]=>value&&typeof value==='object'?[...(value.kind==='claim'?[value.id+':'+(value.claimVersionId??'')]:[]),...Object.values(value).flatMap(claimRefs)]:[];
 assert.deepEqual(claimRefs(original.page).sort(),claimRefs(trial.page).sort());
 assert.equal(trial.page.actions.length,original.page.actions.length-1);
 assert.ok(trial.plan.omissions.some((x:any)=>x.sourceRefs.some((r:any)=>r.id==='asset_test')));
 const html=renderPageHtml({...trial,registry});
 assert.match(html,/参数对照/);assert.match(html,/50%/);assert.match(html,/data-component="section"/);assert.doesNotMatch(html,/data:image/);
});
test('renderer generates self-contained version-bound HTML from 1.1 without mutation',()=>{
 const o=options(),before=JSON.stringify(o.page),html=renderPageHtml(o);
 assert.ok(html.startsWith('<!doctype html>'));assert.match(html,/50%/);assert.match(html,/10 mm/);assert.match(html,/20 mm/);
 assert.match(html,/候选预览 · 未独立审查/);assert.match(html,/data:image\/png;base64,/);assert.match(html,/role="tab"/);assert.match(html,/<details /);
 assert.equal(JSON.stringify(o.page),before);assert.doesNotMatch(html,/<script[^>]+src=|<link[^>]+href=/);
 const script=html.match(/<script>([\s\S]*?)<\/script>/)![1];
 assert.ok(html.includes(createHash('sha256').update(script).digest('base64')));
});
test('renderer supports 1.0 and preserves numerical qualifiers',()=>{
 const f=designFixture(),html=renderPageHtml({...f,registry,evidenceExportIds:f.snapshot.evidence.map((e:any)=>e.evidenceId),themeValues:{space_section:'1rem',width_content:'100%'}});
 assert.match(html,/纯合成测试，不代表客户事实/);assert.match(html,/10 mm/);
});
test('renderer refuses stale or unauthorized design before producing HTML',()=>{
 const o=options();o.page.snapshotRef.snapshotVersionId='stale_version';assert.throws(()=>renderPageHtml(o),/invalid_page/);
});
test('renderer requires explicit excerpt export permission',()=>{
 const o=options();o.evidenceExportIds=[];assert.throws(()=>renderPageHtml(o),/evidence_export_denied/);
});
test('renderer omits unused evidence rather than embedding the whole snapshot',()=>{
 const o=options();o.snapshot.evidence.push({...o.snapshot.evidence[0],evidenceId:'evidence_unselected',excerpt:'UNSELECTED_PRIVATE_TEXT'});
 o.context.snapshotHash=fingerprint(o.snapshot);o.plan.snapshotRef.contentHash=o.context.snapshotHash;o.page.snapshotRef.contentHash=o.context.snapshotHash;o.page.informationPlanRef.contentHash=fingerprint(o.plan);
 assert.doesNotMatch(renderPageHtml(o),/UNSELECTED_PRIVATE_TEXT/);
});
test('renderer escapes model strings in HTML and evidence templates',()=>{
 const o=options();o.page.root.children[0].children.find((n:any)=>n.componentRef.id==='narrative').bindings.paragraphs[0].text='</script><img src=x onerror=alert(1)>';
 const html=renderPageHtml(o);assert.match(html,/&lt;\/script&gt;&lt;img/);assert.doesNotMatch(html,/<img src=x/);
});
test('renderer rejects dangerous theme values and mismatched image bytes',()=>{
 const o=options();o.themeValues.color_text='url(https://example.invalid)';assert.throws(()=>renderPageHtml(o),/invalid_theme_value/);
 const a=options();a.assets.resource_test=Buffer.from('changed');assert.throws(()=>renderPageHtml(a),/asset_bytes_unavailable/);
});
test('CLI writes an openable file and preserves an existing destination',()=>{
 const output=join(mkdtempSync(join(tmpdir(),'page-preview-')),'page.html');
 previewMain(['--demo',output]);assert.match(readFileSync(output,'utf8'),/<!doctype html>/);
 writeFileSync(output,'KEEP');assert.throws(()=>previewMain(['--demo',output]),/output_exists/);assert.equal(readFileSync(output,'utf8'),'KEEP');
});
