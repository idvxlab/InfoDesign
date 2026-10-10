/**
 * 生成类型一致性测试：生成的 TypeScript 类型必须与权威 Schema 的根属性、
 * 必填字段与占位状态一致，且重跑生成器不再产生差异。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { resolvePointer } from '../../packages/contracts/src/validator.ts';
import { repoRoot, registry } from '../helpers/fixtures.ts';

interface ManifestType {
  name: string;
  pointer: string;
  kind: 'root' | 'def' | 'placeholder';
  properties: string[];
  required: string[];
}

interface ManifestEntry {
  schemaId: string;
  file: string;
  types: ManifestType[];
}

const generatedDir = join(repoRoot, 'packages/contracts/generated');
const manifest = JSON.parse(readFileSync(join(generatedDir, 'manifest.json'), 'utf8')) as ManifestEntry[];

function generated(file: string): string {
  return readFileSync(join(generatedDir, file), 'utf8');
}

test('清单覆盖全部已注册 Schema', () => {
  const ids = manifest.map((entry) => entry.schemaId).sort();
  assert.deepEqual(ids, registry.ids().sort());
});

test('根类型属性与必填字段和 Schema 一致', () => {
  let rootCount = 0;
  for (const entry of manifest) {
    const schema = registry.get(entry.schemaId) as Record<string, any> | undefined;
    assert.ok(schema, `无法取到 Schema ${entry.schemaId}`);
    for (const type of entry.types) {
      if (type.kind === 'root') {
        rootCount += 1;
        assert.deepEqual(
          [...type.properties].sort(),
          Object.keys(schema.properties ?? {}).sort(),
          `${type.name} 属性不一致`,
        );
        assert.deepEqual([...type.required].sort(), [...(schema.required ?? [])].sort(), `${type.name} 必填不一致`);
      } else if (type.kind === 'def') {
        const pointer = type.pointer.slice(type.pointer.indexOf('#') + 1);
        const def = resolvePointer(schema, pointer) as Record<string, any> | undefined;
        assert.ok(def, `${type.name} 的 $defs 指针无法解析`);
        assert.deepEqual([...type.properties].sort(), Object.keys(def.properties ?? {}).sort());
      } else if (type.kind === 'placeholder') {
        assert.notEqual(schema.not, undefined, `${type.name} 占位 Schema 应使用 not`);
        assert.match(generated(entry.file), new RegExp(`export type ${type.name} = never;`));
      }
    }
  }
  assert.ok(rootCount >= 5, '应生成至少 5 个根类型');
});

test('生成文件包含关键类型且不把已知引用降级为 unknown', () => {
  const common = generated('common.ts');
  assert.match(common, /export type CommonFactValue = CommonNumberValue/);
  assert.doesNotMatch(common, /export type CommonFactValue = unknown/);
  const output = generated('evidence-output.ts');
  assert.match(output, /candidateSnapshot: EvidenceSnapshot &/);
  const reviewInput = generated('review-input.ts');
  assert.match(reviewInput, /subject: ReviewReportReportSubject;/);
});

test('index.ts 重新导出全部生成文件', () => {
  const index = generated('index.ts');
  for (const entry of manifest) {
    assert.ok(index.includes(`./${entry.file}`), `index.ts 缺少 ${entry.file}`);
  }
});

test('重跑生成器 --check 无差异', () => {
  const result = spawnSync('node', [join(repoRoot, 'scripts/generate-types.mjs'), '--check'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});