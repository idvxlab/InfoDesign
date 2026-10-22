# 设计交底适配验证（2026-10-12）

新增交底消费入口、DesignReviewRef Schema/生成类型、可信审查绑定校验和测试。pending 候选在真实交底核验后可供设计，事实状态不被改写，成果保留候选／报告／交底关联。新失败分支在启动模型前停止。

## 实际验证

- 本地代码在隔离容器执行 package.json 默认 test 所列的 `node --test` 文件：273/273，通过，无跳过。
- 其中设计协议及 SDK 87 项、新增审查绑定 11 项，共 98 项通过。新增覆盖客户端伪造引用、候选版本变化、不可用事实、产物引用丢失和核验失败零调用。
- `node node_modules/typescript/bin/tsc --noEmit` 与 `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.server.json` 通过。
- 协议检查通过：21 个 Schema、316 个引用、9 个正例和 16 个反例。生成类型已重新生成，生成一致性包含在默认回归中。

## 与同学真实实现联合验证

使用 `git fetch origin` 后的远程默认分支 `origin/snapshot/2026-10-10-multimodal-reader`，提交 `e55a9061279675b5ec2f2a8eee957bb669d59612`。在忽略目录 `.local-data/handoff-integration/source` 解包该提交，再叠加设计侧源文件和测试，未合并或覆盖本地主分支。

独立容器 infodesign-handoff-integration 禁用外网、只读挂载源代码，执行上游 design-handoff 测试与新增 design-handoff-consumer 测试：36/36（24+12）通过。新增测试调用真实 B5 workflow、produceDesignHandoff 和四参数 verifyDesignHandoff；证据、审查、设计 Pi SDK 的模型回复均来自本地模拟网关，不使用真实客户资料或付费 API。

新增 12 项覆盖：合法 ready、原状态不变、上游与设计任务身份分开、blocked、候选篡改、报告版本篡改、原文定位篡改、旧版本 pins、资料范围不足、必需检查缺失、运行状态变化、store 异常、原文读取及完整设计成果（多个断言归于同一测试）。

合并后可在团队容器复现：

```sh
pnpm test:design
pnpm test:design-handoff
pnpm check:types
pnpm check:generated
pnpm test
```

`test:design-handoff` 必须有同学的 B5 源码与 fact-workflow-harness，旧本地快照缺少时明确报错。本轮联合验证证明所测远程版本的接口兼容；不代表已经接入业务 HTTP 服务或完成真实模型、客户数据、渲染与发布验收。未新增模型调用费用，未执行 Git 提交或推送。
