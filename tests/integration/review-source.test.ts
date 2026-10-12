/**
 * 集成测试：Pi SDK + 本地模拟 SSE 评审来源流程。
 * 注明：使用合成夹具与本地模拟 SSE，非真实模型/真实文档，不代表真实模型质量。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeReviewSourceFixture } from '../helpers/review-source-fixture.ts';
import { scenario, complete, makeReportOutput } from '../helpers/review-harness.ts';

function toolNames(res: { requests: Array<{ tools: Array<{ function: { name: string } }> }> }): string[] {
  return [...new Set(res.requests.flatMap((r) => r.tools.map((t) => t.function.name)))];
}

test('原生文本来源可读并通过评审', async () => {
  const fixture = await makeReviewSourceFixture(false);
  const inputBefore = structuredClone(fixture.input);
  const snapshotBefore = structuredClone(fixture.snapshot);
  try {
    const res = await scenario(
      (request, res, i) => {
        if (i === 1) return complete(res, [fixture.request], 'stop', 'read_source');
        return complete(res, JSON.stringify(makeReportOutput(request, 'pass', 'rd60')));
      },
      fixture.input,
      fixture.snapshot,
      { sourceBundles: [fixture.bundle] },
    );

    assert.equal(res.outcome.status, 'completed');
    assert.equal(res.outcome.verdict, 'pass');
    assert.equal(res.outcome.successfulReads, 1);
    assert.equal(res.outcome.resourcesDisposed, true);
    assert.equal(res.requests.length, 2);
    assert.deepEqual(toolNames(res), ['read_source']);

    const first = res.records[0];
    assert.ok(first);
    assert.equal(first.state, 'reviewed');
    assert.ok(first.output);
    assert.equal(first.output.report.subject.contentHash, fixture.input.subject.contentHash);

    assert.deepEqual(fixture.input, inputBefore);
    assert.deepEqual(fixture.snapshot, snapshotBefore);
  } finally {
    fixture.cleanup();
  }
});

test('图像来源缺少视觉能力返回 needs_input', async () => {
  const fixture = await makeReviewSourceFixture(true);
  const inputBefore = structuredClone(fixture.input);
  const snapshotBefore = structuredClone(fixture.snapshot);
  try {
    const res = await scenario(
      (request, res, i) => {
        if (i === 1) return complete(res, [fixture.request], 'stop', 'read_source');
        const output = makeReportOutput(request, 'pass', 'rd60');
        output.report.verdict = 'needs_input';
        output.report.issues = [
          {
            issueId: 'issue_image',
            category: 'missing',
            severity: 'error',
            description: '无法从图片核实',
            suggestedStage: 'needs_input',
          },
        ];
        for (const check of output.report.checks) {
          check.status = 'not_run';
          check.severity = 'warning';
          check.claimRefs = ['claim_rd_60'];
          check.evidenceRefs = [];
          check.finding = '图像语义未执行';
        }
        output.report.summary = '当前环境不具备视觉能力，图像语义未执行，存在限制。';
        return complete(res, JSON.stringify(output));
      },
      fixture.input,
      fixture.snapshot,
      { sourceBundles: [fixture.bundle] },
    );

    assert.equal(res.outcome.status, 'completed');
    assert.equal(res.outcome.verdict, 'needs_input');
    assert.equal(res.outcome.successfulReads, 1);
    assert.equal(res.outcome.resourcesDisposed, true);
    assert.equal(res.requests.length, 2);
    assert.deepEqual(toolNames(res), ['read_source']);
    assert.equal(res.records[0].state, 'reviewed');

    assert.deepEqual(fixture.input, inputBefore);
    assert.deepEqual(fixture.snapshot, snapshotBefore);
  } finally {
    fixture.cleanup();
  }
});

test('伪造 pass 报告判定为 invalid_report', async () => {
  const fixture = await makeReviewSourceFixture(true);
  const inputBefore = structuredClone(fixture.input);
  const snapshotBefore = structuredClone(fixture.snapshot);
  try {
    const res = await scenario(
      (request, res, i) => {
        if (i === 1) return complete(res, [fixture.request], 'stop', 'read_source');
        return complete(res, JSON.stringify(makeReportOutput(request, 'pass', 'rd60')));
      },
      fixture.input,
      fixture.snapshot,
      { sourceBundles: [fixture.bundle] },
    );

    assert.equal(res.outcome.status, 'failed');
    assert.equal(res.outcome.reason, 'invalid_report');
    assert.equal(res.outcome.verdict, undefined);
    assert.equal(res.outcome.reportVersionId, undefined);
    assert.equal(res.outcome.successfulReads, 1);
    assert.equal(res.outcome.resourcesDisposed, true);
    assert.equal(res.records.length, 1);
    assert.equal(res.records[0].state, 'invalid');
    assert.equal(res.records[0].output, undefined);
    assert.equal(res.requests.length, 2);
    assert.deepEqual(toolNames(res), ['read_source']);

    assert.deepEqual(fixture.input, inputBefore);
    assert.deepEqual(fixture.snapshot, snapshotBefore);
  } finally {
    fixture.cleanup();
  }
});

