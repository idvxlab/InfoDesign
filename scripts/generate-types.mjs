#!/usr/bin/env node
/**
 * 从权威 Schema 生成 TypeScript 类型与清单。
 * 生成文件位于 packages/contracts/generated/，不手工修改。
 * 用法：node scripts/generate-types.mjs [--check]
 *   --check：只比较生成结果与已提交文件是否一致，不写盘。
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const schemasDir = join(root, 'packages/contracts/schemas');
const outDir = join(root, 'packages/contracts/generated');
const checkOnly = process.argv.includes('--check');

function pascal(value) {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function findSchemaFiles(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...findSchemaFiles(full));
    else if (name.endsWith('.schema.json')) found.push(full);
  }
  return found.sort();
}

const schemaFiles = findSchemaFiles(schemasDir);
const byId = new Map();
const byBase = new Map();
for (const file of schemaFiles) {
  const schema = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof schema.$id !== 'string' || schema.$id.length === 0) {
    throw new Error(`Schema 缺少 $id，无法生成类型：${file}`);
  }
  if (byId.has(schema.$id)) throw new Error(`Schema $id 重复：${schema.$id}`);
  const rel = relative(schemasDir, file).replace(/\.schema\.json$/, '');
  const base = rel.split('/').pop();
  if (byBase.has(base)) throw new Error(`生成文件名重复：${base}`);
  const entry = { file, schema, base, typeName: pascal(base) };
  byId.set(schema.$id, entry);
  byBase.set(base, entry);
}

/** 本地 $defs 类型名：<SchemaType><DefName>；common 用 Common<DefName>。 */
function defTypeName(entry, defName) {
  return `${entry.typeName}${pascal(defName)}`;
}

/** 解析 $ref，返回目标 entry 与目标类型名。 */
function refInfo(ref, ctx) {
  const hashIndex = ref.indexOf('#');
  const baseId = hashIndex === -1 ? ref : ref.slice(0, hashIndex);
  const pointer = hashIndex === -1 ? '' : ref.slice(hashIndex + 1);
  const target = baseId === '' || baseId === ctx.entry.schema.$id ? ctx.entry : byId.get(baseId);
  if (!target) return undefined;
  if (pointer.startsWith('/$defs/')) {
    const defName = pointer.slice('/$defs/'.length);
    return { target, typeName: defTypeName(target, defName) };
  }
  return { target, typeName: target.typeName };
}

function isIdentifier(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

function propertyKey(name) {
  return isIdentifier(name) ? name : JSON.stringify(name);
}

function unionTypes(schemas, ctx) {
  const rendered = schemas.map((s) => renderType(s, ctx));
  return [...new Set(rendered)].join(' | ');
}

function structuralType(schema, ctx) {
  if (typeof schema.$ref === 'string') {
    const info = refInfo(schema.$ref, ctx);
    if (!info) return 'unknown';
    if (info.target.base !== ctx.entry.base) ctx.imports.add(info.target.base);
    return info.typeName;
  }
  if (Array.isArray(schema.enum)) {
    return [...new Set(schema.enum.map((v) => JSON.stringify(v)))].join(' | ');
  }
  if ('const' in schema) return JSON.stringify(schema.const);
  if (schema.type === 'array' || schema.items !== undefined) {
    return `Array<${renderType(schema.items, ctx)}>`;
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const nonObject = types.filter((t) => t !== 'object');
  if (types.length > 0 && nonObject.length === types.length) {
    const mapped = nonObject.map((t) => (t === 'integer' ? 'number' : t));
    return [...new Set(mapped)].join(' | ');
  }
  if (schema.properties !== undefined || types.includes('object')) {
    if (schema.properties === undefined && schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      return `Record<string, ${renderType(schema.additionalProperties, ctx)}>`;
    }
    const required = new Set(schema.required ?? []);
    const lines = [];
    for (const [name, sub] of Object.entries(schema.properties ?? {})) {
      const optional = required.has(name) ? '' : '?';
      lines.push(`  ${propertyKey(name)}${optional}: ${renderType(sub, ctx)};`);
    }
    if (lines.length === 0) return 'Record<string, unknown>';
    return `{\n${lines.join('\n')}\n}`;
  }
  return 'unknown';
}

function renderType(schema, ctx) {
  if (schema === undefined || schema === null || schema === true) return 'unknown';
  if (schema === false) return 'never';
  if (Array.isArray(schema.oneOf)) return unionTypes(schema.oneOf, ctx);
  if (Array.isArray(schema.anyOf)) return unionTypes(schema.anyOf, ctx);
  const pieces = [];
  const structural = structuralType(schema, ctx);
  if (structural !== 'unknown') pieces.push(structural);
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      const rendered = renderType(branch, ctx);
      if (rendered !== 'unknown') pieces.push(rendered);
    }
  }
  const unique = [...new Set(pieces)];
  if (unique.length === 0) return 'unknown';
  return unique.join(' & ');
}

function importedNames(entry) {
  const names = [];
  if (entry.base !== 'common') names.push(entry.typeName);
  for (const defName of Object.keys(entry.schema.$defs ?? {})) {
    names.push(defTypeName(entry, defName));
  }
  return names;
}

function generateFile(entry) {
  const ctx = { entry, imports: new Set() };
  const blocks = [];
  const manifestTypes = [];

  for (const [defName, defSchema] of Object.entries(entry.schema.$defs ?? {})) {
    const name = defTypeName(entry, defName);
    blocks.push(`export type ${name} = ${renderType(defSchema, ctx)};`);
    manifestTypes.push({
      name,
      pointer: `${entry.schema.$id}#/$defs/${defName}`,
      kind: 'def',
      properties: Object.keys(defSchema.properties ?? {}),
      required: defSchema.required ?? [],
    });
  }

  const isPlaceholder =
    entry.schema.not !== undefined &&
    entry.schema.type === undefined &&
    entry.schema.properties === undefined &&
    entry.schema.$defs === undefined;
  if (isPlaceholder) {
    blocks.push(`/** 占位协议：当前拒绝全部输入，尚未实现。 */\nexport type ${entry.typeName} = never;`);
    manifestTypes.push({ name: entry.typeName, pointer: entry.schema.$id, kind: 'placeholder', properties: [], required: [] });
  } else if (entry.base !== 'common' && (entry.schema.type === 'object' || entry.schema.properties !== undefined)) {
    blocks.push(`export interface ${entry.typeName} ${renderType(entry.schema, ctx)}`);
    manifestTypes.push({
      name: entry.typeName,
      pointer: entry.schema.$id,
      kind: 'root',
      properties: Object.keys(entry.schema.properties ?? {}),
      required: entry.schema.required ?? [],
    });
  }

  const importLines = [...ctx.imports]
    .sort()
    .map((dep) => `import type { ${importedNames(byBase.get(dep)).join(', ')} } from './${dep}.ts';`);

  const header = ['// 自动生成，请勿手动修改。', '// 来源：packages/contracts/schemas', ''].join('\n');
  const content = `${header}${importLines.length ? importLines.join('\n') + '\n\n' : ''}${blocks.join('\n\n')}\n`;
  return { file: `${entry.base}.ts`, content, manifestTypes };
}

const outputs = [];
for (const entry of byId.values()) outputs.push(generateFile(entry));
outputs.sort((a, b) => a.file.localeCompare(b.file));

const manifest = [];
for (const entry of byId.values()) {
  const out = outputs.find((o) => o.file === `${entry.base}.ts`);
  manifest.push({ schemaId: entry.schema.$id, file: `${entry.base}.ts`, types: out.manifestTypes });
}
manifest.sort((a, b) => a.schemaId.localeCompare(b.schemaId));

const indexContent = ['// 自动生成，请勿手动修改。', ...outputs.map((out) => `export * from './${out.file}';`), ''].join('\n');

const mismatches = [];
function emit(file, content) {
  const full = join(outDir, file);
  if (checkOnly) {
    let existing = '';
    try {
      existing = readFileSync(full, 'utf8');
    } catch {
      mismatches.push(file);
      return;
    }
    if (existing !== content) mismatches.push(file);
  } else {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(full, content);
  }
}

for (const out of outputs) emit(out.file, out.content);
emit('index.ts', indexContent);
emit('manifest.json', JSON.stringify(manifest, null, 2) + '\n');

if (checkOnly) {
  if (mismatches.length > 0) {
    console.error(`生成类型与已提交文件不一致：${mismatches.join(', ')}`);
    process.exit(1);
  }
  console.log(`生成类型检查通过：${outputs.length + 2} 个文件一致`);
} else {
  console.log(`已生成 ${outputs.length + 2} 个类型文件到 packages/contracts/generated/`);
}