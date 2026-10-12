/** B4 程序回归测试：真实 Pi SDK + 本地模拟网关（SYNTHETIC SSE，非真实模型质量）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReviewInput } from '../../packages/contracts/generated/index.ts';
import type { EvidenceSnapshot } from '../../packages/contracts/generated/evidence-snapshot.ts';
import { REVIEW_LIMITS } from '../../apps/server/src/runtime/pi/execution-limits.ts';
import {
  baseSnapshot, makeInput, checkInput, READ_REQS, promptJson, makeReportOutput,
  complete, scenario, type Body,
} from '../helpers/review-harness.ts';


function setup(): { input: ReviewInput; snapshot: EvidenceSnapshot } {
  const snapshot = baseSnapshot();
  const input = makeInput(snapshot);
  checkInput(input, snapshot);
  return { input, snapshot };
}

function toolNames(body: Body): string[] {
  return body.tools.map(t => t.function.name);
}

function msgText(body: Body): string {
  return body.messages.map(m => (typeof m.content === 'string' ? m.content : m.content.map(c => c.text ?? '').join(''))).join('\n');
}

test('两次顺序成功场景', async () => {
  const handler = (body: Body, res: Parameters<typeof complete>[0], index: number) => {
    if (index === 1) complete(res, READ_REQS);
    else complete(res, JSON.stringify(makeReportOutput(body, 'pass', 'rd60')));
  };

  const first = setup();
  const inputBefore = JSON.stringify(first.input);
  const snapBefore = JSON.stringify(first.snapshot);
  const one = await scenario(handler, first.input, first.snapshot);

  assert.equal(one.outcome.status, 'completed');
  assert.equal(one.outcome.verdict, 'pass');
  assert.equal(one.outcome.resourcesDisposed, true);
  assert.equal(one.requests.length, 2);
  assert.deepEqual([...new Set(one.requests.flatMap(toolNames))], ['read_document']);
  assert.equal(JSON.stringify(first.input), inputBefore);
  assert.equal(JSON.stringify(first.snapshot), snapBefore);
  assert.equal(first.snapshot.reviewStatus, 'pending');
  assert.ok(one.outcome.sessionId);
  assert.ok(one.outcome.reportVersionId);

  const second = setup();
  const inputPre = JSON.stringify(second.input);
  const snapPre = JSON.stringify(second.snapshot);
  const two = await scenario(handler, second.input, second.snapshot);

  assert.equal(two.outcome.status, 'completed');
  assert.equal(two.outcome.verdict, 'pass');
  assert.equal(two.outcome.resourcesDisposed, true);
  assert.equal(two.requests.length, 2);
  assert.deepEqual([...new Set(two.requests.flatMap(toolNames))], ['read_document']);
  assert.equal(JSON.stringify(second.input), inputPre);
  assert.equal(JSON.stringify(second.snapshot), snapPre);
  assert.equal(second.snapshot.reviewStatus, 'pending');
  assert.ok(two.outcome.sessionId);
  assert.ok(two.outcome.reportVersionId);
  assert.notEqual(two.outcome.sessionId, one.outcome.sessionId);
  assert.notEqual(two.outcome.reportVersionId, one.outcome.reportVersionId);
  const firstText = msgText(one.requests[0]);
  assert.equal(msgText(two.requests[0]).includes(firstText), false);
  assert.equal(firstText.includes(one.outcome.reportVersionId), true);
  assert.equal(msgText(two.requests[0]).includes(one.outcome.sessionId), false);
  assert.equal(msgText(two.requests[0]).includes(one.outcome.reportVersionId), false);

  const record = one.records[0];
  assert.ok(record);
  assert.ok(record.output);
  assert.ok(record.output.report);
  const prompt = promptJson(one.requests[0]);
  const report = record.output.report;
  assert.deepEqual(report.subject, prompt.subject);
  assert.equal(report.reportId, prompt.envelope.reportId);
  assert.equal(report.reportVersionId, prompt.envelope.reportVersionId);
  assert.equal(report.createdAt, prompt.envelope.createdAt);
  assert.deepEqual(report.reviewedBy, prompt.envelope.reviewedBy);
  assert.equal('sessionId' in report, false);

  const listed = one.store.list();
  const copy = listed[listed.length - 1];
  assert.ok(copy);
  assert.ok(copy.output);
  assert.ok(copy.output.report);
  assert.ok(copy.output.report.summary !== undefined);
  const storedFirst = one.store.list()[0];
  assert.ok(storedFirst.output);
  copy.output.report.summary = 'mutated';
  const reread = one.store.list()[listed.length - 1];
  assert.ok(reread.output);
  assert.notEqual(reread.output.report.summary, 'mutated');
  assert.equal(one.store.list().length, one.records.length);
  assert.throws(() => one.store.append(record), /review_version_exists/);
});
test('预先 abort', async () => {
  const a = setup();
  const controller = new AbortController();
  controller.abort();
  const { outcome, requests, records } = await scenario(() => {}, a.input, a.snapshot, { signal: controller.signal });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.reason, 'cancelled');
  assert.equal(requests.length, 0);
  assert.equal(records.length, 0);
  assert.equal(outcome.resourcesDisposed, true);
  assert.equal(outcome.verdict, undefined);
  assert.equal(outcome.reportVersionId, undefined);
});

test('handler 中触发 abort 且不回复', async () => {
  const a = setup();
  const controller = new AbortController();
  const handler = (_body: Body, _res: Parameters<typeof complete>[0], index: number) => {
    if (index === 1) controller.abort();
  };
  const { outcome, requests, records } = await scenario(handler, a.input, a.snapshot, { signal: controller.signal });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.reason, 'cancelled');
  assert.equal(requests.length, 1);
  assert.equal(records.length, 0);
  assert.equal(outcome.resourcesDisposed, true);
  assert.equal(outcome.verdict, undefined);
  assert.equal(outcome.reportVersionId, undefined);
});

test('silent handler 触发 timeout', async () => {
  const a = setup();
  const { outcome, requests } = await scenario(() => {}, a.input, a.snapshot, { limits: { ...REVIEW_LIMITS, timeoutMs: 250 } });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.reason, 'timeout');
  assert.ok(requests.length <= 1);
  assert.equal(outcome.resourcesDisposed, true);
  assert.equal(outcome.verdict, undefined);
  assert.equal(outcome.reportVersionId, undefined);
});

test('limits maxModelCalls:1 触发 model_budget', async () => {
  const a = setup();
  const handler = (_body: Body, res: Parameters<typeof complete>[0]) => complete(res, READ_REQS);
  const { outcome, requests, records } = await scenario(handler, a.input, a.snapshot, { limits: { ...REVIEW_LIMITS, maxModelCalls: 1 } });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.reason, 'model_budget');
  assert.equal(requests.length, 1);
  assert.equal(records.length, 0);
  assert.equal(outcome.resourcesDisposed, true);
  assert.equal(outcome.verdict, undefined);
  assert.equal(outcome.reportVersionId, undefined);
});

test('第2次 finishReason length 触发 output_truncated', async () => {
  const a = setup();
  const handler = (body: Body, res: Parameters<typeof complete>[0], index: number) => {
    if (index === 1) complete(res, READ_REQS);
    else complete(res, JSON.stringify(makeReportOutput(body, 'pass', 'rd60')), 'length');
  };
  const { outcome, requests, records } = await scenario(handler, a.input, a.snapshot);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.reason, 'output_truncated');
  assert.equal(requests.length, 2);
  assert.equal(records.length, 1);
  assert.equal(records[0].state, 'invalid');
  assert.equal(records[0].output, undefined);
  assert.equal(outcome.resourcesDisposed, true);
  assert.equal(outcome.verdict, undefined);
  assert.equal(outcome.reportVersionId, undefined);
});

test("第1次返回 '{broken' 触发 invalid_report", async () => {
  const a = setup();
  const handler = (_body: Body, res: Parameters<typeof complete>[0], index: number) => {
    if (index === 1) complete(res, '{broken');
  };
  const { outcome, requests, records } = await scenario(handler, a.input, a.snapshot);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.reason, 'invalid_report');
  assert.equal(requests.length, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].state, 'invalid');
  assert.equal(records[0].output, undefined);
  assert.equal(outcome.resourcesDisposed, true);
  assert.equal(outcome.verdict, undefined);
  assert.equal(outcome.reportVersionId, undefined);
});

test('store.append 抛错触发 report_store_failed', async () => {
  const a = setup();
  const handler = (body: Body, res: Parameters<typeof complete>[0], index: number) => {
    if (index === 1) complete(res, READ_REQS);
    else complete(res, JSON.stringify(makeReportOutput(body, 'pass', 'rd60')));
  };
  const store = { append() { throw new Error('synthetic_store_failure'); } };
  const { outcome, requests } = await scenario(handler, a.input, a.snapshot, { store });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.reason, 'report_store_failed');
  assert.equal(requests.length, 2);
  assert.equal(outcome.resourcesDisposed, true);
  assert.equal(outcome.verdict, undefined);
  assert.equal(outcome.reportVersionId, undefined);
});

test('HTTP 500 触发 provider_failed', async () => {
  const a = setup();
  const handler = (_body: Body, res: Parameters<typeof complete>[0]) => {
    res.writeHead(500);
    res.end('synthetic_failure');
  };
  const { outcome, requests } = await scenario(handler, a.input, a.snapshot);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.reason, 'provider_failed');
  assert.equal(requests.length, 1);
  assert.equal(outcome.resourcesDisposed, true);
  assert.equal(outcome.verdict, undefined);
  assert.equal(outcome.reportVersionId, undefined);
});
