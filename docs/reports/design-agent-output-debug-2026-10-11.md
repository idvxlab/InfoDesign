# 设计输出截断与交互绑定排查

## 已定位并修正

1. SDK 0.99.1 的 `api/simple-options.js` 根据 `contextWindow - estimateContextTokens(context).tokens - CONTEXT_SAFETY_TOKENS` 裁剪输出预算。项目固定使用 16,384 的保守上下文窗口；此前提示重复发送完整 common、PageSpec 和正文 Schema，占用了输出空间。新增线请求测试在旧实现测到配置 8,192、实际首请求仅 4,435，证明不是只需更换长度参数名。
2. 现在仅发送设计正文 Schema 的递归引用闭包，不发送无关公共定义和服务元数据外壳。服务端权威 Schema、权限和事实检查不变。独立编译闭包、合法正文与嵌套非法字段测试通过；按“目录 → 事实 → 正文”三轮模拟，两个长度参数配置下各请求均保留至少 6,000、至多 8,192 输出 tokens。
3. 模型曾把节点 events 的值写成新的 evt 编号，未指向 actions.actionId。页面编写 Skill 已明确直接引用关系和最小示例；不靠服务自动改写模型结果放行。
4. `runDesignAgent` 增加默认关闭的 `onDraft` 诊断回调。受信任调用方可将最多 262,144 字符的原始正文写入本地忽略目录；标注 unvalidated、停止原因及存储截断标志。正文不进入默认返回结果，不作为有效产物；诊断写入失败返回 diagnostic_failed。该回调不是模型工具，也不由用户输入决定保存路径。

## 真实试跑记录

所有输入均为既有 4 条纯合成事实；没有发送客户资料。沿用内部网络、域名白名单代理和受限容器。每次任务最多 4 次模型请求、12 次工具调用、180 秒；费用未知，没有人民币硬限额。此前首轮记录见 [首次真实试跑](design-agent-live-2026-10-11.md)。

| 轮次 | 变化 | 实际结果 |
| --- | --- | --- |
| 02 | 仅显式 max_tokens | 3 请求、5 次读取成功，仍 length 截断；44,796 ms |
| 03 | 精简 Schema；最多一次修正 | 4 请求、5 次读取成功；首版 invalid_draft，修正版 length，未接受产物 |
| 04 | 原始正文诊断；关闭修正 | 3 请求、5 次读取成功；完整正文通过 Schema，但 4 处 action_binding 与 4 处 unused_action 被服务校验拒绝 |
| 05 | 明确 events 直接引用 actionId；关闭修正 | completed，3 请求、5 次读取成功；61,045 ms，所有程序校验通过，未使用修正 |

本地 `.local-data/design-live/attempt-02` 至 `attempt-05` 保存各轮独立诊断，不覆盖首轮记录。第 04 轮的 `model-draft.unvalidated.json` 是原始模型正文的可读副本，不能作为已通过的设计使用。原始会话与凭据不提交仓库。

第 05 轮两份有效候选位于 `attempt-05/information-plan.json` 和 `attempt-05/page-spec.json`。人工阅读抽查：三个分区为业务概览、产品参数对比、技术服务；四条事实均绑定，比较表主体与属性相符，保留来源单位和限定条件，不做排名；三个来源动作均正确引用。该抽查不等于独立页面审查，也未验证视觉或交互。最终布局未使用 disclosure，不能把本轮当作真实模型展开组件验收。

第 05 轮 SDK 报告 input 6,616、cacheRead 10,752、output 4,658、cacheWrite 0；实际费用未知。所有本次容器已停止。真实模型已生成通过程序校验的合成候选，但组件实现、渲染、客户数据和独立语义验收仍未完成。

## 离线验证

在断网容器执行：

```sh
node --test tests/integration/contracts-design.test.ts tests/integration/design-agent.test.ts
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.server.json
node --test --test-name-pattern 'max_tokens|模型选择' tests/integration/pi-session.test.ts
```

设计测试 87/87（69 协议 + 18 运行时）、类型检查通过；既有长度配置映射测试 2/2 通过。最后提示词示例修改后又执行三轮请求的 6,000-token 回归并通过。本轮没有重新执行完整默认回归；此前 275 项结果属于上一版。当前默认测试集合为 262 项。
