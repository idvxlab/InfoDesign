#!/usr/bin/env node
/**
 * 协议完整性检查：
 * 1) 加载 packages/contracts/schemas 全部 Schema，确认 $id 唯一；
 * 2) 校验所有 $ref 可解析；
 * 3) 用合成夹具运行结构层正反例，确认合法实例通过与非法实例拒绝。
 * 服务层校验（引用、版本、权限、指纹、采纳）由 tests/integration 覆盖。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSchemasFromDir } from '../packages/contracts/src/schema-registry.ts';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptsDir);
const fixturesDir = join(repoRoot, 'tests/fixtures/synthetic');
const schemasDir = join(repoRoot, 'packages/contracts/schemas');

const registry = loadSchemasFromDir(schemasDir);
const failures = [];

const integrity = registry.checkRefs();
if (!integrity.ok) {
  for (const problem of integrity.problems) failures.push(`引用不可解析：${problem}`);
}

const cases = JSON.parse(readFileSync(join(fixturesDir, 'cases.json'), 'utf8'));
let validPassed = 0;
let invalidRejected = 0;

for (const item of cases.valid) {
  const data = JSON.parse(readFileSync(join(fixturesDir, item.file), 'utf8'));
  const result = registry.validate(item.schemaId, data);
  if (result.valid) {
    validPassed += 1;
  } else {
    failures.push(`正例被拒绝：${item.name} -> ${result.errors.map((e) => `${e.instancePath} ${e.message}`).join('; ')}`);
  }
}

for (const item of cases.invalid) {
  const data = JSON.parse(readFileSync(join(fixturesDir, item.file), 'utf8'));
  const result = registry.validate(item.schemaId, data);
  if (!result.valid) {
    invalidRejected += 1;
  } else {
    failures.push(`负例未拒绝：${item.name}（${item.reason}）`);
  }
}

console.log(`Schema 数量：${registry.ids().length}`);
console.log(`$ref 数量：${integrity.refs.length}`);
console.log(`结构层正例通过：${validPassed}/${cases.valid.length}`);
console.log(`结构层负例拒绝：${invalidRejected}/${cases.invalid.length}`);

if (failures.length > 0) {
  console.error('\n检查失败：');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('\n协议完整性检查通过。');