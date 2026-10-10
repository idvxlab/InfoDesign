# read_source 读取源 API 与边界文档

本文档描述 `createSourceReader` 与 `createReadSourceTool` 的对外契约、输入边界、返回结构与当前集成状态。内容基于已验证实现；未验证行为不在此声明。

## 1. 概览

- `createSourceReader(access: SourceAccess, registry)` 返回读取函数 `read(raw, signal?) => ReadSourceResult`。
- `createReadSourceTool(...)` 在 `read` 之上注册一个顺序执行的 actual Pi `ToolDefinition`，名称为 **`read_source`**，附带 `ExecutionBudget`，并仅克隆成功回执（success-only receipts）。
- 结果 JSON 序列化上限为 **65536 字节**：超限即 **拒绝（reject）**，不截断。
- 累积预算（cumulative budget）不在此处处理。

## 2. 输入契约 SourceAccess

```ts
SourceAccess = { scope, documents, bundles? }
```

- 调用方提供受信任（trusted）的 service scope。
- 请求仅携带严格 3 个 ID（strict three IDs），不接受额外字段。
- 无模型权限（model permissions）、无路径（path）语义。

## 3. 读取时校验

- scope 必须允许 `read_document`。
- 文档成员关系（document membership）在读取时检查。
- 原始请求（raw request）按严格 schema 校验。

## 4. PDF 与 bundle 边界

- PDF 读取要求在构造器处具备 **真实（genuine）** 的 `getValidatedSourceBundle` 能力——即使定位为段落（paragraph location）也同样要求。
- 伪造、结构性克隆、被改动或循环引用的 bundle => 错误码 `invalid_source_bundle`。
- 内容哈希 / 完整规范化 `DocumentIR` 必须相等：不相等即拒绝。
- 重复版本 / 重复 bundle、外来（foreign）bundle 一律拒绝。
- 仅有真实 PDF bundle 时，才允许 legacy B1 的 `location.not_verified` / `location.kind_mismatch` 由 bundle 物理校验覆盖；其余 schema / blockID / index 检查全部保留。
- 共享的 B1 校验保持不变。
- **不存在** `bundle_missing_pdf_content`（该错误码为虚构，勿列出）。
- PDF 无 bundle 时的错误为 `source_bundle_required`。
- 非 PDF legacy 且无 bundle：保持原有 B1 文档校验不变，仅读取段落定位（paragraph location）的非空文本。

## 5. 返回结构 ReadSourceResult

- 精选 ID，以及完整内容哈希前缀 `sha256:<64hex>`。
- 原始文本（raw text）。
- 实际物理位置（actual physical locations）。
- 类型 / 状态（type/status）。
- 资源（asset）/ 表格（table）可为空（nullable）。
- 限制与不支持原因（limitations / unsupportedReasons）。

### 5.1 资源（Assets）

仅包含：安全相对路径、`sha256:` 前缀哈希、字节数（bytes）、asset kind、blockID。**绝不**包含二进制、base64 或宿主路径。

### 5.2 表格（Tables）

保留原始字符串 / 空值 / 单元格位置 / 警告；状态为 `candidate_not_reviewed`。

### 5.3 图像（Images）

文本为空，`semanticStatus = not_run`；不执行 OCR / 视觉（vision）。

## 6. 克隆与回执

- 结果与回执均为深克隆（deep cloned）。
- 取消（cancelled）、失败（failed）、超预算（overbudget）的调用**不产生回执**。

## 7. 集成状态（重要）

该 reader 目前**仅连接元数据（metadata-only）**，**尚未接入 Evidence / ReviewAgent**。此集成为**待办（pending）**。

## 8. 测试

- 测试文件位于文档测试路径。
- 运行需使用显式离线（offline）命令。
- 本文档不声明测试数量或通过结论；须以最新一次实际运行结果为准。