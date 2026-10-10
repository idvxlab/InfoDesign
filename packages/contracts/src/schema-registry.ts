/**
 * 协议注册表：从权威 Schema 目录加载全部协议，按 $id 建索引并解析跨文件引用。
 * 协议以 packages/contracts/schemas 为唯一权威来源。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveRef,
  type JsonValue,
  type SchemaLookup,
  type ValidationResult,
  createValidator,
  validateWith,
} from './validator.ts';

export interface LoadedSchema {
  id: string;
  file: string;
  schema: JsonValue;
}

export interface RefReport {
  id: string;
  file: string;
  ref: string;
}

export interface IntegrityResult {
  ok: boolean;
  problems: string[];
  refs: RefReport[];
}

export class SchemaRegistry implements SchemaLookup {
  private readonly validator = createValidator();
  private readonly byId = new Map<string, LoadedSchema>();

  addSchema(file: string, schema: JsonValue): LoadedSchema {
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
      throw new Error(`Schema 必须是 JSON 对象：${file}`);
    }
    const id = (schema as { $id?: unknown }).$id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`Schema 缺少字符串 $id：${file}`);
    }
    if (this.byId.has(id)) {
      const existing = this.byId.get(id)!;
      throw new Error(`Schema $id 重复：${id}（${existing.file} 与 ${file}）`);
    }
    const loaded: LoadedSchema = { id, file, schema };
    this.validator.addSchema(schema, id);
    this.byId.set(id, loaded);
    return loaded;
  }

  get(id: string): JsonValue | undefined {
    return this.byId.get(id)?.schema;
  }

  getLoaded(id: string): LoadedSchema | undefined {
    return this.byId.get(id);
  }

  ids(): string[] {
    return [...this.byId.keys()].sort();
  }

  entries(): LoadedSchema[] {
    return [...this.byId.values()];
  }

  /** 依据已注册 Schema 的 $id 或其定义片段校验数据。 */
  validate(schemaId: string, data: unknown): ValidationResult {
    const loaded = this.byId.get(schemaId.split('#')[0]);
    if (!loaded) throw new Error(`未注册的 Schema：${schemaId}`);
    const validate = this.validator.getSchema(schemaId);
    if (!validate) throw new Error(`无法编译 Schema：${schemaId}`);
    return validateWith(validate, data);
  }

  /** 所有文件注册后立即严格编译；未知关键字、格式或悬空引用阻止加载。 */
  compile(): void {
    for (const id of this.ids()) {
      const validate = this.validator.getSchema(id);
      if (!validate || ('$async' in validate && validate.$async)) throw new Error(`协议必须可同步编译：${id}`);
    }
  }

  /** 校验所有 $ref 都能解析，避免生成类型或运行时出现悬空引用。 */
  checkRefs(): IntegrityResult {
    const problems: string[] = [];
    const refs: RefReport[] = [];
    for (const loaded of this.byId.values()) {
      collectRefs(loaded.schema, loaded.id, loaded.file, refs);
    }
    for (const entry of refs) {
      const loaded = this.byId.get(entry.id);
      const resolved = resolveRef(entry.ref, {
        registry: this,
        rootId: entry.id,
        rootSchema: loaded?.schema,
      });
      if (!resolved) problems.push(`${entry.file}: 无法解析 ${entry.ref}`);
    }
    return { ok: problems.length === 0, problems, refs };
  }
}

function collectRefs(node: unknown, id: string, file: string, out: RefReport[]): void {
  if (Array.isArray(node)) {
    node.forEach((item) => collectRefs(item, id, file, out));
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === '$ref' && typeof value === 'string') {
      out.push({ id, file, ref: value });
    } else {
      collectRefs(value, id, file, out);
    }
  }
}

function findSchemaFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      found.push(...findSchemaFiles(full));
    } else if (name.endsWith('.schema.json')) {
      found.push(full);
    }
  }
  return found.sort();
}

export function loadSchemasFromDir(dir: string): SchemaRegistry {
  const registry = new SchemaRegistry();
  for (const file of findSchemaFiles(dir)) {
    const schema = JSON.parse(readFileSync(file, 'utf8')) as JsonValue;
    registry.addSchema(file, schema);
  }
  registry.compile();
  return registry;
}

export function schemasRootFromUrl(metaUrl: string): string {
  // <contracts>/src/schema-registry.ts -> <contracts>/schemas
  return join(dirname(dirname(fileURLToPath(metaUrl))), 'schemas');
}

export function describePath(file: string, base: string): string {
  return relative(base, file);
}
