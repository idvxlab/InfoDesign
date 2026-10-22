# InformationPlan 与 PageSpec 协议建议

2026-10-11。用户同意按配套样例试行，已落实有限的 v1 Schema 与服务校验，权威字段以 packages/contracts/schemas/ 为准；[实施范围与验证](../reports/design-contracts-v1-2026-10-11.md)说明产物协议限制。首次生成的 Agent 输入输出现已实现，见[接口说明](design-agent-io-v1.md)。下文仍包含后续能力建议，不能全部视为已实现。Pi 设计会话已接入并通过模拟网关验证；真实模型质量未验收，渲染与发布未实现，发布协议仍拒绝输入。本文不复制客户资料，不使用此前被否定的虚构企业案例。

## 1. 两份产物分别解决什么问题

| 产物 | 要回答的问题 | 使用者 |
| --- | --- | --- |
| EvidenceSnapshot | 资料支持哪些事实，证据在哪里 | 设计者、渲染器、审查者 |
| InformationPlan | 面向谁，读者要理解什么，选哪些内容，为什么这样组织 | 设计 Agent 后续步骤、内容审查、修改流程 |
| PageSpec | 内容具体怎样呈现，采用哪些组件、布局与交互，如何绑定事实 | 渲染器、页面审查、修改流程 |

InformationPlan 是内容方案，不是生成网页的提示词。PageSpec 是能由程序解释的页面规格，不是 HTML 字符串，也不是“请做得科技感一些”的描述。两者属于同一个设计角色，无需新增两个 Agent，也不要求固定两次模型调用。

ViviDoc 的 DocSpec 包含有序知识单元、内容说明和 SRTC 交互描述。本项目借鉴显式设计意图，但将内容决策与页面实现规格分开，并增加事实绑定、版本和权限约束。不存在 DocSpec 与某一个产物的一一对应；这两份协议都是本项目自定义。参考来源见 [项目总方案](project-spec.md#s20)；个人阅读笔记不属于此功能提交的依赖。

## 2. 共同约定

- 使用 JSON；后续以 JSON Schema 为权威定义并生成类型。固定对象关闭未知字段，明确长度、深度、节点数等预算。
- 服务固定项目、任务、输入快照版本和权限；模型只提交设计内容。ID、版本、时间、内容指纹等由服务签发或校验，模型不能自称已审查通过。
- 保存产物包含 `protocolVersion`、自身逻辑 ID/版本 ID、`projectId`、`snapshotRef`、`producedBy`、`createdAt`；`snapshotRef` 固定 `snapshotId`、`snapshotVersionId` 和内容指纹。具体新 ID 命名规则待落实。
- PageSpec 额外引用准确的 `informationPlanRef`，并固定组件目录与主题版本。逻辑 ID 在局部修改时保留，内容改变产生新版本。不要只引用“最新版”。
- 引用统一采用带类型的对象：例如 `{ "kind": "claim", "id": "claim_example" }`。首版考虑 claim/entity/relation/event/asset，均在固定快照内解析。claim 还核对对应 claimVersionId；实体标签不是支持营销断言的证据。
- 服务提供允许使用的记录集合；不信任模型填写权限。现有 relations/events 没有逐条 claim 式审核字段，不能假定它们自动获准展示。

以下 JSON 都是局部形状示意，ID 是占位引用，省略元数据；不是可以通过当前 Schema 的实例，也不表示已有组件可用。

## 3. InformationPlan：先确定信息结构

建议最小字段：

| 字段 | 含义与限制 |
| --- | --- |
| `audience` | 读者角色、已有知识和主要需求 |
| `goal` | 页面要帮助读者理解或完成什么，不写空泛的宣传目标 |
| `readerQuestions` | 读者希望得到答案的问题及稳定 ID |
| `sections` | 有序内容分区，可嵌套；数组顺序就是阅读顺序 |
| `sections[].sectionId/title/purpose` | 分区身份、标题、作用 |
| `sections[].questionIds/sourceRefs` | 回答哪些问题，选用了哪些记录 |
| `sections[].priority/presentationIntent` | 信息优先级及表达意图，例如便于比较；不指定 CSS |
| `sections[].selectionReason` | 为什么采用这些内容和顺序 |
| `omissions` | 有意义的省略、对应记录或范围及原因 |
| `openIssues` | 缺少信息、来源冲突、无法确定的内容，不伪造答案 |

```json
{
  "audience": { "role": "技术选型人员", "needs": ["判断产品是否适用"] },
  "goal": "帮助读者比较产品，并理解参数的适用条件",
  "readerQuestions": [
    { "questionId": "question_compare", "text": "产品的关键参数有什么差别？" }
  ],
  "sections": [
    {
      "sectionId": "section_compare",
      "title": "产品比较",
      "purpose": "在相同口径下比较产品",
      "questionIds": ["question_compare"],
      "sourceRefs": [{ "kind": "claim", "id": "claim_example" }],
      "priority": "primary",
      "presentationIntent": "并列比较，保留每项参数的工况说明",
      "selectionReason": "先回答选型问题，再展开技术细节"
    }
  ],
  "omissions": [],
  "openIssues": []
}
```

这里不规定每家公司必须有新闻、荣誉、产品、联系我们等固定栏目。内容由资料和目标决定。覆盖检查应由程序比较授权任务范围与已选内容，不能只信模型自报 omissions；也不要求无差别列出海量无关事实。

## 4. PageSpec：把信息结构变成可执行页面结构

2026-10-20：已实现显式协商的 [PageSpec 1.1](page-spec-v1.1.md)，补齐布局/视觉、素材、概括、事件/关系/柱图、枚举切换和受限计算。下文为历史方案说明，现行字段以 Schema 和 1.1 专题为准；旧版兼容保留，协议扩展不等于渲染完成。

建议最小字段：

| 字段 | 含义与限制 |
| --- | --- |
| `informationPlanRef` | 对应计划的准确版本与指纹 |
| `componentCatalogRef/themeRef` | 已实现组件目录与主题版本 |
| `root` | 有稳定 nodeId 的节点树；children 顺序决定内容顺序 |
| `root` 内各节点 | nodeId、planSectionId、componentRef、props、bindings、children；字段按组件种类区分 |
| `layout/responsive` | 受支持的 stack/grid/split 等布局及按命名断点的调整，不能隐藏必要工况和来源 |
| `state` | 页面交互状态的类型、允许值、初始值，例如当前选择的产品 |
| `actions` | 白名单动作及目标，如选择、筛选、展开、查看来源；禁止任意 JS |
| `checks` | 必须验证的行为与不变量，采用已注册检查类型，不让自然语言代替执行 |

节点样例：

```json
{
  "nodeId": "node_parameter",
  "planSectionId": "section_compare",
  "componentRef": { "id": "fact_value", "version": "1.0.0" },
  "props": { "density": "comfortable" },
  "bindings": {
    "value": {
      "kind": "claimValue",
      "claimRef": { "kind": "claim", "id": "claim_example" },
      "format": { "unit": "source", "qualifiers": "visible" }
    }
  }
}
```

`fact_value` 是拟议组件。实际可用名称、版本、props、绑定槽位、事件和动作必须来自组件目录，不能由模型自创。上例不填具体参数数值：渲染器从固定快照取出值、单位和限定条件，避免再抄写一次事实。当前快照 qualifiers 只有既定字段，不能随意添加 rpm 等新属性；需按真实快照表示读取。

### 内容绑定不能只有一个笼统的 sourceRefs

建议区分四种内容：

1. **界面文字**：如“展开”“查看来源”，不承载企业事实。
2. **事实值**：直接引用 claim，程序处理值、单位、时间和口径。
3. **基于资料的概括文字**：允许模型改写表述，但每段绑定 sourceRefs，并接受独立语义审查。存在引用不等于表述得到支持；禁止用界面文字类型绕过审查。
4. **素材**：引用 assetId，由服务解析受控资源映射；快照 assets 当前不提供加载 URL，模型不能猜路径。

产品比较应精确到行、列和单元格绑定，图表应精确到数据点；页面底部统一列一组资料引用不足以溯源。缺参数显示缺失或不展示对应比较，不能填零。不同实体、时间或工况不能被拼成一条参数。

首版可先限制直接事实展示。若支持计算，需另行定义输入引用、注册计算方法、输出单位和条件，由程序计算；不允许模型提交数字或任意公式后称其为已验证事实。

### 交互和视觉自由的边界

SRTC 可以用于检查设计是否完整：state 对应 State，节点与绑定对应 Render，受控 actions 对应 Transition，checks 对应可验证的 Constraint。交互还必须明确组件事件、事件参数类型、目标状态以及状态如何影响显示，否则只有一个 action 名称无法执行。首版可只支持展开/收起、产品选择和来源查看；不要先做任意交互语言。

设计自由来自内容组合、组件选择、布局、主题 token、信息层级与受支持的交互，而不是固定企业模板。主题管颜色、字体、间距，不承载企业事实；可用 token 和断点由渲染器声明。首版不接受 raw HTML/CSS/JS。真正无法表达的内容报告组件能力缺口，不悄悄丢掉内容或生成不可执行组件。

## 5. 输入、输出与验证闭环

DesignInput 至少提供：服务授权的固定快照及索引、受众/目标/限制、真实可用组件目录、主题约束、受控素材清单；大快照允许按 ID 补查原始证据。PageSpec 无法脱离这些输入单独约定。

DesignOutput 成功时提交成对的计划和规格候选；服务封装版本并做校验，再交给渲染与独立页面审查。`completed` 仅表示设计任务完成，不表示通过审查或已经发布。

当前 common 的输出状态只有 completed/needs_information/blocked/failed，没有 needs_component。已在设计输出 Schema 中用 blocked 加组件需求记录表达能力缺口；needs_information 必须给信息需求，failed 给执行失败原因。首版停止响应不携带部分候选；没有完整规格不能假装成功。不修改共用状态枚举。

验证分三层：

- **Schema**：字段、类型、枚举、节点结构、组件参数是否合法。
- **服务校验**：项目/版本/指纹一致，引用存在且获准使用；节点唯一，计划与页面对应，素材可用，动作与组件兼容；计算和事实绑定没有错配。
- **独立审查与实际渲染验证**：概括是否夸大、重要信息是否遗漏、条件是否可见；页面是否溢出，键盘操作、窄屏和交互是否真实可用。JSON 合法不能代替这些检查。

审查者同时收到原始证据、固定快照、计划、规格及实际页面。检查失败时反馈明确 sectionId/nodeId/claimId，有限修正；事实问题回到证据流程，不让设计 Agent 修改权威事实。正常验证通过后自动输出，不额外要求每次人工批准。

## 6. 建议的落地顺序

已有[第一版配套 JSON 样例](../examples/design-contracts-v1/README.md)，展示计划到节点、事实绑定和交互的对应。它使用占位引用，省略正式提交信封，不是定稿协议或可运行页面；未采用上一轮图片字段参考。

1. 先确定内容引用、版本和绑定规则，再收敛 InformationPlan 的最小字段。
2. 选择一个真实资料中的内容片段，人工编写计划和规格草案，明确标记为协议示例；有实际审核 JSON 后再替换占位引用。无需等上游完整实现才开始讨论协议。
3. 同步定义少量组件的输入、事件和绑定槽位，验证 PageSpec 足够具体；不先造完整组件库。
4. 协议达成一致后，实现 JSON Schema、服务交叉校验及正反样例，再接真实 Pi 设计 Agent 与最小渲染切片。

v1 已选择平铺 sections、有界递归节点、四种组件接口、直接事实值、查看来源和布尔展开；保存信封固定协议版本 1.0，并补充精确 claimVersionId 与比较列 predicate。素材、自由概括、派生计算、任意组件和局部修订尚未实现。后续在此切片上接业务 Agent 和组件，不把协议验证等同于完整业务完成。
