/**
 * 服务层校验测试：结构合法之外，检查引用存在、版本一致、位置可回查、
 * 项目与操作权限、成果指纹与采纳状态，拒绝模型伪造权限或采纳。
 * 这些检查由程序执行，不能由模型输出代替。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkDocuments,
  checkEvidenceInput,
  checkEvidenceOutput,
  checkReviewInput,
  checkReviewOutput,
  checkTask,
  evaluateAdoption,
  type CheckResult,
} from '../../packages/contracts/src/service-checks.ts';
import { clone, loadFixture, registry } from '../helpers/fixtures.ts';

type Fixture = Record<string, any>;

const task = loadFixture<Fixture>('task.json');
const doc1 = loadFixture<Fixture>('document-ir.json');
const doc2 = loadFixture<Fixture>('document-ir-v2.json');
const snapshot = loadFixture<Fixture>('snapshot.json');
const evidenceInput = loadFixture<Fixture>('evidence-input.json');
const evidenceOutput = loadFixture<Fixture>('evidence-output.json');
const reviewInput = loadFixture<Fixture>('review-input.json');
const reviewReport = loadFixture<Fixture>('review-report.json');
const reviewOutput = loadFixture<Fixture>('review-output.json');

const codes = (result: CheckResult): string[] => result.issues.map((issue) => issue.code);

test('合法任务、资料与信息提取输入通过服务层校验', () => {
  assert.equal(checkTask(task, registry).ok, true);
  assert.equal(checkDocuments([doc1, doc2], registry).ok, true);
  const result = checkEvidenceInput(evidenceInput, registry);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});

test('合法候选输出通过，且保持 pending 与 evidence 角色', () => {
  const result = checkEvidenceOutput(evidenceOutput, evidenceInput, registry);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});

test('合法审查输入、报告与采纳判定通过', () => {
  assert.equal(checkReviewInput(reviewInput, snapshot, registry).ok, true);
  assert.equal(checkReviewOutput(reviewOutput, reviewInput, snapshot, registry).ok, true);
  const adoption = evaluateAdoption(snapshot, reviewReport, registry, {
    outputStatus: 'completed',
    checksRequired: reviewInput.checksRequired,
  });
  assert.equal(adoption.ok, true, JSON.stringify(adoption.issues));
});

test('未实现的任务类型被拒绝', () => {
  const revise = clone(task);
  revise.taskType = 'revise';
  const result = checkTask(revise, registry);
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('task.type_not_supported'));
});

test('跨项目与越权资料被拒绝', () => {
  const input = clone(evidenceInput);
  input.documents[0].projectId = 'project_other';
  assert.ok(codes(checkEvidenceInput(input, registry)).includes('documents.project_mismatch'));

  const outside = clone(evidenceInput);
  outside.documents = [clone(doc2)];
  outside.scope.documentRefs = [{ documentId: doc2.documentId, documentVersionId: doc2.documentVersionId }];
  outside.scope.documentRefs.push({ documentId: 'doc_hidden', documentVersionId: 'docv_hidden_1' });
  assert.ok(codes(checkEvidenceInput(outside, registry)).includes('scope.document_not_provided'));
});

test('scope.projectId 与项目不一致被拒绝', () => {
  const input = clone(evidenceInput);
  input.scope.projectId = 'project_other';
  assert.ok(codes(checkEvidenceInput(input, registry)).includes('scope.project_mismatch'));
});

test('缺少必要操作权限被拒绝', () => {
  const input = clone(evidenceInput);
  input.scope.allowedOperations = ['read_document'];
  assert.ok(codes(checkEvidenceInput(input, registry)).includes('scope.operation_missing'));
});

test('重复业务编号被拒绝', () => {
  const output = clone(evidenceOutput);
  output.candidateSnapshot.entities.push({ entityId: 'ent_company', entityType: 'organization', label: '重复' });
  assert.ok(codes(checkEvidenceOutput(output, evidenceInput, registry)).includes('snapshot.duplicate_id'));

  const dupClaim = clone(evidenceOutput);
  dupClaim.candidateSnapshot.claims.push(clone(dupClaim.candidateSnapshot.claims[0]));
  assert.ok(codes(checkEvidenceOutput(dupClaim, evidenceInput, registry)).includes('snapshot.duplicate_id'));
});

test('证据来源缺失或版本不匹配被拒绝', () => {
  const missing = clone(evidenceOutput);
  missing.candidateSnapshot.evidence[0].documentId = 'doc_unknown';
  assert.ok(codes(checkEvidenceOutput(missing, evidenceInput, registry)).includes('evidence.source_missing'));

  const mismatch = clone(evidenceOutput);
  mismatch.candidateSnapshot.evidence[0].documentVersionId = 'docv_profile_2';
  assert.ok(codes(checkEvidenceOutput(mismatch, evidenceInput, registry)).includes('evidence.version_mismatch'));
});

test('摘录无法回查或定位不一致被拒绝', () => {
  const badExcerpt = clone(evidenceOutput);
  badExcerpt.candidateSnapshot.evidence[0].excerpt = '原文并不包含的句子';
  assert.ok(codes(checkEvidenceOutput(badExcerpt, evidenceInput, registry)).includes('evidence.excerpt_not_found'));

  const badLocator = clone(evidenceOutput);
  badLocator.candidateSnapshot.evidence[0].locator.paragraphIndex = 99;
  assert.ok(codes(checkEvidenceOutput(badLocator, evidenceInput, registry)).includes('location.index_mismatch'));
});

test('事实引用不存在的实体或证据被拒绝', () => {
  const badEntity = clone(evidenceOutput);
  badEntity.candidateSnapshot.claims[0].entityId = 'ent_unknown';
  assert.ok(codes(checkEvidenceOutput(badEntity, evidenceInput, registry)).includes('claim.entity_missing'));

  const badEvidence = clone(evidenceOutput);
  badEvidence.candidateSnapshot.claims[0].evidenceRefs = ['ev_unknown'];
  assert.ok(codes(checkEvidenceOutput(badEvidence, evidenceInput, registry)).includes('claim.evidence_missing'));
});

test('冲突引用不存在的事实被拒绝', () => {
  const output = clone(evidenceOutput);
  output.candidateSnapshot.conflicts[0].claimRefs = ['claim_rd_60', 'claim_unknown'];
  assert.ok(codes(checkEvidenceOutput(output, evidenceInput, registry)).includes('conflict.claim_missing'));
});

test('覆盖范围包含未授权资料被拒绝', () => {
  const output = clone(evidenceOutput);
  output.candidateSnapshot.coverage.documentsProcessed.push({
    documentId: 'doc_hidden',
    documentVersionId: 'docv_hidden_1',
    blockIds: ['b001'],
  });
  assert.ok(codes(checkEvidenceOutput(output, evidenceInput, registry)).includes('coverage.document_not_authorized'));
});

test('模型伪造采纳字段、审查状态或角色被拒绝', () => {
  const forgedField = clone(evidenceOutput);
  forgedField.accepted = true;
  assert.ok(codes(checkEvidenceOutput(forgedField, evidenceInput, registry)).includes('forged.field'));

  const forgedStatus = clone(evidenceOutput);
  forgedStatus.candidateSnapshot.reviewStatus = 'passed';
  assert.ok(codes(checkEvidenceOutput(forgedStatus, evidenceInput, registry)).includes('snapshot.review_status_forged'));

  const forgedRole = clone(evidenceOutput);
  forgedRole.candidateSnapshot.producedBy.role = 'review';
  assert.ok(codes(checkEvidenceOutput(forgedRole, evidenceInput, registry)).includes('snapshot.role_forged'));
});

test('输出身份不一致被拒绝', () => {
  const output = clone(evidenceOutput);
  output.taskId = 'task_other';
  assert.ok(codes(checkEvidenceOutput(output, evidenceInput, registry)).includes('output.identity_mismatch'));
});

test('审查输入：指纹、版本与项目必须匹配候选成果', () => {
  const badHash = clone(reviewInput);
  badHash.subject.contentHash = 'sha256:' + '0'.repeat(64);
  assert.ok(codes(checkReviewInput(badHash, snapshot, registry)).includes('subject.fingerprint_mismatch'));

  const badVersion = clone(reviewInput);
  badVersion.subject.snapshotVersionId = 'snapv_other';
  assert.ok(codes(checkReviewInput(badVersion, snapshot, registry)).includes('subject.version_mismatch'));

  const badOps = clone(reviewInput);
  badOps.scope.allowedOperations = ['read_document', 'submit_report'];
  assert.ok(codes(checkReviewInput(badOps, snapshot, registry)).includes('scope.operation_missing'));
});

test('审查报告：指纹不匹配、角色伪造与未完成执行', () => {
  const badHash = clone(reviewOutput);
  badHash.report.subject.contentHash = 'sha256:' + '1'.repeat(64);
  assert.ok(codes(checkReviewOutput(badHash, reviewInput, snapshot, registry)).includes('report.fingerprint_mismatch'));

  const badRole = clone(reviewOutput);
  badRole.report.reviewedBy.role = 'evidence';
  assert.ok(codes(checkReviewOutput(badRole, reviewInput, snapshot, registry)).includes('report.role_forged'));

  const failedPass = clone(reviewOutput);
  failedPass.report.executionStatus = 'failed';
  failedPass.report.verdict = 'pass';
  assert.ok(codes(checkReviewOutput(failedPass, reviewInput, snapshot, registry)).includes('report.pass_on_failed_execution'));
});

test('给出 pass 前必须完成全部必需检查', () => {
  const output = clone(reviewOutput);
  output.report.checks = output.report.checks.filter((check: Fixture) => check.checkType !== 'conflict');
  assert.ok(codes(checkReviewOutput(output, reviewInput, snapshot, registry)).includes('report.required_check_not_passed'));

  const notRun = clone(reviewOutput);
  notRun.report.checks.find((check: Fixture) => check.checkType === 'value').status = 'not_run';
  assert.ok(codes(checkReviewOutput(notRun, reviewInput, snapshot, registry)).includes('report.required_check_not_passed'));
});

test('报告引用不存在的事实或证据被拒绝', () => {
  const output = clone(reviewOutput);
  output.report.issues.push({ issueId: 'issue_unknown', severity: 'warning', category: 'traceability', description: 'x', claimId: 'claim_unknown' });
  assert.ok(codes(checkReviewOutput(output, reviewInput, snapshot, registry)).includes('issue.claim_missing'));
});

test('采纳判定：未通过、未执行或指纹不符都拒绝', () => {
  const validContext = { outputStatus: 'completed', checksRequired: reviewInput.checksRequired };
  const revise = clone(reviewReport);
  revise.verdict = 'revise';
  assert.ok(codes(evaluateAdoption(snapshot, revise, registry, validContext)).includes('adoption.verdict_not_pass'));

  const notRun = clone(reviewReport);
  notRun.checks[0].status = 'not_run';
  assert.ok(codes(evaluateAdoption(snapshot, notRun, registry, validContext)).includes('adoption.check_incomplete'));

  const notPending = clone(snapshot);
  notPending.reviewStatus = 'passed';
  assert.ok(codes(evaluateAdoption(notPending, reviewReport, registry, validContext)).includes('adoption.candidate_not_pending'));

  const badHash = clone(reviewReport);
  badHash.subject.contentHash = 'sha256:' + '2'.repeat(64);
  assert.ok(codes(evaluateAdoption(snapshot, badHash, registry, validContext)).includes('adoption.fingerprint_mismatch'));
});

test('候选提交时审查状态必须是 pending', () => {
  const output = clone(evidenceOutput);
  output.candidateSnapshot.reviewStatus = 'needs_revision';
  output.candidateSnapshot.reviewStatus = 'pending';
  assert.equal(checkEvidenceOutput(output, evidenceInput, registry).ok, true);
  output.candidateSnapshot.reviewStatus = 'needs_revision';
  assert.equal(checkEvidenceOutput(output, evidenceInput, registry).ok, false);
});