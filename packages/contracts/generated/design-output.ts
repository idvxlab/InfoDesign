// 自动生成，请勿手动修改。
// 来源：packages/contracts/schemas
import type { CommonProtocolVersion, CommonIdentifier, CommonPredicate, CommonProjectId, CommonTaskId, CommonAttemptId, CommonDocumentId, CommonBlockId, CommonSnapshotId, CommonReportId, CommonContentHash, CommonTimestamp, CommonDate, CommonTaskType, CommonStage, CommonSupportStatus, CommonReviewStatus, CommonAgentOutputStatus, CommonReviewMode, CommonReviewVerdict, CommonCheckType, CommonCheckStatus, CommonSeverity, CommonSuggestedStage, CommonAllowedOperation, CommonDocumentVersionRef, CommonSourceLocation, CommonParagraphLocation, CommonTableCellLocation, CommonPageRegionLocation, CommonSlideLocation, CommonImageRegionLocation, CommonSheetCellLocation, CommonBoundingBox, CommonFactValue, CommonNumberValue, CommonQuantityValue, CommonTextValue, CommonBooleanValue, CommonDateValue, CommonReferenceValue, CommonEnumValue, CommonTimeQualifier, CommonQualifiers, CommonExtensionBag, CommonAgentProvenance, CommonScope } from './common.ts';
import type { DesignReviewRef } from './design-review-ref.ts';
import type { InformationPlan } from './information-plan.ts';
import type { PageSpec, PageSpecNode, PageSpecLegacyNode, PageSpecSourceRef, PageSpecLayout, PageSpecStyle, PageSpecAccessibility, PageSpecResponsiveLayout } from './page-spec.ts';

export interface DesignOutput {
  protocolVersion: "1.0";
  projectId: CommonProjectId;
  taskId: CommonTaskId;
  attemptId: CommonAttemptId;
  inputHash: CommonContentHash;
  status: CommonAgentOutputStatus;
  informationPlan?: InformationPlan;
  pageSpec?: PageSpec;
  requirements?: Array<{
  kind: "information" | "component";
  description: string;
}>;
  stopReason?: string;
  producedBy: {
  role: "design";
  protocolVersion: "1.0";
};
  reviewRef?: DesignReviewRef;
}
