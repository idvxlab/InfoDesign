// 自动生成，请勿手动修改。
// 来源：packages/contracts/schemas
import type { CommonProtocolVersion, CommonIdentifier, CommonPredicate, CommonProjectId, CommonTaskId, CommonAttemptId, CommonDocumentId, CommonBlockId, CommonSnapshotId, CommonReportId, CommonContentHash, CommonTimestamp, CommonDate, CommonTaskType, CommonStage, CommonSupportStatus, CommonReviewStatus, CommonAgentOutputStatus, CommonReviewMode, CommonReviewVerdict, CommonCheckType, CommonCheckStatus, CommonSeverity, CommonSuggestedStage, CommonAllowedOperation, CommonDocumentVersionRef, CommonSourceLocation, CommonParagraphLocation, CommonTableCellLocation, CommonPageRegionLocation, CommonSlideLocation, CommonImageRegionLocation, CommonSheetCellLocation, CommonBoundingBox, CommonFactValue, CommonNumberValue, CommonQuantityValue, CommonTextValue, CommonBooleanValue, CommonDateValue, CommonReferenceValue, CommonEnumValue, CommonTimeQualifier, CommonQualifiers, CommonExtensionBag, CommonAgentProvenance, CommonScope } from './common.ts';
import type { DesignReviewRef } from './design-review-ref.ts';

export interface InformationPlan {
  protocolVersion: "1.0";
  projectId: CommonProjectId;
  taskId: CommonTaskId;
  attemptId: CommonAttemptId;
  snapshotRef: {
  snapshotId: CommonSnapshotId;
  snapshotVersionId: CommonIdentifier;
  contentHash: CommonContentHash;
};
  producedBy: {
  role: "design";
  protocolVersion: "1.0";
};
  createdAt: CommonTimestamp;
  planId: CommonIdentifier;
  planVersionId: CommonIdentifier;
  audience: {
  role: string;
  needs: Array<string>;
};
  goal: string;
  readerQuestions: Array<{
  questionId: CommonIdentifier;
  text: string;
}>;
  sections: Array<{
  sectionId: CommonIdentifier;
  title: string;
  purpose: string;
  questionIds: Array<CommonIdentifier>;
  sourceRefs: Array<{
  kind: "claim" | "entity" | "relation" | "event" | "asset";
  id: CommonIdentifier;
}>;
  priority: "primary" | "secondary";
  presentationIntent: string;
  selectionReason: string;
}>;
  omissions: Array<{
  sourceRefs: Array<{
  kind: "claim" | "entity" | "relation" | "event" | "asset";
  id: CommonIdentifier;
}>;
  reason: string;
}>;
  openIssues: Array<{
  issueId: CommonIdentifier;
  kind: "missing_input" | "conflict" | "uncertainty";
  description: string;
}>;
  reviewRef?: DesignReviewRef;
}
