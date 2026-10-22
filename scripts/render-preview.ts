/** Offline local preview, not a production authorization or publication endpoint. */
import { readFileSync, writeFileSync, mkdirSync, linkSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { renderPageHtml } from '../packages/page-renderer/src/index.ts';
import { loadSchemasFromDir } from '../packages/contracts/src/schema-registry.ts';
import { createDemoOptions } from './render-preview-demo.ts';
import { createImpeccableTrial } from './render-impeccable-trial.ts';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function previewMain(args:string[]) {
  const demo=args[0]==='--demo';
  const trial=args[0]==='--impeccable-demo';
  if (args.length!==2) throw new Error('Usage: node scripts/render-preview.ts --demo|--impeccable-demo OUTPUT.html | LOCAL_BUNDLE.json OUTPUT.html');
  const output=resolve(args[1]);
  if(existsSync(output))throw new Error('output_exists_choose_new_path');
  const registry=loadSchemasFromDir(resolve(root,'packages/contracts/schemas'));
  const options=trial?createImpeccableTrial(root):demo?createDemoOptions(root):JSON.parse(readFileSync(resolve(args[0]),'utf8'));
  // Assets in local bundles use base64 bytes. No model paths, URLs or executable code.
  const assets:Record<string,Uint8Array>={};
  for(const [id,bytes]of Object.entries(options.assetBase64??{})) {
    if(typeof bytes!=='string'||! /^[A-Za-z0-9+/]*={0,2}$/.test(bytes)||bytes.length>7_000_000)throw new Error('invalid_asset_base64');
    assets[id]=Buffer.from(bytes,'base64');
  }
  const html=renderPageHtml({...options,registry,assets:demo||trial?options.assets:assets});
  mkdirSync(dirname(output),{recursive:true});
  const temp=output+'.'+randomUUID()+'.tmp';
  writeFileSync(temp,html,{flag:'wx'});
  try { linkSync(temp,output); } finally { unlinkSync(temp); }
  return output;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const output=previewMain(process.argv.slice(2));
    console.log('Generated '+output);
  } catch(error) { console.error(error instanceof Error?error.message:'preview_failed');process.exitCode=1; }
}
