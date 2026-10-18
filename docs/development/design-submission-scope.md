# 设计开发分支与提交范围

本地分支：`codex/design-agent`。起点：`snapshot/2026-10-10-multimodal-reader` 的 `02cb140e257fd481fe1495bf7da8cf7328d06eaa`。本轮不创建提交、不推送、不拉取或合并远程；未验证同学最新远程内容。暂存区用于明确下一次功能提交的范围。

## 纳入设计功能提交

| 范围 | 文件 |
| --- | --- |
| 权威设计协议 | packages/contracts/schemas/information-plan.schema.json、page-spec.schema.json |
| 设计任务协议 | packages/contracts/schemas/agents/design-input.schema.json、design-output.schema.json；对应 generated/design-input.ts、design-output.ts |
| 自动生成类型 | packages/contracts/generated/information-plan.ts、page-spec.ts、manifest.json |
| 独立校验与测试 | packages/contracts/src/design-checks.ts、tests/helpers/design-fixtures.ts、tests/integration/contracts-design.test.ts |
| 设计任务校验及说明 | packages/contracts/src/design-agent-checks.ts、docs/design/design-agent-io-v1.md、docs/reports/design-agent-io-v1-2026-10-11.md |
| 设计运行时 | apps/server/src/agents/design/ 下三个文件、tools/design.tools.ts；skills/information-planning、visual-design、page-spec-authoring 的 SKILL.md；tests/integration/design-agent.test.ts |
| 运行时共享接线 | runtime/pi/session-factory.ts、skill-loader.ts、execution-limits.ts、event-bridge.ts；tsconfig.server.json |
| 运行时验证说明 | docs/reports/design-agent-runtime-v1-2026-10-11.md |
| 必需公共接线 | package.json、tests/helpers/fixtures.ts、tests/types/contracts.ts |
| Windows 换行修复 | .gitattributes；仅约束合成原文和自动生成类型为 LF，不修改事实指纹 |
| 设计样例 | docs/examples/design-contracts-v1/README.md、information-plan.json、page-spec.json |
| 设计文档 | docs/design/design-contracts-draft.md、docs/development/design-agent-onboarding.md、本文件、docs/reports/design-contracts-v1-2026-10-11.md |
| 共享说明更新 | docs/README.md、docs/design/overview.md、docs/design/project-spec.md、packages/contracts/README.md、tests/README.md、status.md |

上述代码、类型、测试和被测试读取的样例互相依赖，建议作为一个完整功能提交；不要仅挑 Schema 上传。学习材料可以另开文档提交，但无需与设计功能捆绑。

## 保留本地，不纳入本次暂存

- docs/development/review-agent-onboarding.md
- docs/development/vividoc-study-notes.md
- docs/examples/design-agent-first-case/README.md
- docs/examples/design-agent-first-case/source.md

这些文件仍存在，不删除、不藏入忽略规则。不要使用 `git add .` 或 `git add -A` 将其混入功能提交。未提交文件并不被某个分支永久保存；后续切分支或清理工作区前仍需检查状态。

## 同学同时修改时怎样合并

- 新增的设计校验文件通常独立，但同名文件仍需检查。两份 Schema 是共同接口，应与后端和渲染负责人对齐。
- package.json 合并时保留双方 scripts／依赖，不能用本地整文件覆盖。此次仅增加设计测试入口及默认测试列表。
- tests/helpers/fixtures.ts 仅移除两份已实现协议的占位列表项，保留其他未实现协议的拒绝规则。
- generated 文件发生冲突时，先合并 Schema 和生成器，再在隔离开发容器内重新生成、校验；不要手工选一方生成类型。
- status.md、总方案和文档索引保留双方的阶段进展。设计协议完成不代表同学负责的功能已完成。
- .gitattributes 若远程新增规则，应合并这两个路径的 LF 约束，不覆盖同学其他规则。

## 上传前的步骤

先查看 `git diff --cached --stat` 与 `git diff --cached`，确认暂存中只有上述内容；完成本地提交后再同步远程。建议提交说明：`feat(design): add initial plan and page contracts with validation`。

下一次需要上传时先 `git fetch origin`，核对团队当前集成分支。当前已知的是阶段分支，不能假定存在 main。确认目标后，在设计分支合并对应的 `origin/<实际集成分支>`，解决冲突并在隔离容器重新验证。最后只推送 `codex/design-agent` 并发起指向实际集成分支的 PR；不强制推送、不直接覆盖阶段分支。

现有验证证据见 [测试记录](../reports/design-contracts-v1-2026-10-11.md)。本轮已新增设计运行时，使用真实 SDK 和模拟网关验证，详见[运行时记录](../reports/design-agent-runtime-v1-2026-10-11.md)。共享 Pi 文件仅接入 design 角色、预算、固定资源和事件名称；合并时保留同学的 evidence/review 改动，禁止整文件覆盖。

输出调试增量：agents/design/context.ts 精简模型提示中的 Schema；agent.ts 增加显式可选诊断；page-spec-authoring/SKILL.md 明确事件引用；design-agent.test.ts 增加回归。新增 reports/design-agent-live-2026-10-11.md 和 design-agent-output-debug-2026-10-11.md 记录真实试跑；.local-data 内全部正文、配置与凭据保持不提交。
