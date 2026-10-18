# InfoDesign

企业智能信息展示系统：把企业的文档、表格和图片整理成可交互的展示页面，让读者能从页面内容回查原始资料。

项目的目标是从资料生成页面，让用户用自然语言调整展示，并在补充资料后更新相关内容。信息与证据、信息设计、独立审查三个 Agent 分工协作，由程序控制流程和版本；页面组织随内容与目标变化。

> **开发中，尚无可用的完整页面产品。** 已完成协议、真实Pi受控提取与独立事实审查，以及本地事实工作流的最低验收。B5可在独立会话间执行有限返修、保留版本与运行历史；页面设计、HTTP与生产保存仍待开发。

提取／审查侧提供[只读设计交付接口](docs/development/design-handoff.md)。当前版本增加提取输出上限 16384 与[分段事实核心](docs/development/segmented-fact-workflow.md)，合并前默认离线回归 504 项通过；PDF 分段接线、恢复和真实全文验收尚未完成。

**当前合并版本的默认测试、类型与协议检查未通过。** 设计 PR #1 提供了设计核心、只读工具、运行角色和协议主体，但仍缺少 design-review-ref 的 Schema／生成类型及两个设计侧测试。实际默认检查 101 项通过、53 项失败；三组类型各有相同的 5 条缺失类型错误，协议编译也受阻。已按确认的范围整合，后续补齐外围依赖；见[当前状态](status.md)与[合并验证记录](docs/reports/design-pr1-merge-2026-10-18.md)。

## Get Started

需要 Git 和 Docker Desktop。Pi、依赖和测试运行在容器内。开发镜像使用固定版本的 Node.js 24.11.1、pnpm 11.3.0 和 Pi SDK 0.99.1。

首次使用，在终端执行（已有仓库可跳过克隆）：

```bash
git clone --branch snapshot/2026-10-10-multimodal-reader https://github.com/idvxlab/InfoDesign.git
cd InfoDesign
bash scripts/dev-container.sh build
bash scripts/dev-container.sh up
bash scripts/dev-container.sh exec pnpm test
```

这些命令准备开发环境并运行协议与运行层测试，不调用真实模型。目前没有完整业务启动命令；已有独立本地 PDF 检查预览，运行方式见 [解析模块](services/parser/README.md)。`up` 会重建容器；已有 Pi 任务时请先结束会话。模型配置和日常操作见 [容器开发指南](docs/development/dev-container.md)。

## 项目结构

```text
apps/                前端、后端与 Pi 运行层
services/parser/     本地 PDF 解析与来源检查（有限支持）
packages/            共享协议、页面渲染与组件
skills/              业务 Agent 的技能说明
tests/、evals/       程序测试与模型评测
docs/                开发指南、设计规范、验证报告
```

查找具体代码入口时，参阅 [代码目录说明](docs/development/repository-layout.md)。目录存在不代表对应功能已完成。

## md文档说明

| 文档 | 给谁看 | 阅读建议 |
| --- | --- | --- |
| 本页、[当前状态](status.md) | 所有人 | 先读，了解用途和目前能做什么。 |
| [协作指南](docs/development/contributing.md)、[容器开发](docs/development/dev-container.md) | 参与开发的人 | 开发前细读，完成环境准备并了解 Git／PR 流程。 |
| [设计概览](docs/design/overview.md)、[项目总方案](docs/design/project-spec.md)、[后端实施指南](docs/development/backend-plan.md) | 设计与实现负责人、编程 Agent | 先读概览；接手实现时细读总方案及本轮阶段。 |
| [AGENTS.md](AGENTS.md)、`skills/*/SKILL.md`、`apps/server/src/agents/*/prompt.md` | 编程／业务 Agent | 普通读者无需细读；维护规则或对应 Agent 时再看。 |

完整索引和历史验证报告见 [docs/README.md](docs/README.md)，各模块的用法见各自的 README。

## 参与协作

从任务分支提交修改，通过 PR 交由管理员审查合并。开始前核对已有改动，完成后记录实际验证结果；具体步骤见 [协作指南](docs/development/contributing.md)。
