// 自动生成，请勿手动修改。
// 来源：packages/contracts/schemas
import type { CommonProtocolVersion, CommonIdentifier, CommonPredicate, CommonProjectId, CommonTaskId, CommonAttemptId, CommonDocumentId, CommonBlockId, CommonSnapshotId, CommonReportId, CommonContentHash, CommonTimestamp, CommonDate, CommonTaskType, CommonStage, CommonSupportStatus, CommonReviewStatus, CommonAgentOutputStatus, CommonReviewMode, CommonReviewVerdict, CommonCheckType, CommonCheckStatus, CommonSeverity, CommonSuggestedStage, CommonAllowedOperation, CommonDocumentVersionRef, CommonSourceLocation, CommonParagraphLocation, CommonTableCellLocation, CommonPageRegionLocation, CommonSlideLocation, CommonImageRegionLocation, CommonSheetCellLocation, CommonBoundingBox, CommonFactValue, CommonNumberValue, CommonQuantityValue, CommonTextValue, CommonBooleanValue, CommonDateValue, CommonReferenceValue, CommonEnumValue, CommonTimeQualifier, CommonQualifiers, CommonExtensionBag, CommonAgentProvenance, CommonScope } from './common.ts';

export type EvidenceSnapshotEntity = {
  entityId: CommonIdentifier;
  entityType: "organization" | "product" | "person" | "location" | "event" | "metric" | "other";
  label: string;
  aliases?: Array<string>;
  extensions?: CommonExtensionBag;
};

export type EvidenceSnapshotClaim = {
  claimId: CommonIdentifier;
  claimVersionId: CommonIdentifier;
  entityId: CommonIdentifier;
  predicate: CommonPredicate;
  value: CommonFactValue;
  qualifiers?: CommonQualifiers;
  supportStatus: CommonSupportStatus;
  reviewStatus: CommonReviewStatus;
  evidenceRefs: Array<CommonIdentifier>;
  conflictGroupId?: CommonIdentifier;
  note?: string;
  extensions?: CommonExtensionBag;
};

export type EvidenceSnapshotEvidenceEntry = {
  evidenceId: CommonIdentifier;
  documentId: CommonDocumentId;
  documentVersionId: CommonIdentifier;
  blockId: CommonBlockId;
  locator: CommonSourceLocation;
  excerpt: string;
  confidence?: "high" | "medium" | "low";
  extensions?: CommonExtensionBag;
};

export type EvidenceSnapshotRelation = {
  relationId: CommonIdentifier;
  fromEntityId: CommonIdentifier;
  toEntityId: CommonIdentifier;
  relationType: CommonPredicate;
  evidenceRefs: Array<CommonIdentifier>;
};

export type EvidenceSnapshotEvent = {
  eventId: CommonIdentifier;
  entityId: CommonIdentifier;
  eventType: CommonPredicate;
  time?: CommonTimeQualifier;
  description: string;
  evidenceRefs: Array<CommonIdentifier>;
};

export type EvidenceSnapshotAsset = {
  assetId: CommonIdentifier;
  documentId: CommonDocumentId;
  documentVersionId: CommonIdentifier;
  blockId: CommonBlockId;
  location: CommonSourceLocation;
  description: string;
};

export type EvidenceSnapshotConflict = {
  conflictId: CommonIdentifier;
  claimRefs: Array<CommonIdentifier>;
  description: string;
  resolutionStatus: "open" | "resolved" | "deferred";
};

export type EvidenceSnapshotMissing = {
  missingId: CommonIdentifier;
  expectedPredicate?: CommonPredicate;
  entityId?: CommonIdentifier;
  description: string;
  severity: CommonSeverity;
};

export type EvidenceSnapshotCoverage = {
  documentsProcessed: Array<EvidenceSnapshotDocumentCoverage>;
  unsupported?: Array<EvidenceSnapshotUnsupportedContent>;
};

export type EvidenceSnapshotDocumentCoverage = {
  documentId: CommonDocumentId;
  documentVersionId: CommonIdentifier;
  blockIds: Array<CommonBlockId>;
};

export type EvidenceSnapshotUnsupportedContent = {
  documentId: CommonDocumentId;
  blockId: CommonBlockId;
  reason: string;
};

export interface EvidenceSnapshot {
  protocolVersion: CommonProtocolVersion;
  snapshotId: CommonSnapshotId;
  snapshotVersionId: CommonIdentifier;
  projectId: CommonProjectId;
  taskId: CommonTaskId;
  attemptId: CommonAttemptId;
  basedOnSnapshotVersionId?: CommonIdentifier;
  entities: Array<EvidenceSnapshotEntity>;
  claims: Array<EvidenceSnapshotClaim>;
  evidence: Array<EvidenceSnapshotEvidenceEntry>;
  relations?: Array<EvidenceSnapshotRelation>;
  events?: Array<EvidenceSnapshotEvent>;
  assets?: Array<EvidenceSnapshotAsset>;
  conflicts: Array<EvidenceSnapshotConflict>;
  missing: Array<EvidenceSnapshotMissing>;
  coverage: EvidenceSnapshotCoverage;
  reviewStatus: CommonReviewStatus;
  producedBy: CommonAgentProvenance;
  createdAt: CommonTimestamp;
  extensions?: CommonExtensionBag;
}
