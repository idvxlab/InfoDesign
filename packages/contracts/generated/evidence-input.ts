// 自动生成，请勿手动修改。
// 来源：packages/contracts/schemas
import type { CommonProtocolVersion, CommonIdentifier, CommonPredicate, CommonProjectId, CommonTaskId, CommonAttemptId, CommonDocumentId, CommonBlockId, CommonSnapshotId, CommonReportId, CommonContentHash, CommonTimestamp, CommonDate, CommonTaskType, CommonStage, CommonSupportStatus, CommonReviewStatus, CommonAgentOutputStatus, CommonReviewMode, CommonReviewVerdict, CommonCheckType, CommonCheckStatus, CommonSeverity, CommonSuggestedStage, CommonAllowedOperation, CommonDocumentVersionRef, CommonSourceLocation, CommonParagraphLocation, CommonTableCellLocation, CommonPageRegionLocation, CommonSlideLocation, CommonImageRegionLocation, CommonSheetCellLocation, CommonBoundingBox, CommonFactValue, CommonNumberValue, CommonQuantityValue, CommonTextValue, CommonBooleanValue, CommonDateValue, CommonReferenceValue, CommonEnumValue, CommonTimeQualifier, CommonQualifiers, CommonExtensionBag, CommonAgentProvenance, CommonScope } from './common.ts';
import type { DocumentIr, DocumentIrBlock, DocumentIrParseInfo, DocumentIrUnsupportedContent } from './document-ir.ts';
import type { EvidenceSnapshot, EvidenceSnapshotEntity, EvidenceSnapshotClaim, EvidenceSnapshotEvidenceEntry, EvidenceSnapshotRelation, EvidenceSnapshotEvent, EvidenceSnapshotAsset, EvidenceSnapshotConflict, EvidenceSnapshotMissing, EvidenceSnapshotCoverage, EvidenceSnapshotDocumentCoverage, EvidenceSnapshotUnsupportedContent } from './evidence-snapshot.ts';
import type { Task, TaskBaseVersionRef, TaskInputRef, TaskConstraints } from './task.ts';

export interface EvidenceInput {
  protocolVersion: CommonProtocolVersion;
  taskId: CommonTaskId;
  attemptId: CommonAttemptId;
  projectId: CommonProjectId;
  taskType: CommonTaskType;
  stage: CommonStage;
  scope: CommonScope;
  documents: Array<DocumentIr>;
  existingSnapshot?: EvidenceSnapshot;
  constraints: TaskConstraints;
  executionPolicyRef: CommonIdentifier;
  extensions?: CommonExtensionBag;
}
