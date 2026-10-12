# 证据 Agent 的 SourceBundle / read_source 接线（B3-source）

本单元把已验证的 `SourceBundle` / `read_source` 能力接入现有 Pi SDK 的 EvidenceAgent，
**不引入 OCR、视觉或任意文件解析**，只处理可信服务提供的、经 `getValidatedSourceBundle`
真伪校验且与授权 `DocumentIR` 规范相等的合成/受控资料包。

## 信任边界

- `sourceBundles` 是 **服务参数**，绝不是模型输入，也不是权限来源。模型无法通过数组、
  标志、mime 或 locator 伪造一个源。
- 真伪判定必须在任何 `structuredClone` **之前**对原始对象调用 `getValidatedSourceBundle`
  （WeakMap 身份）。原始对象通过 WeakMap 完成校验；克隆会丢失受信任能力因而无法通过；getValidatedSourceBundle 会在校验身份后返回一个 detached 视图。
- 任一伪造 / 篡改 / 版本过期 / 越权 / 重复 bundle 都会在 **首个模型请求之前** 抛错拒绝。

## 输入校验（`prepareEvidenceInput`）

次序：

1. `verifyPdfSources`：逐一 `getValidatedSourceBundle` + 与授权文档的 `canonicalize` 规范相等；
2. 提供源时用真实 `createSourceReader` 构造做能力校验（伪造/不匹配源在此失败）；
3. 复跑 `checkEvidenceInput`，**仅** 对“已验证匹配 PDF”的文档路径过滤
   `location.not_verified` / `location.kind_mismatch` 两条 B1 遗留定位码，其余问题全部保留。

未提供 bundles 时保持 legacy 严格行为（PDF 的 `page_region` 输入被拒）。

## 候选校验（`validateEvidenceCandidate`）

签名扩展为
`validateEvidenceCandidate(raw, input, envelope, receipts, registry, previous?, sourceBundles?)`
——新参数在既有 `previous` 之后，兼容旧调用方。收据类型是 `ReadDocumentResult |
ReadSourceResult | MinimalReceipt` 的并集。

- 对“已验证匹配 PDF”的候选证据/素材：要求 locator 与受信块的物理定位 **规范相等**
  （错误页/bbox、伪造 PDF、过期版本 → `evidence.physical_location_mismatch` /
  `asset.physical_location_mismatch`），并要求真实读取收据覆盖 + 摘录为原文连续子串。
- 实现方式：构造 **仅校验用克隆**，把已物理验证的 locator 映射为 legacy paragraph 序号，
  交给既有 `checkEvidenceOutput` 通过；**存储/输出的候选仍保留原始物理定位**。
  绝不整体删除 `location.not_verified`，legacy 通用路径不受影响。

## 目录与模态（`documentCatalog` / `evidenceTaskPrompt`）

目录 **metadata-only**：不含原文、绝对宿主路径、base64、整份 manifest 或 raw extensions。
它标注可读的受控 PDF 文本/表格块，且图片语义恒为 `not_run`。仅凭资产/文件名不构成视觉证据。

## 模态限制（本单元）

- 图片：语义 `not_run`，不得声称识别图片内容。
- 表格：状态 `candidate_not_reviewed`，干净原始表格文本可给临时事实候选，但不得声称视觉对齐已验证；
  带 warning 的表格候选保持 unsupported。
- 空白块、解析器未支持块保持 unsupported；partial 解析 → `needs_information`。

## 工具与运行时

- `createEvidenceTools`：有 genuine bundles → `read_source`；否则 legacy `read_document`。
  每会话只暴露一个受控工具。
- `RuntimeTrace` 白名单同时包含 `read_document` 与 `read_source`，其余折叠为 `unrecognized`，
  不转发提示、参数、结果原文、错误消息或凭据。

## 测试

`tests/integration/evidence-source.test.ts` 使用 `tests/helpers/source-bundle-fixture.ts`
生成 **代码生成的临时合成包**（绝不是真实 PDF），配合本地 host 假 SSE 网关，真实跑通 Pi SDK
与成功的 `read_source` 调用。语义 mock 输出明确标为“模拟”，不代表模型质量。