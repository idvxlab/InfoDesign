/**
 * B0/B1 复核回归测试：逐项覆盖 docs/reports/b0-b1-review-2026-10-10.md 中的 R1–R10。
 * 目的是防止服务层权限、审查状态、采纳一致性、来源定位、引用完整性与
 * 非法输入处理再次回退。所有数据均为内存中构造的合成夹具。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkEvidenceOutput,
  checkReviewInput,
  checkReviewOutput,
  evaluateAdoption,
  type CheckResult,
} from '../../packages/contracts/src/service-checks.ts';
import { clone, IDS, loadFixture, registry } from '../helpers/fixtures.ts';

type Fixture = Record<string, any>;

const evidenceInput = loadFixture<Fixture>('evidence-input.json');
const snapshot = loadFixture<Fixture>('snapshot.json');
const reviewInput = loadFixture<Fixture>('review-input.json');
const reviewOutput = loadFixture<Fixture>('review-output.json');
const evidenceOutput = loadFixture<Fixture>('evidence-output.json');

const codes = (result: CheckResult): string[] => result.issues.map((issue) => issue.code);

function candidate(mutate: (snapshot: Fixture) => void): CheckResult {
  const output = clone(evidenceOutput);
  mutate(output.candidateSnapshot);
  return checkEvidenceOutput(output, evidenceInput, registry);
}

/** 每次调用都返回新的克隆，避免测试之间互相污染夹具。 */
function reviewOutputWith(mutate: (output: Fixture) => void): Fixture {
  const output = clone(reviewOutput);
  mutate(output);
  return output;
}

test('R1：审查资料属于其他项目时拒绝', () => {
  const input = clone(reviewInput);
  input.documents[0].projectId = 'project_other';
  const result = checkReviewInput(input, snapshot, registry);
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('documents.project_mismatch'));
});

test('R2：审查资料不在授权范围内时拒绝', () => {
  const input = clone(reviewInput);
  const injected = clone(input.documents[0]);
  injected.documentId = 'doc_unscoped';
  injected.documentVersionId = 'docv_unscoped';
  input.documents.push(injected);
  const result = checkReviewInput(input, snapshot, registry);
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('scope.document_not_authorized'));
});

test('R3：候选内部单条事实的审查状态不能是 passed', () => {
  const output = clone(evidenceOutput);
  output.candidateSnapshot.claims[0].reviewStatus = 'passed';
  // 结构层必须拒绝
  const structural = registry.validate(IDS.evidenceOutput, output);
  assert.equal(structural.valid, false);
  // 服务层必须拒绝，并且给出明确问题码
  const result = checkEvidenceOutput(output, evidenceInput, registry);
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('claim.review_status_forged'));
});

test('R4：来源字符范围越界时拒绝', () => {
  const result = candidate((s) => {
    s.evidence[0].locator.charStart = 999999;
    s.evidence[0].locator.charEnd = 1000000;
  });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('location.char_out_of_range'));
});

test('R4b：字符范围与摘录位置不一致时拒绝', () => {
  const result = candidate((s) => {
    s.evidence[0].locator.charStart = 0;
    s.evidence[0].locator.charEnd = 3;
  });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('location.excerpt_position_mismatch'));
});

test('R5：关系引用不存在的实体或证据时拒绝', () => {
  const result = candidate((s) => {
    s.relations = [
      {
        relationId: 'rel_missing',
        fromEntityId: 'ent_missing_a',
        toEntityId: 'ent_missing_b',
        relationType: 'partner',
        evidenceRefs: ['ev_missing'],
      },
    ];
  });
  assert.equal(result.ok, false);
  const found = codes(result);
  assert.ok(found.includes('relation.from_entity_missing'));
  assert.ok(found.includes('relation.to_entity_missing'));
  assert.ok(found.includes('relation.evidence_missing'));
});

test('R6：覆盖范围包含不存在的块时拒绝', () => {
  const result = candidate((s) => {
    s.coverage.documentsProcessed[0].blockIds = ['b999999'];
  });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('coverage.block_missing'));
});

test('R7：存在 critical 问题时不能给出 pass，也不能采纳', () => {
  const output = reviewOutputWith((x) => {
    Object.assign(x.report.issues[0], {
      severity: 'critical',
      category: 'value',
      description: '候选关键数值错误，必须修正。',
    });
  });
  const reviewed = checkReviewOutput(output, reviewInput, snapshot, registry);
  assert.equal(reviewed.ok, false);
  assert.ok(codes(reviewed).includes('report.pass_with_blocking_issue'));

  const adoption = evaluateAdoption(snapshot, output.report, registry, {
    outputStatus: 'completed',
    checksRequired: reviewInput.checksRequired,
  });
  assert.equal(adoption.ok, false);
  assert.ok(codes(adoption).includes('adoption.blocking_issue'));
});

test('R8：外层失败时内层报告状态必须一致，且不能被采纳', () => {
  const output = reviewOutputWith((x) => {
    x.status = 'failed';
    x.stopReason = 'provider failed';
  });
  const reviewed = checkReviewOutput(output, reviewInput, snapshot, registry);
  assert.equal(reviewed.ok, false);
  const found = codes(reviewed);
  assert.ok(found.includes('report.execution_status_inconsistent'));
  assert.ok(found.includes('report.pass_on_failed_task'));

  const adoption = evaluateAdoption(snapshot, output.report, registry, {
    outputStatus: output.status,
    checksRequired: reviewInput.checksRequired,
  });
  assert.equal(adoption.ok, false);
  assert.ok(codes(adoption).includes('adoption.output_not_completed'));
});

test('R9：结构非法（claims 为对象）返回 CheckResult 而不是抛异常', () => {
  let result: CheckResult | undefined;
  assert.doesNotThrow(() => {
    result = candidate((s) => {
      s.claims = {};
    });
  });
  assert.equal(result?.ok, false);
  assert.ok(codes(result!).some((code) => code.startsWith('schema.')));
});

test('R9b：其他非法集合类型同样不抛异常', () => {
  for (const mutate of [
    (s: Fixture) => {
      s.claims = null;
    },
    (s: Fixture) => {
      s.evidence = 'not-an-array';
    },
    (s: Fixture) => {
      s.entities = 0;
    },
    (s: Fixture) => {
      s.coverage = null;
    },
    (s: Fixture) => {
      delete s.claims;
    },
  ]) {
    let result: CheckResult | undefined;
    assert.doesNotThrow(() => {
      result = candidate(mutate);
    });
    assert.equal(result?.ok, false);
  }
});

test('R10：不存在的日期不能被结构校验放行', () => {
  const output = clone(evidenceOutput);
  output.candidateSnapshot.createdAt = '2025-02-30T00:00:00Z';
  const structural = registry.validate(IDS.evidenceOutput, output);
  assert.equal(structural.valid, false);
  assert.ok(structural.errors.some((error) => error.keyword === 'format'));

  const result = checkEvidenceOutput(output, evidenceInput, registry);
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('schema.format'));
});

test('未接入的定位类型被明确标记为未验证', () => {
  const result = candidate((s) => {
    s.evidence[0].locator = { kind: 'page_region', page: 1 };
  });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('location.not_verified'));
});

test('缺少必需检查时不能采纳', () => {
  const output = reviewOutputWith((x) => {
    x.report.checks = x.report.checks.filter((check: Fixture) => check.checkType !== 'traceability');
  });
  const reviewed = checkReviewOutput(output, reviewInput, snapshot, registry);
  assert.equal(reviewed.ok, false);
  assert.ok(codes(reviewed).includes('report.required_check_not_passed'));

  const adoption = evaluateAdoption(snapshot, output.report, registry, {
    outputStatus: 'completed',
    checksRequired: reviewInput.checksRequired,
  });
  assert.equal(adoption.ok, false);
  assert.ok(codes(adoption).includes('adoption.required_check_not_passed'));
});

test('R11：采纳函数的必需检查上下文缺失、为空或类型非法时返回结构化错误', () => {
  const valid: Array<[string, unknown, string]> = [
    ['完全缺失上下文', undefined, 'adoption.required_checks_missing'],
    ['只给 outputStatus', { outputStatus: 'completed' }, 'adoption.required_checks_missing'],
    ['列表为空', { outputStatus: 'completed', checksRequired: [] }, 'adoption.required_checks_empty'],
    ['列表类型非法', { outputStatus: 'completed', checksRequired: 'traceability' }, 'adoption.required_checks_missing'],
    ['列表含非字符串', { outputStatus: 'completed', checksRequired: ['traceability', 7] }, 'adoption.required_checks_invalid'],
    ['列表含空字符串', { outputStatus: 'completed', checksRequired: [''] }, 'adoption.required_checks_invalid'],
  ];
  for (const [name, context, expected] of valid) {
    let result: CheckResult | undefined;
    assert.doesNotThrow(() => {
      result = evaluateAdoption(snapshot, reviewOutput.report, registry, context as any);
    }, name);
    assert.equal(result?.ok, false, name);
    assert.ok(codes(result!).includes(expected), `${name} -> ${codes(result!).join(',')}`);
  }
});

test('R11b：必需检查列表只能来自可信上下文，不能用报告内检查反推', () => {
  const forged = clone(reviewOutput);
  forged.report.checks.push({
    checkId: 'check_forged_traceability',
    checkType: 'traceability',
    status: 'pass',
    claimRefs: [],
    evidenceRefs: [],
  });
  const result = evaluateAdoption(snapshot, forged.report, registry, {
    outputStatus: 'completed',
  } as any);
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('adoption.required_checks_missing'));
});

test('报告必须绑定审查任务指定的成果版本', () => {
  const mismatched = clone(reviewInput);
  mismatched.subject.snapshotId = 'snap_other';
  mismatched.subject.snapshotVersionId = 'snapv_other';
  const result = checkReviewOutput(reviewOutput, mismatched, snapshot, registry);
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('report.subject_mismatch'));
});

test('R9c：顶层为 null 或非对象时不抛异常', () => {
  for (const bad of [null, 42, 'text', [], true]) {
    const value = bad as any;
    assert.doesNotThrow(() => checkEvidenceOutput(value, evidenceInput, registry));
    assert.doesNotThrow(() => checkReviewInput(value, snapshot, registry));
    assert.doesNotThrow(() => checkReviewOutput(value, reviewInput, snapshot, registry));
    // 显式的运行时非法输入：类型系统之外的 JS 调用漏传必需检查列表仍不能抛异常。
    assert.doesNotThrow(() => evaluateAdoption(value, value, registry, { outputStatus: 'completed' } as any));
  }
});

test('缺字段的候选不会中断服务层检查', () => {
  const result = candidate((s) => {
    delete s.claims;
    delete s.entities;
  });
  assert.equal(result.ok, false);
  assert.ok(codes(result).some((code) => code.startsWith('schema.')));
});

test('合法夹具在新增检查后仍然全部通过', () => {
  assert.equal(checkEvidenceOutput(evidenceOutput, evidenceInput, registry).ok, true);
  assert.equal(checkReviewInput(reviewInput, snapshot, registry).ok, true);
  assert.equal(checkReviewOutput(reviewOutput, reviewInput, snapshot, registry).ok, true);
  assert.equal(
    evaluateAdoption(snapshot, reviewOutput.report, registry, {
      outputStatus: 'completed',
      checksRequired: reviewInput.checksRequired,
    }).ok,
    true,
  );
});