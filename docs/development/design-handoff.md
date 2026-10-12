# 设计交付接口

本模块位于 `apps/server/src/domain/design-handoff.ts`，`packageVersion` 为 `1.0`。它属于服务适配层，仅生成和校验只读证据交底包。

## 当前范围

- 不包含设计代理、HTTP 端点、采纳逻辑或审批门槛；`DesignAgent` 尚未实现，也未被调用。
- `DesignInput` 的生成类型仍为 `never`；对应 JSON Schema 不是 `{}`，继续拒绝所有输入。
- `designTeamStatus` 为字符串 `待联调`，不是 `null` 或空值；设计团队尚未参与集成。
- `ready` 只表示已复核候选被整理为只读交底包，不代表候选已被采纳。
- 候选与主张的评审状态仍为 `pending`。`supportStatus: 'supported'` 说明有来源支撑，与评审状态是两个独立维度；两者同时出现不表示评审状态已改变。

## 导出接口

| 函数 | 参数 | 返回 |
| --- | --- | --- |
| `produceDesignHandoff` | `store: FactRunStore, registry: SchemaRegistry, pins: HandoffContextPins` | 交底包 |
| `verifyDesignHandoff` | `submitted, store, registry, pins`（四个参数均必填） | `{ ok, reasons }` |
| `summarizeDesignHandoff` | `submitted, store, registry, pins`（四个参数均必填） | mock 摘要或 `null` |

- 对 `FactRunStore` 只调用 `get(runId)` 读取记录，不写回，也不执行采纳。
- `FileSystemFactRunStore` 用于保存本地私有历史，不是生产数据库。

## 可信上下文 Pins

`HandoffContextPins` 字段：

- `runId`、`projectId`、`taskId`、`attemptId`
- `expectedCandidateVersionId: string | null`、`expectedReportVersionId: string | null`
- `allowedDocumentRefs`
- `checksRequired`

权限由服务调用方独立提供，不能从提交的交底包中获取。B5 使用完整的 `DEFAULT_REVIEW_CHECKS`；实现拒绝空列表和非法取值，但不要求每次都传入完整列表。

指纹是 SHA256 摘要，不是数字签名，不能用于来源认证。本模块只接受只读且已校验的 B5 历史，不接受上传的报告。来源句柄与回执不会持久化；本模块也不会重跑 B4 语义评审或伪造回执。

## Ready 结构与只读负载

`identity` 包含 `reviewVerdict: 'pass'` 与 `stopReason: 'passed_all_checks'`；`reviewVerdict` 和 `stopReason` 都在 `identity` 内，不是顶层字段。`claims` 也不在 `ready` 顶层。

其余部分沿用现有只读负载：`evidenceOutput` 复用 `EvidenceOutput`，`reviewOutput` 复用 `ReviewOutput`，`documents` 复用 `EvidenceInput['documents']`。原有标识与版本、报告哈希、来源块与定位器均保留。交底包保持只读，并与来源分离。

`sourceLocations` 的 `locator` 是对象，例如 `{ kind: 'paragraph', paragraphIndex: 0 }`，不是字符串。

下面的就绪状态和 mock JSON 都是摘录，不能作为完整输入。示例使用虚构公司：截至 2025 年有研发人员 60 人，成立于 2018 年。早期记录中的 600 应为 60；新旧记录的 reviewStatus 均为 `pending`。

```json
{
  "kind": "ready",
  "packageVersion": "1.0",
  "designTeamStatus": "待联调",
  "identity": {
    "reviewVerdict": "pass",
    "stopReason": "passed_all_checks"
  },
  "sourceLocations": [
    {
      "evidenceId": "ev_rd",
      "documentId": "doc_repair",
      "documentVersionId": "docv_repair_1",
      "blockId": "b001",
      "locator": { "kind": "paragraph", "paragraphIndex": 0 }
    }
  ]
}
```

mock 摘要如下，其中 `evidenceIds` 复制自 `claim.evidenceRefs`：

```json
{
  "claims": [
    {
      "claimId": "claim_rd",
      "supportStatus": "supported",
      "evidenceIds": ["ev_rd"]
    }
  ]
}
```

## Blocked 结构

```json
{
  "kind": "blocked",
  "packageVersion": "1.0",
  "designTeamStatus": "待联调",
  "recordedAt": "2025-01-10T08:00:00Z",
  "stopReason": "needs_user_input",
  "reasons": [
    {
      "code": "status.not_passed",
      "message": "运行终态不是 passed",
      "path": "status"
    }
  ]
}
```

`stopReason` 与 `reasons[].code` 是两个独立字段。缺失、冲突、修复达到上限或技术失败时，均返回 blocked。包中不包含事实或文档负载；校验返回 `ok: false`，摘要为 `null`。

## 示例用法

以下调用示例以项目根目录为基准，仅演示用法。可信 `pins` 由服务调用方提供，与提交包无关。

```ts
import {
  produceDesignHandoff,
  verifyDesignHandoff,
  summarizeDesignHandoff,
  type HandoffContextPins,
} from './apps/server/src/domain/design-handoff.ts';
import type { FactRunStore } from './apps/server/src/domain/fact-run.service.ts';
import { loadSchemasFromDir } from './packages/contracts/src/schema-registry.ts';

export function consumeReviewedFacts(
  store: FactRunStore,
  pins: HandoffContextPins,
) {
  const registry = loadSchemasFromDir('packages/contracts/schemas');
  const pkg = produceDesignHandoff(store, registry, pins);
  const verification = verifyDesignHandoff(pkg, store, registry, pins);
  const summary = summarizeDesignHandoff(pkg, store, registry, pins);
  return { pkg, verification, summary };
}
```

## 内容与授权

包可能包含 `DocumentIR` 中已授权的文本与位置，不包含原始 PDF 或图像二进制。文本与位置同样需要来源内容的使用授权。当前验收仅使用虚构数据，不涉及真实文件或外部业务模型调用。

## 测试与结论

测试使用真实 Pi SDK 和本地 mock 网关，不调用真实模型。以下命令只在已准备好、依赖版本已锁定的 Docker 环境中执行，不在宿主机上运行 Pi SDK。

| 命令 | 说明 |
| --- | --- |
| `pnpm test:handoff` | 交底模块测试 |
| `pnpm test` | 完整测试 |
| `pnpm check:types` | 类型检查 |
| `pnpm check:generated` | 生成物检查 |
| `pnpm check:contracts` | 契约检查 |

现有开发依赖卷保持不变。最终结果以 `../reports/design-handoff-2026-10-12.md` 为准。

## 后续联调

后续需由设计团队确认正式消费方的目标、组件与采纳边界。设计端仍需另行实现。
