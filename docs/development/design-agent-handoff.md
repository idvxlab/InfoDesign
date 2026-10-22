# Design Agent 交接清单（2026-10-12）

交接方式：在 codex/design-agent 分支提交设计改动，通过 PR 合并到团队实际集成分支。不要把本地整个文件夹覆盖到同学的仓库；同学同步修改的文件需合并差异。当前尚未执行提交或推送，已核对远程默认分支 e55a906，但未合并。

## 当前交付

真实 Pi 设计会话、受控读取工具、InformationPlan/PageSpec 及 DesignInput/DesignOutput 协议、服务校验、有限修正、测试与说明。一个合成资料真实任务生成通过，设计测试 98 项通过；不代表多样本、真实客户或端到端页面验收。

## 文件范围

以下是此前整理的基础提交范围；本轮新增文件见末尾补充。它们依赖仓库原有的 SDK、配置模块、事实协议、Schema 注册表和锁定依赖，不能作为脱离原仓库的独立应用运行。除本清单外，建议保持这一组一起提交。
- `.gitattributes`
- `apps/server/src/agents/design/agent.ts`
- `apps/server/src/agents/design/context.ts`
- `apps/server/src/agents/design/prompt.md`
- `apps/server/src/runtime/pi/event-bridge.ts`
- `apps/server/src/runtime/pi/execution-limits.ts`
- `apps/server/src/runtime/pi/session-factory.ts`
- `apps/server/src/runtime/pi/skill-loader.ts`
- `apps/server/src/tools/design.tools.ts`
- `docs/README.md`
- `docs/design/design-agent-io-v1.md`
- `docs/design/design-contracts-draft.md`
- `docs/design/overview.md`
- `docs/design/project-spec.md`
- `docs/development/design-agent-onboarding.md`
- `docs/development/design-submission-scope.md`
- `docs/examples/design-contracts-v1/README.md`
- `docs/examples/design-contracts-v1/information-plan.json`
- `docs/examples/design-contracts-v1/page-spec.json`
- `docs/reports/design-agent-io-v1-2026-10-11.md`
- `docs/reports/design-agent-live-2026-10-11.md`
- `docs/reports/design-agent-output-debug-2026-10-11.md`
- `docs/reports/design-agent-runtime-v1-2026-10-11.md`
- `docs/reports/design-contracts-v1-2026-10-11.md`
- `package.json`
- `packages/contracts/README.md`
- `packages/contracts/generated/design-input.ts`
- `packages/contracts/generated/design-output.ts`
- `packages/contracts/generated/information-plan.ts`
- `packages/contracts/generated/manifest.json`
- `packages/contracts/generated/page-spec.ts`
- `packages/contracts/schemas/agents/design-input.schema.json`
- `packages/contracts/schemas/agents/design-output.schema.json`
- `packages/contracts/schemas/information-plan.schema.json`
- `packages/contracts/schemas/page-spec.schema.json`
- `packages/contracts/src/design-agent-checks.ts`
- `packages/contracts/src/design-checks.ts`
- `skills/information-planning/SKILL.md`
- `skills/page-spec-authoring/SKILL.md`
- `skills/visual-design/SKILL.md`
- `status.md`
- `tests/README.md`
- `tests/helpers/design-fixtures.ts`
- `tests/helpers/fixtures.ts`
- `tests/integration/contracts-design.test.ts`
- `tests/integration/design-agent.test.ts`
- `tests/types/contracts.ts`
- `tsconfig.server.json`

## 合并时特别留意

- apps/server/src/runtime/pi/ 的四个文件：保留同学已有 evidence/review 逻辑，仅合并 design 角色、资源、预算和事件接线。
- package.json、tsconfig.server.json、tests/helpers/fixtures.ts、tests/types/contracts.ts：合并列表与脚本，不整文件替换。
- packages/contracts/generated/：先合并 Schema，再按团队锁定版本重新生成和验证，不手工解决生成类型冲突。
- status.md 和共享设计文档：同时保留双方进度。我们的设计完成记录不能覆盖同学的提取／审查进度。

## 不提交

- .local-data/ 全部内容，包括 pi.env、网关配置、本地试跑脚本、原始模型正文与结果。
- 客户 PDF、HTML、原始资料、密钥、数据库备份、模型会话日志。
- node_modules、构建产物和本机容器数据。
- 当前未跟踪的学习材料：docs/development/review-agent-onboarding.md、docs/development/vividoc-study-notes.md、docs/examples/design-agent-first-case/ 下两个文件。

docs/examples/design-contracts-v1/ 中的是可提交的合成协议样例，并且被测试使用，不能漏掉。不要把它当作真实模型输出。

## 同学怎么测试

在项目规定的开发容器内执行：

```sh
pnpm test:design
pnpm check:types
pnpm check:generated
```

test:design 当前有 98 项，使用合成输入和模拟网关，不需要提取／审查 Agent 或模型密钥。合并共享运行时后，还应执行 pnpm test 及同学自己的审查／来源测试。本轮默认回归 273 项及真实上游接口联合测试 36 项通过，详见交底适配报告。

真实联调入口是 apps/server/src/agents/design/agent.ts 的 runDesignAgent(options)，目前没有可直接启动的设计 HTTP 服务或正式 eval:design 命令。本地 .local-data 内的临时试跑脚本不随代码交付，不要照报告中的本机容器名称直接执行。

后端同学应负责准备：

1. 已通过审核且由服务授权的 EvidenceSnapshot，与准确版本及指纹；不能把 pending 直接改为 passed 来绕过检查。
2. DesignInput：快照、受众、目标、限制、实际组件目录和主题。
3. 服务构造的可信 DesignTaskContext，以及 SchemaRegistry、ModelConfig；可信授权不能来自模型输出。
4. 需要原文补查时，提供受控 DocumentAccess；当前只支持段落定位。
5. 容器模型配置、调用上限和实际网关费率对应的费用预算。

只有 outcome.status 为 completed 且存在 output 时才接收两份候选。needs_information/blocked 是业务停止响应；failed 是失败。completed 仍不等于页面审核或发布，后续由团队接渲染、持久化与独立页面审查。

先读 docs/design/design-agent-io-v1.md，再参考 tests/integration/design-agent.test.ts 中的调用装配；最新修复及真实试跑边界见 docs/reports/design-agent-output-debug-2026-10-11.md。
## 本轮交底适配补充

上游交底请改用 [runDesignFromHandoff](design-handoff-consumer.md) 入口：由后端注入真实 store、verifyDesignHandoff 和可信 pins，自动装配 DesignInput/context/原文权限。无需也不得将 pending 改为 passed。原 runDesignAgent 保留为较低层接口。

提交范围增加 domain/design-handoff-consumer.ts、design-review-ref Schema 和生成类型、generated/index.ts、design-review-binding.test.ts、design-handoff-consumer.test.ts，以及本交接清单、design-handoff.md、design-handoff-consumer.md、两份 2026-10-12 兼容性／适配报告。共享协议、校验、package.json、tsconfig 与文档更新也应一同合并。完整路径可用 git diff --name-only 和 git ls-files --others --exclude-standard 核对，仍排除上述学习材料。
