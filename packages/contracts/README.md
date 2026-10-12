# 共享输入输出协议

本包是事实阶段协议的**唯一权威来源**。文字约定见 `../../docs/design/overview.md#agent-contracts`，溯源要求见 `../../docs/design/overview.md#provenance`。

## 目录

- `schemas/**/*.schema.json`：权威 JSON Schema（Draft 2020-12），包括角色与运行层工具协议。
- `src/validator.ts`：Ajv Draft 2020-12 严格校验适配、统一错误结构与 `canonicalize`。
- `src/schema-registry.ts`：按 `$id` 加载、跨文件 `$ref` 解析与完整性检查。
- `src/service-checks.ts`：结构校验之外的服务层校验。
- `src/fingerprint.ts`：规范化 JSON 与原始文本的 SHA-256 指纹。
- `generated/`：由 `scripts/generate-types.mjs` 生成的 TypeScript 类型与 `manifest.json`，请勿手改。

## 已实现协议（B0/B1）

任务 `task`、资料中间表示 `document-ir`、证据快照 `evidence-snapshot`、审查报告 `review-report`，
以及信息提取的输入／输出 `agents/evidence-input`、`agents/evidence-output`，
独立事实审查的输入／输出 `agents/review-input`、`agents/review-output`。
B2 新增 `runtime/read-document-request` 与 `runtime/read-document-result`：请求指定资料版本与块，结果返回原文、段落位置和内容指纹；不接受任意路径或模型权限。
`SchemaRegistry.validate` 支持已注册 `$id` 的定义片段，用于复用公共 scope 校验。工具结果不是候选 EvidenceSnapshot。

设计 v1 已实现 InformationPlan、PageSpec 的有限 Schema 与 `src/design-checks.ts` 的 `checkDesign` 服务校验。首版仅含 page、fact_text、comparison_matrix、disclosure 的接口形状；不代表组件已有实现。可信调用方必须提供固定快照指纹、授权记录、实际可用组件目录和主题。细节见 [设计协议验证记录](../../docs/reports/design-contracts-v1-2026-10-11.md)。

设计首次生成的 DesignInput／DesignOutput 与 `src/design-agent-checks.ts` 已实现：绑定服务保存的 inputHash、受众／目标和约束，区分完成、缺资料、缺组件及执行失败。字段见 [输入输出说明](../../docs/design/design-agent-io-v1.md)。此项不代表 Pi 设计会话已经实现。

未实现的协议（PageVersion、ChangeSet、组件工程输入输出）仍以 `not: {}` 拒绝全部输入；
对应生成的 TypeScript 类型为 `never`。

## Schema 校验与类型检查

运行依赖固定为 `ajv@8.20.0`、`ajv-formats@3.0.1`；使用 `ajv/dist/2020.js`，
`strict: true`、`validateFormats: true` 和格式插件 `mode: full`。所有文件注册后立即编译，
未知关键字、未知格式、悬空引用或异步 Schema 会阻止加载，协议配置有误时不能返回数据校验通过。
注册表缓存编译函数；数据错误仍返回 `{ valid, errors }`，保留实例路径、Schema 路径、关键字与说明。
校验不会转换类型、填默认值或删除未知字段，错误结果独立于后续调用。
Schema 只从可信代码目录加载；不得把上传资料或模型输出作为可编译 Schema。

为兼容严格编译，在叠加约束的对象／数组中为已有 `$ref` 补充显式类型，并为条件必填项显式声明属性；
标量扩展值使用等价的 `anyOf`。未放宽字段、权限、角色或候选待审要求。
回归同时覆盖完整日历日期、Draft 2020-12 的 `prefixItems`／`unevaluatedProperties` 及输入不变性。

根 `tsconfig.json` 使用 NodeNext、strict、noEmit、erasableSyntaxOnly；检查本包源码、全部生成类型、
夹具加载器、五个协议测试文件及 `tests/types/contracts.ts` 中的正反例。TypeScript 不能代替运行时
Schema 或服务层检查（例如日期格式、非空列表和引用关系），未实现业务文件不计入 B1 类型验收。

未接入真实解析的定位类型（`table_cell`、`page_region`、`slide`、`image_region`、`sheet_cell`）
在服务层会被明确标记 `location.not_verified` 并拒绝，不默认算作已验证；首轮只有 `paragraph` 定位完整校验。

## 结构安全

公开校验入口在结构非法时不抛异常：所有集合遍历前都通过 `asArray`/`asObject` 收窄类型，
结构错误以 `schema.*` 问题码报告，随后再基于已安全收窄的类型执行业务检查。

## B1 复核对齐

针对 `docs/reports/b0-b1-review-2026-10-10.md`：

- 审查输入与提取输入使用同一套资料权限检查：项目归属 + `scope.documentRefs` 授权双向核对。
- 候选快照及其每条事实的 `reviewStatus` 都必须为 `pending`（Schema 与服务层双重约束）。
- `evaluateAdoption` 的 `AdoptionContext` 类型必填 `outputStatus` 与 `checksRequired`；运行时同样拒绝缺失、空或类型非法的必需检查列表（`adoption.required_checks_missing`／`_empty`／`_invalid`），列表只取自可信调用参数，不从模型报告反推。
- `verdict: pass` 时存在 `error`/`critical` 问题直接拒绝；报告与任务、候选版本、必需检查逐项绑定。
- 来源定位校验字符范围与摘录位置；关系、事件、素材、缺失项、覆盖块的引用逐类核对。

## 两重校验

1. **结构校验**（`SchemaRegistry.validate`）：字段、类型、枚举、模式、必填与未知字段。
2. **服务层校验**（`src/service-checks.ts`）：由程序执行，模型输出不能替代。检查内容包括：
   引用是否存在（实体／事实／证据／关系／事件／素材／冲突／覆盖块）、资料版本是否匹配、
   原文位置与字符范围及摘录能否回查、项目与操作权限（提取与审查一致）、
   成果指纹与审查绑定、`pass` 与阻塞问题及必需检查是否矛盾、
   采纳前候选是否仍是 `pending` 且外层任务确已完成，以及是否伪造权限／采纳／角色字段。
   采纳入口还把 `outputStatus` 与可信 `checksRequired`（非空、类型合法）作为必填上下文。

服务层校验不替代独立审查 Agent 的语义核验；两者分别报告。

## 常用命令

```bash
pnpm generate:types     # 生成 packages/contracts/generated/
pnpm check:generated    # 只比较生成类型是否与 Schema 一致
pnpm check:types        # 真正的 tsc --noEmit，包含编译期正反例
pnpm check:contracts    # 类型一致性 + $ref 完整性 + 结构层正反例
pnpm test               # 全部协议测试
```

设计交底适配新增 design-review-ref.schema.json；四份设计协议可携带 reviewRef。只有独立可信上下文中的审查绑定核验通过，pending 候选才可供设计，不修改事实状态。引用本身不授予权限，见 docs/development/design-handoff-consumer.md。
