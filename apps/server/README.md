# 后端模块

B2受控读取、B3受控提取、B4独立事实审查及B5本地工作流已有验收。当前主仓库422项离线回归及类型／协议通过；B5有限返修与缺证等待的同版虚构真实路径、文件历史跨进程回读已验证。HTTP、队列、生产数据库和自动恢复尚未接通；Router与三类角色职责保持原设计。详见[B5报告](../../docs/reports/b5-fact-workflow-2026-10-12.md)。

- `src/config/env.ts`：显式配置、URL 和凭据校验；保留显式选定的模型文件中的 `compat.maxTokensField`，不自动读取 `.env` 或个人 Pi 配置。
- `src/runtime/pi/`：Pi SDK 0.99.1 会话工厂、受控资源、唯一读取工具、执行限制、诊断与最终结果校验；`model-transport.ts` 为每个会话显式使用运行时已有的环境代理并释放连接池，避免 SDK 导入覆盖全局调度器的影响。
- `src/entrypoints/b2-probe.ts`：需要显式启用的真实验收 CLI，默认拒绝运行。

在隔离容器的仓库根目录运行 `pnpm test:b2`；使用真实 SDK 对接本地模拟网关，不消耗外部模型额度。`pnpm check:types` 包括后端源码和集成测试。

每个任务使用独立的内存会话记录和临时工作区，只开放本轮选定的 `read_document` 或 `read_source`；不提供内置 Shell 或任意文件读写能力。读权限由可信调用方给定，模型不能增加项目或资料范围。最终 JSON 必须通过 Schema，并与本任务成功读取的回执一致。

代理修复后的单次真实任务已成功：2 次模型响应、1 次受控读取，最终结果通过结构和原文一致性校验，见 [验收通过记录](../../docs/reports/b2-live-success-2026-10-10.md)。B2 最小运行任务通过；B3 当前真实测试与版本边界见 [最新补验与版本边界](../../docs/reports/b3-v4-focused-success-2026-10-10.md)。两次历史失败和离线修复证据保留；执行方式、预算及类型检查边界见 [B2 报告](../../docs/reports/b2-runtime-2026-10-10.md)。

首次失败后的无网络诊断发现并修复了模型文件兼容项丢失；首次失败的具体传输原因仍无原始证据。新增传输诊断只记录 fetch 尝试数、HTTP 状态和固定错误码；详见 [诊断报告](../../docs/reports/b2-provider-diagnosis-2026-10-10.md)。

B3 入口为 `src/agents/evidence/agent.ts` 的 `runEvidenceAgent`，由可信调用方提供 `EvidenceInput`、模型配置、Schema 注册表和候选存储。`domain/result-validator.ts` 在 B1 检查之外核对本次实际读取、完整覆盖、运行来源及修正保留；`MemoryCandidateStore` 只在进程内追加保存，不维护已采用版本指针。`pnpm test:b3` 运行断网模拟验证。真实入口 `pnpm eval:b3 --live` 需要显式开关、私有报告路径及足够的既定用量授权；5元累计授权使用专门的私有台账入口；单段、三组合成任务及一次获批v4补验均已结束，成功后停止追加调用，费用机制见 [费用预留报告](../../docs/reports/b3-budget-preflight-2026-10-10.md)。

早期单段执行及失败修复分别见 [初次报告](../../docs/reports/b3-live-2026-10-10.md) 和 [历史重验](../../docs/reports/b3-live-recheck-2026-10-10.md)。后续单段回归已通过；原v3三组中的数值/单位与冲突组通过，覆盖组因operates关系过强失败；后续同资料v4补验保留belongs_to归属关系，程序与语义均通过。候选保持待审，原结果见 [真实矩阵报告](../../docs/reports/b3-synthetic-live-2026-10-10.md)，最新结果见 [v4补验](../../docs/reports/b3-v4-focused-success-2026-10-10.md)。B4后续验收见[多模态阶段报告](../../docs/reports/pi-multimodal-review-100cny-2026-10-10.md)。

运行事件仅记录白名单停止原因与分次用量。B3 的 `repairAttempts` 表示进入的修正尝试；非正常结束的可用正文保存在私有无效版本中，长度结束单独报告为 `output_truncated`，不自动重试。

取消／超时先保留 SDK 实际交付的部分正文再停止，绝不提交可用候选；没有新响应时不复制上一轮正文。`schema-context.ts` 仅从三份权威 Schema 裁去不可达公共定义，程序验证始终使用完整协议。当前提示版本为 `evidence_b3_v4`，新增关系动词与主体角色的来源约束，175项离线检查通过；v4关系语义在97字覆盖组补验通过；未重跑前两组，不能称为v4三组实测通过。

可信调用方可传入 `spendBudget: RequestSpendBudget`，要求每次模型请求前持久化保守费用预留；额度不足或写盘失败会停止且不发请求。未报告用量的费用不自动返还，报告超出预留边界时取消后续请求。金额策略和台账由调用方提供，模型输入无权设置；不将预留金额称为实际账单或网关硬配额。该接入阶段155项离线检查通过，175项为该历史阶段结果；当前验证见本页开头及B5报告。


## B5本地入口

- `orchestration/fact-workflow.ts`：真实独立Pi任务之间的程序编排、最多2轮语义返修、等待及停止分支，不采纳事实。
- `domain/fact-run.service.ts`：本地私有、不可改写的运行历史；保存输入、候选、报告、问题和实际调用，支持跨进程读取，不提供生产恢复。
- `runtime/pi/external-budget-gate.ts`、`entrypoints/b5-fact-workflow.ts`：固定虚构验收的预算预检及CLI。必须由受信隔离启动器接入既有逐请求预算代理；只读账本检查不等于隔离。

容器内`pnpm test:b5`为离线模拟检查，`pnpm eval:b5`默认关闭。真实入口的开关、环境变量及退出码见[B5报告](../../docs/reports/b5-fact-workflow-2026-10-12.md#cli与复现范围)。不得直连网关绕过原累计预算；不得根据CLI退出0推断事实passed，缺失案例的正确结果是等待。
