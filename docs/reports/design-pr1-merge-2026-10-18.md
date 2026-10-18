# 设计 PR #1 合并验证 — 2026-10-18

本轮按用户明确授权，以官方默认分支为基准合并设计核心，保留双方历史；缺失的外围协议、消费实现和测试交由后续任务补齐。合并不表示业务验收通过，没有调整校验标准或付费调用。

## 合并范围

- 默认基准：`snapshot/2026-10-10-multimodal-reader`，`04c6a98a6705a164cb01377ca72b35fb64b8f4fa`。
- 设计来源：`design-agent-2026-10-12`，`0d34a1282c78ebdfe967e352b65f7b62fc25e3ae`，PR #1。
- 两者共同祖先为 `e55a9061279675b5ec2f2a8eee957bb669d59612`。采用普通双父 merge commit；不改写协作者分支、不强推、不删除分支。
- 8 处文本冲突逐项整合：execution-limits、session-factory、package.json、docs/README、overview、project-spec、status、tests/README。行尾格式差异导致部分整文件冲突；实际按功能差异处理。
- 保留提取输出 16384、提取上下文 32768、审查 8192、探测 1024，纳入 DESIGN_LIMITS 8192、design 角色、独立会话前缀和设计资源加载。其他角色上下文仍为 16384。
- 分段核心与对应测试保持默认分支内容；默认测试保留全部原登记、串行及 spec 报告，再追加设计的三个测试路径。test:design、test:design-handoff 保留；根、服务端、B4 三组类型检查保持。
- 另处理一处无文本冲突的兼容差异：事件记录保留 read_document、read_source，并增加 read_design；未知工具仍折叠为 unrecognized。设计 Agent 核心、工具和校验实现保留协作者内容。

## 当前检查结果

在已有日常开发容器内，使用独立临时源码目录和现有锁定依赖运行；没有安装依赖、创建或重启容器。执行环境清空模型凭据，Pi SDK／CLI 测试只使用合成数据和本地模拟网关。

| 检查 | 实际结果 |
| --- | --- |
| `node --run test` | 退出 1；154 个测试条目，101 通过、53 失败，0 跳过。文件加载失败也计为失败条目，不能把 154 解释为全部原用例已执行 |
| `node --run test:design` | 退出 1；两个现有测试文件均在 Schema 加载阶段失败，0 通过、2 失败 |
| `node --run test:design-handoff` | 退出 1；找不到 design-handoff-consumer.test.ts，未执行用例 |
| 根、server、B4 三组 `tsc --noEmit` | 各退出 2，各有相同的 5 条 TS2307，均指向缺失 design-review-ref.ts；未降低 strict 或忽略错误 |
| `node --run check:generated` | 退出 1；design-input、design-output、information-plan、page-spec、manifest 五项不一致 |
| `node scripts/check-contracts.mjs` | 退出 1；design-input 的 design-review-ref 悬空引用导致 MissingRefError |
| `node --test --test-reporter=spec tests/dev-tools/pi-rmb-cost.test.mjs` | 7/7 通过 |
| 辅助零请求会话检查 | 5/5 通过：四类角色预算上限／越界拒绝、上下文、独立资源与清理，以及三个工具名的诊断白名单；0 模型请求 |

共享 Schema 注册表会严格编译全部协议。缺失 reviewRef 会连带阻断原事实／审查／分段测试，部分来源和 CLI 测试因此得到内部错误或非预期退出。不能沿用合并前 504/504 的结果，也不能把设计分支历史 273/98/36 项记载视为本次复验通过。

默认测试的 design-review-binding 路径仍登记，但 Node 24 在有其他匹配文件时未将这个缺失路径单独报告为失败；静态文件存在性核对仍明确判为缺失。另执行现有文件集合诊断，仍遇同一 Schema 阻塞；没有据此删改默认登记或宣称通过。

首次辅助执行的 PATH 漏掉已有 Pi CLI，造成另外 3 条 ENOENT；补上现有 `/workspace/apps/server/node_modules/.bin` 后完整默认检查得到上表 101/53。首次会话检查误在 prompt 前读取尚未装配的 agent systemPrompt，后按锁定 SDK 的 resourceLoader.getSystemPrompt() 核对，5 项通过；两次检查均未 prompt、未请求模型。这些是验证脚本的环境／接口修正，没有改动业务实现。

## 留给后续任务的缺口

- `packages/contracts/schemas/design-review-ref.schema.json`。
- `packages/contracts/generated/design-review-ref.ts`，以及恢复相关生成文件一致性。
- `tests/integration/design-review-binding.test.ts`。
- `tests/integration/design-handoff-consumer.test.ts`，以及对应可信消费入口与服务装配。
- 设计文档引用的 `docs/development/design-handoff-consumer.md`、`docs/reports/design-handoff-consumer-2026-10-12.md`、`docs/reports/design-handoff-compatibility-2026-10-12.md` 也未提供。

这些 reviewRef 约束属于设计之前的事实审查／可信交底，随后同一绑定进入设计产物，不是仅属于设计完成后的页面审查。现有上游 design-handoff.ts 和 design-handoff.test.ts 不能替代设计侧消费实现与测试。缺少文件只能证明当前两分支未提供，不能断言协作者本机没有未提交版本。

PDF 分段适配、页码／区域映射、失败段恢复、真实全文验收、生产保存、渲染与独立页面审查仍未完成。本轮不补这些业务能力。

## 复验与证据

在已配置的开发容器内，从合并版本根目录执行：

```bash
node --run test
node --run test:design
node --run test:design-handoff
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.server.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.b4-tests.json
node --run check:generated
node scripts/check-contracts.mjs
node --test --test-reporter=spec tests/dev-tools/pi-rmb-cost.test.mjs
```

执行端 `.local-data/merge-pr1-20261018/` 保存逐命令退出码、完整离线日志、辅助检查脚本、源码指纹、保护核对和扫描证据；这些本地日志不随公开提交上传。`validation.json` 保留首次执行，`validation-final.json`、`default-test-final.log`、`runtime-merge-final.log` 记录修正后的验证。

发布范围核对覆盖合并候选及引入的公开历史：无冲突标记，没有新增原始 PDF、图片、提取资料、凭据、账本或模型会话。匹配到的测试凭据为合成字面量；默认分支既有历史报告的本地路径引用保持原样，不读取或上传其指向内容。原用户工作区 440 个路径、HEAD、分支、索引及 Git 状态均以指纹保护；仅隔离官方 checkout 承载本次合并。
