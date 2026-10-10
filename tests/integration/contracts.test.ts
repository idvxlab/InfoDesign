/**
 * 协议结构层测试：使用合成夹具验证合法实例通过与非法实例拒绝。
 * 服务层（引用、版本、权限、指纹、采纳）在 contracts-service.test.ts。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fingerprint, textFingerprint } from '../../packages/contracts/src/fingerprint.ts';
import { checkDocumentHash } from '../../packages/contracts/src/service-checks.ts';
import { fixturesDir, loadFixture, PLACEHOLDER_IDS, readRaw, registry, IDS } from '../helpers/fixtures.ts';

interface CaseEntry {
  name: string;
  schemaId: string;
  file: string;
  reason?: string;
}

const cases = loadFixture<{ valid: CaseEntry[]; invalid: CaseEntry[] }>('cases.json');

function fixtureErrors(item: CaseEntry) {
  const data = JSON.parse(readFileSync(join(fixturesDir, item.file), 'utf8'));
  const result = registry.validate(item.schemaId, data);
  return { data, result };
}

test('所有 Schema 具备唯一 $id，引用完整', () => {
  assert.ok(registry.ids().length >= 17);
  const integrity = registry.checkRefs();
  assert.equal(integrity.ok, true, integrity.problems.join('; '));
  assert.ok(integrity.refs.length > 100);
});

test('结构层正例全部通过', () => {
  for (const item of cases.valid) {
    const { result } = fixtureErrors(item);
    assert.equal(
      result.valid,
      true,
      `正例 ${item.name} 被拒绝：${result.errors.map((e) => `${e.instancePath} ${e.message}`).join('; ')}`,
    );
  }
});

test('结构层负例全部拒绝', () => {
  for (const item of cases.invalid) {
    const { result } = fixtureErrors(item);
    assert.equal(result.valid, false, `负例 ${item.name} 未被拒绝（${item.reason}）`);
  }
});

test('信息与证据输出：候选审查状态不能由模型改为已通过', () => {
  const output = loadFixture<Record<string, any>>('evidence-output.json');
  assert.equal(registry.validate(IDS.evidenceOutput, output).valid, true);
  const forged = JSON.parse(JSON.stringify(output));
  forged.candidateSnapshot.reviewStatus = 'passed';
  assert.equal(registry.validate(IDS.evidenceOutput, forged).valid, false);
});

test('信息与证据输出：失败状态必须给出 stopReason', () => {
  const output = loadFixture<Record<string, any>>('evidence-output.json');
  const failed = JSON.parse(JSON.stringify(output));
  failed.status = 'needs_information';
  assert.equal(registry.validate(IDS.evidenceOutput, failed).valid, false);
  failed.stopReason = '缺少品牌信息';
  assert.equal(registry.validate(IDS.evidenceOutput, failed).valid, true);
});

test('未实现的审查模式必须拒绝', () => {
  for (const mode of ['page', 'revision', 'design']) {
    const input = loadFixture<Record<string, any>>('review-input.json');
    input.reviewMode = mode;
    assert.equal(registry.validate(IDS.reviewInput, input).valid, false, `模式 ${mode} 应被拒绝`);
  }
});

test('占位协议拒绝所有输入', () => {
  const samples: unknown[] = [{}, { protocolVersion: '1.0' }, { anything: true }, []];
  for (const id of PLACEHOLDER_IDS) {
    for (const sample of samples) {
      assert.equal(registry.validate(id, sample).valid, false, `${id} 不应接受输入`);
    }
  }
});

test('DocumentIR 内容指纹与原始文本一致', () => {
  const doc = loadFixture<Record<string, any>>('document-ir.json');
  const issues = checkDocumentHash(doc as never, readRaw('company-profile.txt'));
  assert.deepEqual(issues, []);
  assert.equal(doc.contentHash, textFingerprint(readRaw('company-profile.txt')));
  const doc2 = loadFixture<Record<string, any>>('document-ir-v2.json');
  assert.deepEqual(checkDocumentHash(doc2 as never, readRaw('company-profile-v2.txt')), []);
});

test('审查报告与审查输入绑定同一候选指纹', () => {
  const snapshot = loadFixture<Record<string, any>>('snapshot.json');
  const expected = fingerprint(snapshot);
  const reviewInput = loadFixture<Record<string, any>>('review-input.json');
  const reviewReport = loadFixture<Record<string, any>>('review-report.json');
  assert.equal(reviewInput.subject.contentHash, expected);
  assert.equal(reviewReport.subject.contentHash, expected);
});

test('删除必填字段或加入未知字段会改变校验结果', () => {
  const task = loadFixture<Record<string, any>>('task.json');
  assert.equal(registry.validate(IDS.task, task).valid, true);
  const missing = JSON.parse(JSON.stringify(task));
  delete missing.taskId;
  assert.equal(registry.validate(IDS.task, missing).valid, false);
  const unknown = JSON.parse(JSON.stringify(task));
  unknown.permissions = ['admin'];
  assert.equal(registry.validate(IDS.task, unknown).valid, false);
});