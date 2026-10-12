/** 审查角色受控读工具选择器。
 *
 * - 未提供可信 SourceBundle（未提供或空数组）时：使用既有 read_document（严格 paragraph-only）。
 * - 提供可信 SourceBundle 时：使用 createReadSourceTool，支持物理定位读取。
 * 每个会话只暴露一个受控工具；不提供 shell/文件系统接口。
 *
 * bundles 只能来自可信服务，不来自模型参数。审查工具独立于生产者历史。
 */
import type { CommonScope, DocumentIr } from '../../../../packages/contracts/generated/index.ts';
import type { SchemaRegistry } from '../../../../packages/contracts/src/schema-registry.ts';
import type { ExecutionBudget } from '../runtime/pi/execution-limits.ts';
import { createReadDocumentTool } from '../runtime/pi/read-document-tool.ts';
import { createReadSourceTool } from '../runtime/pi/read-source-tool.ts';
import type { SourceBundle } from '../domain/source-bundle.ts';

export interface ReviewToolAccess {
  scope: CommonScope;
  documents: DocumentIr[];
  /** 可信验收/服务提供；模型输入无法设置。缺省时保持 read_document 行为。 */
  bundles?: SourceBundle[];
}

export function createReviewTools(access: ReviewToolAccess, registry: SchemaRegistry, budget: ExecutionBudget) {
  // 空数组或未提供 → read_document，绝不因空数组切换到 read_source。
  if (!access.bundles || access.bundles.length === 0) {
    return createReadDocumentTool({ scope: access.scope, documents: access.documents }, registry, budget);
  }
  return createReadSourceTool({ scope: access.scope, documents: access.documents, bundles: access.bundles }, registry, budget);
}