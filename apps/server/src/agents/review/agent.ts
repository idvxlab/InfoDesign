/** B4 真实 Pi 业务 Agent；独立会话审查，程序校验，追加保存待审报告。 */
import type { ReviewOutput } from '../../../../../packages/contracts/generated/review-output.ts';
import type { CommonAgentProvenance } from '../../../../../packages/contracts/generated/common.ts';
import type { SchemaRegistry } from '../../../../../packages/contracts/src/schema-registry.ts';
import type { CheckIssue } from '../../../../../packages/contracts/src/service-checks.ts';
import type { ModelConfig } from '../../config/env.ts';
import { REVIEW_LIMITS, ExecutionBudget, type ExecutionLimits, type StopCode } from '../../runtime/pi/execution-limits.ts';
import { RuntimeTrace, safeStopReason, type TokenUsage, type RuntimeEvent, type ModelStopReason } from '../../runtime/pi/event-bridge.ts';
import type { RequestSpendBudget } from '../../runtime/pi/spend-budget.ts';
import type { TransportDiagnostics } from '../../runtime/pi/transport-diagnostics.ts';
import { createBusinessSession } from '../../runtime/pi/session-factory.ts';
import { createReviewTools } from '../../tools/review.tools.ts';
import { validateReviewReport } from '../../domain/review-result-validator.ts';
import type { SourceBundle } from '../../domain/source-bundle.ts';
import type { ReviewStore } from '../../domain/review.service.ts';
import { prepareReviewInput, newReviewEnvelope, reviewTaskPrompt, type ReviewEnvelope } from './context.ts';

export interface ReviewOutcome {
  status: ReviewOutput['status'];
  reason?: StopCode | 'invalid_input' | 'initialization_failed' | 'provider_failed' | 'invalid_report' | 'report_store_failed' | 'validation_failed' | 'output_truncated' | 'incomplete_response' | 'cleanup_failed';
  verdict?: string;
  reportVersionId?: string;
  reportVersions: string[];
  issues: CheckIssue[];
  /** 单一报告尝试，无隐藏修正循环；保留计数器以镜像 B3 观测口径。 */
  repairAttempts: number;
  reportsSaved?: number;
  reportsInvalid?: number;
  finalStopReason?: ModelStopReason;
  modelCalls: number;
  toolCalls: number;
  successfulReads: number;
  elapsedMs: number;
  usage: TokenUsage | null;
  usageReportedResponses: number;
  usageUnreportedResponses: number;
  billedAmount: null;
  sessionId?: string;
  events: RuntimeEvent[];
  resourcesDisposed: boolean;
  transport: TransportDiagnostics;
}

export async function runReviewAgent(options: {
  input: Parameters<typeof prepareReviewInput>[0];
  candidateSnapshot: Parameters<typeof prepareReviewInput>[1];
  config: ModelConfig;
  registry: SchemaRegistry;
  store: ReviewStore;
  limits?: ExecutionLimits;
  /** 可信验收／服务调用方提供；模型输入无法设置或扩大费用授权。 */
  spendBudget?: RequestSpendBudget;
  /** 可信服务提供的已验证 SourceBundle；模型无法伪造或借此扩权。缺省时保持 legacy read_document。 */
  sourceBundles?: SourceBundle[];
  signal?: AbortSignal;
}): Promise<ReviewOutcome> {
  const started = Date.now(), trace = new RuntimeTrace();
  const budget = new ExecutionBudget(options.limits ?? REVIEW_LIMITS, options.signal, 'review', options.spendBudget);
  const outcome: ReviewOutcome = {
    status: 'failed', reason: 'invalid_input', reportVersions: [], issues: [], repairAttempts: 0,
    reportsSaved: 0, reportsInvalid: 0,
    modelCalls: 0, toolCalls: 0, successfulReads: 0, elapsedMs: 0, usage: null,
    usageReportedResponses: 0, usageUnreportedResponses: 0, billedAmount: null,
    events: trace.events, resourcesDisposed: false, transport: { attempts: 0, httpStatuses: [], failureCodes: [] },
  };
  let handle: Awaited<ReturnType<typeof createBusinessSession>> | undefined;
  let reader: ReturnType<typeof createReviewTools> | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    budget.check();
    const prepared = prepareReviewInput(options.input, options.candidateSnapshot, options.registry, options.sourceBundles);
    const input = prepared.input;
    reader = createReviewTools({ scope: input.scope, documents: input.documents, bundles: options.sourceBundles }, options.registry, budget);
    outcome.reason = 'initialization_failed';
    // 永远是新的独立会话；绝不复制证据会话/消息，绝不改动候选。
    handle = await createBusinessSession(options.config, reader.tool, budget, 'review');
    {
      const originalStreamFunction = handle.session.agent.streamFunction;
      const sessionAgent = handle.session.agent;
      handle.session.agent.streamFunction = async (requestModel, context, streamOptions) => {
        const originalOnPayload = streamOptions?.onPayload;
        const wrappedOptions: Parameters<typeof originalStreamFunction>[2] = {
          ...streamOptions,
          onPayload: async (payload: Parameters<NonNullable<typeof originalOnPayload>>[0], model: Parameters<NonNullable<typeof originalOnPayload>>[1]) => {
            let current = payload;
            if (originalOnPayload) {
              const replaced = await originalOnPayload(payload, model);
              if (replaced !== undefined) current = replaced;
            }
            if (current === null || typeof current !== 'object' || Array.isArray(current)) {
              throw new Error('review request payload must be a non-null object');
            }
            return { ...(current as Record<string, unknown>), response_format: { type: 'json_object' } };
          },
        };
        return originalStreamFunction.call(sessionAgent, requestModel, context, wrappedOptions);
      };
    }

    outcome.transport = handle.transport;
    outcome.sessionId = handle.session.sessionId;
    unsubscribe = handle.session.subscribe(event => {
      trace.observe(event);
      if (event.type === 'message_end' && event.message.role === 'assistant') budget.observeModelUsage(event.message.usage);
    });
    const reviewedBy: CommonAgentProvenance = {
      role: 'review', protocolVersion: '1.0', model: options.config.modelId,
      sessionId: 'session_' + handle.session.sessionId.replaceAll('-', ''), promptVersion: 'review_b5_v14',

    } as CommonAgentProvenance;
    const envelope: ReviewEnvelope = newReviewEnvelope(reviewedBy);
    const prompt = reviewTaskPrompt(input, prepared.candidateSnapshot, envelope, options.registry, budget.limits, options.sourceBundles);
    const saveReport = (rawOutput: string, issues: CheckIssue[], parsed?: unknown): boolean => {
      try {
        options.store.append({
          reportVersionId: envelope.reportVersionId, recordedAt: envelope.createdAt,
          state: issues.length ? 'invalid' : 'reviewed', rawOutput, issues,
          ...(issues.length ? {} : { output: parsed as ReviewOutput }),
        });
      } catch { outcome.reason = 'report_store_failed'; return false; }
      outcome.reportVersions.push(envelope.reportVersionId);
      if (issues.length) outcome.reportsInvalid = (outcome.reportsInvalid ?? 0) + 1;
      else outcome.reportsSaved = (outcome.reportsSaved ?? 0) + 1;
      outcome.issues = issues;
      return true;
    };
    // 单一报告尝试：绝不进入隐藏修正循环或重试。
    budget.check();
    outcome.reason = 'provider_failed';
    const messageOffset = handle.session.state.messages.length;
    let generationFailed = false;
    try { await handle.session.prompt(prompt); } catch { generationFailed = true; }
    // 只检查本轮响应，避免把上一轮消息误当作新报告。
    const last = handle.session.state.messages.slice(messageOffset).findLast(m => m.role === 'assistant');
    if (!last || last.role !== 'assistant') { budget.check(); outcome.reason = 'provider_failed'; }
    else {
      outcome.finalStopReason = safeStopReason(last.stopReason);
      const rawOutput = last.content.filter(c => c.type === 'text').map(c => c.text).join('');
      if (budget.stopCode || generationFailed) {
        // 取消／超时仍可保存 SDK 已交付的私有诊断，绝不解析为可用报告。
        if (rawOutput) saveReport(rawOutput, [{ code: 'report.interrupted_response', path: 'response.stopReason', message: budget.stopCode ?? 'provider_failed' }]);
        budget.check();
      } else {
        budget.check();
        // 只有最终 assistant stop 才能解析 JSON；length 即使正文完整 JSON 也不解析。
        if (last.stopReason !== 'stop') {
          outcome.reason = last.stopReason === 'length' ? 'output_truncated'
            : ['error', 'aborted'].includes(last.stopReason) ? 'provider_failed' : 'incomplete_response';
          // 非正常结束的正文只能作为私有失败版本保存，不能被解析后冒充完成；不自动重试。
          if (rawOutput || last.stopReason === 'length') {
            saveReport(rawOutput, [{ code: 'report.incomplete_response', path: 'response.stopReason', message: outcome.finalStopReason }]);
          }
        } else {
          let parsed: unknown;
          let issues: CheckIssue[] = [];
          let parses = false;
          try { parsed = JSON.parse(rawOutput); parses = true; }
          catch { issues = [{ code: 'report.invalid_json', path: '', message: 'report.invalid_json' }]; }
          let reportExecutionStatus: unknown;
          let parsedValid = false;
          let derivedVerdict: string | undefined;
          if (parses) {
            outcome.reason = 'validation_failed';
            const result = validateReviewReport(parsed, input, prepared.candidateSnapshot, envelope, reader.receipts, options.registry);
            issues = result.issues;
            if (result.ok) {
              parsedValid = true;
              const value = parsed as ReviewOutput;
              derivedVerdict = (value.report as { verdict?: string })?.verdict;
              reportExecutionStatus = (value.report as { executionStatus?: unknown })?.executionStatus;
            }
          }
          const stopped = budget.stopCode;
          budget.check();
          // 模型 status failed／报告 executionStatus failed 属技术不完整，不得当作有效完成审查。
          const parsedStatus = parses && parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as { status?: unknown }).status : undefined;
          const technicallyIncomplete = parsedStatus === 'failed' || reportExecutionStatus === 'failed';
          if (technicallyIncomplete) {
            if (!issues.length) issues = [{ code: 'report.incomplete_response', path: 'status', message: 'model_execution_failed' }];
            outcome.reason = 'incomplete_response';
          }
          if (saveReport(rawOutput, issues, parsed)) {
            if (parsedValid && !issues.length && !technicallyIncomplete) {
              outcome.status = (parsed as ReviewOutput).status;
              outcome.reportVersionId = envelope.reportVersionId;
              outcome.verdict = derivedVerdict;
              delete outcome.reason;
            } else if (!technicallyIncomplete) {
              outcome.reason = 'invalid_report';
            }
          }
          if (stopped) outcome.reason = stopped;
        }
      }
    }
  } catch {
    outcome.reason = budget.stopCode ?? outcome.reason;
  } finally {
    let cleanupFailed = false;
    try { unsubscribe?.(); } catch { cleanupFailed = true; }
    try { await handle?.dispose(); } catch { cleanupFailed = true; }
    finally {
      budget.dispose();
      outcome.modelCalls = budget.modelCalls; outcome.toolCalls = budget.toolCalls;
      outcome.successfulReads = reader?.receipts.length ?? 0; outcome.elapsedMs = Date.now() - started;
      outcome.usage = trace.usage;
      outcome.finalStopReason = trace.events.findLast(event => event.type === 'model_response')?.stopReason;
      outcome.usageReportedResponses = trace.usageReportedResponses;
      outcome.usageUnreportedResponses = trace.usageUnreportedResponses;
      // 仅在清理成功且预算确已释放时标记为已释放。
      outcome.resourcesDisposed = !cleanupFailed && budget.disposed;
      if (cleanupFailed) {
        // 清理失败不得抛出，也不得虚假宣称成功；移除公开成功结论。
        outcome.status = 'failed';
        outcome.reason = 'cleanup_failed';
        delete outcome.verdict;
        delete outcome.reportVersionId;
      }
    }
  }
  return outcome;
}