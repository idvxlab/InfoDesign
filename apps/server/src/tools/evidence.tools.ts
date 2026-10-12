/** 事实角色受控读工具选择器。
 *
 * - 未提供可信 SourceBundle 时：沿用既有 read_document（严格 paragraph-only），行为不变。
 * - 提供可信 SourceBundle 时：改用 createReadSourceTool，支持物理定位（PDF 文本/表格/图片区）。
 *   每个会话只暴露一个受控工具，杜绝同时开放两条读取路径。
 *
 * bundles 只能来自可信服务，不来自模型参数；此处不做真伪校验以外的放宽。
 */
import type { CommonScope, DocumentIr } from '../../../../packages/contracts/generated/index.ts';
import type { SchemaRegistry } from '../../../../packages/contracts/src/schema-registry.ts';
import type { ExecutionBudget } from '../runtime/pi/execution-limits.ts';
import { createReadDocumentTool } from '../runtime/pi/read-document-tool.ts';
import { createReadSourceTool } from '../runtime/pi/read-source-tool.ts';
import type { SourceBundle } from '../domain/source-bundle.ts';

export interface EvidenceToolAccess {
  scope: CommonScope;
  documents: DocumentIr[];
  /** 可信验收/服务提供；模型输入无法设置。缺省时保持 legacy read_document 行为。 */
  bundles?: SourceBundle[];
}

export function createEvidenceTools(access: EvidenceToolAccess, registry: SchemaRegistry, budget: ExecutionBudget) {
  // bundles 为空数组或未提供 → legacy read_document，绝不因空数组而切换到 read_source。
  if (!access.bundles || access.bundles.length === 0) {
    return createReadDocumentTool({ scope: access.scope, documents: access.documents }, registry, budget);
  }
  return createReadSourceTool({ scope: access.scope, documents: access.documents, bundles: access.bundles }, registry, budget);
}