/** B3 真实 Pi 业务 Agent；模型提取，程序校验，追加保存待审候选。 */
import type { EvidenceInput, EvidenceOutput } from '../../../../../packages/contracts/generated/index.ts';
import type { SchemaRegistry } from '../../../../../packages/contracts/src/schema-registry.ts';
import type { CheckIssue } from '../../../../../packages/contracts/src/service-checks.ts';
import type { ModelConfig } from '../../config/env.ts';
import { EVIDENCE_LIMITS, ExecutionBudget, type ExecutionLimits, type StopCode } from '../../runtime/pi/execution-limits.ts';
import { RuntimeTrace, safeStopReason, type TokenUsage, type RuntimeEvent, type ModelStopReason } from '../../runtime/pi/event-bridge.ts';
import type { RequestSpendBudget } from '../../runtime/pi/spend-budget.ts';
import type { TransportDiagnostics } from '../../runtime/pi/transport-diagnostics.ts';
import { createBusinessSession } from '../../runtime/pi/session-factory.ts';
import { createEvidenceTools } from '../../tools/evidence.tools.ts';
import { validateEvidenceCandidate } from '../../domain/result-validator.ts';
import { validateRepairPreservation } from '../../domain/repair-validator.ts';
import type { SourceBundle } from '../../domain/source-bundle.ts';
import { verifyPdfSources } from '../../domain/evidence-source-policy.ts';
import type { CandidateStore } from '../../domain/evidence.service.ts';
import {
  prepareEvidenceInput, newCandidateEnvelope, nextCandidateEnvelope, evidenceTaskPrompt,
  repairCandidateEnvelope, evidenceRepairPrompt,
  type CandidateEnvelope, type EvidenceRepairRequest,
} from './context.ts';

export interface EvidenceOutcome {
  status: EvidenceOutput['status'];
  reason?: StopCode | 'invalid_input' | 'initialization_failed' | 'provider_failed' | 'invalid_candidate' | 'candidate_store_failed' | 'validation_failed' | 'output_truncated' | 'incomplete_response';
  /** 已进入的结构修正尝试，不从保存成功的候选个数倒推。 */
  repairAttempts: number;
  finalStopReason?: ModelStopReason;
  candidateVersionId?: string;
  candidateVersions: string[];
  issues: CheckIssue[];
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
export async function runEvidenceAgent(options: {
  input: EvidenceInput;
  config: ModelConfig;
  registry: SchemaRegistry;
  store: CandidateStore;
  limits?: ExecutionLimits;
  maxRepairRounds?: 0 | 1;
  /** 可信验收／服务调用方提供；模型输入无法设置或扩大费用授权。 */
  spendBudget?: RequestSpendBudget;
  /** 可信服务提供的已验证 SourceBundle；模型无法伪造或借此扩权。缺省时保持 legacy read_document。 */
  sourceBundles?: SourceBundle[];
  /** 语义返修请求；提供时本轮不执行结构自修正，且不计入结构修复额度。 */
  repair?: EvidenceRepairRequest;
  signal?: AbortSignal;
}): Promise<EvidenceOutcome> {
  const maxRepairRounds = options.repair ? 0 : (options.maxRepairRounds ?? 1);
  if (maxRepairRounds !== 0 && maxRepairRounds !== 1) throw new Error('invalid_repair_budget');
  const started = Date.now(), trace = new RuntimeTrace();
  const budget = new ExecutionBudget(options.limits ?? EVIDENCE_LIMITS, options.signal, 'evidence', options.spendBudget);
  const outcome: EvidenceOutcome = {
    status: 'failed', reason: 'invalid_input', candidateVersions: [], issues: [], repairAttempts: 0,
    modelCalls: 0, toolCalls: 0, successfulReads: 0, elapsedMs: 0, usage: null,
    usageReportedResponses: 0, usageUnreportedResponses: 0, billedAmount: null,
    events: trace.events, resourcesDisposed: false, transport: { attempts: 0, httpStatuses: [], failureCodes: [] },
  };
  let handle: Awaited<ReturnType<typeof createBusinessSession>> | undefined;
  let reader: ReturnType<typeof createEvidenceTools> | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    budget.check();
    const input = prepareEvidenceInput(options.input, options.registry, options.sourceBundles);
    // 已验证源仅用于目录模态/prompt 与候选校验；不泄漏原文。
    const verified = options.sourceBundles && options.sourceBundles.length
      ? verifyPdfSources(options.sourceBundles, input.documents)
      : undefined;
    reader = createEvidenceTools({ scope: input.scope, documents: input.documents, bundles: options.sourceBundles }, options.registry, budget);
    outcome.reason = 'initialization_failed';
    handle = await createBusinessSession(options.config, reader.tool, budget, 'evidence');
    outcome.transport = handle.transport;
    outcome.sessionId = handle.session.sessionId;
    unsubscribe = handle.session.subscribe(event => {
      trace.observe(event);
      if (event.type === 'message_end' && event.message.role === 'assistant') budget.observeModelUsage(event.message.usage);
    });
    let envelope: CandidateEnvelope;
    const repair = options.repair;
    if (repair) {
      // 语义返修运行在本次真实 Pi 会话中，provenance 必须记录当前会话与当前模型，
      // 不得沿用旧候选快照的 producedBy（旧 artifact 的 provenance 保持不变）。
      envelope = repairCandidateEnvelope({
        snapshotId: repair.previous.candidateSnapshot.snapshotId,
        snapshotVersionId: repair.previous.candidateSnapshot.snapshotVersionId,
        createdAt: repair.previous.candidateSnapshot.createdAt,
        producedBy: {
          role: 'evidence', protocolVersion: '1.0', model: options.config.modelId,
          sessionId: 'session_' + handle.session.sessionId.replaceAll('-', ''), promptVersion: 'evidence_repair_v1',
        },
      }, repair.parentVersionId);
    } else {
      envelope = newCandidateEnvelope({
        role: 'evidence', protocolVersion: '1.0', model: options.config.modelId,
        sessionId: 'session_' + handle.session.sessionId.replaceAll('-', ''), promptVersion: 'evidence_b3_v4',
      });
    }
    let prompt = repair
      ? evidenceRepairPrompt(input, repair, envelope, options.registry, budget.limits, verified)
      : evidenceTaskPrompt(input, envelope, options.registry, budget.limits, verified);
    let previous: unknown;
    const saveCandidate = (rawOutput: string, issues: CheckIssue[], parsed?: unknown): boolean => {
      try {
        options.store.append({
          snapshotVersionId: envelope.snapshotVersionId, recordedAt: new Date().toISOString(),
          state: issues.length ? 'invalid' : 'pending_review', rawOutput, issues,
          ...(issues.length ? {} : { output: parsed as EvidenceOutput }),
        });
      } catch { outcome.reason = 'candidate_store_failed'; return false; }
      outcome.candidateVersions.push(envelope.snapshotVersionId);
      outcome.issues = issues;
      return true;
    };
    outcome.reason = 'provider_failed';
    for (let round = 0; round <= maxRepairRounds; round++) {
      budget.check();
      if (round > 0) outcome.repairAttempts++;
      outcome.reason = 'provider_failed';
      const messageOffset = handle.session.state.messages.length;
      let generationFailed = false;
      try { await handle.session.prompt(prompt); } catch { generationFailed = true; }
      // 只检查本轮响应，避免修正请求未产生消息时把上一轮候选保存成新版本。
      const last = handle.session.state.messages.slice(messageOffset).findLast(m => m.role === 'assistant');
      if (!last || last.role !== 'assistant') { budget.check(); outcome.reason = 'provider_failed'; break; }
      outcome.finalStopReason = safeStopReason(last.stopReason);
      const rawOutput = last.content.filter(c => c.type === 'text').map(c => c.text).join('');
      if (budget.stopCode || generationFailed) {
        // 取消／超时仍可保存 SDK 已交付的私有诊断，绝不解析为可用候选。
        if (rawOutput) saveCandidate(rawOutput, [{ code: 'candidate.interrupted_response', path: 'response.stopReason', message: budget.stopCode ?? 'provider_failed' }]);
        budget.check();
        break;
      }
      budget.check();
      if (last.stopReason !== 'stop') {
        outcome.reason = last.stopReason === 'length' ? 'output_truncated'
          : ['error', 'aborted'].includes(last.stopReason) ? 'provider_failed' : 'incomplete_response';
        // 非正常结束的正文只能作为私有失败版本保存，不能被解析后冒充完成；不自动重试。
        if (rawOutput || last.stopReason === 'length') {
          saveCandidate(rawOutput, [{ code: 'candidate.incomplete_response', path: 'response.stopReason', message: outcome.finalStopReason }]);
        }
        break;
      }
      let parsed: unknown;
      let issues: CheckIssue[] = [];
      try {
        parsed = JSON.parse(rawOutput);
      } catch {
        issues = [{ code: 'candidate.invalid_json', path: '', message: 'candidate.invalid_json' }];
      }
      if (parsed !== undefined) {
        outcome.reason = 'validation_failed';
        issues = validateEvidenceCandidate(parsed, input, envelope, reader.receipts, options.registry, repair ? undefined : previous, options.sourceBundles, repair ? { allowUpdate: true } : undefined).issues;
        if (repair) {
          issues = issues.concat(validateRepairPreservation(parsed, repair.previous, repair.parentVersionId, repair.allowedChangeClaimIds, repair.withdrawalPermits ?? []).issues);
        }
      }
      budget.check();
      if (!saveCandidate(rawOutput, issues, parsed)) break;
      if (!issues.length) {
        outcome.status = (parsed as EvidenceOutput).status;
        outcome.candidateVersionId = envelope.snapshotVersionId;
        delete outcome.reason;
        break;
      }
      outcome.reason = 'invalid_candidate';
      if (round === maxRepairRounds) break;
      previous = parsed;
      envelope = nextCandidateEnvelope(envelope);
      // 只反馈程序错误码与路径；不会把服务错误消息当作新增业务指令。
      prompt = JSON.stringify({
        instruction: '仅修正已报告的结构、来源和覆盖问题，返回完整 EvidenceOutput。保留事实编号、合法事实值及已有缺失和冲突，使用新的 envelope；不得删除困难事实。',
        envelope, remainingModelCalls: budget.limits.maxModelCalls - budget.modelCalls,
        remainingToolCalls: budget.limits.maxToolCalls - budget.toolCalls,
        issues: issues.slice(0, 32).map(i => ({ code: i.code, path: i.path })),
      });
    }
  } catch {
    outcome.reason = budget.stopCode ?? outcome.reason;
  } finally {
    unsubscribe?.();
    try { await handle?.dispose(); outcome.resourcesDisposed = true; }
    finally {
      budget.dispose();
      outcome.modelCalls = budget.modelCalls; outcome.toolCalls = budget.toolCalls;
      outcome.successfulReads = reader?.receipts.length ?? 0; outcome.elapsedMs = Date.now() - started;
      outcome.usage = trace.usage;
      outcome.finalStopReason = trace.events.findLast(event => event.type === 'model_response')?.stopReason;
      outcome.usageReportedResponses = trace.usageReportedResponses;
      outcome.usageUnreportedResponses = trace.usageUnreportedResponses;
    }
  }
  return outcome;
}
