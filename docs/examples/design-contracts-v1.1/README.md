# PageSpec 1.1 合成协议示例

这些是程序测试使用的人工合成内容，不是企业资料、真实模型输出或审核通过页面。

- `design-input.json`：显式请求 1.1，包含合成快照、组件授权、主题和素材映射。
- `trusted-context.json`：仅用于测试的独立服务授权上下文；生产中不能从模型或用户 JSON 构造权限。
- `information-plan.json`：配套计划。
- `page-spec.json`：包含布局、视觉、概括、事件、关系、图表、标签切换和计算的完整候选。

字段解释见 [1.1 协议](../../design/page-spec-v1.1.md)。合成组件目录不是已部署清单，资源 hash 为测试标识，不存在真实图片或浏览器检查结果。

文件由 `tests/helpers/pagespec-fixtures.ts` 的 extendedDesignTaskFixture 导出；集成测试加载文件检查引用及指纹。与 v1 概念样例不同，本目录包含完整保存信封。
