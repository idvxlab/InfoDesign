# InfoDesign — development snapshot

企业智能信息展示系统：把企业的文档、表格和图片整理成可交互的展示页面，让读者能从页面内容回查原始资料。

项目的目标是从资料生成页面，让用户用自然语言调整展示，并在补充资料后更新相关内容。信息与证据、信息设计、独立审查三个 Agent 分工协作，由程序控制流程和版本；页面组织随内容与目标变化。

> **开发中，尚无可用的完整产品。** 事实协议与校验、Pi 最小真实工具验收已完成；信息与证据 Agent 已实现首次生成候选快照的本地流程，单段与代表性合成案例已有分版本通过证据，关系问题的v4补验通过；前两组仍为v3证据，v4完整三组真实回归未执行。本地 PDF 来源检查预览已实现，文字／图片区域／表格候选及限制见解析报告；页面生成等完整业务能力尚待开发。本快照的范围与验证见 [SNAPSHOT.md](SNAPSHOT.md)，当前状态见 [status.md](status.md)。

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

2026-10-21 新增本地 HTML 预览：在开发容器执行 `node scripts/render-preview.ts --demo /output/preview.html`（`/output` 需挂载宿主输出目录），生成可双击打开的合成页面。实际 PageSpec 输入格式和边界见 [渲染器说明](packages/page-renderer/README.md)。这尚不是完整业务系统或已独立审查的页面。

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

完整索引见 [docs/README.md](docs/README.md)，各模块的用法见各自的 README。

## 参与协作

从任务分支提交修改，通过 PR 交由管理员审查合并。开始前核对已有改动，完成后记录实际验证结果；具体步骤见 [协作指南](docs/development/contributing.md)。
