# HTML 预览交付（2026-10-21）

实现 `packages/page-renderer/src/render-html.ts`：确定性读取 PageSpec 1.0/1.1、InformationPlan、固定快照与可信上下文，校验后导出单文件 HTML。新增 `scripts/render-preview.ts` 本地生成命令和只服务一个指定文件的 localhost 查看工具。无需新依赖或模型调用。

支持十二种协议接口、主题 token、响应式布局、比较表、时间轴、有向关系行、柱图、图片、派生值、展开和标签切换。图片校验媒体签名与 SHA-256。来源弹窗展示被点击记录的固定证据摘录、文档版本和位置；只嵌入获准导出且实际使用的证据。动态内容转义，客户端为固定脚本并由 CSP hash 约束。生成失败或目标已存在时保留原文件。

交付合成文件：`.local-data/InfoDesign-preview.html`，可双击打开；不依赖 localhost 服务。测试图片是 1px 合成夹具，不是企业素材，页面明确标记候选未独立审查。

## 已执行验证

在无网络、无凭据、普通用户、只读系统的 `infodesign-html-20261021` 容器中，复用现有测试镜像，代码只读挂载，输出仅写宿主 `.local-data`。

```sh
node --test tests/integration/page-renderer.test.ts tests/integration/contracts-design.test.ts
node node_modules/typescript/bin/tsc --noEmit -p tests/tsconfig.renderer.json
node --check packages/page-renderer/src/preview-client.js
node scripts/render-preview.ts --demo /output/InfoDesign-preview.html
```

测试 77/77（新增渲染 8 项、已有协议 69 项）通过；类型和脚本语法通过。共享状态接线最后修正后复跑渲染 8/8 并再次检查类型/语法。没有重跑与本次无关的整个模型运行层回归，没有真实模型调用。

内置浏览器实际验证：页面打开；来源弹窗显示对应 claim/version、摘录和段落位置；关闭弹窗；鼠标切换两个标签；方向键切回；展开服务详情；派生值来源显示两份输入和计算式；图片 naturalWidth=1、加载成功。390×844 窄屏 documentWidth=375，无横向溢出，比较表切成卡片。观察了桌面实际排版。localhost 首次沙箱服务不可访问，改用经授权的本机服务后验证成功；未扩大监听至公网。

限制：使用合成 PageSpec，未验证真实模型→页面的自动业务工作流；独立页面审查未接入；完整原文附件/生产证据 API 未实现，因此不能宣称完整原文定位验收完成。React TSX 入口仍为占位，本次实现离线 HTML 适配器。关系为有向连接行，不支持拖拽；负值柱图明确拒绝。完整后端类型检查的上游缺文件问题沿用前一轮报告，未补造接口。

下一步：将设计 Agent 通过校验的候选直接交给此渲染器，并接真实素材和独立页面审查。未提交或推送 Git。
