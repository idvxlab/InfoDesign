/** B2 最小业务 Pi 任务。验证实际工具读取与最终结构化引用，不宣称完成事实提取。 */
import type { ModelConfig } from '../../config/env.ts';
import type { SchemaRegistry } from '../../../../../packages/contracts/src/schema-registry.ts';
import { canonicalize } from '../../../../../packages/contracts/src/validator.ts';
import type { ReadDocumentRequest, ReadDocumentResult } from '../../../../../packages/contracts/generated/index.ts';
import { B2_LIMITS, ExecutionBudget, type ExecutionLimits, type StopCode } from './execution-limits.ts';
import { RuntimeTrace, type RuntimeEvent, type TokenUsage } from './event-bridge.ts';
import type { TransportDiagnostics } from './transport-diagnostics.ts';
import { createBusinessSession } from './session-factory.ts';
import { createReadDocumentTool, READ_REQUEST_ID, READ_RESULT_ID, type DocumentAccess } from './read-document-tool.ts';
export interface ProbeOutcome {
  status: 'completed' | 'failed';
  reason?: StopCode | 'initialization_failed' | 'provider_failed' | 'invalid_output' | 'no_tool_call' | 'evidence_mismatch';
  result?: ReadDocumentResult;
  modelCalls: number;
  toolCalls: number;
  successfulReads: number;
  elapsedMs: number;
  usage: TokenUsage | null;
  usageReportedResponses: number;
  usageUnreportedResponses: number;
  billedAmount: null;
  events: RuntimeEvent[];
  sessionId?: string;
  resourcesDisposed: boolean;
  transport: TransportDiagnostics;
}
export async function runReadProbe(options: {
  config: ModelConfig;
  access: DocumentAccess;
  request: ReadDocumentRequest;
  registry: SchemaRegistry;
  limits?: ExecutionLimits;
  signal?: AbortSignal;
}): Promise<ProbeOutcome> {
  const start = Date.now();
  const budget = new ExecutionBudget(options.limits ?? B2_LIMITS, options.signal);
  const trace = new RuntimeTrace();
  let handle: Awaited<ReturnType<typeof createBusinessSession>> | undefined;
  let unsubscribe: (() => void) | undefined;
  let receipts: ReadDocumentResult[] = [];
  const outcome: ProbeOutcome = {
    status: 'failed', reason: 'initialization_failed', modelCalls: 0, toolCalls: 0,
    successfulReads: 0, elapsedMs: 0, usage: null, usageReportedResponses: 0, usageUnreportedResponses: 0, billedAmount: null,
    events: trace.events, resourcesDisposed: false,
    transport: { attempts: 0, httpStatuses: [], failureCodes: [] },
  };
  try {
    budget.check();
    if (!options.registry.validate(READ_REQUEST_ID, options.request).valid) throw new Error('invalid_request');
    const reader = createReadDocumentTool(options.access, options.registry, budget);
    const tool = reader.tool;
    receipts = reader.receipts;
    handle = await createBusinessSession(options.config, tool, budget);
    outcome.transport = handle.transport;
    outcome.sessionId = handle.session.sessionId;
    unsubscribe = handle.session.subscribe(event => trace.observe(event));
    const prompt = `调用 read_document，参数为 ${JSON.stringify(options.request)}。只返回该工具实际读取结果的完整 JSON，不加 Markdown 或说明。`;
    await handle.session.prompt(prompt);
    budget.check();
    const last = handle.session.state.messages.findLast(m => m.role === 'assistant');
    if (!last || last.role !== 'assistant' || last.stopReason !== 'stop') {
      outcome.reason = 'provider_failed';
    } else if (!receipts.length) {
      outcome.reason = 'no_tool_call';
    } else {
      const text = last.content.filter(c => c.type === 'text').map(c => c.text).join('');
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { /* 输出必须为严格 JSON。 */ }
      if (!options.registry.validate(READ_RESULT_ID, parsed).valid) {
        outcome.reason = 'invalid_output';
      } else if (!receipts.some(r => canonicalize(r) === canonicalize(parsed)
        && r.documentId === options.request.documentId && r.documentVersionId === options.request.documentVersionId && r.blockId === options.request.blockId)) {
        outcome.reason = 'evidence_mismatch';
      } else {
        outcome.status = 'completed';
        delete outcome.reason;
        outcome.result = parsed as ReadDocumentResult;
      }
    }
  } catch {
    outcome.reason = budget.stopCode ?? (handle ? 'provider_failed' : 'initialization_failed');
  } finally {
    unsubscribe?.();
    try { await handle?.dispose(); outcome.resourcesDisposed = true; }
    finally {
      budget.dispose();
      outcome.modelCalls = budget.modelCalls;
      outcome.toolCalls = budget.toolCalls;
      outcome.successfulReads = receipts.length;
      outcome.elapsedMs = Date.now() - start;
      outcome.usage = trace.usage;
      outcome.usageReportedResponses = trace.usageReportedResponses;
      outcome.usageUnreportedResponses = trace.usageUnreportedResponses;
    }
  }
  return outcome;
}
