import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { estimateRmb, statusText } from '../../.pi/extensions/rmb-cost/usage.js';

const prices = JSON.parse(readFileSync(new URL('../../.pi/extensions/rmb-cost/rates.json', import.meta.url)));
const usage = (extra = {}) => ({ input: 448000, output: 111000, cacheRead: 5700000, cacheWrite: 0, ...extra });
const assistant = (extra = {}) => ({ type: 'message', message: {
  role: 'assistant', provider: 'company-gateway', model: 'deepseek-v4.1-flash', usage: usage(), ...extra,
} });

test('用户提供的近似用量按当前暂估价格为 1.94064 元，历史 cost 为零仍可回算', () => {
  const entry = assistant({ usage: usage({ cost: { total: 0 } }) });
  const result = estimateRmb([entry], prices);
  assert.ok(Math.abs(result.total - 1.94064) < 1e-10);
  assert.equal(result.unpricedEntries, 0);
  assert.equal(statusText(result), '💰 会话≈¥1.94（暂估）');
});

test('压缩前后和明确标注模型的 usage 记录均统计，用户消息不计费', () => {
  const result = estimateRmb([assistant(), { type: 'compaction' }, assistant(),
    { type: 'usage', provider: 'company-gateway', model: 'deepseek-v4.1-flash', usage: usage() },
    { type: 'message', message: { role: 'user', content: 'not used', usage: usage() } },
  ], prices);
  assert.ok(Math.abs(result.total - 3 * 1.94064) < 1e-10);
});

test('其他模型、无法归属模型的摘要及工具用量标成待定', () => {
  const result = estimateRmb([assistant(), assistant({ model: 'unknown-model' }),
    { type: 'compaction', usage: usage() },
    { type: 'message', message: { role: 'toolResult', usage: usage() } },
  ], prices);
  assert.equal(result.unpricedEntries, 3);
  assert.match(statusText(result), /已计部分≈¥1.94.*3条待定/);
});

test('未知缓存写入费率只遗漏该部分，必须标明不完整', () => {
  const result = estimateRmb([assistant({ usage: usage({ cacheWrite: 10000 }) })], prices);
  assert.equal(result.unpricedEntries, 1);
  assert.equal(result.amounts.cacheWrite, 0);
  assert.match(statusText(result), /已计部分/);
});

test('缺少、负数及非有限用量不能冒充零费用', () => {
  for (const u of [undefined, {}, usage({ input: -1 }), usage({ input: Infinity })]) {
    assert.equal(estimateRmb([assistant({ usage: u })], prices).unpricedEntries, 1);
  }
});

test('计价单位和费率无效时拒绝配置', () => {
  assert.throws(() => estimateRmb([], { ...prices, currency: 'USD' }));
  const invalid = structuredClone(prices);
  invalid.models['company-gateway/deepseek-v4.1-flash'].input = -1;
  assert.throws(() => estimateRmb([], invalid));
});

test('由实际 Pi 0.99.1 扩展加载器载入，事件和命令能更新费用显示', async () => {
  const { loadExtensions } = await import('../../apps/server/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js');
  const path = new URL('../../.pi/extensions/rmb-cost/index.js', import.meta.url).pathname;
  const loaded = await loadExtensions([path], '/workspace');
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  let status;
  let detail;
  let entries = [assistant()];
  const ctx = { mode: 'tui', hasUI: true, sessionManager: { getEntries: () => entries },
    ui: { setStatus: (_key, value) => { status = value; }, notify: value => { detail = value; } } };
  for (const handler of extension.handlers.get('session_start')) await handler({ reason: 'resume' }, ctx);
  assert.match(status, /¥1.94/);
  entries = [assistant(), assistant()];
  for (const handler of extension.handlers.get('turn_end')) await handler({}, ctx);
  assert.match(status, /¥3.88/);
  await extension.commands.get('rmb-cost').handler('', ctx);
  assert.match(detail, /尚非平台确认价/);
  entries = [];
  for (const handler of extension.handlers.get('session_start')) await handler({ reason: 'new' }, ctx);
  assert.match(status, /¥0.00/);
  assert.equal(extension.tools.size, 0);
});
