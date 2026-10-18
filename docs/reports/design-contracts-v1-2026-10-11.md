# 设计协议 v1 最小切片验证

日期：2026-10-11。用户同意按配套 Plan/PageSpec 样例试行。本轮实现协议与程序校验，不运行付费模型，不实现渲染器，也不改变提取／审查业务角色。

## 已实现

- InformationPlan：固定项目／任务／尝试／快照版本及指纹、设计来源、受众与目标、问题、平铺有序分区、选择／省略及未决问题。
- PageSpec：计划版本和指纹、组件目录／主题版本及指纹、有界节点树、明确 claimVersionId 的值绑定、比较表逐格绑定及列 predicate、响应式模式、布尔展开和受控来源动作、检查声明。
- 固定字段关闭未知属性。协议版本 1.0；组件接口版本 0.1.0，仅支持 page、fact_text、comparison_matrix、disclosure。它们是接口约定，不是已注册可运行组件。
- `packages/contracts/src/design-checks.ts` 的 checkDesign：先校验结构，再核对可信上下文、授权来源、快照审核状态、逐条事实可用状态、证据 ID、版本指纹、行主体与列属性、计划覆盖和顺序、动作状态以及主题 token。必需检查从组件用途推导，不能由模型任意省略。
- 明确省略的授权记录允许未审查，但不可混入显示事实。输入与节点有大小／深度预算；循环及结构非法输入返回错误。
- 从 Schema 重新生成类型；新增测试纳入默认 `pnpm test`，新增 `pnpm test:design`。

调用方必须从可信服务构造 DesignContext。组件列表应只包含实际可用实现；测试目录和主题不属于生产登记。校验器不直接查询数据库或执行素材访问，也不签发审查结果；它检查的是调用方提供的固定授权快照，不能用模型提供的同名对象代替。

## 验证环境及命令

Windows 上启动 Docker Desktop，使用现有 `deploy/Dockerfile.dev` 构建 `infodesign-design-tests:local`，依赖按现有锁文件安装。临时容器 `infodesign-design-check-20261011` 使用无网络、只读根文件系统、普通用户、cap-drop ALL、no-new-privileges、2 GB 内存／2 CPU／128 进程限制。只挂载本轮 Schema、源码、测试、文档和 package.json；生成类型目录可写，不挂载模型凭据或宿主主目录。

实际执行：

```text
docker build -f deploy/Dockerfile.dev -t infodesign-design-tests:local .
docker exec infodesign-design-check-20261011 node scripts/generate-types.mjs
docker exec infodesign-design-check-20261011 node --test tests/integration/contracts-design.test.ts
docker exec infodesign-design-check-20261011 node node_modules/typescript/bin/tsc --noEmit
docker exec infodesign-design-check-20261011 node scripts/check-contracts.mjs
docker exec infodesign-design-check-20261011 node scripts/generate-types.mjs --check
git diff --check
```

原默认回归和新测试的合并命令：

```text
docker exec infodesign-design-check-20261011 node --test tests/integration/contracts-validator.test.ts tests/integration/contracts.test.ts tests/integration/contracts-service.test.ts tests/integration/contracts-regressions.test.ts tests/integration/contracts-design.test.ts tests/integration/generated-types.test.ts tests/integration/pi-session.test.ts tests/integration/pi-proxy.test.ts tests/integration/evidence-agent.test.ts tests/integration/evidence-replay.test.ts tests/integration/spend-budget.test.ts tests/integration/evidence-quality.test.ts
```

结果：

- 初次新增测试暴露对象共享引用被误判为循环的问题；改为有界遍历后通过。
- 合并回归 214/214 通过（原有 175＋当时新增 39）。随后补充省略未审查记录的规则，最终独立设计测试 40/40 通过；最终版本未再次执行整组合并测试，原模块未再变更。
- 根项目 TypeScript 最终检查通过；服务端 TypeScript 在本轮前段通过，后续未改服务端代码。
- 全部 20 个 Schema 严格编译及 284 处引用检查通过；原结构正例 9/9、反例 16/16 通过。
- 22 个生成文件的一致性检查通过。git diff --check 通过。

只读容器中，修改 package.json 后 `pnpm test`／`pnpm test:design` 的依赖状态检查尝试写临时文件而失败（EROFS）。因此实际使用上面的等价 Node 命令复用已安装锁定依赖，不放开文件系统或网络。普通可写开发容器仍使用 package scripts。

Windows 初次原回归 174/175：两个合成原文被 Git 转成 CRLF，破坏已有 SHA-256。已先核对还原 LF 后恰好等于提交的指纹，再固定 `.gitattributes` 中测试原文与生成类型的 LF 规则；没有更改预期指纹或客户资料。

## 未实现与下一步

收尾：上轮停止测试容器时自动审批因额度限制未完成，命令未执行。本轮继续后 `docker stop infodesign-design-check-20261011` 成功；保留测试镜像和文件。重新执行 git diff --check 通过，未重复运行已通过的业务测试。

- 测试快照和 passed 状态是测试装配，不能冒充真实上游审核。客户真实审核 JSON 仍未提供。
- 没有业务 DesignInput/DesignOutput、Pi 设计会话、页面渲染、浏览器行为或独立语义验收。对应 Agent 输入输出、PageVersion、ChangeSet 等 Schema 继续拒绝全部输入。
- 当前只验证来源 ID 存在与绑定关系；原文定位与摘录真实性依赖上游及独立审查，不能由本校验器证明。
- 标题和文字是否夸大、参数条件是否语义可比、资料覆盖是否充分仍需语义审查；检查声明也不等于检查已执行。
- 素材展示、关系图、时间轴、自由概括、派生计算和任意组件扩展不在本切片内。
- 下一步定义设计 Agent 的输入输出及受控工具，将 Schema 和服务反馈接入真实 Pi 会话；实际渲染需配套组件实现与可信目录。业务验证必须继续在隔离环境进行。
