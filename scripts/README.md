# 开发脚本

`dev-container.sh` 管理隔离开发环境：构建、启动、进入、检查和停止。源码直接与 Mac 共享，无需导出同步；`export` 仅作为可选源码归档保留。`check-dev-container.mjs` 校验项目挂载、Git 只读、依赖隔离、运行权限、网络限制与 SDK 导入，`export-dev-source.mjs` 归档经过路径过滤的普通源码文件。
具体用法见 [隔离开发指南](../docs/development/dev-container.md)。脚本不自动调用模型，配置凭据并运行 `pi` 后才能使用模型。

B0/B1 已实现的协议工具：

- `generate-types.mjs` / `generate-types.sh`：由 `packages/contracts/schemas` 生成 TypeScript 类型与 `manifest.json`；`--check` 只比较不写盘。
- `check-contracts.mjs` / `check-contracts.sh`：校验 `$id` 的唯一性与 `$ref` 的完整性，并运行合成夹具的结构层正反例。

根目录 `pnpm generate:types`、`pnpm check:generated`、`pnpm check:contracts` 是上述脚本的入口。
`pnpm check:types` 依次执行根 `tsconfig.json` 和后端 `tsconfig.server.json` 的 `tsc --noEmit`；两组配置均检查项目源码，后端配置仅跳过上游依赖声明内部的检查。
`pnpm test:b2` 使用真实 SDK 与本地模拟网关；`pnpm eval:b2 --live` 是真实模型验收入口，还需显式启用环境开关，不属于默认测试。配置、授权边界与记录见 [B2 报告（历史记录未随快照上传）](../SNAPSHOT.md#verification)。
`prepare-local.sh` 仍为占位。

`pnpm test:b3` 验证候选提取与程序检查的模拟调用链。`pnpm eval:b3 --live` 为固定合成资料的真实提取入口，需要 `APP_RUN_LIVE_EVAL=1`、显式模型配置和 `APP_B3_REPORT_PATH`；原始候选只写私有报告，不打印到终端。运行前须取得新的单次模型用量授权，预算与操作边界见 [B3 报告（历史记录未随快照上传）](../SNAPSHOT.md#verification)。

`parser-container.sh` 独立构建、测试及运行断网 PDF 解析镜像，不重启 Pi；`check-parser-output.mjs` 用现有权威 Schema 校验解析产物、文件指纹和区域／单元格引用。命令与输出目录见 [解析模块](../services/parser/README.md)。
