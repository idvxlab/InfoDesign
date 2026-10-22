# InfoDesign 全库导读与事实审查 Agent 接手说明

核对日期：2026-10-10。代码基线：`snapshot/2026-10-10-multimodal-reader`，提交 `02cb140`；开始检查时工作区干净。本说明来自静态源码、协议、测试代码和文档核对；本轮未运行项目测试、启动服务或调用业务模型。

## 1. 先理解当前交付是什么

这是“完整产品的目录骨架 + 已实现的事实处理基础”，尚不是能上传企业资料并生成页面的完整产品。

- B1：事实数据协议、Schema 校验、来源/权限/版本校验已有实现。
- B2：真实 Pi SDK 会话、受控工具、执行预算、取消和资源释放已有实现。
- B3：信息与证据 Agent 已实现首次生成候选快照的本地任务；尚不支持现有快照更新。
- PDF 解析：已实现原生文字、图片区域、带矢量边框的表格候选及本地来源检查页面。
- SourceBundle / read_source：已实现来源包验证及受控读取，但尚未接入 B3。
- B4：审查提示词、Skill、公共会话和预算已有基础；审查 agent.ts、context.ts、review.tools.ts 仍是占位。
- B5/B6：提取—审查—修正工作流、业务 HTTP API 和持久化仍待实现。
- 页面侧：设计 Agent、渲染器、组件和前端仍主要为占位。

附件要求的是资料理解、信息组织、视觉表达、页面生成、迭代和验证的完整能力。三个 Pi 角色、双阶段审查以及 InformationPlan/PageSpec 是仓库的实施设计；不要把设计方案或需求目标当作已有功能。

## 2. 全库地图

下列路径相对于仓库根目录；查看代码时可直接在编辑器按路径打开。

| 目录/文件 | 职责 | 当前状态及阅读优先级 |
| --- | --- | --- |
| README.md / status.md / SNAPSHOT.md | 入口、当前阶段、快照范围与验证摘要 | 先读；历史原始报告未随快照上传 |
| docs/design/ | 全系统架构、协议、流程、溯源、验收 | 方案不等于实现；部分进度文字仍停留在旧阶段 |
| docs/development/backend-plan.md | B0—B6 阶段和职责、测试案例 | 你重点读 B4 和 F06—F13 |
| apps/server/src/agents/evidence/ | 提取执行入口、输入准备、提示词和 Schema 上下文 | 学习实现方法的主入口 |
| apps/server/src/agents/review/ | 审查入口、输入准备、提示词 | 你的主要实现区域，前两个文件尚空 |
| apps/server/src/agents/design/ | 信息组织和页面规格生成 | 占位，可暂缓 |
| apps/server/src/agents/component-engineer/ | 可选组件开发 | 占位，非首轮核心角色 |
| apps/server/src/runtime/pi/ | Pi SDK 适配、资源加载、受控读工具、预算、事件与传输 | 已有实现，应复用 |
| apps/server/src/tools/ | 各角色工具入口 | evidence.tools.ts 已转接读取工具，其他角色仍占位 |
| apps/server/src/domain/ | 业务规则与存储抽象 | 候选内存保存、提取校验、来源包已有实现；页面版本、影响分析、溯源服务等仍占位 |
| apps/server/src/entrypoints/ | 可执行入口 | b2-probe.ts、b3-evidence.ts 已实现；API/worker/preview-worker 占位 |
| apps/server/src/config/env.ts | 模型配置读取和校验 | 已实现，不把模型密钥放进提示词 |
| apps/server/src/orchestration/ | Router、工作流、状态推进 | 占位；当前没有完整多 Agent 自动串联 |
| apps/server/src/api/、infrastructure/ | HTTP、鉴权、队列、数据库、对象存储等 | 占位为主 |
| services/parser/ | Python PDF 解析和来源预览 | pipeline.py → pdfplumber_adapter.py → source_locator.py / preview.py；非最终企业页面生成器 |
| packages/contracts/schemas/ | 权威数据格式 | 事实阶段已实现；设计/页面等占位 Schema 继续拒绝输入 |
| packages/contracts/src/ | Ajv 校验、服务规则、内容指纹 | 审查输入输出已有校验可复用 |
| packages/contracts/generated/ | 从 Schema 生成的 TS 类型 | 用来查类型，不手工修改 |
| packages/page-renderer/、ui-components/ | 页面渲染、图表、关系、来源组件 | 占位，可暂缓 |
| apps/web/ | 上传、编辑、预览、证据面板 | 占位，可暂缓 |
| skills/ | 各业务角色的方法规则 | 重点看提取、归并、事实审查三个 Skill |
| design-references/ | 视觉知识与参考来源 | 当前事实审查阶段可暂缓 |
| tests/integration/ | 协议、权限、Pi 运行层及提取等程序测试 | 注意实际测试与占位测试混在同一目录 |
| tests/fixtures/synthetic/ | 合成原文、输入输出、合法/非法案例 | 最容易理解协议的入口；不是企业生产资料 |
| tests/e2e/ | 最终页面端到端测试 | 占位 |
| evals/ | 评测设计、案例、评分器位置 | run.ts 和 graders 仍占位；真实入口目前在 entrypoints |
| scripts/、deploy/ | 开发容器、类型生成、协议校验和解析命令 | 开发与解析部分已有；不能把 Dockerfile 文件存在视为服务完成 |
| .github/workflows/ | CI、评测、部署 | 手动触发并明确失败的占位 |
| package.json / pnpm-lock.yaml / tsconfig* | 命令、依赖锁定、类型检查 | 学会查脚本；没有完整产品 dev/build 入口 |
| snapshot-manifest.json | 发布快照的文件哈希清单 | 快照记录，不是程序入口 |

## 3. 同学是怎样搭建提取 Agent 的

当前代码中的调用链：

```text
entrypoints/b3-evidence.ts（显式真实验收入口，固定合成资料）
  → runEvidenceAgent(input, config, registry, store)
  → prepareEvidenceInput：检查首次生成输入、授权和版本
  → createEvidenceTools：绑定受控 read_document
  → createBusinessSession(..., 'evidence')：新建独立 Pi 会话
  → evidenceTaskPrompt：任务、资料目录、预算、输出信封、Schema
  → session.prompt：模型读原文、提取、提交严格 JSON
  → validateEvidenceCandidate：程序校验
  → MemoryCandidateStore：追加 invalid 或 pending_review 记录
  → 如有结构问题，最多再修正一次；结束后释放会话
```

### 各层解决什么问题

1. `agents/evidence/agent.ts` 是任务执行器。管理开始、调用、取结果、验证、修正、保存和清理，不直接用固定规则生成事实。
2. `context.ts` 准备任务输入。模型先看到资料目录和块编号，原文经工具读取；程序生成快照编号、版本、时间和执行来源，要求模型原样返回。
3. `prompt.md` 定义角色边界和输出约束。`skills/evidence-extraction/` 提供提取方法，`skills/evidence-reconciliation/` 提供归并、口径与冲突处理方法。
4. `runtime/pi/skill-loader.ts` 从固定仓库路径读取这些文件并拼入 systemPrompt。当前不是让模型自动扫描 skills 目录；自动资源发现被关闭。
5. `session-factory.ts` 调用锁定的 `@earendil-works/pi-coding-agent@0.99.1`。每次有独立临时目录、内存会话和明确模型；禁用内置工具及个人开发资源，只开放传入的自定义工具。
6. `read-document-tool.ts` 用资料 ID、版本 ID、块 ID 读授权原文，拒绝任意路径和越权请求；保存成功读取回执。模型不能仅声称“已经读过”。
7. `result-validator.ts` 检查结构、实际读取、来源、覆盖、重复和冲突，以及修正是否偷偷删除事实。它不判断全部语义，因此通过后仍待独立审查。
8. `evidence.service.ts` 目前只有追加式内存候选仓库，进程退出后不持久保存；不存在生产可用事实版本指针。

Pi 在这里负责模型与工具交互；项目程序负责权限、预算、验证和业务状态。增加审查角色应复用这个运行层，不用另起一套 harness。

### 输入与输出怎样看

- `DocumentIR`：带版本、原文块、位置和解析质量的资料表示。
- `EvidenceInput`：本次授权任务及这些资料。
- `EvidenceOutput.candidateSnapshot`：候选信息集合。
- `EvidenceSnapshot`：实体、claims、relations、events、evidence、conflicts、missing、coverage 等。
- `ReviewInput`：待审版本/指纹、资料、范围、必要检查。
- `ReviewOutput.report`：结构化 ReviewReport。

例如“2025 年末在册研发人员 60 人”应拆成主体、属性、数值、单位、时间、口径和证据引用。“有原文支持”的 supportStatus 与“已经独立审查”的 reviewStatus 分开；B3 不得自行标为审查通过。

推荐先并排看 `tests/fixtures/synthetic/b3-evidence-input.json`、`raw/company-profile.txt`、`snapshot.json`、`review-input.json`、`review-output.json`，再看相应 Schema。它们用于理解格式，不保证都是同一次执行的配套产物；B3 预期见 b3-evidence-expected.json。

### 当前边界

- 只支持首次生成，不接 existingSnapshot 更新。
- `read_document` 只接受 paragraph 定位；PDF 解析产物使用 page_region/image_region，不能直接串接。
- 来源包验证与 `read_source` 已有实现，但 EvidenceAgent 仍使用旧工具。
- 当前会话模型输入声明为 text，并设置 blockImages；图片引用不等于视觉模型输入。
- B3 的一次修正只修结构/来源问题；B5 的审查后事实修正尚未实现，不能照搬 B3“禁止改变有效事实值”的规则来阻止后续纠错。

## 4. 你接手的 B4 已有什么、缺什么

### 已有、可以复用

- `runtime/pi/session-factory.ts`：支持独立 review 角色。
- `runtime/pi/skill-loader.ts`：loadReviewResources。
- `runtime/pi/execution-limits.ts`：REVIEW_LIMITS，当前默认 180 秒、6 次模型调用、16 次工具调用、8192 输出 token、128000 上下文字节上限。
- `agents/review/prompt.md` 和 `skills/evidence-review/SKILL.md`：审查要求。
- `packages/contracts/schemas/agents/review-input.schema.json`、review-output.schema.json 和 review-report.schema.json：事实审查协议。
- `packages/contracts/src/service-checks.ts`：checkReviewInput、checkReviewOutput、evaluateAdoption。
- `packages/contracts/src/fingerprint.ts`：候选内容指纹。
- `tests/integration/review-runtime.test.ts`：真实 SDK 配合本地模拟网关，验证运行层；不验证真实模型语义。

### 尚需实现

| 工作 | 推荐落点 | 关键约束 |
| --- | --- | --- |
| 准备审查任务上下文 | agents/review/context.ts | 服务提供待审快照，绑定确切版本与指纹，不带提取者聊天历史 |
| 组织只读工具 | tools/review.tools.ts | 复用受控读取；能直接核对原文，不能修改事实 |
| 执行审查并收集结果 | agents/review/agent.ts | 独立会话、预算、取消、异常、资源释放 |
| 验证与保存报告 | 复用 service-checks 并增加必要运行层验证/报告存储 | 不能仅信任模型自述检查完成；与实际读取记录对应 |
| 程序测试 | tests/integration/ 下新增 B4 业务测试 | 版本错配、无读取、越权、失败、遗漏检查等 |
| 显式真实验收入口 | entrypoints/ 下新增，按团队命名约定 | 正确候选与人为改错候选都测，记录检出和误报 |

`ReviewInput` 目前只有 subject 引用，不内嵌候选快照；现有 checkReviewInput(input, subjectSnapshot, registry) 也要求调用方另传候选。实现 context 时必须明确从受控存储取得快照并核对指纹，不能指望模型凭 snapshotId 自行访问数据库。

### 接手前需对齐的协议细节

这些是源码阅读发现的接口问题，不是本轮已修复的问题：

- 审查提示词写每项 issue 都需 claim/evidence 引用，但 Schema 允许这些字段缺省。真实“漏提事实”可能没有候选 claimId；当前服务还要求 evidenceRefs 指向候选 evidence 集合。需与公共后端明确如何引用审查新发现的原始证据，不能编造候选 ID。
- 提示词允许 not_applicable，但服务对 checksRequired 的采纳条件是全部 pass。必须区分“允许报告某项不适用”和“必要检查能否免除”，不能由模型自行放宽。
- read_source 的物理定位支持已经比原 B1/B3 段落路径更广；后续接 PDF 审查时，要核对 checkReviewInput 的资料校验与来源包验证能否兼容，不只替换工具名称。
- checkReviewOutput 已有结构、引用、版本、结论约束，但并不证明审查者实际读取证据。B4 应增加运行记录与报告的对应验证，语义正确性再通过真实模型案例验收。

## 5. 最小学习与开发顺序

1. 看合成原文及 snapshot/review 示例，理解“一条事实”和“一条审查问题”长什么样。
2. 阅读 evidence/agent.ts，沿函数调用读 context.ts、evidence.tools.ts、read-document-tool.ts。
3. 阅读 evidence/prompt.md 和提取/归并 Skill，区分提示规则与程序强制规则。
4. 阅读 session-factory.ts、skill-loader.ts、execution-limits.ts，理解独立上下文与工具权限。
5. 阅读 result-validator.ts 和 checkReviewInput/checkReviewOutput，明确程序已经替你检查什么。
6. 阅读 review 的提示词、Skill、Schema 和 review-runtime.test.ts，开始实现 B4。

建议 B4 第一小阶段用现有合成段落资料完成闭环；多模态接入可与负责提取/解析的同学协作，不必等待前端或整站生成完成。该顺序是接手建议，不改变 status.md 中公共后端当前的多模态接入计划。

最小语义验收：正确候选可以 pass；把 60 改为 600、替换主体/年份/单位应定位错误；删除必需事实应发现遗漏；关键冲突不能直接放行；无来源或工具失败必须如实报告。审查只提交报告，工作流决定修正、等待或采纳。

## 6. 验证证据与环境提醒

SNAPSHOT.md 记录历史 245/245：既有回归 175、SourceBundle 33、read_source 22、审查运行时 15。原始运行报告未随快照上传；本轮只核对源码和记录，没有重新确认这些测试在当前机器通过。

根 package.json 的 pnpm test 明确列出旧测试文件，不自动包括后三个新增测试文件。准备好隔离环境后按 SNAPSHOT.md 单独执行它们。evals/run.ts 和多个 e2e/workflow 测试仍是占位，不能用其退出成功作为能力证明。

已有真实 B3 历史记录存在提示词版本边界：前两组为 v3、覆盖组和关系补验为 v4，完整 v4 三组回归未执行。更不能据此声称达到需求书的事实准确率等目标。

开发说明主要基于 Mac/Docker，解析依赖说明锁定 Linux ARM64；当前工作区是 Windows。本轮没有验证 Windows/WSL/Docker 的实际适配，不保证原命令直接在 PowerShell 可用。后续先核对容器与平台，再运行项目测试和 Pi。

本轮仅新增本导读并在 status.md 登记文档进展；未修改业务代码、安装依赖、启动服务或使用模型凭据。
