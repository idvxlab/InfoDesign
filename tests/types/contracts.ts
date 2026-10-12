/** 编译期契约：只由 tsc 执行；@ts-expect-error 变得多余时检查必须失败。 */
import type {
  Task, DocumentIr, EvidenceSnapshot, EvidenceInput, EvidenceOutput,
  ReviewInput, ReviewOutput, ReviewReport, CommonFactValue, PageSpec, DesignInput, DesignOutput,
} from '../../packages/contracts/generated/index.ts';
import {
  checkTask, checkDocuments, checkEvidenceInput, checkEvidenceOutput,
  checkReviewInput, checkReviewOutput, evaluateAdoption,
  type AdoptionContext, type CheckResult,
} from '../../packages/contracts/src/service-checks.ts';
import type { SchemaRegistry } from '../../packages/contracts/src/schema-registry.ts';

declare const registry: SchemaRegistry;
declare const task: Task;
declare const document: DocumentIr;
declare const snapshot: EvidenceSnapshot;
declare const evidenceInput: EvidenceInput;
declare const evidenceOutput: EvidenceOutput;
declare const reviewInput: ReviewInput;
declare const reviewOutput: ReviewOutput;
const report: ReviewReport = reviewOutput.report;
const context: AdoptionContext = {
  outputStatus: reviewOutput.status,
  checksRequired: reviewInput.checksRequired,
};
const results: CheckResult[] = [
  checkTask(task, registry),
  checkDocuments([document], registry),
  checkEvidenceInput(evidenceInput, registry),
  checkEvidenceOutput(evidenceOutput, evidenceInput, registry),
  checkReviewInput(reviewInput, snapshot, registry),
  checkReviewOutput(reviewOutput, reviewInput, snapshot, registry),
  evaluateAdoption(snapshot, report, registry, context),
];
void results;

const value: CommonFactValue = { type: 'quantity', normalized: 60, unit: '人' };
void value;
// @ts-expect-error 数量必须有单位。
const missingUnit: CommonFactValue = { type: 'quantity', normalized: 60 };
// @ts-expect-error 数值不能是字符串。
const badNumber: CommonFactValue = { type: 'number', normalized: '60' };
// @ts-expect-error 候选事实不能伪造已经通过审查。
evidenceOutput.candidateSnapshot.reviewStatus = 'passed';
// @ts-expect-error 候选中的单条事实同样必须保持 pending。
evidenceOutput.candidateSnapshot.claims[0].reviewStatus = 'passed';
// @ts-expect-error 事实提取输出不能伪造审查角色。
evidenceOutput.producedBy.role = 'review';
// @ts-expect-error 采纳入口必须传入可信上下文。
evaluateAdoption(snapshot, report, registry);
// @ts-expect-error 可信上下文必须包含 checksRequired。
evaluateAdoption(snapshot, report, registry, { outputStatus: 'completed' });
// @ts-expect-error checksRequired 必须为列表。
evaluateAdoption(snapshot, report, registry, { outputStatus: 'completed', checksRequired: 'traceability' });
declare const taskWithoutId: Omit<Task, 'taskId'>;
// @ts-expect-error 任务必须有 taskId。
const missingTaskId: Task = taskWithoutId;
// @ts-expect-error PageSpec 必须包含版本、布局、节点及绑定等必填字段。
const placeholder: PageSpec = {};

declare const designInput: DesignInput;
declare const designOutput: DesignOutput;
// @ts-expect-error 首版设计任务只允许首次生成。
designInput.taskType = 'revise';
// @ts-expect-error 设计输出不能改写权威事实快照。
designOutput.snapshot = snapshot;
