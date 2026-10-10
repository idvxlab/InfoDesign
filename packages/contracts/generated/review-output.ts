// 自动生成，请勿手动修改。
// 来源：packages/contracts/schemas
import type { CommonProtocolVersion, CommonIdentifier, CommonPredicate, CommonProjectId, CommonTaskId, CommonAttemptId, CommonDocumentId, CommonBlockId, CommonSnapshotId, CommonReportId, CommonContentHash, CommonTimestamp, CommonDate, CommonTaskType, CommonStage, CommonSupportStatus, CommonReviewStatus, CommonAgentOutputStatus, CommonReviewMode, CommonReviewVerdict, CommonCheckType, CommonCheckStatus, CommonSeverity, CommonSuggestedStage, CommonAllowedOperation, CommonDocumentVersionRef, CommonSourceLocation, CommonParagraphLocation, CommonTableCellLocation, CommonPageRegionLocation, CommonSlideLocation, CommonImageRegionLocation, CommonSheetCellLocation, CommonBoundingBox, CommonFactValue, CommonNumberValue, CommonQuantityValue, CommonTextValue, CommonBooleanValue, CommonDateValue, CommonReferenceValue, CommonEnumValue, CommonTimeQualifier, CommonQualifiers, CommonExtensionBag, CommonAgentProvenance, CommonScope } from './common.ts';
import type { ReviewReport, ReviewReportReportSubject, ReviewReportCheckResult, ReviewReportIssue } from './review-report.ts';

export interface ReviewOutput {
  protocolVersion: CommonProtocolVersion;
  taskId: CommonTaskId;
  attemptId: CommonAttemptId;
  projectId: CommonProjectId;
  status: CommonAgentOutputStatus;
  report: ReviewReport & {
  reviewedBy?: CommonAgentProvenance & {
  role?: "review";
};
};
  stopReason?: string;
  producedBy?: CommonAgentProvenance & {
  role?: "review";
};
  extensions?: CommonExtensionBag;
}
