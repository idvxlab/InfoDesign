/**
 * Ajv 适配器回归：结构、格式、严格编译与错误路径，保留原关键字正反例。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalize,
  resolvePointer,
  resolveRef,
  validateSchema,
  type JsonValue,
} from '../../packages/contracts/src/validator.ts';

import { SchemaRegistry } from '../../packages/contracts/src/schema-registry.ts';

function valid(schema: Record<string, unknown>, data: unknown): boolean {
  return validateSchema(schema, data).valid;
}

test('type：基本类型判定', () => {
  assert.equal(valid({ type: 'string' }, 'a'), true);
  assert.equal(valid({ type: 'string' }, 1), false);
  assert.equal(valid({ type: 'integer' }, 3), true);
  assert.equal(valid({ type: 'integer' }, 3.5), false);
  assert.equal(valid({ type: ['string', 'null'] }, null), true);
  assert.equal(valid({ type: ['string', 'null'] }, false), false);
});

test('required 与 additionalProperties：拒绝缺字段与未知字段', () => {
  const schema = {
    type: 'object',
    required: ['a'],
    properties: { a: { type: 'number' } },
    additionalProperties: false,
  };
  assert.equal(valid(schema, { a: 1 }), true);
  assert.equal(valid(schema, {}), false);
  assert.equal(valid(schema, { a: 1, b: 2 }), false);
});

test('enum 与 const', () => {
  assert.equal(valid({ enum: ['a', 'b'] }, 'a'), true);
  assert.equal(valid({ enum: ['a', 'b'] }, 'c'), false);
  assert.equal(valid({ const: 'x' }, 'x'), true);
  assert.equal(valid({ const: 'x' }, 'y'), false);
});

test('字符串长度、模式与格式', () => {
  assert.equal(valid({ type: 'string', minLength: 2 }, 'ab'), true);
  assert.equal(valid({ type: 'string', minLength: 2 }, 'a'), false);
  assert.equal(valid({ type: 'string', maxLength: 2 }, 'abc'), false);
  assert.equal(valid({ type: 'string', pattern: '^[a-z]+$' }, 'abc'), true);
  assert.equal(valid({ type: 'string', pattern: '^[a-z]+$' }, 'Abc'), false);
  assert.equal(valid({ type: 'string', format: 'date' }, '2024-02-29'), true);
  assert.equal(valid({ type: 'string', format: 'date' }, '2023-02-30'), false);
  assert.equal(valid({ type: 'string', format: 'date-time' }, '2025-01-10T08:00:00Z'), true);
  assert.equal(valid({ type: 'string', format: 'date-time' }, '2025-01-10T08:00:00'), false);
});

test('数值范围与倍数', () => {
  assert.equal(valid({ type: 'number', minimum: 1, maximum: 3 }, 2), true);
  assert.equal(valid({ type: 'number', minimum: 1, maximum: 3 }, 0), false);
  assert.equal(valid({ type: 'number', exclusiveMinimum: 0 }, 0), false);
  assert.equal(valid({ type: 'number', exclusiveMaximum: 0 }, 0), false);
  assert.equal(valid({ type: 'number', multipleOf: 2 }, 4), true);
  assert.equal(valid({ type: 'number', multipleOf: 2 }, 3), false);
});

test('数组项数、唯一性与逐项校验', () => {
  assert.equal(valid({ type: 'array', minItems: 1, items: { type: 'number' } }, [1]), true);
  assert.equal(valid({ type: 'array', minItems: 1, items: { type: 'number' } }, []), false);
  assert.equal(valid({ type: 'array', items: { type: 'number' } }, [1, 'a']), false);
  assert.equal(valid({ type: 'array', uniqueItems: true }, [1, 2]), true);
  assert.equal(valid({ type: 'array', uniqueItems: true }, [1, 1]), false);
});

test('oneOf 恰好一个分支，anyOf、allOf、not', () => {
  const oneOf = { oneOf: [{ type: 'number' }, { type: 'string' }] };
  assert.equal(valid(oneOf, 1), true);
  assert.equal(valid(oneOf, true), false);
  const overlapping = { oneOf: [{ type: 'number' }, { type: 'number', minimum: 0 }] };
  assert.equal(valid(overlapping, 1), false, '同时命中两个分支应被拒绝');
  assert.equal(valid({ anyOf: [{ type: 'number' }, { type: 'string' }] }, 'a'), true);
  assert.equal(valid({ anyOf: [{ type: 'number' }, { type: 'string' }] }, true), false);
  assert.equal(valid({ allOf: [{ type: 'number' }, { type: 'number', minimum: 0 }] }, 1), true);
  assert.equal(valid({ allOf: [{ type: 'number' }, { type: 'number', minimum: 0 }] }, -1), false);
  assert.equal(valid({ not: { type: 'string' } }, 1), true);
  assert.equal(valid({ not: { type: 'string' } }, 'a'), false);
});

test('if/then/else 条件分支', () => {
  const schema = {
    type: 'object',
    properties: { kind: {}, extra: {}, other: {} },
    if: { properties: { kind: { const: 'a' } }, required: ['kind'] },
    then: { properties: { extra: {} }, required: ['extra'] },
    else: { properties: { other: {} }, required: ['other'] },
  };
  assert.equal(valid(schema, { kind: 'a', extra: 1 }), true);
  assert.equal(valid(schema, { kind: 'a' }), false);
  assert.equal(valid(schema, { kind: 'b', other: 1 }), true);
  assert.equal(valid(schema, { kind: 'b' }), false);
});

test('propertyNames 与 patternProperties', () => {
  const schema = {
    type: 'object',
    propertyNames: { type: 'string', pattern: '^[a-z]+$' },
  };
  assert.equal(valid(schema, { abc: 1 }), true);
  assert.equal(valid(schema, { Abc: 1 }), false);
  const patternProps = {
    type: 'object',
    patternProperties: { '^x_': { type: 'number' } },
  };
  assert.equal(valid(patternProps, { x_a: 1 }), true);
  assert.equal(valid(patternProps, { x_a: 'no' }), false);
});

test('$ref：跨文件解析与悬空引用', () => {
  const common = {
    $id: 'urn:test:common',
    $defs: { name: { type: 'string', minLength: 1 } },
  };
  const lookup = new SchemaRegistry();
  lookup.addSchema('common.json', common);
  const schema = { type: 'object', properties: { name: { $ref: 'urn:test:common#/$defs/name' } }, required: ['name'] };
  lookup.addSchema('root.json', { $id: 'urn:test:root', ...schema });
  lookup.compile();
  assert.equal(lookup.validate('urn:test:root', { name: 'ok' }).valid, true);
  assert.equal(lookup.validate('urn:test:root', { name: '' }).valid, false);
  assert.throws(() => validateSchema(schema, { name: 'ok' }), /resolve reference/, '悬空引用阻止 Schema 编译');

  const resolved = resolveRef('urn:test:common#/$defs/name', {
    registry: lookup,
    rootId: 'urn:test:root',
    rootSchema: schema,
  });
  assert.ok(resolved);
  assert.deepEqual(resolved?.schema, common.$defs.name);
});

test('resolvePointer 解码 ~0 与 ~1', () => {
  const doc = { a: { 'b/c': 1, 'd~e': 2 } };
  assert.equal(resolvePointer(doc, '/a/b~1c'), 1);
  assert.equal(resolvePointer(doc, '/a/d~0e'), 2);
  assert.equal(resolvePointer(doc, '/missing'), undefined);
});

test('canonicalize 对键排序且稳定', () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  assert.equal(canonicalize([1, { b: 1, a: 2 }]), '[1,{"a":2,"b":1}]');
  assert.notEqual(canonicalize({ a: 1 }), canonicalize({ a: 2 }));
});

test('嵌套对象错误路径可定位', () => {
  const schema = {
    type: 'object',
    properties: { list: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'string' } }, additionalProperties: false } } },
    required: ['list'],
  };
  const result = validateSchema(schema, { list: [{ id: 1 }] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.instancePath === '/list/0/id'));
});

test('严格编译拒绝未知关键字、未知格式和缺失类型约束', () => {
  const invalidSchemas: Array<Record<string, JsonValue>> = [
    { type: 'string', minLenght: 1 },
    { type: 'string', format: 'unregistered-format' },
    { minimum: 0 },
  ];
  for (const schema of invalidSchemas) {
    const registry = new SchemaRegistry();
    registry.addSchema('invalid.json', { $id: 'urn:test:invalid', ...schema });
    assert.throws(() => registry.compile(), /strict mode|unknown format/);
  }
});

test('draft 2020-12：prefixItems 与 unevaluatedProperties 实际生效', () => {
  const tuple = { type: 'array', prefixItems: [{ type: 'string' }], items: false, minItems: 1, maxItems: 1 };
  assert.equal(valid(tuple, ['ok']), true);
  assert.equal(valid(tuple, [1]), false);
  assert.equal(valid(tuple, ['ok', 'extra']), false);
  const object = { type: 'object', allOf: [{ properties: { id: { type: 'string' } } }], unevaluatedProperties: false };
  assert.equal(valid(object, { id: 'ok' }), true);
  assert.equal(valid(object, { id: 'ok', extra: 1 }), false);
});

test('格式使用完整日历检查，日期时间必须有时区', () => {
  const schema = { type: 'string', format: 'date-time' };
  for (const value of ['2024-02-29T00:00:00Z', '2025-01-01T12:30:00+08:00']) {
    assert.equal(valid(schema, value), true, value);
  }
  for (const value of ['2025-02-29T00:00:00Z', '2025-02-30T00:00:00Z', '2025-01-01T25:00:00Z', '2025-01-01T12:30:00']) {
    assert.equal(valid(schema, value), false, value);
  }
});

test('校验不转换类型、不填默认值、不删除额外字段', () => {
  const schema = { type: 'object', properties: { count: { type: 'integer', default: 1 } }, required: ['count'], additionalProperties: false };
  for (const input of [{ count: '2', extra: true }, {}]) {
    const original = structuredClone(input);
    assert.equal(valid(schema, input), false);
    assert.deepEqual(input, original);
  }
});

test('注册表复用编译器时保留独立错误与 JSON Pointer 路径', () => {
  const registry = new SchemaRegistry();
  const id = 'urn:test:errors';
  registry.addSchema('errors.json', { $id: id, type: 'object', properties: { 'a/b~c': { type: 'integer' } } });
  registry.compile();
  const failed = registry.validate(id, { 'a/b~c': 'bad' });
  const saved = structuredClone(failed);
  assert.equal(failed.valid, false);
  assert.equal(failed.errors[0].instancePath, '/a~1b~0c');
  assert.equal(registry.validate(id, { 'a/b~c': 1 }).valid, true);
  assert.deepEqual(failed, saved);
});

test('异步 Schema 不能被同步入口误判为通过', () => {
  assert.throws(() => validateSchema({ $async: true, type: 'string' }, 'ok'), /同步/);
  const registry = new SchemaRegistry();
  registry.addSchema('async.json', { $id: 'urn:test:async', $async: true, type: 'string' });
  assert.throws(() => registry.compile(), /同步/);
});
