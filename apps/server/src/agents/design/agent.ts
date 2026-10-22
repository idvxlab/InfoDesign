/** Real Pi SDK design task. Model quality still requires a separate real-provider evaluation. */
import type { DesignInput, DesignOutput } from '../../../../../packages/contracts/generated/index.ts';
import type { SchemaRegistry } from '../../../../../packages/contracts/src/schema-registry.ts';
import type { CheckIssue } from '../../../../../packages/contracts/src/service-checks.ts';
import { checkDesignInput, checkDesignOutput, type DesignTaskContext } from '../../../../../packages/contracts/src/design-agent-checks.ts';
import type { ModelConfig } from '../../config/env.ts';
import { DESIGN_LIMITS, ExecutionBudget, type ExecutionLimits } from '../../runtime/pi/execution-limits.ts';
import { RuntimeTrace, safeStopReason } from '../../runtime/pi/event-bridge.ts';
import type { RequestSpendBudget } from '../../runtime/pi/spend-budget.ts';
import { createBusinessSession } from '../../runtime/pi/session-factory.ts';
import type { DocumentAccess } from '../../runtime/pi/read-document-tool.ts';
import { createDesignTools } from '../../tools/design.tools.ts';
import { designDraftProtocol, designPrompt, materializeDesign } from './context.ts';

export interface DesignAttempt { round: number; issues: CheckIssue[]; planVersionId?: string; pageSpecVersionId?: string }
/** Untrusted model text for an explicitly configured local diagnostic sink, never a design artifact. */
export interface DesignDraftDiagnostic { round: number; status: 'unvalidated'; stopReason: string; text: string; truncatedForStorage: boolean }
export async function runDesignAgent(options: {
  input: DesignInput; trusted: DesignTaskContext; registry: SchemaRegistry; config: ModelConfig;
  evidenceAccess?: DocumentAccess; limits?: ExecutionLimits; maxRepairRounds?: 0 | 1;
  spendBudget?: RequestSpendBudget; signal?: AbortSignal;
  onDraft?: (draft: DesignDraftDiagnostic) => void;
}) {
  const maxRepairRounds = options.maxRepairRounds ?? 1;
  if (maxRepairRounds !== 0 && maxRepairRounds !== 1) throw new Error('invalid_repair_budget');
  const budget = new ExecutionBudget(options.limits ?? DESIGN_LIMITS, options.signal, 'design', options.spendBudget);
  const trace = new RuntimeTrace(), started = Date.now();
  const attempts: DesignAttempt[] = [];
  let reason: string | undefined = 'invalid_input', output: DesignOutput | undefined;
  let handle: Awaited<ReturnType<typeof createBusinessSession>> | undefined;
  let reader: ReturnType<typeof createDesignTools> | undefined, unsubscribe: (() => void) | undefined;
  let resourcesDisposed = false, repairAttempts = 0;
  try {
    budget.check();
    const check = checkDesignInput(options.input, options.registry, options.trusted);
    if (!check.ok) { attempts.push({ round: 0, issues: check.issues }); }
    else {
      const input = structuredClone(options.input), trusted = structuredClone(options.trusted);
      reader = createDesignTools(input, trusted, options.registry, budget, options.evidenceAccess);
      const draft = designDraftProtocol(options.registry, input.pageSpecVersion ?? '1.0');
      let prompt = designPrompt(input, options.registry, draft.schema);
      reason = 'initialization_failed';
      handle = await createBusinessSession(options.config, reader.tool, budget, 'design');
      unsubscribe = handle.session.subscribe(event => {
        trace.observe(event);
        if (event.type === 'message_end' && event.message.role === 'assistant') budget.observeModelUsage(event.message.usage);
      });
      for (let round = 0; round <= maxRepairRounds; round++) {
        budget.check();
        if (round) repairAttempts++;
        reason = 'provider_failed';
        const offset = handle.session.state.messages.length;
        let failed = false;
        try { await handle.session.prompt(prompt); } catch { failed = true; }
        budget.check();
        const last = handle.session.state.messages.slice(offset).findLast(m => m.role === 'assistant');
        if (failed || !last || last.role !== 'assistant') break;
        const raw = last.content.filter(c => c.type === 'text').map(c => c.text).join('');
        if (options.onDraft) {
          reason = 'diagnostic_failed';
          options.onDraft({ round, status: 'unvalidated', stopReason: safeStopReason(last.stopReason),
            text: raw.slice(0, 262144), truncatedForStorage: raw.length > 262144 });
        }
        if (last.stopReason !== 'stop') {
          reason = last.stopReason === 'length' ? 'output_truncated' : 'incomplete_response'; break;
        }
        let candidate: DesignOutput | undefined;
        let issues: CheckIssue[] = [];
        try { candidate = materializeDesign(JSON.parse(raw), input, trusted, draft); }
        catch { issues.push({ code: 'design.invalid_draft', message: 'Invalid JSON or design body; no metadata is accepted' }); }
        if (candidate) {
          issues.push(...checkDesignOutput(candidate, input, options.registry, trusted).issues);
          if (candidate.status !== 'failed' && !reader.receipts.some(r => r.kind === 'catalog')) issues.push({ code: 'design.catalog_not_read', message: 'Read catalog before submitting' });
          if (candidate.status === 'completed') {
            const readClaims = new Set(reader.receipts.filter(r => r.kind === 'claim').map(r => r.id));
            for (const section of candidate.informationPlan!.sections) for (const ref of section.sourceRefs)
              if (ref.kind === 'claim' && !readClaims.has(ref.id)) issues.push({ code: 'design.claim_not_read', path: ref.id, message: 'Selected claim was not read' });
            if (input.pageSpecVersion === '1.1') for (const section of candidate.informationPlan!.sections) for (const ref of section.sourceRefs)
              if (['event','relation','asset'].includes(ref.kind) && !reader.receipts.some(r => r.kind === ref.kind && r.id === ref.id)) issues.push({ code: 'design.source_not_read', path: ref.id, message: 'Selected source was not read' });
          }
        }
        budget.check();
        attempts.push({ round, issues, ...(candidate?.informationPlan ? {
          planVersionId: candidate.informationPlan.planVersionId, pageSpecVersionId: candidate.pageSpec!.pageSpecVersionId,
        } : {}) });
        if (!issues.length) { output = candidate; reason = undefined; break; }
        reason = 'invalid_candidate';
        if (round === maxRepairRounds) break;
        prompt = JSON.stringify({ instruction: '修正所列错误后返回完整 design-draft JSON。保持任务目标、受众和合法事实引用；不要填写身份、版本或哈希。',
          issues: issues.slice(0, 32).map(i => ({ code: i.code, path: i.path })),
          remainingModelCalls: budget.limits.maxModelCalls - budget.modelCalls,
          remainingToolCalls: budget.limits.maxToolCalls - budget.toolCalls });
      }
    }
  } catch { reason = budget.stopCode ?? reason ?? 'execution_failed'; output = undefined; }
  finally {
    unsubscribe?.();
    try { await handle?.dispose(); resourcesDisposed = true; }
    catch { reason = 'cleanup_failed'; output = undefined; }
    budget.dispose();
  }
  return {
    status: output?.status ?? 'failed', ...(reason ? { reason } : {}), ...(output ? { output } : {}),
    attempts, repairAttempts, modelCalls: budget.modelCalls, toolCalls: budget.toolCalls,
    successfulReads: reader?.receipts.length ?? 0, elapsedMs: Date.now() - started,
    usage: trace.usage, usageReportedResponses: trace.usageReportedResponses, usageUnreportedResponses: trace.usageUnreportedResponses,
    billedAmount: null, sessionId: handle?.session.sessionId, resourcesDisposed,
    finalStopReason: safeStopReason(trace.events.findLast(e => e.type === 'model_response')?.stopReason),
    events: trace.events, transport: handle?.transport ?? { attempts: 0, httpStatuses: [], failureCodes: [] },
  };
}
