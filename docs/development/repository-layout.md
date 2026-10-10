# 代码目录说明

本页按职责列出主要入口，不维护逐文件清单。当前实现范围以 [status.md](../../status.md) 为准；具体文件可在编辑器中查找，或在项目根目录运行 `rg --files`。

## 模块分工

| 路径 | 职责与说明 |
| --- | --- |
| [apps/server/](../../apps/server/README.md) | TypeScript 后端、Pi 运行层、业务规则；HTTP 与完整角色流程待实现 |
| [apps/web/](../../apps/web/README.md) | 上传、预览、编辑和来源查看界面，待实现 |
| [services/parser/](../../services/parser/README.md) | 本地 PDF 解析、来源位置与检查预览已实现；其他格式／API 待实现 |
| [packages/contracts/](../../packages/contracts/README.md) | 权威 Schema、校验器、服务层检查和生成类型 |
| [packages/page-renderer/](../../packages/page-renderer/README.md) | PageSpec 渲染、数据绑定与交互，待实现 |
| [packages/ui-components/](../../packages/ui-components/README.md) | 图表、时间轴、关系表达与来源组件，待实现 |
| [skills/](../../skills/README.md) | 业务 Agent 的专业方法和参考材料 |
| [design-references/](../../design-references/README.md) | 视觉规范和设计来源；不存企业真实资料 |
| [tests/](../../tests/README.md)、[evals/](../../evals/README.md) | 程序测试、合成夹具与真实模型评测 |
| [scripts/](../../scripts/README.md)、[deploy/](../../deploy/README.md) | 开发容器、协议检查和类型生成；业务部署仍待实现 |
| `.github/workflows/` | CI/CD 占位，手动触发后明确失败，不代表部署可用 |

## 已有实现入口

以下路径均相对项目根目录：

- `packages/contracts/schemas/`：事实阶段协议及 B2 读取工具协议；其余协议继续拒绝输入。
- `packages/contracts/src/`：Schema 注册、Ajv 校验、来源／权限／版本检查与内容指纹。
- `packages/contracts/generated/`：生成的 TypeScript 类型与清单，请勿手改。
- `apps/server/src/config/env.ts`：显式读取并校验业务模型配置。
- `apps/server/src/runtime/pi/`：会话、受控读取、预算、取消、结果校验与安全诊断。
- `apps/server/src/entrypoints/b2-probe.ts`：显式启用的真实验收入口，不是 HTTP 服务。
- `tsconfig.json`、`tsconfig.server.json`、`tests/types/contracts.ts`：协议、运行层及调用方类型检查。
- `.pi/extensions/rmb-cost/`：开发 Pi CLI 的人民币费用估算扩展。

后端尚待实现的 API、Router、工作流、角色和存储代码位置见 [总方案第 3 节](../design/project-spec.md#s03)，阶段任务见 [后端实施指南](backend-plan.md)。

## 文档与本地数据

根目录仅保留项目首页、`status.md` 和 `AGENTS.md`。开发指南在 `docs/development/`，设计规范在 `docs/design/`，执行记录在 `docs/reports/`，统一入口为 [文档索引](../README.md)。模块 README、角色提示词与 Skills 留在对应代码目录。

`.local-data/` 用于被 Git 忽略的本地配置、报告与运行数据；容器内同名路径是独立数据卷，与 Mac 目录不共享。不要把资料、凭据或模型日志放进普通源码路径。
