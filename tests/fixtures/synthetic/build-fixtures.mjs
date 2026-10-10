#!/usr/bin/env node
/**
 * 生成合成测试夹具（B1）。
 * 输入：raw/*.txt；输出：DocumentIR、EvidenceSnapshot、各 Agent 输入输出与审查报告。
 * 内容指纹由脚本对原始文本与候选快照实时计算，避免手写哈希漂移。
 * 运行：node tests/fixtures/synthetic/build-fixtures.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fingerprint, textFingerprint } from '../../../packages/contracts/src/fingerprint.ts';

const here = import.meta.dirname;
const rawDir = join(here, 'raw');
const out = (name, value) => writeFileSync(join(here, name), JSON.stringify(value, null, 2) + '\n');

const PROTOCOL = '1.0';
const PROJECT = 'project_tju_demo';
const TASK = 'task_facts_001';
const ATTEMPT = 'attempt_facts_001';
const POLICY = 'policy_facts_v1';
const CREATED = '2025-01-10T08:00:00Z';

const profileText = readFileSync(join(rawDir, 'company-profile.txt'), 'utf8');
const updateText = readFileSync(join(rawDir, 'company-profile-v2.txt'), 'utf8');

const docProfile = {
  protocolVersion: PROTOCOL,
  documentId: 'doc_profile',
  documentVersionId: 'docv_profile_1',
  projectId: PROJECT,
  version: 1,
  contentHash: textFingerprint(profileText),
  mimeType: 'text/plain',
  sourceName: 'company-profile.txt',
  language: 'zh-CN',
  createdAt: CREATED,
  blocks: [
    {
      blockId: 'b001',
      index: 0,
      type: 'heading',
      text: '天津智造科技有限公司简介',
      location: { kind: 'paragraph', paragraphIndex: 0 },
    },
    {
      blockId: 'b002',
      index: 1,
      type: 'paragraph',
      text: '天津智造科技有限公司成立于 2018 年，注册地为天津市滨海新区。',
      location: { kind: 'paragraph', paragraphIndex: 1 },
    },
    {
      blockId: 'b003',
      index: 2,
      type: 'paragraph',
      text: '公司专注于工业软件与智能质检设备，主要产品为“智检云”平台。',
      location: { kind: 'paragraph', paragraphIndex: 2 },
    },
    {
      blockId: 'b004',
      index: 3,
      type: 'paragraph',
      text: '截至 2025 年，公司研发人员 60 人，营业收入 1200 万元。',
      location: { kind: 'paragraph', paragraphIndex: 3 },
    },
  ],
  parseInfo: { parser: 'synthetic/fixture', quality: 'complete' },
};

const docUpdate = {
  protocolVersion: PROTOCOL,
  documentId: 'doc_update',
  documentVersionId: 'docv_update_1',
  projectId: PROJECT,
  version: 1,
  contentHash: textFingerprint(updateText),
  mimeType: 'text/plain',
  sourceName: 'company-profile-v2.txt',
  language: 'zh-CN',
  createdAt: CREATED,
  blocks: [
    {
      blockId: 'b001',
      index: 0,
      type: 'heading',
      text: '天津智造科技有限公司 2025 年度更新',
      location: { kind: 'paragraph', paragraphIndex: 0 },
    },
    {
      blockId: 'b002',
      index: 1,
      type: 'paragraph',
      text: '本年度补充说明：公司研发人员 55 人（以年末在册口径计）。',
      location: { kind: 'paragraph', paragraphIndex: 1 },
    },
    {
      blockId: 'b003',
      index: 2,
      type: 'paragraph',
      text: '公司办公地点位于天津市滨海新区海河教育园区。',
      location: { kind: 'paragraph', paragraphIndex: 2 },
    },
  ],
  parseInfo: { parser: 'synthetic/fixture', quality: 'complete' },
};

const documents = [docProfile, docUpdate];

const scope = {
  projectId: PROJECT,
  documentRefs: documents.map((d) => ({ documentId: d.documentId, documentVersionId: d.documentVersionId })),
  allowedOperations: ['read_document', 'read_evidence', 'submit_candidate'],
};

const evidence = [
  { evidenceId: 'ev_founded', documentId: 'doc_profile', documentVersionId: 'docv_profile_1', blockId: 'b002', locator: { kind: 'paragraph', paragraphIndex: 1 }, excerpt: '成立于 2018 年', confidence: 'high' },
  { evidenceId: 'ev_registered', documentId: 'doc_profile', documentVersionId: 'docv_profile_1', blockId: 'b002', locator: { kind: 'paragraph', paragraphIndex: 1 }, excerpt: '注册地为天津市滨海新区', confidence: 'high' },
  { evidenceId: 'ev_product', documentId: 'doc_profile', documentVersionId: 'docv_profile_1', blockId: 'b003', locator: { kind: 'paragraph', paragraphIndex: 2 }, excerpt: '智检云', confidence: 'high' },
  { evidenceId: 'ev_rd_60', documentId: 'doc_profile', documentVersionId: 'docv_profile_1', blockId: 'b004', locator: { kind: 'paragraph', paragraphIndex: 3 }, excerpt: '研发人员 60 人', confidence: 'high' },
  { evidenceId: 'ev_revenue', documentId: 'doc_profile', documentVersionId: 'docv_profile_1', blockId: 'b004', locator: { kind: 'paragraph', paragraphIndex: 3 }, excerpt: '营业收入 1200 万元', confidence: 'high' },
  { evidenceId: 'ev_rd_55', documentId: 'doc_update', documentVersionId: 'docv_update_1', blockId: 'b002', locator: { kind: 'paragraph', paragraphIndex: 1 }, excerpt: '研发人员 55 人', confidence: 'high' },
  { evidenceId: 'ev_office', documentId: 'doc_update', documentVersionId: 'docv_update_1', blockId: 'b003', locator: { kind: 'paragraph', paragraphIndex: 2 }, excerpt: '海河教育园区', confidence: 'high' },
];

const snapshot = {
  protocolVersion: PROTOCOL,
  snapshotId: 'snap_facts_001',
  snapshotVersionId: 'snapv_facts_001',
  projectId: PROJECT,
  taskId: TASK,
  attemptId: ATTEMPT,
  entities: [
    { entityId: 'ent_company', entityType: 'organization', label: '天津智造科技有限公司' },
    { entityId: 'ent_product', entityType: 'product', label: '智检云' },
    { entityId: 'ent_rd', entityType: 'metric', label: '研发人员数' },
    { entityId: 'ent_revenue', entityType: 'metric', label: '营业收入' },
    { entityId: 'ent_office', entityType: 'location', label: '海河教育园区' },
  ],
  claims: [
    { claimId: 'claim_founded', claimVersionId: 'claimv_founded_1', entityId: 'ent_company', predicate: 'founded_year', value: { type: 'number', normalized: 2018, unit: '年', raw: '2018 年' }, supportStatus: 'supported', reviewStatus: 'pending', evidenceRefs: ['ev_founded'] },
    { claimId: 'claim_registered', claimVersionId: 'claimv_registered_1', entityId: 'ent_company', predicate: 'registered_address', value: { type: 'text', text: '天津市滨海新区', raw: '注册地为天津市滨海新区' }, supportStatus: 'supported', reviewStatus: 'pending', evidenceRefs: ['ev_registered'] },
    { claimId: 'claim_product', claimVersionId: 'claimv_product_1', entityId: 'ent_product', predicate: 'product_name', value: { type: 'text', text: '智检云' }, supportStatus: 'supported', reviewStatus: 'pending', evidenceRefs: ['ev_product'] },
    { claimId: 'claim_rd_60', claimVersionId: 'claimv_rd_60_1', entityId: 'ent_rd', predicate: 'headcount', value: { type: 'quantity', normalized: 60, unit: '人', raw: '60 人' }, qualifiers: { time: { year: 2025 }, basis: '截至2025年' }, supportStatus: 'supported', reviewStatus: 'pending', evidenceRefs: ['ev_rd_60'] },
    { claimId: 'claim_revenue', claimVersionId: 'claimv_revenue_1', entityId: 'ent_revenue', predicate: 'amount', value: { type: 'quantity', normalized: 1200, unit: '万元', raw: '1200 万元' }, qualifiers: { time: { year: 2025 } }, supportStatus: 'supported', reviewStatus: 'pending', evidenceRefs: ['ev_revenue'] },
    { claimId: 'claim_rd_55', claimVersionId: 'claimv_rd_55_1', entityId: 'ent_rd', predicate: 'headcount', value: { type: 'quantity', normalized: 55, unit: '人', raw: '55 人' }, qualifiers: { time: { year: 2025 }, basis: '年末在册' }, supportStatus: 'conflicted', reviewStatus: 'pending', evidenceRefs: ['ev_rd_55'], conflictGroupId: 'conflict_rd_headcount' },
    { claimId: 'claim_office', claimVersionId: 'claimv_office_1', entityId: 'ent_office', predicate: 'office_location', value: { type: 'text', text: '天津市滨海新区海河教育园区', raw: '办公地点位于天津市滨海新区海河教育园区' }, supportStatus: 'supported', reviewStatus: 'pending', evidenceRefs: ['ev_office'] },
  ],
  evidence,
  conflicts: [
    {
      conflictId: 'conflict_rd_headcount',
      claimRefs: ['claim_rd_60', 'claim_rd_55'],
      description: '研发人员数在不同资料中分别为 60 人与 55 人，统计口径不同，需人工确认。',
      resolutionStatus: 'open',
    },
  ],
  missing: [
    { missingId: 'missing_brand', expectedPredicate: 'brand_name', entityId: 'ent_company', description: '未找到品牌名称信息。', severity: 'warning' },
  ],
  coverage: {
    documentsProcessed: [
      { documentId: 'doc_profile', documentVersionId: 'docv_profile_1', blockIds: ['b001', 'b002', 'b003', 'b004'] },
      { documentId: 'doc_update', documentVersionId: 'docv_update_1', blockIds: ['b001', 'b002', 'b003'] },
    ],
  },
  reviewStatus: 'pending',
  producedBy: { role: 'evidence', model: 'synthetic-fixture', sessionId: 'session_fixture', protocolVersion: PROTOCOL, promptVersion: 'fixture-v1' },
  createdAt: CREATED,
};

const snapshotFingerprint = fingerprint(snapshot);

const task = {
  protocolVersion: PROTOCOL,
  taskId: TASK,
  attemptId: ATTEMPT,
  projectId: PROJECT,
  taskType: 'generate',
  stage: 'facts',
  userIntent: '从两份公司资料中提取企业事实与证据，保留冲突与缺失。',
  baseVersions: [],
  inputRefs: documents.map((d) => ({ refType: 'document', refId: d.documentId, versionId: d.documentVersionId, contentHash: d.contentHash })),
  constraints: { preserveFacts: true, forbiddenNewFacts: true, brand: 'tju-mas', notes: '合成夹具，用于协议校验测试。' },
  executionPolicyRef: POLICY,
  createdAt: CREATED,
};

const evidenceInput = {
  protocolVersion: PROTOCOL,
  taskId: TASK,
  attemptId: ATTEMPT,
  projectId: PROJECT,
  taskType: 'generate',
  stage: 'facts',
  scope,
  documents,
  constraints: { preserveFacts: true, forbiddenNewFacts: true },
  executionPolicyRef: POLICY,
};

const evidenceOutput = {
  protocolVersion: PROTOCOL,
  taskId: TASK,
  attemptId: ATTEMPT,
  projectId: PROJECT,
  status: 'completed',
  candidateSnapshot: snapshot,
  producedBy: { role: 'evidence', model: 'synthetic-fixture', sessionId: 'session_fixture', protocolVersion: PROTOCOL },
};

const reviewScope = {
  projectId: PROJECT,
  documentRefs: scope.documentRefs,
  allowedOperations: ['read_document', 'read_evidence', 'check_source', 'compare_versions', 'submit_report'],
};

const subject = {
  subjectType: 'evidence_snapshot',
  snapshotId: snapshot.snapshotId,
  snapshotVersionId: snapshot.snapshotVersionId,
  contentHash: snapshotFingerprint,
};

const checksRequired = ['support', 'entity_match', 'value', 'source_locator', 'conflict', 'missing', 'traceability'];

const reviewInput = {
  protocolVersion: PROTOCOL,
  taskId: TASK,
  attemptId: ATTEMPT,
  projectId: PROJECT,
  reviewMode: 'fact',
  scope: reviewScope,
  subject,
  documents,
  checksRequired,
  executionPolicyRef: POLICY,
};

const reviewReport = {
  protocolVersion: PROTOCOL,
  reportId: 'report_facts_001',
  reportVersionId: 'reportv_facts_001',
  projectId: PROJECT,
  taskId: TASK,
  attemptId: ATTEMPT,
  reviewMode: 'fact',
  subject,
  verdict: 'pass',
  checks: checksRequired.map((checkType, i) => ({
    checkId: `check_${checkType}`,
    checkType,
    status: 'pass',
    finding: `已按 ${checkType} 规则核对候选快照与原始资料。`,
    severity: 'info',
    ...(i === 0 ? { claimRefs: ['claim_founded'], evidenceRefs: ['ev_founded'] } : {}),
  })),
  issues: [
    {
      issueId: 'issue_conflict_rd',
      severity: 'warning',
      category: 'conflict',
      description: '研发人员数存在 60 人与 55 人两种口径，已登记为未解决冲突。',
      expected: '同一口径下唯一人数',
      actual: '60 人（截至2025年）与 55 人（年末在册）',
      suggestedStage: 'needs_input',
    },
  ],
  summary: '候选快照与原始资料逐条核对，冲突与缺失均已登记；提取阶段通过，业务口径待人工确认。',
  executionStatus: 'completed',
  reviewedBy: { role: 'review', model: 'synthetic-fixture', sessionId: 'session_review_fixture', protocolVersion: PROTOCOL },
  createdAt: CREATED,
};

const reviewOutput = {
  protocolVersion: PROTOCOL,
  taskId: TASK,
  attemptId: ATTEMPT,
  projectId: PROJECT,
  status: 'completed',
  report: reviewReport,
  producedBy: { role: 'review', model: 'synthetic-fixture', sessionId: 'session_review_fixture', protocolVersion: PROTOCOL },
};

const expectedFacts = {
  description: '合成资料中期望提取的事实与证据，供后续真实模型抽取时对照。当前仅用于协议与校验测试。',
  documents: documents.map((d) => ({ documentId: d.documentId, documentVersionId: d.documentVersionId, contentHash: d.contentHash })),
  facts: snapshot.claims.map((c) => ({
    claimId: c.claimId,
    entityId: c.entityId,
    predicate: c.predicate,
    value: c.value,
    supportStatus: c.supportStatus,
    conflictGroupId: c.conflictGroupId ?? null,
    evidenceRefs: c.evidenceRefs,
  })),
  expectedConflicts: snapshot.conflicts.map((c) => ({ conflictId: c.conflictId, claimRefs: c.claimRefs, resolutionStatus: c.resolutionStatus })),
  expectedMissing: snapshot.missing.map((m) => ({ missingId: m.missingId, expectedPredicate: m.expectedPredicate, severity: m.severity })),
};

out('document-ir.json', docProfile);
out('document-ir-v2.json', docUpdate);
out('snapshot.json', snapshot);
out('task.json', task);
out('evidence-input.json', evidenceInput);
out('evidence-output.json', evidenceOutput);
out('review-input.json', reviewInput);
out('review-report.json', reviewReport);
out('review-output.json', reviewOutput);
out('expected-facts.json', expectedFacts);

// ---- 负例（结构层） ----
const minimalSnapshot = {
  protocolVersion: PROTOCOL,
  snapshotId: 'snap_negative',
  snapshotVersionId: 'snapv_negative_1',
  projectId: PROJECT,
  taskId: TASK,
  attemptId: ATTEMPT,
  entities: [],
  claims: [],
  evidence: [],
  conflicts: [],
  missing: [],
  coverage: { documentsProcessed: [] },
  reviewStatus: 'pending',
  producedBy: { role: 'evidence', protocolVersion: PROTOCOL },
  createdAt: CREATED,
};

const clone = (v) => JSON.parse(JSON.stringify(v));

const invalid = {
  'snapshot-missing-coverage': (() => {
    const v = clone(minimalSnapshot);
    delete v.coverage;
    return { schemaId: 'urn:tju-mas:contracts:evidence-snapshot', instance: v, reason: '缺少必填字段 coverage' };
  })(),
  'snapshot-unknown-field': (() => {
    const v = clone(minimalSnapshot);
    v.entities = [{ entityId: 'ent_x', entityType: 'organization', label: 'X', permissions: ['admin'] }];
    return { schemaId: 'urn:tju-mas:contracts:evidence-snapshot', instance: v, reason: '实体出现未知字段 permissions' };
  })(),
  'snapshot-bad-fact-value': (() => {
    const v = clone(minimalSnapshot);
    v.claims = [
      {
        claimId: 'claim_x',
        claimVersionId: 'claimv_x_1',
        entityId: 'ent_x',
        predicate: 'headcount',
        value: { type: 'quantity', normalized: '60', unit: '人' },
        supportStatus: 'supported',
        reviewStatus: 'pending',
        evidenceRefs: ['ev_x'],
      },
    ];
    return { schemaId: 'urn:tju-mas:contracts:evidence-snapshot', instance: v, reason: '事实值 normalized 应为数字' };
  })(),
  'snapshot-reserved-extension': (() => {
    const v = clone(minimalSnapshot);
    v.extensions = { permissions: 'admin' };
    return { schemaId: 'urn:tju-mas:contracts:evidence-snapshot', instance: v, reason: '扩展区使用保留键 permissions' };
  })(),
  'snapshot-invalid-review-status': (() => {
    const v = clone(minimalSnapshot);
    v.reviewStatus = 'approved';
    return { schemaId: 'urn:tju-mas:contracts:evidence-snapshot', instance: v, reason: 'reviewStatus 使用未登记的状态 approved' };
  })(),
  'document-ir-missing-blocks': (() => {
    const v = clone(docProfile);
    delete v.blocks;
    return { schemaId: 'urn:tju-mas:contracts:document-ir', instance: v, reason: '缺少必填字段 blocks' };
  })(),
  'task-missing-task-id': (() => {
    const v = clone(task);
    delete v.taskId;
    return { schemaId: 'urn:tju-mas:contracts:task', instance: v, reason: '缺少必填字段 taskId' };
  })(),
  'evidence-output-forged-review-status': (() => {
    const v = clone(evidenceOutput);
    v.candidateSnapshot.reviewStatus = 'passed';
    return { schemaId: 'urn:tju-mas:contracts:evidence-output', instance: v, reason: '候选快照审查状态被改为 passed' };
  })(),
  'evidence-output-forged-role': (() => {
    const v = clone(evidenceOutput);
    v.candidateSnapshot.producedBy.role = 'review';
    return { schemaId: 'urn:tju-mas:contracts:evidence-output', instance: v, reason: '候选快照角色被改为 review' };
  })(),
  'evidence-output-forged-claim-review-status': (() => {
    const v = clone(evidenceOutput);
    v.candidateSnapshot.claims[0].reviewStatus = 'passed';
    return { schemaId: 'urn:tju-mas:contracts:evidence-output', instance: v, reason: '候选内部单条事实的审查状态被改为 passed' };
  })(),
  'evidence-output-claims-not-array': (() => {
    const v = clone(evidenceOutput);
    v.candidateSnapshot.claims = {};
    return { schemaId: 'urn:tju-mas:contracts:evidence-output', instance: v, reason: '候选事实集合被改为对象，结构错误' };
  })(),
  'snapshot-invalid-timestamp': (() => {
    const v = clone(minimalSnapshot);
    v.createdAt = '2025-02-30T00:00:00Z';
    return { schemaId: 'urn:tju-mas:contracts:evidence-snapshot', instance: v, reason: 'createdAt 使用不存在的日期 2025-02-30' };
  })(),
  'review-input-unsupported-mode': (() => {
    const v = clone(reviewInput);
    v.reviewMode = 'page';
    return { schemaId: 'urn:tju-mas:contracts:review-input', instance: v, reason: '未实现的审查模式 page' };
  })(),
  'review-output-forged-role': (() => {
    const v = clone(reviewOutput);
    v.report.reviewedBy.role = 'evidence';
    return { schemaId: 'urn:tju-mas:contracts:review-output', instance: v, reason: '审查报告角色被改为 evidence' };
  })(),
  'evidence-output-missing-stop-reason': (() => {
    const v = clone(evidenceOutput);
    v.status = 'failed';
    return { schemaId: 'urn:tju-mas:contracts:evidence-output', instance: v, reason: '失败状态缺少 stopReason' };
  })(),
  'information-plan-placeholder': {
    schemaId: 'urn:tju-mas:contracts:information-plan',
    instance: { protocolVersion: PROTOCOL },
    reason: '未实现的占位协议必须拒绝任何输入',
  },
};

const invalidDir = join(here, 'invalid');
for (const [name, entry] of Object.entries(invalid)) {
  writeFileSync(join(invalidDir, `${name}.json`), JSON.stringify(entry.instance, null, 2) + '\n');
}

const cases = {
  description: '结构层正反例清单。有效性由 packages/contracts 的校验器判定；服务层用例在 tests/integration/contracts-service.test.ts。',
  valid: [
    { name: 'task', schemaId: 'urn:tju-mas:contracts:task', file: 'task.json' },
    { name: 'document-ir', schemaId: 'urn:tju-mas:contracts:document-ir', file: 'document-ir.json' },
    { name: 'document-ir-v2', schemaId: 'urn:tju-mas:contracts:document-ir', file: 'document-ir-v2.json' },
    { name: 'snapshot', schemaId: 'urn:tju-mas:contracts:evidence-snapshot', file: 'snapshot.json' },
    { name: 'evidence-input', schemaId: 'urn:tju-mas:contracts:evidence-input', file: 'evidence-input.json' },
    { name: 'evidence-output', schemaId: 'urn:tju-mas:contracts:evidence-output', file: 'evidence-output.json' },
    { name: 'review-input', schemaId: 'urn:tju-mas:contracts:review-input', file: 'review-input.json' },
    { name: 'review-report', schemaId: 'urn:tju-mas:contracts:review-report', file: 'review-report.json' },
    { name: 'review-output', schemaId: 'urn:tju-mas:contracts:review-output', file: 'review-output.json' },
  ],
  invalid: Object.entries(invalid).map(([name, entry]) => ({
    name,
    schemaId: entry.schemaId,
    file: `invalid/${name}.json`,
    reason: entry.reason,
  })),
};

out('cases.json', cases);

console.log(`夹具已生成：文档 ${documents.length} 份，事实 ${snapshot.claims.length} 条，负例 ${Object.keys(invalid).length} 个`);
console.log(`候选快照指纹：${snapshotFingerprint}`);