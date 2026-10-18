// 自动生成，请勿手动修改。
// 来源：packages/contracts/schemas
import type { CommonProtocolVersion, CommonIdentifier, CommonPredicate, CommonProjectId, CommonTaskId, CommonAttemptId, CommonDocumentId, CommonBlockId, CommonSnapshotId, CommonReportId, CommonContentHash, CommonTimestamp, CommonDate, CommonTaskType, CommonStage, CommonSupportStatus, CommonReviewStatus, CommonAgentOutputStatus, CommonReviewMode, CommonReviewVerdict, CommonCheckType, CommonCheckStatus, CommonSeverity, CommonSuggestedStage, CommonAllowedOperation, CommonDocumentVersionRef, CommonSourceLocation, CommonParagraphLocation, CommonTableCellLocation, CommonPageRegionLocation, CommonSlideLocation, CommonImageRegionLocation, CommonSheetCellLocation, CommonBoundingBox, CommonFactValue, CommonNumberValue, CommonQuantityValue, CommonTextValue, CommonBooleanValue, CommonDateValue, CommonReferenceValue, CommonEnumValue, CommonTimeQualifier, CommonQualifiers, CommonExtensionBag, CommonAgentProvenance, CommonScope } from './common.ts';
import type { DesignReviewRef } from './design-review-ref.ts';
import type { EvidenceSnapshot, EvidenceSnapshotEntity, EvidenceSnapshotClaim, EvidenceSnapshotEvidenceEntry, EvidenceSnapshotRelation, EvidenceSnapshotEvent, EvidenceSnapshotAsset, EvidenceSnapshotConflict, EvidenceSnapshotMissing, EvidenceSnapshotCoverage, EvidenceSnapshotDocumentCoverage, EvidenceSnapshotUnsupportedContent } from './evidence-snapshot.ts';

export interface DesignInput {
  protocolVersion: "1.0";
  projectId: CommonProjectId;
  taskId: CommonTaskId;
  attemptId: CommonAttemptId;
  taskType: "generate";
  snapshot: EvidenceSnapshot;
  snapshotRef: {
  snapshotId: CommonSnapshotId;
  snapshotVersionId: CommonIdentifier;
  contentHash: CommonContentHash;
};
  audience: {
  role: string;
  needs: Array<string>;
};
  goal: string;
  visualGuidance: Array<string>;
  constraints: {
  language: "zh-CN" | "en";
  maxSections: number;
  maxNodes: number;
};
  catalog: {
  catalogId: CommonIdentifier;
  version: string;
  contentHash: CommonContentHash;
  components: Array<{
  id: "page" | "fact_text" | "comparison_matrix" | "disclosure";
  version: "0.1.0";
}>;
};
  theme: {
  themeId: CommonIdentifier;
  version: string;
  contentHash: CommonContentHash;
  tokens: Array<CommonIdentifier>;
};
  reviewRef?: DesignReviewRef;
}
