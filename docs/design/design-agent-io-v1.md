# DesignInput / DesignOutput v1

本协议是设计 Agent 的任务边界。首次生成的 Schema 和服务校验已实现；Pi 会话与受控工具已接入并通过模拟网关验证，真实模型生成质量尚未验证。保持同一个设计角色，不增加新的 Agent，不修改其他同学负责的事实或审查业务。

## 输入：服务交给 Agent 的设计任务

| 字段 | 含义 |
| --- | --- |
| protocolVersion、projectId、taskId、attemptId | 固定协议 1.0 与任务身份，由服务赋值 |
| taskType | 首版仅 generate，暂不接受修订任务 |
| snapshot、snapshotRef | 授权事实快照及准确版本／内容指纹；本切片传完整授权快照 |
| reviewRef（可选） | 可信交底核验后由服务填入的候选、报告及交底绑定；不是权限令牌 |
| audience、goal | 受众与展示目标，输出计划必须保持一致 |
| visualGuidance | 视觉指导文本；这里只检查格式，是否遵循仍需语义／视觉验收 |
| constraints | language、maxSections、maxNodes；程序检查输出是否遵守 |
| catalog | 目录 ID、版本、指纹及已授权可用组件的 ID／版本 |
| theme | 主题 ID、版本、指纹及可用 token |
| pageSpecVersion（可选） | 服务指定 1.0 或 1.1，默认 1.0；与可信上下文一致，不由模型升级 |
| resources（可选） | 与可信上下文一致的图片资源映射，不含任意 URL |

可用组件为空仍是合法任务输入：Agent 应报告能力不足，而不是猜组件。首版目录条目只支持已有 PageSpec 中约定的四类接口；完整组件说明由可信 Schema 和将来的固定工具提供，不允许上传任意可执行 Schema。目录版本和指纹由可信服务提供，本校验器不把模型自报的目录当已实现组件。

服务必须在下发前保存完整输入的 inputHash 和独立的 DesignTaskContext。context.design 保留项目／任务、固定快照指纹、允许使用的记录、可信目录与主题。不得从模型回复构造这个 context。输入快照的全部实体／事实／关系／事件／素材都要属于服务授权集合；原文和证据内容的访问授权由提供快照的服务负责。首版不是按权限动态裁剪资料的接口。

## 输出：候选成果或停止原因

所有结果包含协议、任务身份、inputHash、status、producedBy（design）。

| status | 必需内容 | 禁止内容 |
| --- | --- | --- |
| completed | informationPlan 与 pageSpec 成对提交 | stopReason、requirements、事实快照或发布字段 |
| needs_information | stopReason 和非空 requirements，kind=information | 计划／页面候选 |
| blocked | stopReason 和非空 requirements，kind=component；首版专用于组件能力缺口 | 计划／页面候选 |
| failed | stopReason；用于执行错误等失败 | 候选及 requirements |

每条 requirement 包含 kind 和具体 description，不扩大权限。所有结构关闭未知字段。首版不在停止响应中保存部分计划；未来如需断点恢复，应另行定义中间状态协议。

## 如何使用校验器

`packages/contracts/src/design-agent-checks.ts` 提供：

```typescript
checkDesignInput(input, registry, trustedContext);
checkDesignOutput(output, input, registry, trustedContext);
```

输入检查绑定服务保存的 inputHash、项目／任务／尝试、快照审核状态与版本、授权记录及目录／主题。输出检查要求它对应同一输入；completed 时复用 checkDesign 检查 Plan/PageSpec，并检查受众、目标、语言和数量限制。计划仍有 openIssues 时不能报 completed。

**校验返回 ok=true 不表示任务成功或页面已通过审查。** needs_information、blocked、failed 也可以是格式和身份都正确的响应。调用方必须同时判断 output.status；completed 也只是候选设计，后续仍需实际渲染与独立审查。

格式合法与完整输入指纹只能阻止无声替换，不能证明内容真实、审查充分或视觉效果良好。上游传入的快照须已经由可信服务验证；该接口不代替原文检查、证据访问控制或页面审查。

## 第一版的边界

2026-10-20：服务可显式启用 [PageSpec 1.1](page-spec-v1.1.md)，目录扩展到十二种固定接口，提供关系/事件/素材读取。下列首版边界保留为 1.0 历史范围；1.1 仍不支持发布或局部修订。

- 小任务输入有大小和深度上限；超过时拒绝，不自动截断。大资料索引／按需补查工具留到会话接入阶段。
- 不包含资产下载地址、Shell、任意 URL、JS 或动态代码执行权限。
- Plan/PageSpec 现有组件与交互范围保持不变。设计阶段不更改公共 Task 的事实阶段枚举，也不启用页面发布协议。
- 测试通过不代表真实模型已能生成结果；合成测试的 passed 状态是测试装配，非真实审查证据。

运行入口、受控工具、正文与服务元数据分工及验证边界见[运行时记录](../reports/design-agent-runtime-v1-2026-10-11.md)。下一步进行有预算的真实模型小样本验证。

调试实现更新：模型提示只携带正文 Schema 的递归引用闭包，完整服务端校验不变。可由受信任调用方显式设置 onDraft 保存未验证正文；默认不保存、不纳入有效结果，详见[输出排查记录](../reports/design-agent-output-debug-2026-10-11.md)。

2026-10-12：新增可信交底消费路径。通过真实 verifyDesignHandoff 核验的 ready 包可保留 pending 快照和事实；服务独立保存 reviewRef，输入与全部成果必须匹配该绑定。未核验的 pending 输入继续拒绝，既有 passed 输入保持兼容。详见[对接入口](../development/design-handoff-consumer.md)。
