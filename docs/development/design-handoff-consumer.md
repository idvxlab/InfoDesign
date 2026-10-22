# 设计侧交底消费入口

2026-10-12：依据同学提供的 [交底要求](design-handoff.md) 实现。原文保持不变；其中设计端占位描述对应上游分支，不代表本分支实现状态。

## 服务端怎么接

入口为 `apps/server/src/domain/design-handoff-consumer.ts` 的 `runDesignFromHandoff`。服务端装配示意（这些变量必须由业务服务准备）：

```ts
import { verifyDesignHandoff } from './design-handoff.ts';
import { runDesignFromHandoff } from './design-handoff-consumer.ts';

const outcome = await runDesignFromHandoff({
  submitted: handoffPackage,
  authority: { store: factRunStore, verifyDesignHandoff },
  pins: trustedHandoffPins,
  registry,
  request: designRequest,
  runtime: { config, limits, spendBudget },
});
```

`authority` 必须注入同学的真实核验函数和事实运行记录 store，不能从 HTTP 请求或模型输出取得。每次启动前调用完整四参数 `verifyDesignHandoff(submitted, store, registry, pins)`。本地旧快照没有 B5 模块，因此采用依赖注入，不复制或覆盖同学实现；合并双方代码后由服务端完成上述装配。

`pins` 从可信任务上下文获得：runId、projectId、上游 taskId/attemptId、明确的 expectedCandidateVersionId/expectedReportVersionId、allowedDocumentRefs 和非空 checksRequired；不能从提交包自行推导授权。

`request` 包含新的设计 taskId/attemptId、audience、goal、visualGuidance、constraints、catalog、theme。目录和主题由服务端授权。`runtime` 使用现有 Pi 模型配置、调用限制、费用预算，可另传取消信号；在项目开发容器内运行。

## 数据与停止语义

- 上游 ready 包可保留快照和事实的 pending 状态。只有独立报告 pass、真实交底核验及版本绑定通过后，才允许设计使用其中 supported 的 pending 事实；不改写快照，不执行事实采纳。
- 服务生成 reviewRef，绑定上游任务、候选与报告版本及指纹、交底指纹和必需检查。DesignInput、DesignOutput、InformationPlan、PageSpec 均保留该引用。模型只生成正文，不能赋予自己审查权限。
- reviewRef 是溯源信息，不是独立授权凭据。单独提交它不能绕过可信 context 校验。已通过审查的旧输入仍兼容，不强制添加该字段。
- 核验失败返回 stage=handoff、status=blocked，modelCalls/toolCalls 均为 0，不产生候选。设计阶段的 blocked 仍表示组件不足，调用方用 stage 区分。
- 仅在 stage=design、status=completed 且存在 output 时接收两份候选。候选不等于发布成功，仍待持久化、渲染与页面独立审查。
- 原文读取来自经核验的 documents，访问范围仍受 pins.allowedDocumentRefs 限制；当前设计原文工具只支持段落。

## 验证

容器内执行 `pnpm test:design`（98 项）、`pnpm check:types`、`pnpm check:generated`。合并上游真实 B5 模块和其测试辅助文件后执行 `pnpm test:design-handoff`（12 项）；缺少上游时该命令明确失败，不跳过或伪造核验。

本轮已在独立目录以远程默认分支真实代码加设计改动验证 12 项，并与上游 24 项交底测试一同通过。Pi SDK 真实执行，网关响应为本地模拟。详细命令与边界见[验证报告](../reports/design-handoff-consumer-2026-10-12.md)。
