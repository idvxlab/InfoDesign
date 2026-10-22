# 阶段源码快照 — 2026-10-10

面向 `idvxlab/InfoDesign` 的独立开发分支快照。源码由当前本地工作树中的明确文件清单复制；不包含原仓库 Git 历史。业务实现、测试与锁文件保持源文件字节一致；首页、文档索引和进度说明针对公开快照更新。该快照不会自动同步回原开发目录。

## 上传范围

后端／前端源码与占位模块、协议 Schema 和生成类型、PDF 解析器源码、合成测试数据、测试、锁定依赖清单、容器配置模板、设计和开发说明。`snapshot-manifest.json` 记录上传文件的 SHA-256。

排除：所有原 Git 历史、真实文档与 PDF／图片、`.env`（空值模板 `.env.example` 除外）、模型凭据与本地模型配置、`.local-data/`、Pi 会话和日志、账单、历史运行报告、缓存、依赖目录、二进制产物，以及个人 Pi 费用显示扩展及其专用测试。包含的原始文本均为虚构测试夹具；没有从原始企业资料复制内容。

## verification

即将上传的精确快照已在隔离、无外网的本地容器中一次运行通过 245/245 项测试，并通过类型、生成一致性和协议检查。覆盖：

- 既有 175 项回归。
- SourceBundle 33 项与 `read_source` 22 项，共 55 项。
- 审查运行时 15 项。
- 严格项目 TypeScript、生成类型一致性及协议检查。
- 真实本地解析器生成的纯合成来源包读取：4 页、11 块、1 表、2 处图片引用。

以下为仓库开发容器准备完成后的复现命令，不触发真实模型：

```bash
bash scripts/dev-container.sh exec pnpm test
bash scripts/dev-container.sh exec pnpm check:types
bash scripts/dev-container.sh exec pnpm check:generated
bash scripts/dev-container.sh exec pnpm check:contracts
bash scripts/dev-container.sh exec node --test tests/integration/source-bundle.test.ts tests/integration/read-source.test.ts tests/integration/review-runtime.test.ts
```

Pi SDK 0.99.1、Node.js 24.11.1、pnpm 11.3.0、TypeScript 5.9.3。HTTPS 代理回归需要 OpenSSL 与系统中存在的容器用户；标准开发镜像提供该环境。本轮没有运行新的完整产品构建；根脚本尚无可用的产品 `build` 命令。解析器已有历史独立验证，本次快照准备未重跑其 Python 测试或安装依赖。GitHub 工作流仅为手动触发、明确失败的占位，不自动部署或调用模型。

## 未完成与边界

`read_source` 已校验身份、来源完整性、授权范围和输出结构，返回原文、物理位置、候选表格及图像引用；它没有 OCR 或图像语义能力。图片保持 `not_run`，表格保持 `candidate_not_reviewed`。它尚未接入 EvidenceAgent。独立审查仅具备运行时基础，完整 B4 Agent 与语义验收仍待实现。B3 的程序检查与历史合成实测不能替代独立审查，也不能证明完整多模态产品可用。设计、页面、持久化及完整工作流仍未完成。

原始运行日志、真实材料和账单未随公开快照上传。文档中的历史报告链接统一指向本说明，避免将私有运行记录作为公开文件引用。公开快照上传不新增任何真实模型或资料出站授权。
