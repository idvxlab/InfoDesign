# 文档索引

第一次了解项目，从 [项目首页](../README.md) 和 [当前状态](../status.md) 开始。本目录按开发、设计和验证记录分组；命令及非链接路径除特别说明外，均相对项目根目录。

## 开发指南

| 文档 | 什么时候读 |
| --- | --- |
| [协作指南](development/contributing.md) | 第一次参与开发，或查 Git 分支、提交与 PR 操作 |
| [容器开发](development/dev-container.md) | 准备环境、配置模型、运行 Pi、排查连接问题 |
| [代码目录说明](development/repository-layout.md) | 查找模块职责和已有代码入口 |
| [后端实施指南](development/backend-plan.md) | 实施 B0—B6，核对完成条件、测试案例和团队分工 |
| [分段事实核心](development/segmented-fact-workflow.md) | 查输入、严格合并与未接线边界 |
| [设计交付接口](development/design-handoff.md) | 查ready／blocked、可信版本与来源、模拟消费者和调用示例 |

测试命令和覆盖范围见 [tests/README.md](../tests/README.md)；协议用法见 [contracts/README.md](../packages/contracts/README.md)。

## 设计规范

先读 [设计概览](design/overview.md)：[需求](design/overview.md#requirements)、[架构](design/overview.md#architecture)、[Agent 协议](design/overview.md#agent-contracts)、[流程](design/overview.md#workflows)、[溯源](design/overview.md#provenance)、[组件扩展](design/overview.md#component-branch)、[验收](design/overview.md#acceptance)。

[项目总方案](design/project-spec.md) 包含完整设计、示例和参考来源，是实施依据。首次接手实现或调整方案时通读；后续按章节查阅。概览用于快速定位，不另设一套协议。

## 验证报告

各份报告记录对应任务实际执行的检查，并保留当时结论。判断当前进度请看 [status.md](../status.md)，不要用历史通过项推断新功能已完成。

| 日期 | 报告 | 记录内容 |
| --- | --- | --- |
| 2026-10-18 | [分段核心发布](reports/segmented-release-candidate-2026-10-18.md) | 504＋7 项通过，保留官方设计端既有 45 条类型错误 |
| 2026-10-12 | [官方源码交接](reports/official-handoff-2026-10-12.md) | 发布副本446＋7项离线测试、隐私排除、同历史交接与CI边界 |
| 2026-10-12 | [整份真实PDF测试](reports/real-pdf-test-2026-10-12.md) | 客户端4096输出限制截断，未进入审查或返修 |
| 2026-10-12 | [提取／审查侧交付](reports/design-handoff-2026-10-12.md) | 只读交付、待联调边界、446项主仓库回归、原B5历史消费与保护回写 |
| 2026-10-12 | [B5事实工作流](reports/b5-fact-workflow-2026-10-12.md) | 同版两类虚构真实验收、422项主仓库回归、私有历史、原预算入口与保护回写 |
| 2026-10-10 | [PDF 本地解析与来源预览](reports/pdf-local-parser-2026-10-10.md) | 用户批准提前 PDF 切片；14 页真实样本、合成表格、16 项解析测试与 175 项项目回归；6 张候选质量提示及浏览器核验限制 |
| 2026-10-10 | [B3 v4关系语义补验通过](reports/b3-v4-focused-success-2026-10-10.md) | 2次请求、程序/语义通过、账单折算0.0438876元；前两组仍为v3证据，未宣称v4完整矩阵通过 |
| 2026-10-10 | [B3 三组合成真实验收与修复](reports/b3-synthetic-live-2026-10-10.md) | 6次真实请求，2组语义通过、1组关系需修正；v4离线175项检查通过，未付费重跑 |
| 2026-10-10 | [B3 合成质量矩阵](reports/b3-quality-matrix-2026-10-10.md) | 3组独立合成资料、19项新回归、全量174项检查；记录离线准备阶段，后续真实结果见上条 |
| 2026-10-10 | [B3 授权单段回归通过](reports/b3-scoped-success-2026-10-10.md) | 2 次真实请求、7 条事实与 2 项缺失；程序和开发语义复核通过，账单折算约 0.045713 元；完整 B3 质量验收仍待完成 |
| 2026-10-10 | [B3 计费核验与费用预留](reports/b3-budget-preflight-2026-10-10.md) | 账户账单与费率核对、逐请求私有台账、155 项离线检查；记录准备阶段的审批阻碍，后续解除见单段回归报告 |
| 2026-10-10 | [B3 离线回放与加固](reports/b3-offline-hardening-2026-10-10.md) | 全合成历史错误回放、取消正文保存、上下文精简；147 项程序检查通过，实际计价未核实，付费验证暂停 |
| 2026-10-10 | [B3 同限额重验与修复](reports/b3-live-recheck-2026-10-10.md) | 重验失败，语义对照、诊断与修正计数修复；131 项程序回归通过，未追加真实调用 |
| 2026-10-10 | [B3 单段资料真实提取](reports/b3-live-2026-10-10.md) | 2 次模型调用、7 条事实及 2 项缺失；程序复核通过，两处语义措辞待真实重验 |
| 2026-10-10 | [B3 本地候选提取](reports/b3-local-2026-10-10.md) | Pi 提取任务、候选校验与失败版本、128 项程序回归；真实提取未运行 |
| 2026-10-10 | [B2 真实工具验收通过](reports/b2-live-success-2026-10-10.md) | 2 次 HTTP 200、1 次真实受控读取、结果校验与用量记录 |
| 2026-10-10 | [B2 环境代理修复](reports/b2-proxy-fix-2026-10-10.md) | 根因调用栈、独立会话传输、106 项离线回归与增量镜像；未再调用真实模型 |
| 2026-10-10 | [B2 修复后真实重验](reports/b2-live-recheck-2026-10-10.md) | DNS 失败、无 HTTP 响应；无网络对照复现 SDK 导入后的代理问题 |
| 2026-10-10 | [B2 网关失败诊断](reports/b2-provider-diagnosis-2026-10-10.md) | 兼容项修复、安全诊断、98 项模拟回归；当轮未请求真实网关 |
| 2026-10-10 | [B2 首次真实验收](reports/b2-live-2026-10-10.md) | 首次模型调用失败，未执行工具，未自动重跑 |
| 2026-10-10 | [B2 运行层](reports/b2-runtime-2026-10-10.md) | 实现范围、模拟验证、真实验收入口和限制 |
| 2026-10-10 | [B1 收尾](reports/b1-completion-2026-10-10.md) | Ajv、类型检查与协议验证 |
| 2026-10-10 | [B0/B1 复核](reports/b0-b1-review-2026-10-10.md) | R1—R11 问题、修复与复验记录 |
| 2026-10-07—09 | [开发容器验证](reports/dev-container-verification.md) | 挂载、权限、网络及开发 CLI 连接验证 |
| 2026-10-01 | [SDK 安装记录](reports/sdk-install-2026-10-01.md) | 早期依赖与接口导入检查，仅供追溯 |

## 留在代码旁的文档

- 各模块 `README.md`：描述本模块的入口、用法和限制，修改模块时查阅。
- 根目录 [AGENTS.md](../AGENTS.md)：编程助手的任务约束，普通读者无需逐条细读。
- [skills/](../skills/README.md) 与 `apps/server/src/agents/*/prompt.md`：业务 Agent 的方法和角色指令，维护对应 Agent 时阅读。
- [design-references/](../design-references/README.md) 与 [evals/](../evals/README.md)：视觉规则与模型评测案例，按任务查阅。

## 文档维护约定

README 只保留项目介绍、上手步骤和导航；`status.md` 只保留当前状态、验证摘要和下一步。操作方法放 `development/`，设计约定放 `design/`，有日期的执行记录放 `reports/`。同一操作或规则只维护一份正文，其他位置用链接引用。

本次整理已将原 `指南.md` 与 `develop.md` 合为协作指南，原 `编程指南.md` 与实施计划合为后端实施指南；分散的七份设计摘要合为设计概览。总方案移入 `design/`，完整目录清单改为代码目录说明，历史安装与验证记录统一归入 `reports/`。
