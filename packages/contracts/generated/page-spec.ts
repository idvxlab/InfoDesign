// 自动生成，请勿手动修改。
// 来源：packages/contracts/schemas
import type { CommonProtocolVersion, CommonIdentifier, CommonPredicate, CommonProjectId, CommonTaskId, CommonAttemptId, CommonDocumentId, CommonBlockId, CommonSnapshotId, CommonReportId, CommonContentHash, CommonTimestamp, CommonDate, CommonTaskType, CommonStage, CommonSupportStatus, CommonReviewStatus, CommonAgentOutputStatus, CommonReviewMode, CommonReviewVerdict, CommonCheckType, CommonCheckStatus, CommonSeverity, CommonSuggestedStage, CommonAllowedOperation, CommonDocumentVersionRef, CommonSourceLocation, CommonParagraphLocation, CommonTableCellLocation, CommonPageRegionLocation, CommonSlideLocation, CommonImageRegionLocation, CommonSheetCellLocation, CommonBoundingBox, CommonFactValue, CommonNumberValue, CommonQuantityValue, CommonTextValue, CommonBooleanValue, CommonDateValue, CommonReferenceValue, CommonEnumValue, CommonTimeQualifier, CommonQualifiers, CommonExtensionBag, CommonAgentProvenance, CommonScope } from './common.ts';
import type { DesignReviewRef } from './design-review-ref.ts';

export type PageSpecNode = {
  nodeId: CommonIdentifier;
  planSectionId: CommonIdentifier;
  componentRef: {
  id: "fact_text";
  version: "0.1.0";
};
  props: {
  title?: string;
  headingLevel?: number;
};
  bindings: {
  body: {
  kind: "claimValue";
  claimRef: {
  kind: "claim";
  id: CommonIdentifier;
  claimVersionId: CommonIdentifier;
};
  format: {
  unit: "source";
  qualifiers: "visible";
};
};
};
  events: {
  sourceRequested: CommonIdentifier;
};
} | {
  nodeId: CommonIdentifier;
  planSectionId: CommonIdentifier;
  componentRef: {
  id: "comparison_matrix";
  version: "0.1.0";
};
  props: {
  title: string;
  headingLevel: number;
  missingValueLabel: "资料未提供";
  ranking: "none";
};
  bindings: {
  rows: {
  kind: "comparisonRows";
  columns: Array<{
  columnId: CommonIdentifier;
  label: string;
  predicate: CommonPredicate;
}>;
  items: Array<{
  rowId: CommonIdentifier;
  entityRef: {
  kind: "entity";
  id: CommonIdentifier;
};
  cells: Array<{
  columnId: CommonIdentifier;
  claimRef: {
  kind: "claim";
  id: CommonIdentifier;
  claimVersionId: CommonIdentifier;
};
  format: {
  unit: "source";
  qualifiers: "visible";
};
}>;
}>;
};
};
  responsive: {
  small: {
  mode: "cards";
};
  large: {
  mode: "table";
};
};
  events: {
  sourceRequested: CommonIdentifier;
};
} | {
  nodeId: CommonIdentifier;
  planSectionId: CommonIdentifier;
  componentRef: {
  id: "disclosure";
  version: "0.1.0";
};
  props: {
  title: string;
  headingLevel: number;
  expandLabel: string;
  collapseLabel: string;
};
  bindings: {
  expanded: {
  kind: "state";
  stateId: CommonIdentifier;
};
};
  events: {
  toggleRequested: CommonIdentifier;
};
  children: Array<PageSpecNode>;
};

export interface PageSpec {
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
  pageSpecId: CommonIdentifier;
  pageSpecVersionId: CommonIdentifier;
  informationPlanRef: {
  planId: CommonIdentifier;
  planVersionId: CommonIdentifier;
  contentHash: CommonContentHash;
};
  componentCatalogRef: {
  catalogId: CommonIdentifier;
  version: string;
  contentHash: CommonContentHash;
};
  themeRef: {
  themeId: CommonIdentifier;
  version: string;
  contentHash: CommonContentHash;
};
  state: Array<{
  stateId: CommonIdentifier;
  type: "boolean";
  initialValue: boolean;
}>;
  root: {
  nodeId: CommonIdentifier;
  componentRef: {
  id: "page";
  version: "0.1.0";
};
  props: {
  lang: "zh-CN" | "en";
};
  layout: {
  type: "stack";
  gapToken: CommonIdentifier;
  widthToken: CommonIdentifier;
};
  children: Array<PageSpecNode>;
};
  actions: Array<{
  actionId: CommonIdentifier;
  type: "toggleBoolean";
  sourceNodeId: CommonIdentifier;
  targetStateId: CommonIdentifier;
} | {
  actionId: CommonIdentifier;
  type: "openEvidence";
  sourceNodeId: CommonIdentifier;
  target: {
  kind: "claim";
  id: CommonIdentifier;
  claimVersionId: CommonIdentifier;
} | {
  kind: "eventBoundClaim";
  bindingSlot: "rows";
};
}>;
  checks: Array<{
  type: "visibleQualifiers";
  nodeId: CommonIdentifier;
  bindingSlot: "rows";
} | {
  type: "evidenceResolvable";
  nodeIds: Array<CommonIdentifier>;
} | {
  type: "toggleRoundTrip";
  nodeId: CommonIdentifier;
  stateId: CommonIdentifier;
}>;
  reviewRef?: DesignReviewRef;
}
