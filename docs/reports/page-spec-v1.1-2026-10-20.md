# PageSpec 1.1 实施与验证

本轮按用户要求同步实现 Schema、校验器、生成类型和测试。扩展输出协议及必要的输入/工具/正文封装接线；未实现组件、渲染或页面发布。

## 修改

- PageSpec 1.1 由服务显式启用，保留 1.0 精确结构约束；模型不能升级协议。
- 新增 section、narrative、asset_image、timeline、relation_graph、bar_chart、tabs、derived_value 接口；补充布局、主题 token、响应式、可访问性、来源、状态/动作与必需检查。
- 素材映射绑定固定来源；概括逐段保留依据；事件/关系核对授权端点和证据；柱图拒绝不可比数据；percentChange 限制明确的同口径年份输入并由程序计算。
- DesignInput/可信上下文增加版本和资源字段，交底入口转发；工具增加事件/关系/素材读取，SDK 验证读取回执。正文 Schema 按版本选择，保留旧模型输出预算。
- 类型通过现有脚本生成；完整合成输入、可信上下文、计划和 PageSpec 文件纳入直接加载测试。

详见[协议说明](../design/page-spec-v1.1.md)和[示例目录](../examples/design-contracts-v1.1/README.md)。

## 实际验证

复用已有 `infodesign-design-tests:local` 镜像，创建 `infodesign-pagespec-20261020` 容器。断网、普通用户、只读系统、移除 capabilities；不注入模型凭据，只读挂载源码，仅 generated 目录可写。Node 24.11.1，无新增依赖安装。

命令在容器内执行，宿主前缀为 `docker exec infodesign-pagespec-20261020`。

| 检查 | 实际命令／范围 | 最终结果 |
| --- | --- | --- |
| 扩展及示例 | `node --test tests/integration/pagespec-extensions.test.ts` | 40/40 |
| SDK | `node --test tests/integration/design-agent.test.ts` | 20/20；真实 SDK + 本地模拟网关 |
| 默认回归 | 下方包装执行 package.json scripts.test | 320/320，0 失败/跳过 |
| 设计类型 | `node node_modules/typescript/bin/tsc --noEmit -p tests/tsconfig.design.json` | 通过，含设计源码、共享协议、夹具和相关测试 |
| 类型生成 | `node scripts/generate-types.mjs` | 生成 23 文件 |
| 生成一致性 | `node scripts/generate-types.mjs --check` | 23 文件一致 |
| 协议检查 | `node scripts/check-contracts.mjs` | 21 Schema、463 引用；9/9 正例通过、16/16 负例拒绝 |
| 差异 | 宿主 `git diff --check` | 退出码 0；有 Git 后续转换 CRLF 的提示 |

默认回归实际执行：

```sh
node --input-type=module -e 'import fs from "node:fs";import {spawnSync} from "node:child_process";const args=JSON.parse(fs.readFileSync("package.json","utf8")).scripts.test.split(" ").slice(1);const r=spawnSync(process.execPath,args,{encoding:"utf8"});fs.writeFileSync("/tmp/pagespec-regression.log",r.stdout+r.stderr);console.log((r.stdout+r.stderr).split("\n").slice(-15).join("\n"));process.exit(r.status??1);'
```

没有真实外部模型、付费调用或浏览器验收。样例和网关响应均为合成数据，320 是本轮实际执行数。

执行输出已在本聊天工具记录中返回。临时日志写在容器 tmpfs；随后 docker cp 导出时报文件不可见，未保存本地原始日志。测试容器已停止，本报告保留实际命令和结果，不声称存在可下载的完整日志文件。

## 修复与限制

首次严格 Schema 编译发现缺少 object 类型，已修复。全量新 Schema 曾使旧 SDK 输出预算测试失败，已改为按版本选择正文结构，未降低原断言。新夹具类型转换错误也已修复。

完整 `tsc --noEmit -p tsconfig.server.json` 实际失败：仓库缺少 `domain/design-handoff.ts`、`domain/fact-run.service.ts`、`orchestration/fact-workflow.ts`、`tests/helpers/fact-workflow-harness.ts`，并产生关联隐式 any 错误。没有补造上游接口或修改完整检查掩盖错误。新增设计范围类型检查不替代完整检查；交底入口转发字段未完成上游联合验证。

`pnpm check:types` 在只读容器内触发依赖状态检查和安装，报 EROFS，后续直接调用已有 tsc。`bash scripts/check-contracts.sh` 因既有 CRLF 报 pipefail 错误，后续直接执行其两个 Node 检查步骤并通过；没有批量改写历史 shell 文件。

Docker 最初未启动，启动后创建隔离测试容器，未重启其他项目容器。未提交、推送或合并 Git。

组件、渲染器、素材服务、独立页面审查与局部修订仍未完成；checks 是要求，不是已执行报告。任意筛选、折线图、任意计算和其他时间口径未支持；原文仍只补查段落。1.1 真实模型质量及其上下文/输出容量未验收。

下一步按 1.1 接最小真实组件/渲染和来源操作，再联调页面审查。
