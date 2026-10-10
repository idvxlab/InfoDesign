import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequestSpendBudget, SpendError, type SpendPolicy, type SpendReservation } from '../../apps/server/src/runtime/pi/spend-budget.ts';
const policy: SpendPolicy = { limitMicros: 5_000_000, safetyMicros: 1_000_000, inputCnyPerMillion: 2, outputCnyPerMillion: 8, inputTokensPerByte: 2, inputTokenOverhead: 8192 };
test('费用预留采用峰值、无缓存折扣，并在可用四元耗尽前拒绝请求', () => {
  let persisted: readonly SpendReservation[] = [];
  const budget = new RequestSpendBudget(policy, next => { persisted = next; });
  for (let i = 0; i < 7; i++) budget.reserve(128000, 4096);
  assert.equal(budget.reservedMicros, 3_928_064);
  assert.throws(() => budget.reserve(128000, 4096), (e: unknown) => e instanceof SpendError && e.code === 'spend_budget');
  assert.equal(persisted.length, 7); assert.equal(budget.list().length, 7);
  assert.equal(budget.availableMicros, 4_000_000);
});
test('费用台账写入失败阻止请求，内部记录不会伪装成已预留', () => {
  const budget = new RequestSpendBudget(policy, () => { throw new Error('private disk error'); });
  assert.throws(() => budget.reserve(1000, 4096), (e: unknown) => e instanceof SpendError && e.code === 'spend_ledger_failed');
  assert.equal(budget.reservedMicros, 0);
});
test('跨任务从已保存历史继续累计，不把未知、失败请求视为免费', () => {
  const one = new RequestSpendBudget(policy, () => {}); one.reserve(128000, 4096);
  const history = one.list(); const two = new RequestSpendBudget(policy, () => {}, history);
  history[0].reservedMicros = 0;
  two.reserve(128000, 4096); assert.equal(two.reservedMicros, 1_122_304);
  const returned = two.list(); returned.length = 0; assert.equal(two.list().length, 2);
});
test('台账篡改、非整数费率及不安全整数在请求前拒绝', () => {
  assert.throws(() => new RequestSpendBudget({ ...policy, inputCnyPerMillion: NaN }, () => {}), /invalid_spend_policy/);
  assert.throws(() => new RequestSpendBudget({ ...policy, safetyMicros: 5_000_000 }, () => {}), /invalid_spend_policy/);
  const budget = new RequestSpendBudget(policy, () => {}); budget.reserve(100, 20);
  const history = budget.list(); history[0].reservedMicros--;
  assert.throws(() => new RequestSpendBudget(policy, () => {}, history), /invalid_spend_history/);
  assert.throws(() => budget.reserve(Number.MAX_SAFE_INTEGER, 4096), /invalid_spend_request/);
});
test('用量报告超出输入预留或输出上限时触发停止；未知用量保留全部额度', () => {
  const budget = new RequestSpendBudget(policy, () => {}); budget.reserve(1000, 4096);
  budget.checkReportedUsage({ input: 200, output: 50, cacheRead: 100, cacheWrite: 0 });
  budget.checkReportedUsage({ input: NaN, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(budget.reservedMicros, 53_152);
  for (const usage of [{ input: 10_193, output: 1, cacheRead: 0, cacheWrite: 0 }, { input: 0, output: 4097, cacheRead: 0, cacheWrite: 0 }]) assert.throws(() => budget.checkReportedUsage(usage), SpendError);
});
