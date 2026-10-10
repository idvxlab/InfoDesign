/** 可信调用方的保守费用预留；不是网关账户硬配额，也不把预留额声称为账单。 */
export interface SpendPolicy {
  limitMicros: number;
  safetyMicros: number;
  inputCnyPerMillion: number;
  outputCnyPerMillion: number;
  inputTokensPerByte: number;
  inputTokenOverhead: number;
}
export interface SpendReservation {
  sequence: number;
  contextBytes: number;
  reservedInputTokens: number;
  requestedOutputTokens: number;
  reservedMicros: number;
}
export class SpendError extends Error {
  readonly code: 'spend_budget' | 'spend_ledger_failed';
  constructor(code: SpendError['code']) { super(code); this.code = code; }
}
export class RequestSpendBudget {
  readonly policy: Readonly<SpendPolicy>;
  private readonly records: SpendReservation[];
  private readonly persist: (next: readonly SpendReservation[]) => void;
  constructor(policy: SpendPolicy, persist: (next: readonly SpendReservation[]) => void, previous: readonly SpendReservation[] = []) {
    const keys: Array<keyof SpendPolicy> = ['limitMicros', 'safetyMicros', 'inputCnyPerMillion', 'outputCnyPerMillion', 'inputTokensPerByte', 'inputTokenOverhead'];
    if (!policy || Object.keys(policy).length !== keys.length) throw new Error('invalid_spend_policy');
    for (const key of keys) {
      const value = policy[key];
      if (!Number.isSafeInteger(value) || value < (key === 'safetyMicros' || key === 'inputTokenOverhead' ? 0 : 1)) throw new Error('invalid_spend_policy');
    }
    if (policy.safetyMicros >= policy.limitMicros || typeof persist !== 'function') throw new Error('invalid_spend_policy');
    this.policy = Object.freeze({ ...policy }); this.persist = persist; this.records = structuredClone(previous) as SpendReservation[];
    for (const [index, item] of this.records.entries()) {
      const expected = this.quote(item.contextBytes, item.requestedOutputTokens, index + 1);
      if (Object.keys(item).length !== Object.keys(expected).length || Object.entries(expected).some(([key, value]) => item[key as keyof SpendReservation] !== value)) throw new Error('invalid_spend_history');
    }
    if (this.reservedMicros > this.availableMicros) throw new Error('invalid_spend_history');
  }
  get availableMicros(): number { return this.policy.limitMicros - this.policy.safetyMicros; }
  get reservedMicros(): number { return this.records.reduce((n, r) => n + r.reservedMicros, 0); }
  list(): SpendReservation[] { return structuredClone(this.records); }
  private quote(contextBytes: number, requestedOutputTokens: number, sequence: number): SpendReservation {
    if (![contextBytes, requestedOutputTokens].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('invalid_spend_request');
    const reservedInputTokens = contextBytes * this.policy.inputTokensPerByte + this.policy.inputTokenOverhead;
    // CNY / million tokens × tokens = micro-CNY；整数算术不向下舍入。
    const reservedMicros = reservedInputTokens * this.policy.inputCnyPerMillion + requestedOutputTokens * this.policy.outputCnyPerMillion;
    if (![reservedInputTokens, reservedMicros].every(Number.isSafeInteger)) throw new Error('invalid_spend_request');
    return { sequence, contextBytes, reservedInputTokens, requestedOutputTokens, reservedMicros };
  }
  reserve(contextBytes: number, requestedOutputTokens: number): void {
    const item = this.quote(contextBytes, requestedOutputTokens, this.records.length + 1);
    if (item.reservedMicros > this.availableMicros - this.reservedMicros) throw new SpendError('spend_budget');
    // 必须先完成持久化，才能让模型请求开始；失败或未知响应的额度不自动返还。
    try { this.persist([...this.list(), structuredClone(item)]); } catch { throw new SpendError('spend_ledger_failed'); }
    this.records.push(item);
  }
  checkReportedUsage(usage: { input: number; output: number; cacheRead: number; cacheWrite: number }): void {
    const values = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
    if (!values.every(n => Number.isFinite(n) && n >= 0)) return; // 未知按全部预留扣减。
    const last = this.records.at(-1); if (!last) return;
    if (usage.input + usage.cacheRead + usage.cacheWrite > last.reservedInputTokens || usage.output > last.requestedOutputTokens) throw new SpendError('spend_budget');
  }
}
