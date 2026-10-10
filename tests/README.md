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

代理修复的 106 项离线回归、直接执行命令与候选镜像验证边界见 [代理修复报告（历史记录未随快照上传）](../SNAPSHOT.md#verification)。

- `integration/evidence-agent.test.ts`：B3 的 36 项回归，包括真实 SDK 经模拟网关读取资料并保存待审候选、独立上下文、权限、覆盖、结构修正与失败版本、冲突及缺失保留、预算／取消／超时、存储失败、默认关闭真实验收，以及逐请求费用写盘、额度不足／写盘失败阻止网络、报告用量超界后停止。
- `integration/evidence-replay.test.ts`：9 项全合成历史错误结构回放、关系确定程度边界及 Schema 引用闭包检查。人工语义标注与程序结果分开，包括名称过强、无依据别名、partial 过度推断、重复覆盖、多块范围及明确名称的正例。

- `integration/spend-budget.test.ts`：5 项费用预留检查，覆盖累计额度、安全余量、持久化失败、跨任务恢复、历史篡改、整数金额与用量超界。

`pnpm test:b3` 当前执行 69 项；最新全量 175/175 通过。这些检查不代表真实模型的语义提取质量，详见 [费用预留报告（历史记录未随快照上传）](../SNAPSHOT.md#verification) 和 [离线加固报告（历史记录未随快照上传）](../SNAPSHOT.md#verification)。

B3 新增 HTTP 200 下的输出截断、修正失败时的真实尝试计数与两个失败版本保留、未知供应商停止码不泄漏错误等回归；模拟结果及真实失败的证据边界见 [重验报告（历史记录未随快照上传）](../SNAPSHOT.md#verification)。

- `integration/evidence-quality.test.ts`：19项独立合成质量矩阵回归，真实SDK连接环回模拟网关；覆盖小数/零值/百分比/单位、年份/季度/口径、真/假冲突、双来源归并、完整日期/范围、缺失/解析空块、跨资料同块编号及修正保留。编号/顺序/合法同义属性变体均可处理。7个语义负例显式证明程序接受不能替代语义审查。

矩阵输入、参考成果与人工清单位于 [b3-quality](fixtures/synthetic/b3-quality/README.md)；辅助回放器位于 `integration/fixtures/evidence-quality.ts`，不提供生产语义判断。报告见 [质量矩阵验证（历史记录未随快照上传）](../SNAPSHOT.md#verification)。三组真实模型测试已经执行，原批次及已完成的单组v4补验范围见 [执行与补验记录](../evals/cases/b3-quality-matrix.md)。

原v3矩阵为2组语义通过、1组关系需修正；第三组后续v4单次补验的12项程序检查及全部输出语义核对通过。v4三组完整真实回归未执行。69项B3/175项全量及类型/协议/生成检查在同一v4镜像此前通过，本轮源码未变而未重复运行；详见 [补验结果与版本边界（历史记录未随快照上传）](../SNAPSHOT.md#verification)。

PDF 解析切片新增 `services/parser/tests/test_pipeline.py` 的 16 项实际合成 PDF 回归，可用 `bash scripts/parser-container.sh test` 在独立断网镜像执行。真实样本与合成表格另经 `node scripts/check-parser-output.mjs` 检查 DocumentIR、指纹与坐标，5 组篡改反例均拒绝；结果与浏览器核验边界见 [PDF 报告（历史记录未随快照上传）](../SNAPSHOT.md#verification)。该模块不调用 Pi 或模型。
