# 设计 Agent 输入输出协议验证

2026-10-11，分支 codex/design-agent。本轮只实现 DesignInput／DesignOutput 和服务校验，不接入 Pi 设计会话、工具或渲染器。接口说明见 [DesignInput / DesignOutput v1](../design/design-agent-io-v1.md)。

## 修改范围

- 补齐 schemas/agents/design-input.schema.json 与 design-output.schema.json；其他未实现的 PageVersion／ChangeSet 等继续拒绝输入。
- 新增 design-agent-checks.ts 的 checkDesignInput／checkDesignOutput，以可信 inputHash 和 DesignContext 校验任务、授权、快照、组件与主题；成功输出复用原 checkDesign。
- 成功必须包含两份设计成果；缺资料、缺组件、执行失败使用不同停止分支，不能同时携带候选页面。成功计划不得保留未决问题。
- 原 design-checks.ts 仅将有界 JSON 检查导出复用；未改既有提取／审查运行层。生成设计输入输出类型和清单。
- 在现有设计测试文件新增 29 项任务检查，默认测试入口自动覆盖；补充编译期负例。未新增依赖。

## 已执行验证

复用无网络、只读根文件系统的 infodesign-design-check-20261011 容器，挂载方式见[前轮验证记录](design-contracts-v1-2026-10-11.md)。未提供模型凭据；SDK 回归使用本地模拟网关。

```text
docker exec infodesign-design-check-20261011 node scripts/generate-types.mjs
docker exec infodesign-design-check-20261011 node scripts/check-contracts.mjs
docker exec infodesign-design-check-20261011 node --test tests/integration/contracts-design.test.ts
docker exec infodesign-design-check-20261011 node node_modules/typescript/bin/tsc --noEmit
docker exec infodesign-design-check-20261011 node scripts/generate-types.mjs --check
```

- 设计测试 69/69 通过，覆盖完成、停止、缺产物、错误需求类型、输入篡改、越权、身份错配、目标／受众／语言变化、分区／节点数量和非法输入。
- 全部 20 个 Schema 严格编译，303 处引用有效；原有结构正例 9/9、反例 16/16 通过。
- TypeScript 检查及全部 22 个生成文件一致性通过。
- 完整默认测试命令如下，244/244 通过，无跳过：

```text
docker exec infodesign-design-check-20261011 node --test tests/integration/contracts-validator.test.ts tests/integration/contracts.test.ts tests/integration/contracts-service.test.ts tests/integration/contracts-regressions.test.ts tests/integration/contracts-design.test.ts tests/integration/generated-types.test.ts tests/integration/pi-session.test.ts tests/integration/pi-proxy.test.ts tests/integration/evidence-agent.test.ts tests/integration/evidence-replay.test.ts tests/integration/spend-budget.test.ts tests/integration/evidence-quality.test.ts
```

## 限制与后续

合成测试的 passed 状态由夹具装配，不是真实审查。ok=true 仅表示响应满足协议，仍需查看 status；completed 也不代表页面验收通过。视觉指导、概括准确性与资料是否充分需后续语义／视觉检查。目录接口和可信数据由服务提供，本轮没有实现目录登记、访问服务或真实组件。

下一步接入真实 Pi 设计会话与受控工具，再做模型生成验收。业务服务实际组装和保存 inputHash 前，不得从模型输入自建可信上下文。
