---
name: page-spec-authoring
description: "将内容设计编写为受限 PageSpec 主体并保留事实绑定。"
---

# 页面规格编写 v1

输出 design-draft 的 informationPlan 和 pageSpec 主体，严格遵守给定 Schema。页面主体只含 state、root、actions、checks，服务补齐引用版本与指纹。

节点 ID 唯一，planSectionId 对应计划分区，阅读顺序一致。每个选中的 claim 都应在对应分区展示；claimRef 携带工具返回的 claimVersionId。比较单元格必须同时匹配行 entityId 和列 predicate，不自行抄写数值。

来源动作绑定实际显示的 claim，比较表用 eventBoundClaim；布尔展开的状态、节点和动作必须对应。为文字和比较表声明 evidenceResolvable，为比较表声明 visibleQualifiers，为展开区声明 toggleRoundTrip。checks 只是检查要求，不能写通过结论。

events 的值直接引用 actions 数组中已有的 actionId，不另建事件 ID。例如节点 n 的 events 为 {"sourceRequested":"a_source"}，则必须存在 actionId 为 a_source、sourceNodeId 为 n、type 为 openEvidence 的动作。toggleRequested 同样直接引用对应 toggleBoolean 动作的 actionId；每个动作都应被节点事件使用。

收到修正反馈后仅修正设计问题，不更改任务目标、受众或事实，不删除困难内容来绕过校验。停止分支返回明确原因，不携带半成品页面。
