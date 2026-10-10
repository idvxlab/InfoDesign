/** 从权威协议裁去不可达的 $defs；不改字段、描述、约束或服务端验证器。 */
import type { SchemaRegistry } from '../../../../../packages/contracts/src/schema-registry.ts';
import type { JsonValue } from '../../../../../packages/contracts/src/validator.ts';

type SchemaObject = { [key: string]: JsonValue };
const object = (value: JsonValue | undefined): SchemaObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_evidence_schema');
  return value;
};
export function evidenceSchemaContext(registry: SchemaRegistry): JsonValue[] {
  const schemas = new Map(['common', 'evidence-snapshot', 'evidence-output'].map(name => {
    const id = 'urn:tju-mas:contracts:' + name;
    return [id, object(registry.get(id))] as const;
  }));
  const visited = new Set<string>();
  const required = new Map<string, Set<string>>();
  function visit(ref: string, base: string): void {
    const [prefix, fragment = '', extra] = ref.split('#');
    const id = prefix || base, key = id + '#' + fragment;
    if (visited.has(key)) return;
    visited.add(key);
    const schema = schemas.get(id);
    if (!schema || extra !== undefined) throw new Error('unsupported_evidence_schema_ref');
    if (!fragment) { walk(schema, id, true); return; }
    // 当前权威协议只使用根或顶层 $defs 引用；新增引用形式须先扩充裁剪与等价性测试。
    const match = /^\/\$defs\/([^/]+)$/.exec(fragment);
    if (!match) throw new Error('unsupported_evidence_schema_ref');
    const name = match[1].replaceAll('~1', '/').replaceAll('~0', '~');
    const definition = object(schema.$defs)[name];
    if (definition === undefined) throw new Error('missing_evidence_schema_ref');
    const names = required.get(id) ?? new Set<string>(); required.set(id, names); names.add(name);
    walk(definition, id);
  }
  function walk(node: JsonValue, base: string, root = false): void {
    if (Array.isArray(node)) { node.forEach(item => walk(item, base)); return; }
    if (!node || typeof node !== 'object') return;
    if (!root && '$id' in node) throw new Error('unsupported_nested_evidence_schema_id');
    if (typeof node.$ref === 'string') visit(node.$ref, base);
    for (const [key, value] of Object.entries(node)) if (!(root && key === '$defs')) walk(value, base);
  }
  // 三份协议的根保持原样；只删没有任何根／已保留定义引用的顶层定义。
  for (const id of schemas.keys()) visit(id, id);
  return [...schemas].map(([id, schema]) => ({
    ...structuredClone(schema),
    $defs: Object.fromEntries(Object.entries(object(schema.$defs)).filter(([name]) => required.get(id)?.has(name)).map(([name, value]) => [name, structuredClone(value)])),
  }));
}
