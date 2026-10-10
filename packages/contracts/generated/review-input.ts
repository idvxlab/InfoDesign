// 自动生成，请勿手动修改。
// 来源：packages/contracts/schemas
import type { CommonProtocolVersion, CommonIdentifier, CommonPredicate, CommonProjectId, CommonTaskId, CommonAttemptId, CommonDocumentId, CommonBlockId, CommonSnapshotId, CommonReportId, CommonContentHash, CommonTimestamp, CommonDate, CommonTaskType, CommonStage, CommonSupportStatus, CommonReviewStatus, CommonAgentOutputStatus, CommonReviewMode, CommonReviewVerdict, CommonCheckType, CommonCheckStatus, CommonSeverity, CommonSuggestedStage, CommonAllowedOperation, CommonDocumentVersionRef, CommonSourceLocation, CommonParagraphLocation, CommonTableCellLocation, CommonPageRegionLocation, CommonSlideLocation, CommonImageRegionLocation, CommonSheetCellLocation, CommonBoundingBox, CommonFactValue, CommonNumberValue, CommonQuantityValue, CommonTextValue, CommonBooleanValue, CommonDateValue, CommonReferenceValue, CommonEnumValue, CommonTimeQualifier, CommonQualifiers, CommonExtensionBag, CommonAgentProvenance, CommonScope } from './common.ts';
import type { DocumentIr, DocumentIrBlock, DocumentIrParseInfo, DocumentIrUnsupportedContent } from './document-ir.ts';
import type { ReviewReport, ReviewReportReportSubject, ReviewReportCheckResult, ReviewReportIssue } from './review-report.ts';

export interface ReviewInput {
  protocolVersion: CommonProtocolVersion;
  taskId: CommonTaskId;
  attemptId: CommonAttemptId;
  projectId: CommonProjectId;
  reviewMode: CommonReviewMode;
  scope: CommonScope;
  subject: ReviewReportReportSubject;
  documents: Array<DocumentIr>;
  checksRequired: Array<CommonCheckType>;
  executionPolicyRef?: CommonIdentifier;
  extensions?: CommonExtensionBag;
}
