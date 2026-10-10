# 自动生成类型目录

本目录中的类型由 `scripts/generate-types.mjs`（`pnpm generate:types`）根据 `../schemas/**/*.schema.json` 生成，请勿手工修改。

- `common.ts`：公共定义。
- 其余 `*.ts`：各协议根类型与 `$defs`；未实现的占位协议生成 `never`。
- `index.ts`：汇总导出。
- `manifest.json`：类型与 Schema 指针、属性、必填字段清单，供一致性测试使用。

`pnpm check:generated` 和 `pnpm check:contracts` 检查生成结果与 Schema 是否一致；
`pnpm check:types` 通过 `tsc --noEmit` 检查全部生成类型、校验实现与测试调用方。
