# 设计协议第一版配套样例

这是按协议讨论草案手写的 JSON 形状样例，不是 Agent 运行结果或真实客户快照。其有限 v1 现已落实为 Schema；这里保留便于阅读的原始设计主体，仍非完整可提交对象。忽略上一轮图片参考，不将 EvidenceSnapshot 字段复制为 PageSpec 字段。此前被否定的虚构企业练习未被采用。

先读 [information-plan.json](information-plan.json)，再读 [page-spec.json](page-spec.json)。对应规则见 [协议草案](../../design/design-contracts-draft.md)。

## 看什么

- Plan 的三个 section 决定业务概览、产品比较、服务说明的顺序和目的；PageSpec 用 planSectionId 将实际节点对应回去。这是一次具体方案，不是所有企业固定采用的模板。
- Plan 的 sourceRefs 表示内容选择；PageSpec 的 bindings 精确决定文字、产品行和参数单元格从哪里取值。
- PageSpec 没有企业数值或宣传文案。claimValue 从指定快照取值，单位与工况随事实展示；产品行标题取实体 label。
- 产品比较在大屏用表格、小屏用卡片，来源绑定保持一致；服务详情初始收起，点击后改变布尔状态，组件依据状态显示内容。
- omissions 为空仅表示本示例未填写，不能证明覆盖完整；Plan 已显式记录缺少真实快照的问题。

## 有意未填的运行信息

所有 placeholder ID 都不可解析。正式保存时，服务还需封装 protocolVersion、项目/任务/产物 ID、版本、时间、producedBy 和内容指纹，并将同一 snapshotRef 绑定到 Plan 与 PageSpec。本文未填写虚假指纹或虚假审核状态；JSON 文件仅展示设计内容主体与拟议引用形状，不是完整业务提交包。

真实快照到位后，需选择实际同类参数、替换列标题和引用，核对主体、单位、时间与工况。不支持的值类型应校验失败，不能直接转字符串。该样例没有计算、自由概括、图片与复杂筛选，后续按实际需要扩展。

## 与渲染器配套的拟议接口

下列组件、主题、动作和 checks 都尚未实现或登记，版本号仅示例。

| 组件 | 绑定/行为 |
| --- | --- |
| page | children 按顺序排列；接受受支持的布局 token；输出文档语言 |
| fact_text | body 接受可显示的 claimValue；sourceRequested 无外部参数，来源由规格固定 |
| comparison_matrix | rows 包含明确实体与单元格；程序核对 claim 所属 entity 和列的参数含义；每格的来源事件仅携带 rowId/columnId |
| disclosure | expanded 绑定 boolean；toggleRequested 无参数；按钮支持键盘、aria-expanded 和内容区域关联 |

comparison_matrix 的事件不能传任意 claimId 给来源服务。运行时先校验 rowId/columnId 属于该节点 rows，再解析对应 claimRef，并重新校验项目和来源访问权限。toggleBoolean 只能修改指定 boolean 状态，不能写入事实。

主题拟提供 space_section、width_content 等 token，以及 small/large 断点；具体值由主题/渲染器定义，模型不能传任意 CSS。checks 是待实现的检查声明，不是“已通过”报告。visibleQualifiers 要验证实际条件展示；evidenceResolvable 要验证授权来源可定位；toggleRoundTrip 要实际操作展开和收起并核对状态及可见内容。

## 验证边界与下一步

协议实现位于 packages/contracts/schemas/，测试装配见 tests/helpers/design-fixtures.ts：增加正式信封、真实计算的测试指纹、claimVersionId 和比较列 predicate，再用纯合成记录验证引用关系。designTaskFixture 进一步装配 DesignInput/DesignOutput；其协议与校验已实现，未实施渲染、浏览器或真实模型验证。发布 Schema 继续拒绝输入。

后续以真实审核 JSON 和实际组件目录替换测试上下文，再接业务 Agent。完整验证命令和限制见 [验证记录](../../reports/design-contracts-v1-2026-10-11.md)。
