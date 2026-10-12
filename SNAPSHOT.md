# 官方源码交接 — 2026-10-12

本次交接承接官方仓库`idvxlab/InfoDesign`已有提交`02cb140e257fd481fe1495bf7da8cf7328d06eaa`，不导入私人开发仓库的Git历史。用户确认将原快照分支通过GitHub分支改名机制迁至`main`。当前认证有代码推送权限、无管理员权限，改名仍待管理员完成；本次先向原快照分支沿同一历史追加当前代码。原Mac开发目录、`initial_test_zjt`及其origin保持独立。

## 上传范围

受控来源读取及信息提取、独立审查、程序编排的有限返修、本地历史与只读设计交付适配；协议Schema及生成类型、源码、锁文件、合成夹具、容器配置模板、测试和开发／设计文档。通用Pi费用显示扩展及其7项测试一并保留，费率仅为显式标注的估算配置。

业务实现、测试与锁文件逐文件保持当前开发源的字节一致；发布差异只涉及文档清理、导航和阶段说明。`snapshot-manifest.json`记录发布文件SHA-256，清单自身除外。

排除真实PDF／图片及其提取结果、私有HTML、凭据、非空`.env`、持久认证与模型配置、`.local-data/`、会话日志、原始账本、依赖、缓存和运行产物。历史报告只保留工程结论与统计，真实文件名称、私人交付标识和来源指纹已移除；完整私有证据不随仓库发布。

## 本次复验

在隔离、断网、无凭据、只读源码容器中执行：

```text
pnpm test                                      # 446/446
pnpm check:types                               # 三组通过
pnpm check:generated                           # 22文件一致
pnpm check:contracts                           # 20 Schema、217引用、9正例／16负例
node --test tests/dev-tools/pi-rmb-cost.test.mjs # 7/7
```

Node.js 24.11.1、pnpm 11.3.0、Pi SDK 0.99.1、TypeScript 5.9.3。使用既有完整依赖镜像，未安装新依赖或启动真实模型。解析器源码相对已有官方快照未改动，本次没有重跑其历史Python验证。项目尚无完整产品build；GitHub工作流仅为手动触发且明确失败的占位，不能称为CI通过。详细验证见[交接记录](docs/reports/official-handoff-2026-10-12.md)。

## 当前边界

设计交付仍待设计团队联调，ready不等于事实采纳；设计Agent、正式设计协议、HTTP、生产保存与完整页面尚未完成。最新14页真实PDF任务因本项目客户端4096输出Token配置截断，未生成有效候选、未进入独立审查或返修；模型实际最大输出能力未知。历史B4 v12七类验收不能当作当前v14同版七类通过。详见[当前状态](status.md)、[交付接口](docs/development/design-handoff.md)与[真实PDF记录](docs/reports/real-pdf-test-2026-10-12.md)。
