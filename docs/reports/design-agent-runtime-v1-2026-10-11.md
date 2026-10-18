# 设计会话运行时验证（2026-10-11）

本轮接入真实 Pi SDK 0.99.1，使用本地环回 HTTP 模拟网关和合成快照验证调用链。没有真实模型生成、付费请求或客户资料输入；不能据此宣称设计质量或端到端页面验收通过。

## 已实现

- `runDesignAgent` 创建独立 design 会话，固定加载设计提示词和三个设计 Skill；不自动发现上传目录的指令。
- 单个 `read_design` 工具分派 catalog、claim、evidence 三种只读操作。事实受服务授权范围限制；原文读取复用 DocumentAccess，目前仅支持授权段落定位。缺少原文访问条件时明确拒绝，不把摘要当原文。
- 模型只生成计划与页面正文；服务补齐身份、版本、时间、快照引用和指纹。最终结果经过 Schema、交叉引用、主体匹配和读取凭证检查。
- 默认最多一次结构修正；取消、超时、截断、模型与工具预算、上下文和可选费用预算均可停止执行。失败候选不作为成功结果返回。
- 正常执行返回候选或缺资料／缺组件等停止状态，清理会话资源。尝试记录只保留内存中的问题摘要和版本 ID，尚未接入成果持久化。

## 使用入口

入口为 `apps/server/src/agents/design/agent.ts` 的 `runDesignAgent(options)`。调用方传入 `input`、服务构造的 `trusted`、Schema `registry` 和显式 `config: ModelConfig`；不能从模型或客户端直接接受可信授权上下文。可传 `evidenceAccess`、更低的 `limits`、`maxRepairRounds: 0 | 1`、`spendBudget` 和取消 `signal`。

学习顺序：先看 `tests/integration/design-agent.test.ts` 的成功案例，再看 `context.ts` 的提示组装与成果封装、`tools/design.tools.ts` 的授权读取，最后看 `agent.ts` 的执行循环。测试中的网关是脚本响应，不是模型。

开发容器内可执行 `pnpm test:design`（69 项协议 + 16 项 SDK 测试）。尚无设计业务 CLI 或 HTTP 入口；不要直接在宿主机启动 SDK。真实模型配置和凭据当前缺失，下一步在隔离环境设置显式模型及费用上限后，用小型合成任务验证真实生成质量。

## 实际验证

断网、只读根文件系统、普通用户、禁提权及限制资源的 `infodesign-design-runtime-20261011` 容器中执行：

```sh
node --test tests/integration/contracts-validator.test.ts tests/integration/contracts.test.ts tests/integration/contracts-service.test.ts tests/integration/contracts-regressions.test.ts tests/integration/contracts-design.test.ts tests/integration/design-agent.test.ts tests/integration/generated-types.test.ts tests/integration/pi-session.test.ts tests/integration/pi-proxy.test.ts tests/integration/evidence-agent.test.ts tests/integration/evidence-replay.test.ts tests/integration/spend-budget.test.ts tests/integration/evidence-quality.test.ts tests/integration/review-runtime.test.ts
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.server.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

结果：275/275 通过（默认测试集合 260 项，加显式审查运行时 15 项），两份 TypeScript 检查通过。生成文件一致性测试包含在上述集合中。新增 16 项覆盖完整工具调用、独立会话、未读事实拒绝、一次修正、截断、越权、原文读取、输入篡改、预算、费用、取消、超时与网关错误。

## 限制

真实模型生成与语义质量为 `not_run`。目前组件只有有限协议形状，没有渲染实现；目录测试不证明生产组件可用。关系、事件和素材尚无专门详情工具，原文补查仅支持段落。独立页面审查、浏览器验收、持久化、局部修改与发布均未接通。现有自动校验不等于事实或文案语义正确。
