// 自动生成，请勿手动修改。
// 来源：packages/contracts/schemas
import type { CommonProtocolVersion, CommonIdentifier, CommonPredicate, CommonProjectId, CommonTaskId, CommonAttemptId, CommonDocumentId, CommonBlockId, CommonSnapshotId, CommonReportId, CommonContentHash, CommonTimestamp, CommonDate, CommonTaskType, CommonStage, CommonSupportStatus, CommonReviewStatus, CommonAgentOutputStatus, CommonReviewMode, CommonReviewVerdict, CommonCheckType, CommonCheckStatus, CommonSeverity, CommonSuggestedStage, CommonAllowedOperation, CommonDocumentVersionRef, CommonSourceLocation, CommonParagraphLocation, CommonTableCellLocation, CommonPageRegionLocation, CommonSlideLocation, CommonImageRegionLocation, CommonSheetCellLocation, CommonBoundingBox, CommonFactValue, CommonNumberValue, CommonQuantityValue, CommonTextValue, CommonBooleanValue, CommonDateValue, CommonReferenceValue, CommonEnumValue, CommonTimeQualifier, CommonQualifiers, CommonExtensionBag, CommonAgentProvenance, CommonScope } from './common.ts';

export type ReviewReportReportSubject = {
  subjectType: "evidence_snapshot";
  snapshotId: CommonSnapshotId;
  snapshotVersionId: CommonIdentifier;
  contentHash: CommonContentHash;
};

export type ReviewReportCheckResult = {
  checkId: CommonIdentifier;
  checkType: CommonCheckType;
  status: CommonCheckStatus;
  claimRefs?: Array<CommonIdentifier>;
  evidenceRefs?: Array<CommonIdentifier>;
  finding: string;
  severity?: CommonSeverity;
};

export type ReviewReportIssue = {
  issueId: CommonIdentifier;
  claimId?: CommonIdentifier;
  evidenceRefs?: Array<CommonIdentifier>;
  severity: CommonSeverity;
  category: CommonCheckType;
  description: string;
  expected?: string;
  actual?: string;
  suggestedStage?: CommonSuggestedStage;
};

export interface ReviewReport {
  protocolVersion: CommonProtocolVersion;
  reportId: CommonReportId;
  reportVersionId: CommonIdentifier;
  projectId: CommonProjectId;
  taskId: CommonTaskId;
  attemptId: CommonAttemptId;
  reviewMode: CommonReviewMode;
  subject: ReviewReportReportSubject;
  verdict: CommonReviewVerdict;
  checks: Array<ReviewReportCheckResult>;
  issues: Array<ReviewReportIssue>;
  summary: string;
  executionStatus: "completed" | "failed";
  reviewedBy: CommonAgentProvenance;
  createdAt: CommonTimestamp;
  extensions?: CommonExtensionBag;
}
