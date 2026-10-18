/** 每次任务独立预算；在请求/工具开始前扣次数，主动传播超时和取消。 */
import { SpendError, type RequestSpendBudget } from './spend-budget.ts';
export interface ExecutionLimits {
  timeoutMs: number;
  maxModelCalls: number;
  maxToolCalls: number;
  maxOutputTokens: number;
  maxContextBytes: number;
}
export const B2_LIMITS: Readonly<ExecutionLimits> = Object.freeze({
  timeoutMs: 90_000, maxModelCalls: 3, maxToolCalls: 2,
  maxOutputTokens: 1024, maxContextBytes: 12_000,
});
export const EVIDENCE_LIMITS: Readonly<ExecutionLimits> = Object.freeze({
  timeoutMs: 120_000, maxModelCalls: 6, maxToolCalls: 12,
  // 16384 依据同网关同模型实际 completion usage（含推理 token），不声称模型最高上限。
  maxOutputTokens: 16_384, maxContextBytes: 128_000,
});
export const REVIEW_LIMITS: Readonly<ExecutionLimits> = Object.freeze({
  timeoutMs: 180_000, maxModelCalls: 6, maxToolCalls: 16,
  maxOutputTokens: 8192, maxContextBytes: 128_000,
});
export const DESIGN_LIMITS: Readonly<ExecutionLimits> = Object.freeze({
  timeoutMs: 180_000, maxModelCalls: 6, maxToolCalls: 16,
  maxOutputTokens: 8192, maxContextBytes: 128_000,
});
export type ExecutionProfile = 'probe' | 'evidence' | 'review' | 'design';
export type StopCode = 'cancelled' | 'timeout' | 'model_budget' | 'tool_budget' | 'context_budget' | 'spend_budget' | 'spend_ledger_failed';
export class ExecutionStopped extends Error {
  readonly code: StopCode;
  constructor(code: StopCode) { super(code); this.name = 'ExecutionStopped'; this.code = code; }
}
export function validateLimits(limits: ExecutionLimits, profile: ExecutionProfile = 'probe'): void {
  if (!['probe', 'evidence', 'review', 'design'].includes(profile)) throw new Error('invalid_execution_profile');
  const ceiling = profile === 'probe' ? B2_LIMITS
    : profile === 'evidence' ? EVIDENCE_LIMITS
    : profile === 'design' ? DESIGN_LIMITS : REVIEW_LIMITS;
  for (const key of Object.keys(ceiling) as Array<keyof ExecutionLimits>) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > ceiling[key]) {
      throw new Error(`无效或超过 ${profile} 上限的预算：${key}`);
    }
  }
}
export class ExecutionBudget {
  readonly limits: Readonly<ExecutionLimits>;
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly external?: AbortSignal;
  private readonly spend?: RequestSpendBudget;
  private readonly cancel = () => this.stop('cancelled');
  modelCalls = 0;
  toolCalls = 0;
  stopCode?: StopCode;
  disposed = false;

  constructor(limits: ExecutionLimits, signal?: AbortSignal, profile: ExecutionProfile = 'probe', spend?: RequestSpendBudget) {
    validateLimits(limits, profile);
    this.limits = Object.freeze({ ...limits });
    this.signal = this.controller.signal;
    this.external = signal;
    this.spend = spend;
    signal?.addEventListener('abort', this.cancel, { once: true });
    this.timer = setTimeout(() => this.stop('timeout'), limits.timeoutMs);
    if (signal?.aborted) this.stop('cancelled');
  }
  stop(code: StopCode): void {
    if (this.stopCode) return;
    this.stopCode = code;
    this.controller.abort(new ExecutionStopped(code));
  }
  check(): void {
    if (this.stopCode) throw new ExecutionStopped(this.stopCode);
  }
  model(context: unknown): void {
    this.check();
    const contextBytes = Buffer.byteLength(JSON.stringify(context), 'utf8');
    if (contextBytes > this.limits.maxContextBytes) this.stop('context_budget');
    if (this.modelCalls >= this.limits.maxModelCalls) this.stop('model_budget');
    this.check();
    try { this.spend?.reserve(contextBytes, this.limits.maxOutputTokens); }
    catch (error) { this.stop(error instanceof SpendError ? error.code : 'spend_budget'); }
    this.check();
    this.modelCalls++;
  }
  observeModelUsage(usage: { input: number; output: number; cacheRead: number; cacheWrite: number }): void {
    try { this.spend?.checkReportedUsage(usage); }
    catch { this.stop('spend_budget'); }
  }
  tool(): void {
    this.check();
    if (this.toolCalls >= this.limits.maxToolCalls) this.stop('tool_budget');
    this.check();
    this.toolCalls++;
  }
  dispose(): void {
    clearTimeout(this.timer);
    this.external?.removeEventListener('abort', this.cancel);
    this.disposed = true;
  }
}
