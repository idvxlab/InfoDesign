# PageSpec 1.1 输出协议

2026-10-20。权威定义为 `packages/contracts/schemas/page-spec.schema.json`。本次实现 Schema、服务校验、生成类型、Agent 正文封装和测试，不表示渲染器、组件或页面审查已经完成。

## 版本与完整文件要素

服务在 DesignInput 和独立可信 DesignContext 同时指定 `pageSpecVersion: "1.1"` 才启用扩展，省略时使用 1.0。旧版字段和四种组件接口保持兼容，新增字段和节点不能伪装成 1.0。DesignInput、DesignOutput、InformationPlan 信封仍为 1.0；PageSpec 自身 protocolVersion 为 1.1，producedBy.protocolVersion 仍表示设计角色信封 1.0。模型不选择版本。

| 层级 | 字段 | 含义 |
| --- | --- | --- |
| 身份 | protocolVersion、projectId、taskId、attemptId、pageSpecId、pageSpecVersionId、producedBy、createdAt | 服务封装身份和版本 |
| 固定依赖 | snapshotRef、informationPlanRef、componentCatalogRef、themeRef、可选 reviewRef | 快照、计划、目录、主题和交底绑定 |
| 页面树 | root、nodeId、planSectionId、componentRef、children | 稳定节点、有界递归、与计划分区和顺序对应 |
| 内容 | props、bindings | 界面文字、直接事实、概括、事件、关系、素材、图表和计算引用 |
| 布局 | layout、responsiveLayout | stack/grid/split；small/large 布局 |
| 视觉 | style | colorToken、backgroundToken、typographyToken、paddingToken、borderToken、radiusToken |
| 可访问性 | accessibility | label、description、role、headingLevel；标题等级不能与 props 冲突 |
| 状态与行为 | state、events、actions | 有类型的状态、合法初值、事件到动作再到状态/来源的绑定 |
| 计算 | calculations | 注册算法和版本固定的输入，不允许手填结果 |
| 检查要求 | checks | 待执行检查，不能填写通过结论 |

1.1 必填 root.style、root.accessibility、root.responsiveLayout、calculations；无视觉覆盖时 style 可为空对象，无计算时 calculations 为空数组。非根节点可选 style/accessibility；section 有自己的 layout，根节点有 small/large 布局，比较表保留 cards/table 响应式。尚不支持任意节点的任意断点覆盖。所有 token 必须来自服务主题，不接受 HTML/CSS/JS。

## 组件与内容绑定

下列接口版本均为 0.1.0，使用前必须在可信组件目录中出现；协议支持不等于前端已经部署。

| 组件 | 绑定和约束 |
| --- | --- |
| page | 根节点、语言、布局和子节点 |
| section | 内容分组及 stack/grid/split，不固定企业栏目 |
| fact_text | body.claimRef；值、单位、条件从快照读取 |
| comparison_matrix | 行实体、列 predicate、单元格 claimRef 一致；缺失不填零，不自动排名 |
| disclosure | boolean 状态与 toggleBoolean 动作对应 |
| narrative | paragraphs 的每段 text/sourceRefs；引用存在不证明表述正确，仍需独立语义审查 |
| asset_image | asset 引用、alt、fit；必须有可信且来源匹配的素材资源 |
| timeline | items[].eventRef；日期/描述从事件取得；source/ascending/descending；未知或仅文字时间单独置于尾部，不猜日期 |
| relation_graph | edges[].relationRef；端点来自关系且需授权，不能自创边 |
| bar_chart | points[].claimRef；数值型、同属性/单位/限定条件、零基线，缺失省略 |
| tabs | selected.stateId、items[].value/childNodeId 与 enum 合法值和直接子节点一一对应 |
| derived_value | 引用 calculationId，showInputs 必须为 true |

当前未支持折线图、任意筛选语言、外链、任意组件或代码生成；目录不足时返回 blocked/component 需求，不降级成假成功。

## 素材与来源动作

DesignInput.resources.assets 必须与独立可信上下文的资源表相同。每项固定 assetId、documentId、documentVersionId、blockId、resourceId、mediaType、contentHash。resourceId 是服务内部标识，不是文件路径或 URL。当前仅支持 PNG/JPEG/WebP，不实现下载、签名链接、解码或素材内容验证。合成 hash 格式合法不表示真实字节已核验。

素材属于快照授权集合且固定来源一致。事件和关系必须有可解析证据和获准实体端点；每个选中 claim 仍须在对应计划分区呈现。企业事实不能靠实体标签代替证据。

fact_text 的来源动作绑定精确 claimRef，比较表用 eventBoundClaim。新增内容用 eventBoundSource，bindingSlot 分别为 paragraphs、asset、items、edges、points、derived。未来渲染器须从触发节点绑定中解析具体点击对象，不能信任客户端任意提交的事实 ID。本轮仅定义并校验契约，未实现前端事件处理器。

## 状态、计算和检查

tabs.selectionRequested 引用 selectValue，valueFrom 固定为 event.value，targetStateId 与 selected.stateId 一致。渲染器只接受 allowedValues 内的值并显示对应子节点。disclosure 不能绑定 enum。普通页面交互无需调用模型。

唯一注册计算为 percentChange：`(current - base) / base * 100`。输入必须同主体/属性/单位、非时间限定条件完全一致且具有明确 basis；仅支持两个先后不同年份、不混用 period/asOf。base 大于零，输入和结果必须有限。程序函数 percentChange 执行计算；协议禁止 result 字段和任意表达式。尚不支持合计、计数、单位换算和其他时间口径。

每个节点必须声明 responsiveLayout 检查，覆盖 small/large；有 events 的节点必须声明 keyboardAccess；有来源内容声明 evidenceResolvable。另按组件派生必需项：narrative→semanticFidelity，asset_image→assetAvailable，timeline→timelineOrder，relation_graph→relationIntegrity，bar_chart→chartComparability，tabs→selectionRoundTrip，derived_value→derivedInputs；原比较表/展开区继续要求 visibleQualifiers/toggleRoundTrip。

服务检查检查项及目标，不能通过删 checks 绕过。checks 不是已执行结果；浏览器与独立审查另行生成报告。completed 仅表示候选设计生成。

## 接入及限制

完整合成文件见 [示例目录](../examples/design-contracts-v1.1/README.md)。调用方复用 checkDesignInput/checkDesignOutput；直接调用 checkDesign 也需可信上下文的版本及素材资源。交底入口同步转发这些可信配置。

正文 Schema 按版本选择，避免旧任务承受全部新 Schema 的提示体积。工具支持 event/relation/asset 受控读取，1.1 选中记录必须实际读取。原文补查仍限段落，未增加视觉模型输入。

实际组件、渲染、素材服务、独立页面审查、ChangeSet 修订与端到端验收尚未完成。稳定节点与依赖为修订提供基础，不代表局部修改已实现。
