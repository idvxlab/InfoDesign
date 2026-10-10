/** draft 2020-12 校验适配：Ajv 严格编译，完整日期格式，不修改调用方输入。 */
import { Ajv2020, type AnySchema, type ValidateFunction } from 'ajv/dist/2020.js';
import formatsPlugin from 'ajv-formats';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ValidationError {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/** 支持 `$id` 索引与跨文件 `$ref` 的最小注册表接口。 */
export interface SchemaLookup {
  get(id: string): unknown;
}

interface ResolvedRef {
  schema: unknown;
  root: unknown;
  id: string;
}

type Dict = { [key: string]: unknown };

function isObject(value: unknown): value is Dict {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodePointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function resolvePointer(doc: unknown, pointer: string): unknown {
  if (pointer === '' || pointer === '/') return doc;
  const parts = pointer.split('/').slice(1).map(decodePointerToken);
  let current: unknown = doc;
  for (const part of parts) {
    if (!isObject(current) && !Array.isArray(current)) return undefined;
    current = (current as Dict)[part];
  }
  return current;
}

/** 返回 `$ref` 解析到的子 schema；失败返回 undefined。 */
export function resolveRef(
  ref: string,
  ctx: { registry: SchemaLookup; rootId: string; rootSchema: unknown },
): ResolvedRef | undefined {
  const hashIndex = ref.indexOf('#');
  const baseId = hashIndex === -1 ? ref : ref.slice(0, hashIndex);
  const pointer = hashIndex === -1 ? '' : ref.slice(hashIndex + 1);
  let baseDoc: unknown;
  let id: string;
  if (baseId === '' || baseId === ctx.rootId) {
    baseDoc = ctx.rootSchema;
    id = ctx.rootId;
  } else {
    baseDoc = ctx.registry.get(baseId);
    id = baseId;
  }
  if (baseDoc === undefined) return undefined;
  const schema = resolvePointer(baseDoc, pointer);
  if (schema === undefined) return undefined;
  return { schema, root: baseDoc, id };
}

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((v) => canonicalize(v)).join(',') + ']';
  const keys = Object.keys(value as Dict).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + canonicalize((value as Dict)[k])).join(',') +
    '}'
  );
}

/** 只接受仓库维护的可信 Schema；业务输入只作为待校验数据。 */
export function createValidator(): Ajv2020 {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    validateFormats: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  });
  // ajv-formats 的 CommonJS 入口同时导出 .default，兼容 NodeNext 类型解析。
  formatsPlugin.default(ajv, { mode: 'full' });
  return ajv;
}

/** 复制错误信息，避免后续调用改写上次结果；不输出数据值。 */
export function validateWith(validator: ValidateFunction, data: unknown): ValidationResult {
  if ('$async' in validator && validator.$async) throw new Error('协议只支持同步 Schema 校验');
  const valid = validator(data) === true;
  return {
    valid,
    errors: (validator.errors ?? []).map(({ instancePath, schemaPath, keyword, message }) => ({
      instancePath, schemaPath, keyword, message: message ?? 'Schema 校验失败',
    })),
  };
}

/** 小型内联 Schema 的便捷入口；注册表使用缓存后的编译函数。 */
export function validateSchema(schema: AnySchema, data: unknown): ValidationResult {
  return validateWith(createValidator().compile(schema), data);
}
