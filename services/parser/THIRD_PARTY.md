# 解析依赖与 Skill 评估

核对日期：2026-10-10。仅从 PyPI 官方索引下载 wheel，锁定版本与 SHA-256；安装阶段断网，不运行第三方仓库脚本，不下载模型权重。`requirements.lock` 当前针对 CPython 3.12 / Linux ARM64，其他架构需重新核对 wheel 与哈希。

| 依赖 | 版本 | wheel 内许可证 |
| --- | --- | --- |
| pdfplumber | 0.11.10 | MIT |
| pdfminer.six | 20260107 | MIT |
| pypdfium2 | 5.14.0 | Apache-2.0 / BSD-3-Clause；另含 PDFium 与第三方组件许可 |
| Pillow | 12.3.0 | MIT-CMU |
| charset-normalizer | 3.5.2 | MIT |
| cryptography | 50.0.2 | Apache-2.0 OR BSD-3-Clause |
| cffi | 2.1.1 | MIT-0 |
| pycparser | 3.11 | BSD-3-Clause |
| ReportLab（仅 test 镜像） | 5.0.1 | BSD；附带字体另有许可，合成夹具只用 PDF 标准 Helvetica，不嵌入附带字体 |

依赖自带的许可证随安装包保留。PDFium 含第三方库，不能将整个二进制简化标为仅 MIT；分发镜像时须保留包内完整声明。ReportLab 附带 DarkGarden 等字体声明不等于本项目采用这些字体。原始 wheel 与许可证核对记录保存在本机忽略目录，不将第三方二进制提交到源码仓库。

## 为什么本轮没有安装 Docling

[Docling 官方使用 Skill](https://docling-project.github.io/docling/usage/agent_skills/) 随包提供，[v2.137.0 Skill](https://raw.githubusercontent.com/docling-project/docling/v2.137.0/docling/.agents/skills/docling/SKILL.md) 标为 MIT。已审阅其 CLI、Python SDK、slim 安装和离线边界。它是后续统一格式适配的候选，本轮未将它加入业务 Agent 白名单，也未复制或执行其安装示例。

官方 [Python SDK 参考](https://raw.githubusercontent.com/docling-project/docling/v2.137.0/docling/.agents/skills/docling/references/python-sdk.md) 中的无模型 NativePdfPipeline 可以提取原生内容，但不提供表格结构和阅读顺序推断。完整布局／表格／OCR 路线引入模型与额外依赖。本轮目标是小范围、纯本地、无需权重的可检查结果，因此使用成熟的 pdfplumber 网格检测与 PDFium 渲染，保留现有 adapter 边界；`docling_adapter.py` 继续是占位。

后续启用 Docling 模型前，单独核对所用模型许可、下载来源、资源开销与离线缓存。[Docling 的远程服务开关](https://docling-project.github.io/docling/usage/advanced_options/) 不阻止首次模型权重下载，不能只凭 `enable_remote_services=False` 声称完全离线。

[pdfplumber 官方文档](https://github.com/jsvine/pdfplumber) 提供字符／图像区域、表格候选和渲染接口；本实现没有使用它不存在的“完整图片语义理解”能力。OpenAI 旧 PDF Skill 的渲染复核方法可参考，但其仓库已弃用；Anthropic PDF/PPT Skills 为源码可见许可，本轮未复制。
