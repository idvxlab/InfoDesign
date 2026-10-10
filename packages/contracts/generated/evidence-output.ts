// 自动生成，请勿手动修改。
// 来源：packages/contracts/schemas
import type { CommonProtocolVersion, CommonIdentifier, CommonPredicate, CommonProjectId, CommonTaskId, CommonAttemptId, CommonDocumentId, CommonBlockId, CommonSnapshotId, CommonReportId, CommonContentHash, CommonTimestamp, CommonDate, CommonTaskType, CommonStage, CommonSupportStatus, CommonReviewStatus, CommonAgentOutputStatus, CommonReviewMode, CommonReviewVerdict, CommonCheckType, CommonCheckStatus, CommonSeverity, CommonSuggestedStage, CommonAllowedOperation, CommonDocumentVersionRef, CommonSourceLocation, CommonParagraphLocation, CommonTableCellLocation, CommonPageRegionLocation, CommonSlideLocation, CommonImageRegionLocation, CommonSheetCellLocation, CommonBoundingBox, CommonFactValue, CommonNumberValue, CommonQuantityValue, CommonTextValue, CommonBooleanValue, CommonDateValue, CommonReferenceValue, CommonEnumValue, CommonTimeQualifier, CommonQualifiers, CommonExtensionBag, CommonAgentProvenance, CommonScope } from './common.ts';
import type { EvidenceSnapshot, EvidenceSnapshotEntity, EvidenceSnapshotClaim, EvidenceSnapshotEvidenceEntry, EvidenceSnapshotRelation, EvidenceSnapshotEvent, EvidenceSnapshotAsset, EvidenceSnapshotConflict, EvidenceSnapshotMissing, EvidenceSnapshotCoverage, EvidenceSnapshotDocumentCoverage, EvidenceSnapshotUnsupportedContent } from './evidence-snapshot.ts';

export type EvidenceOutputClaimChange = {
  changeId: CommonIdentifier;
  changeType: "added" | "updated" | "unchanged" | "removed";
  claimId: CommonIdentifier;
  description: string;
};

export interface EvidenceOutput {
  protocolVersion: CommonProtocolVersion;
  taskId: CommonTaskId;
  attemptId: CommonAttemptId;
  projectId: CommonProjectId;
  status: CommonAgentOutputStatus;
  candidateSnapshot: EvidenceSnapshot & {
  reviewStatus?: "pending";
  claims?: Array<{
  reviewStatus?: "pending";
}>;
  producedBy?: CommonAgentProvenance & {
  role?: "evidence";
};
};
  changes?: Array<EvidenceOutputClaimChange>;
  stopReason?: string;
  producedBy: CommonAgentProvenance & {
  role?: "evidence";
};
  extensions?: CommonExtensionBag;
}
