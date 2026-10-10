/**
 * @tju-mas/contracts 公共入口。
 * 权威定义在 schemas/*.schema.json；本包提供校验器、服务层校验与指纹工具。
 */
export * from './validator.ts';
export * from './schema-registry.ts';
export * from './fingerprint.ts';
export * from './service-checks.ts';