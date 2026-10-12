# 本地 PDF 解析与来源检查

已实现一个无模型 PDF 适配器：提取原生文字行、图片对象区域、有矢量边框的表格候选，输出现有 DocumentIR 与可本地打开的检查页面。它是提前实施的 M2 解析切片，不是 API 服务或最终企业页面生成器。B4 暂后移，Pi 核心角色与事实协议未变。

## 运行

需要 Docker Desktop；目前锁定 Linux ARM64 / Python 3.12 wheel。独立镜像与原 Pi 容器分开，不执行 `dev-container.sh up`。

```bash
# 首次构建：只在依赖下载容器联网，随后按哈希离线安装。
bash scripts/parser-container.sh build
bash scripts/parser-container.sh test

# 输出父目录需存在；输出目录必须是新的，防止覆盖旧版本。
mkdir -p .local-data/parser/runs
bash scripts/parser-container.sh parse /absolute/path/example.pdf .local-data/parser/runs/example
```

用本机浏览器打开 `.local-data/parser/runs/example/result/index.html`。整个 result 目录需保留在一起。预览可按页和类型查看结果，点击“定位来源”显示区域；表格同时展示源图和单元格文本。源 PDF、DocumentIR 和解析清单可从页面查看。

生成结果可用现有 Node 24 开发环境运行 `node scripts/check-parser-output.mjs OUTPUT/result` 验证。应在独立断网开发容器中执行，并仅把该输出目录只读挂载进去；不要重启有活动 Pi 的原容器。该命令校验权威 Schema、文件 SHA-256、页码、块序号、区域和单元格边界及资源引用。

## 输出与坐标

- `source.pdf`：本次实际读取字节的副本，与 DocumentIR.contentHash 相同；不执行 PDF 内脚本或链接。
- `document-ir.json`：保持 protocolVersion 1.0，不修改权威 Schema。位置采用已有 `page_region` / `image_region`。
- `pages/` 与 `assets/`：页面渲染及图片／表格的页面区域裁剪；裁剪不等于重建原始图片文件。均记录 SHA-256。
- `tables/`：候选行列和每个实际单元格的位置；合并单元格的空位保留为 null，不伪造内容。
- `manifest.json`：检查预览的辅助清单，记录引擎版本、逐页状态、警告与生成资源；不是新的业务事实协议。

坐标使用物理 PDF 页（从 1 开始）、旋转后 MediaBox、左上角原点，单位为 point（1/72 英寸）。不把印刷页码或展开页的左右版面页码当成物理页码；原 MediaBox、CropBox、旋转角与渲染像素尺寸保留在清单中。字体几何可能导致文字框偏移，尤其影响表格单元格分配；不能仅凭边界数值合法认定内容定位完全正确。

parseInfo.quality 始终为 partial。图片语义／OCR、无内容页、解析失败和表格错位风险按块记录，不自动提升为完成状态。表格文字与原生文字行可能重叠，不能当成相互独立的两份证据。当前 B2/B3 `read_document` 只接受 paragraph 定位，本轮没有把新 PDF 块接入 Agent 或绕过该限制。

## 支持范围与隔离

已支持原生文字、图片位置与区域裁剪、矢量边框表格候选。未支持 OCR、图片含义、图表数值、无边框／栅格表格、语义阅读顺序、跨页合并或事实审查。未检出表格不证明原文没有表格。表头和末行可能错位或遗漏；有警告时应核对旁边的源图。

`parse` 只读挂载一个明确的本地 PDF，并只写一个新输出目录；无网络、无模型凭据、只读系统、非特权用户、去除 capabilities、限制 CPU／内存／进程。默认最多 25 MiB、40 页、页面边长 2400 pt、5000 块；180 秒任务超时。不支持加密 PDF、非默认 UserUnit 或越出 MediaBox 的 CropBox。资源限制并非面向公开不可信上传的完整生产隔离方案。

本轮真实样本和合成样本结果、已发现的质量问题及浏览器核验边界见 [验证报告](../../docs/reports/pdf-local-parser-2026-10-10.md)。依赖与 Docling Skill 的评估见 [THIRD_PARTY.md](THIRD_PARTY.md)。
