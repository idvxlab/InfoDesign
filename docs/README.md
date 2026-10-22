# 文档索引

第一次了解项目，从 [项目首页](../README.md) 和 [当前状态](../status.md) 开始。本目录按开发、设计和验证记录分组；命令及非链接路径除特别说明外，均相对项目根目录。

## 开发指南

| 文档 | 什么时候读 |
| --- | --- |
| [协作指南](development/contributing.md) | 第一次参与开发，或查 Git 分支、提交与 PR 操作 |
| [容器开发](development/dev-container.md) | 准备环境、配置模型、运行 Pi、排查连接问题 |
| [代码目录说明](development/repository-layout.md) | 查找模块职责和已有代码入口 |
| [后端实施指南](development/backend-plan.md) | 实施 B0—B6，核对完成条件、测试案例和团队分工 |

测试命令和覆盖范围见 [tests/README.md](../tests/README.md)；协议用法见 [contracts/README.md](../packages/contracts/README.md)。

## 设计规范

[PageSpec 1.1 输出要素](design/page-spec-v1.1.md)：版本协商、节点/绑定、布局/视觉、交互、计算、检查要求及当前限制；附[完整合成示例](examples/design-contracts-v1.1/README.md)。

先读 [设计概览](design/overview.md)：[需求](design/overview.md#requirements)、[架构](design/overview.md#architecture)、[Agent 协议](design/overview.md#agent-contracts)、[流程](design/overview.md#workflows)、[溯源](design/overview.md#provenance)、[组件扩展](design/overview.md#component-branch)、[验收](design/overview.md#acceptance)。

[项目总方案](design/project-spec.md) 包含完整设计、示例和参考来源，是实施依据。首次接手实现或调整方案时通读；后续按章节查阅。概览用于快速定位，不另设一套协议。

## 阶段验证

设计侧协议讨论见 [InformationPlan 与 PageSpec 草案](design/design-contracts-draft.md)：它补充字段建议，不代替已确认方案或正式 Schema。

本公开快照的范围、可复现检查命令与限制见 [阶段说明](../SNAPSHOT.md)。历史运行报告、模型会话、账单和本地原始资料未包含在快照中。

## 留在代码旁的文档

- 各模块 `README.md`：描述本模块的入口、用法和限制，修改模块时查阅。
- 根目录 [AGENTS.md](../AGENTS.md)：编程助手的任务约束，普通读者无需逐条细读。
- [skills/](../skills/README.md) 与 `apps/server/src/agents/*/prompt.md`：业务 Agent 的方法和角色指令，维护对应 Agent 时阅读。
- [design-references/](../design-references/README.md) 与 [evals/](../evals/README.md)：视觉规则与模型评测案例，按任务查阅。

## 文档维护约定

README 只保留项目介绍、上手步骤和导航；`status.md` 只保留当前状态、验证摘要和下一步。操作方法放 `development/`，设计约定放 `design/`，有日期的执行记录放 `reports/`。同一操作或规则只维护一份正文，其他位置用链接引用。

本次整理已将原 `指南.md` 与 `develop.md` 合为协作指南，原 `编程指南.md` 与实施计划合为后端实施指南；分散的七份设计摘要合为设计概览。总方案移入 `design/`，完整目录清单改为代码目录说明，历史安装与验证记录统一归入 `reports/`。

设计运行入口与最新测试：[设计 Agent 运行时验证](reports/design-agent-runtime-v1-2026-10-11.md)。

上游新对接资料：[设计交底接口（原文）](development/design-handoff.md)；本地核对结果：[设计交底兼容性检查](reports/design-handoff-compatibility-2026-10-12.md)。

- [设计交底消费入口](development/design-handoff-consumer.md)：可信核验、pending 语义、服务装配和联调条件。
- [设计交底适配验证](reports/design-handoff-consumer-2026-10-12.md)：273 项回归及 36 项上游联合测试。
