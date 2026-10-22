# 可打开的 HTML 预览

当前实现 PageSpec 1.0/1.1 → 单文件 HTML，可直接用浏览器打开，不需要前端构建或外部 CDN。由确定性 TypeScript 渲染器读取规格，不调用模型生成 HTML。React 应用及其 TSX 占位文件仍待后续接入；本实现是离线预览适配器。

Impeccable 原则适配试用：`node scripts/render-preview.ts --impeccable-demo /output/trial.html`。同一合成事实经过人工调整布局，不是一次真实模型生成；[对接说明](../../docs/development/impeccable-integration.md)。

在项目开发容器执行：

```sh
node scripts/render-preview.ts --demo /output/preview.html
node scripts/render-preview.ts LOCAL_BUNDLE.json /output/preview.html
```

`/output` 需要挂载为宿主可写输出目录。目标文件已存在时拒绝覆盖。示例为合成数据，不是业务模型生成或已通过独立审查的页面。

LOCAL_BUNDLE 包含 plan、page、snapshot、context、themeValues、evidenceExportIds，以及可选 assetBase64（resourceId → base64 图片字节）。这些权限和资源字段只能由可信服务装配；命令行仅供本地开发，不是接收外部 JSON 的生产 API。

服务直接调用 `renderPageHtml(options)`，传 SchemaRegistry、准确成果/快照和独立 DesignContext。渲染前执行 checkDesign，拒绝版本/授权/组件/绑定错误和未解决的计划问题。themeValues 提供目录内 token 的受限颜色、长度或字体值；不执行模型 HTML/CSS/JS。

支持十二种已定义组件接口：分组、事实文字、比较表、展开、概括、图片、时间轴、带方向关系连接、柱图、标签切换、派生值和根页面。使用固定客户端代码；标签支持方向键/Home/End，来源弹窗支持关闭及焦点返回。比较表窄屏显示卡片。当前关系图是有向连接行，不支持自由拖拽；柱图负值明确拒绝，不静默画错。

图片只接受可信资源表映射的 PNG/JPEG/WebP 字节，检查 hash 和媒体签名；不请求任意 URL。离线导出须由服务显式提供 evidenceExportIds（素材来源使用 assetId），只嵌入实际展示内容所引用的证据；未获准则失败。页面含来源摘录和精确版本/位置，不含完整原文附件或生产证据 API。

所有输出标注“候选预览 · 未独立审查”。正常生产流程的自动审查与采纳规则不变；预览生成不代表独立页面审查、真实模型端到端或发布完成。

测试：`node --test tests/integration/page-renderer.test.ts`；类型：`node node_modules/typescript/bin/tsc --noEmit -p tests/tsconfig.renderer.json`。
