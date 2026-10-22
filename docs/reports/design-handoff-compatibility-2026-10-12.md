# 新交底接口与设计分支的兼容性检查

依据：用户提供的 [design-handoff.md](../development/design-handoff.md)，已原样复制并比对文件哈希。它说明同学分支的服务交底接口，不是让本地删除设计 Agent 或恢复占位 Schema 的指令。

检查对象：本地 codex/design-agent 工作区（包括暂存及未提交改动），基点 02cb140。2026-10-12 只读查询 `git ls-remote --symref origin HEAD`：默认分支为 snapshot/2026-10-10-multimodal-reader，远程 HEAD 为 e55a9061279675b5ec2f2a8eee957bb669d59612。没有拉取、合并、提交或推送；未检查远程新代码的具体实现。

## 结论：设计原型存在，但不能直接消费新交底包

| 对接项 | 本地证据与结论 |
| --- | --- |
| ready 交底包结构 | 不兼容。DesignInput 要求 snapshot、snapshotRef、audience、goal、constraints、catalog、theme 等；未实现 evidenceOutput/reviewOutput/documents 到设计任务的适配。不能把 ready 包或 mock 摘要直接传入 runDesignAgent。 |
| 复核与采纳分离 | 关键冲突。新包的 reviewVerdict=pass 在 identity 内，但候选及 claims.reviewStatus 仍 pending；本地 design-agent-checks.ts:39 要求 snapshot.reviewStatus=passed，design-checks.ts:107 还要求被引用主张 supported 且 passed。即使映射出快照，也会被拒绝。 |
| 服务端交底核验 | 未接入。本地没有 domain/design-handoff.ts、domain/fact-run.service.ts，也没有 produceDesignHandoff/verifyDesignHandoff 或 HandoffContextPins 的调用。设计侧 DesignTaskContext 不能替代对 store 历史及候选／报告版本的核验。 |
| blocked | 未接入上游分支。上游 blocked 不含事实负载，必须在服务层直接停止、不调用设计模型。当前设计输出中的 blocked 特指缺组件，不能与上游 blocked 含义混用。 |
| 只读及权限 | 方向一致。设计工具克隆输入，只读取，不写权威事实；授权由可信调用方提供。尚不能据此声称已经验证交底包的 allowedDocumentRefs、checksRequired 和报告指纹。 |
| 来源定位 | 部分兼容。现有定位器使用对象；设计 evidence 工具只支持 paragraph，并通过 DocumentAccess 读取原文。需由适配层从独立授权与 documents 构造访问范围，其他定位类型仍不支持。 |
| 模块状态描述 | 文档称 DesignInput=never、DesignAgent 未实现，反映对方尚未集成设计的分支。本地已有正式接口和真实 Pi 实现，这是待合并的工作，不应回退为 never。 |
| 测试 | 原 87 项设计测试使用合成 passed 快照，不能证明新 pending + 独立通过报告的路径有效。本地没有 test:handoff 脚本，也没有对方报告 design-handoff-2026-10-12.md，无法复核其测试结论。 |

## 后续适配建议（尚未实施）

1. 保留本地设计改动的独立提交，再同步默认分支中的新交底实现与测试，按差异合并共享文件。
2. 在服务层调用 verifyDesignHandoff(submitted, store, registry, pins)，pins 必须独立提供。只有校验成功的 ready 才进入后续装配；blocked、篡改、旧版本、越权或不完整检查均停止。
3. 与同学确定“已复核但未采纳候选可供设计”的正式条件。建议用服务核验过的候选／报告版本和检查结果建立只读设计授权，保留原 pending；不要把 pending 改成 passed，也不要简单移除现有门槛。该条件需要同步 DesignInput、可信上下文和校验规则。
4. 装配受众、目标、组件目录、主题与 DocumentAccess，保留候选版本、报告哈希、来源块和对象定位器；mock 摘要不替代完整交底负载。
5. 补充真实交底形状的合成联调测试：合法 ready（pending + 独立 pass）、blocked 无模型调用、报告/候选版本篡改、旧版本、权限、定位器、缺组件及任务输入指纹。最后由团队进行真实模型／页面验收。

本轮仅做文件归档、静态代码和既有测试断言核对、远程默认分支只读查询。未执行业务测试或模型调用，未修改协议、实现或校验门槛。当前 87 项通过记录仍是此前版本证据。

## 分支与 PR 的含义

commit 保存一组代码差异；push 把这个提交所在的功能分支上传 GitHub；PR 是请求团队把功能分支的差异合并到目标分支。打开 PR 不等于合并，团队可先审阅、测试、讨论和解决冲突。

本地已有 codex/design-agent，可继续使用；不必再建同名分支。当前代码尚未 commit，所以单纯 push 分支不会包含这些改动。后续推送应推功能分支，在 PR 中设置 compare=codex/design-agent、base=团队届时的默认分支（本次查询为 snapshot/2026-10-10-multimodal-reader）。创建 PR 前再次确认目标；不要假定默认分支叫 main，也不要上传整库覆盖或强制推送默认分支。

## 后续实现

以上为修改前审计。2026-10-12 已补齐可信核验适配、pending 语义和 reviewRef 溯源；默认 273 项及与远程真实 B5 的 36 项联合测试通过。未直接合并上游到本地工作分支，服务端仍需按[新入口说明](../development/design-handoff-consumer.md)装配；见[验证报告](design-handoff-consumer-2026-10-12.md)。
