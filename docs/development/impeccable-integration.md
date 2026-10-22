# Impeccable 对接与试用（2026-10-21）

## 实际接线

上游设计原则 → 项目 `skills/visual-design/SKILL.md`（短中文适配）与 `design-references/visual-presets/DESIGN.md` → Pi 固定资源加载 → InformationPlan/PageSpec → 受控 HTML 渲染 → 实际浏览器检查。

`runtime/pi/skill-loader.ts` 新增固定 DESIGN.md 路径。没有加载用户上传目录或个人全局 Skill；外部原文仅留作参考，不注入模型长上下文。品牌和用户指导优先，PageSpec 权限、事实绑定和组件授权不变。

上游固定提交 `89097b912d714e1324691be46e1ff513bf597f25`，声明技能版本 4.7.0。原文、Apache-2.0 许可及本地修改说明保存在 [来源目录](../../design-references/vendor/impeccable/PROVENANCE.md)。未安装/运行上游 CLI、hooks、二进制、context、craft 或 detect；这是设计原则适配，不宣称完整 Impeccable 工作流运行。

## 试用交付

容器内执行：

```sh
node scripts/render-preview.ts --impeccable-demo /output/InfoDesign-impeccable-v2.html
```

宿主成品 `.local-data/InfoDesign-impeccable-v2.html` 可直接打开。旧版 `.local-data/InfoDesign-preview.html` 保留以便比较。

此次人工试排采用阅读型企业档案方向：纸白/墨蓝/铜橙、衬线主标题、细线与留白、标签与正文对齐，取消等大卡片嵌套，纠正嵌套窄栏。渲染器根据 data-component 应用组件样式，不改事实值。试用规格保持所有 claim 及其版本引用；1px 测试图显式记入 omissions 后省略。新的默认样式不是完整多品牌主题系统；后续品牌预设仍需通过受控主题实现，不固定企业栏目。

## 实际验证

断网无凭据容器 `infodesign-impeccable-20261021`，源码只读、仅输出目录可写：

```sh
node --test tests/integration/page-renderer.test.ts tests/integration/design-agent.test.ts
node node_modules/typescript/bin/tsc --noEmit -p tests/tsconfig.renderer.json
node --test --test-name-pattern 'reads claims, produces a candidate' tests/integration/design-agent.test.ts
```

29/29（渲染9、SDK20）通过，类型通过。新增定向断言确认 SDK 请求包含适配 Skill 和 DESIGN.md，且不包含上游 concept-seed 长流程；该项1/1通过。最终排版修正后复跑渲染9项和类型检查，结果见本轮工具执行记录。

浏览器验证：1280px桌面观察并修正一次标题网格对齐；390×844窄屏文档宽375px，无横向溢出，比较表切成卡片；鼠标/方向键切换、展开和来源弹窗可用；弹窗保留事实版本、文档版本、段落位置及摘录。

没有调用真实外部模型；SDK 使用本地模拟网关，因此只证明资源加载、协议及程序链路，不证明真实模型已掌握新设计方法。没有完成独立业务页面审查。下一步用一份可核对的真实上游设计输入做小范围生成评测，比较组织、排版及来源保留；费用与凭据按项目运行策略处理。
