# 官方源码交接验证（2026-10-12）

本次将当前提取、独立审查、有限返修和设计交付代码整理到官方仓库同一提交历史，未改动业务功能或4096输出配置。原始开发目录只读取证；源代码、测试与依赖锁文件按SHA-256核对复制，发布副本的后续改动仅为文档清理与交接说明。

## 实际验证

以下命令在隔离容器内对发布副本执行，全部退出0：

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | 446通过、0失败、0跳过，36.730秒 |
| `pnpm check:types` | 根、server、B4/B5及交付测试三组通过 |
| `pnpm check:generated` | 22个文件一致 |
| `pnpm check:contracts` | 20个Schema、217个引用；9正例通过、16负例拒绝 |
| `node --test tests/dev-tools/pi-rmb-cost.test.mjs` | 7通过、0失败、0跳过 |

使用既有`tju-mas-dev-coder:full-acceptance-20261011`镜像，ID为`sha256:f673e83398ecc7b7496447371ed1eaefa87b45297ae390422b15055d0352beef`。Docker设置`--network none --read-only --cap-drop ALL --security-opt no-new-privileges`，源码只读，临时文件在容器tmpfs；没有挂载模型凭据、私人运行数据或开发依赖卷。真实Pi SDK调用仅连接容器内模拟网关，没有付费请求。

原始离线日志留在协调者本地审核目录，不随代码发布；发布内容指纹见根目录`snapshot-manifest.json`。Python解析器实现与已有官方快照相同，本次没有重跑解析器测试。没有完整产品构建或浏览器产品验收。`git diff --cached --check`另报告两个已有测试文件（`review-cli.test.ts`、`review-source.test.ts`）末尾多一个空行；本次保留源文件字节，没有为消除样式提示修改测试。

## 隐私与历史

按明确路径清单发布，排除原始企业资料、真实提取结果、私有HTML、凭据、非空环境文件、日志、账本、依赖及缓存。候选文件未检出与真实PDF任意24个连续非空白字符相同的正文片段；密钥模式命中均核对为合成反例。历史报告中真实文件名、私有附件标识与资料指纹已去除。该扫描只作辅助检查，不能替代文件范围核对。

本地16个旧文档路径删除属于此前的文档迁移，这些路径在官方已有快照中已不存在。本次保留并更新官方`SNAPSHOT.md`和指纹清单，避免将不在私人工作目录中的发布元数据误删。提交基于官方`02cb140e257fd481fe1495bf7da8cf7328d06eaa`，不移植私人Git历史、不强制推送、不合并或部署。

## 交付边界

设计端尚待联调，所有候选仍pending。最新真实14页PDF的客户端4096输出限制导致截断，未进入审查或返修，模型本身最大输出能力未核实。本次离线通过不能代替真实全文成功；见[设计交付说明](../development/design-handoff.md)和[真实PDF记录](real-pdf-test-2026-10-12.md)。

现有三个GitHub工作流均只有`workflow_dispatch`，任务明确失败以标记占位；推送不会触发有效CI，也不会部署或调用模型。

## 分支权限

GitHub官方API核对：当前默认分支为`snapshot/2026-10-10-multimodal-reader`，没有main，原最新提交为`02cb140e257fd481fe1495bf7da8cf7328d06eaa`。现有认证`push=true`、`admin=false`、`maintain=false`；默认分支改名需管理员权限，因此本次只向现有分支正常追加提交。没有发出改名或默认分支设置请求，没有新建远端替代分支或删除原分支。用户确认的main方案仍待管理员完成。
