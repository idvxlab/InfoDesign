# 软件测试

已实现 B0/B1 的协议与校验测试，以及 B2、B3 真实 SDK 对本地模拟网关的集成测试，使用 Node 内置 `node --test`（Node 24 直接运行可擦除类型的 `.ts`）。
运行时校验依赖 Ajv 与格式插件；静态检查使用锁定的 TypeScript 和 Node 类型声明。

```bash
pnpm test
pnpm check:types
pnpm check:contracts
```

覆盖文件：

- `integration/contracts-validator.test.ts`：Ajv 适配器的关键字正反例、严格编译、完整日期格式、2020-12 关键字、输入不变性与错误路径。
- `integration/contracts.test.ts`：权威 Schema 的结构层正反例、占位协议拒绝、指纹一致性。
- `integration/contracts-service.test.ts`：引用、版本、权限、位置回查、指纹与采纳的服务层校验。
- `integration/contracts-regressions.test.ts`：复核报告 R1–R11 的正式回归（权限、审查状态、采纳一致性、定位与引用、非法输入不抛异常、无效日期）。
- `integration/generated-types.test.ts`：检查生成类型与 Schema 是否一致，以及重复运行生成器是否产生差异。
- `types/contracts.ts`：由 `tsc --noEmit` 单独检查的生成类型与调用方正反例；`@ts-expect-error` 确保缺少采纳上下文、错误事实类型或伪造审查状态不能静态通过。此文件不作为运行时测试执行。

- `integration/pi-session.test.ts`：真实 Pi SDK 与容器内 OpenAI SSE 模拟网关；覆盖独立会话、唯一工具、权限、输出依据、预算、取消、超时、资源清理、默认禁用真实调用及缺失／部分用量。可用 `pnpm test:b2` 单独执行。

`integration/lineage.test.ts`、`workflows.test.ts` 仍为注释占位。
普通测试不访问外部模型，也不启动业务 API；合成资料见 `fixtures/synthetic/`。
真实验收的独立显式入口与本轮结果见 `../docs/reports/b2-runtime-2026-10-10.md`。

模拟输出测试与真实模型接入测试分别验证，不能互相替代。真实模型验证需要明确授权，失败不自动重跑。

B2 后续回归还覆盖模型文件 `compat.maxTokensField` 到真实 SDK 请求体的映射、模型级覆盖提供方级配置、非法配置拒绝，以及 HTTP 状态／固定网络错误码的安全记录；不读取错误响应正文，不输出原始异常或凭据。

- `integration/pi-proxy.test.ts`：真实 SDK、本地 HTTPS 网关和 CONNECT 代理，覆盖导入前后代理路径、环境变量优先级、NO_PROXY、max_tokens、认证头、拒绝后不直连、无隐藏重试、取消、超时和 TLS 验证。测试子进程夹具位于 `integration/fixtures/pi-proxy-child.ts`；使用镜像自带 OpenSSL 创建临时证书，只在测试子进程中信任它，不改系统信任。新旧 B2 测试合计 31 项。

代理修复的 106 项离线回归、直接执行命令与候选镜像验证边界见 [代理修复报告](../docs/reports/b2-proxy-fix-2026-10-10.md)。

- `integration/evidence-agent.test.ts`：B3 的 36 项回归，包括真实 SDK 经模拟网关读取资料并保存待审候选、独立上下文、权限、覆盖、结构修正与失败版本、冲突及缺失保留、预算／取消／超时、存储失败、默认关闭真实验收，以及逐请求费用写盘、额度不足／写盘失败阻止网络、报告用量超界后停止。
- `integration/evidence-replay.test.ts`：9 项全合成历史错误结构回放、关系确定程度边界及 Schema 引用闭包检查。人工语义标注与程序结果分开，包括名称过强、无依据别名、partial 过度推断、重复覆盖、多块范围及明确名称的正例。

- `integration/spend-budget.test.ts`：5 项费用预留检查，覆盖累计额度、安全余量、持久化失败、跨任务恢复、历史篡改、整数金额与用量超界。

`pnpm test:b3` 当前执行 69 项；最新全量 175/175 通过。这些检查不代表真实模型的语义提取质量，详见 [费用预留报告](../docs/reports/b3-budget-preflight-2026-10-10.md) 和 [离线加固报告](../docs/reports/b3-offline-hardening-2026-10-10.md)。

B3 新增 HTTP 200 下的输出截断、修正失败时的真实尝试计数与两个失败版本保留、未知供应商停止码不泄漏错误等回归；模拟结果及真实失败的证据边界见 [重验报告](../docs/reports/b3-live-recheck-2026-10-10.md)。

- `integration/evidence-quality.test.ts`：19项独立合成质量矩阵回归，真实SDK连接环回模拟网关；覆盖小数/零值/百分比/单位、年份/季度/口径、真/假冲突、双来源归并、完整日期/范围、缺失/解析空块、跨资料同块编号及修正保留。编号/顺序/合法同义属性变体均可处理。7个语义负例显式证明程序接受不能替代语义审查。

矩阵输入、参考成果与人工清单位于 [b3-quality](fixtures/synthetic/b3-quality/README.md)；辅助回放器位于 `integration/fixtures/evidence-quality.ts`，不提供生产语义判断。报告见 [质量矩阵验证](../docs/reports/b3-quality-matrix-2026-10-10.md)。三组真实模型测试已经执行，原批次及已完成的单组v4补验范围见 [执行与补验记录](../evals/cases/b3-quality-matrix.md)。

原v3矩阵为2组语义通过、1组关系需修正；第三组后续v4单次补验的12项程序检查及全部输出语义核对通过。v4三组完整真实回归未执行。69项B3/175项全量及类型/协议/生成检查在同一v4镜像此前通过，本轮源码未变而未重复运行；详见 [补验结果与版本边界](../docs/reports/b3-v4-focused-success-2026-10-10.md)。

PDF 解析切片新增 `services/parser/tests/test_pipeline.py` 的 16 项实际合成 PDF 回归，可用 `bash scripts/parser-container.sh test` 在独立断网镜像执行。真实样本与合成表格另经 `node scripts/check-parser-output.mjs` 检查 DocumentIR、指纹与坐标，5 组篡改反例均拒绝；结果与浏览器核验边界见 [PDF 报告](../docs/reports/pdf-local-parser-2026-10-10.md)。该模块不调用 Pi 或模型。

## B4 事实审查（离线默认，真实评测需显式授权）

B4 审查只做事实审查：对候选事实逐条核对，报告保存在内存（`MemoryReviewStore`）中，不采纳也不改写候选事实；每次审查使用独立上下文，不共享会话。已实现的离线回归已加入默认命令：

```bash
pnpm test      # 默认离线全量，含 B4 七文件与来源/预算/视觉离线项
pnpm test:b4   # 单独执行七个 B4 文件
pnpm check:types
```

- `pnpm test`：默认离线全量，含 B4 七个文件 `integration/review-runtime.test.ts`、`integration/review-agent.test.ts`、`integration/review-validator.test.ts`、`integration/review-execution.test.ts`、`integration/review-source.test.ts`、`integration/review-cases.test.ts`、`integration/review-cli.test.ts`，以及来源/预算/视觉离线项 `integration/source-bundle.test.ts`、`integration/read-source.test.ts`、`integration/evidence-source.test.ts`、`dev-tools/pi-dev-budget-proxy.test.mjs`、`dev-tools/vision-budget-probe.test.mjs`。
- `pnpm test:b4`：单独执行上述七个 B4 文件。
- `pnpm check:types`：依次 `tsc --noEmit`、`tsc --noEmit -p tsconfig.server.json`、`tsc --noEmit -p tsconfig.b4-tests.json`；`tsconfig.b4-tests.json` 继承服务端配置的 strict，不加入 any 或忽略规则。

B4 离线七案例使用固定合成资料，覆盖：一条全部正确的正例；数值、单位、时间、主体各自出错；净利润缺失（`missing`）；以及同年同口径两来源冲突（`conflict`，需成功读取至少两份来源并引用两条证据）。负例期望 `revise`/`needs_input`，正例期望 `pass`；程序只根据结构化字段评分，不硬编码通过。

真实模型评测默认关闭（`pnpm eval:b4` 为 `node evals/run-b4.ts`）。启用需用户已有该次任务的真实模型用量授权，并同时提供 `--live` 与 `APP_RUN_LIVE_EVAL=1`，再显式给出 `--case <B4_CASE_ID>` 与 `APP_B4_REPORT_PATH`（私有、新建、`wx` 不覆盖的报告文件）；缺失或未知一律拒绝，不默认跑 all。`--budget-loopback` 只用于容器内固定预算代理放行 127.0.0.1/[::1]，不是任意域名放行；禁止在宿主运行 SDK，文档不贴任何凭据，不新增真实视觉请求。

2026-10-12，B4 v12同版七类虚构真实验收及独立审计通过，10次尝试中保留2次格式失败和1次连接失败；范围与质量限制见 `../evals/README.md`。最终独立断网`pnpm test`为382/382，三组类型、22个生成文件及协议9正/16负均通过。`review-cli.test.ts`新增5项评分一致性反例，包括结构化expected/actual相同、空白归一、缺失字段不伪造及适用类别/严重度边界；旧真实错误报告离线重放被新评分拒绝。详细证据见[阶段报告](../docs/reports/pi-multimodal-review-100cny-2026-10-10.md)。

## 提取／审查侧设计交付回归

`integration/design-handoff.test.ts` 新增24项，并注册到默认测试与`tsconfig.b4-tests.json`。在准备好的隔离容器内执行`pnpm test:handoff`，以真实Pi SDK＋本地模拟网关产生B5历史，验证返修后ready、缺失／冲突／上限／技术失败blocked、错误身份／版本／工件／来源、内容篡改与历史不变性。没有真实业务模型调用。最新主仓库446/446及类型／生成／协议结果见[交付报告](../docs/reports/design-handoff-2026-10-12.md)。

## 分段核心合并前验收（2026-10-18）

`integration/segmented-fact-workflow.test.ts` 的 40 项专项已登记默认测试和 B4 类型检查，覆盖独立会话、完整输入／快照指纹、最新报告、缺段、空结果和冲突拒绝。合并设计分支前的默认 504 项、费用扩展 7 项通过，生成／协议一致；官方设计端缺失依赖导致 45 条类型错误，不能称为整仓通过。见[本轮验证](../docs/reports/segmented-release-candidate-2026-10-18.md)。

## 设计 PR #1 合并检查（2026-10-18）

默认 test 保留上述全部文件、串行与 spec 报告，并追加设计分支的 contracts-design、design-agent、design-review-binding 三文件；test:design 与 test:design-handoff 也保留。check:types 继续包含根、服务端和 B4 三组配置。

当前 design-review-ref Schema／生成类型、design-review-binding.test.ts 与 design-handoff-consumer.test.ts 缺失，默认命令和设计命令会失败。不得删除登记或跳过这些文件来声称通过。已有设计测试使用真实 Pi SDK 和本地模拟网关，协作者历史 273／98／36 项的记载不代表合并版本复验通过；当前实际结果与诊断命令见[合并验证](../docs/reports/design-pr1-merge-2026-10-18.md)。
