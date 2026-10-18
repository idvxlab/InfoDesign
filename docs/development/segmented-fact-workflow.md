# 分段事实核心

入口为 `apps/server/src/orchestration/segmented-fact-workflow.ts`。受信调用方提供唯一段 ID 与完整 EvidenceInput；服务层的原权限、来源与协议校验继续生效，上传资料不能自授范围。

`runSegmentedFactWorkflow` 顺序复用真实 `runFactWorkflow`，每段创建独立候选／审查存储与 Pi 会话，保留失败输入、候选、报告和停止原因。原工作流最多两轮语义返修；本核心不引入 Supervisor、设计 Agent 或额外预算权限。

`mergeReviewedSegments` 核对完整计划、段唯一性、输入指纹、当前候选、最新绑定审查报告和会话独立性。缺段、空候选、陈旧／不匹配报告、未解决冲突或关键缺失不能通过。合并结果保留来源与各段原始对象；它是去重视图，不是新 EvidenceSnapshot、正式采纳或完整页面。

专项 `tests/integration/segmented-fact-workflow.test.ts` 的 40 项已纳入默认 `test` 和 B4 类型检查。专项使用真实 SDK 和容器内合成 SSE 响应，不代表真实模型质量。

```bash
node --test tests/integration/segmented-fact-workflow.test.ts
node --run test
node --run check:types
```

命令在匹配锁文件的开发容器内执行。整仓类型检查目前受官方设计端缺失依赖阻塞，详见[发布记录](../reports/segmented-release-candidate-2026-10-18.md)。

本核心尚未实现 PDF 自动切分、原页区域映射、跨进程失败段恢复、API、队列或自动发布。完整 PDF 的真实分段提取／审查仍待独立接线和验收；不能用内存核心通过推断全文已成功。
