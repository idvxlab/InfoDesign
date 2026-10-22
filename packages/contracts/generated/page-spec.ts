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
  style?: PageSpecStyle;
  accessibility?: PageSpecAccessibility;
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
  style?: PageSpecStyle;
  accessibility?: PageSpecAccessibility;
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
  style?: PageSpecStyle;
  accessibility?: PageSpecAccessibility;
} | {
  nodeId: CommonIdentifier;
  planSectionId: CommonIdentifier;
  componentRef: {
  id: "section";
  version: "0.1.0";
};
  props: {
  title: string;
  headingLevel: number;
};
  bindings: Record<string, unknown>;
  layout: PageSpecLayout;
  children: Array<PageSpecNode>;
  style?: PageSpecStyle;
  accessibility?: PageSpecAccessibility;
} | {
  nodeId: CommonIdentifier;
  planSectionId: CommonIdentifier;
  componentRef: {
  id: "narrative";
  version: "0.1.0";
};
  props: {
  title?: string;
  headingLevel?: number;
};
  bindings: {
  paragraphs: Array<{
  paragraphId: CommonIdentifier;
  text: string;
  sourceRefs: Array<PageSpecSourceRef>;
}>;
};
  events: {
  sourceRequested: CommonIdentifier;
};
  style?: PageSpecStyle;
  accessibility?: PageSpecAccessibility;
} | {
  nodeId: CommonIdentifier;
  planSectionId: CommonIdentifier;
  componentRef: {
  id: "asset_image";
  version: "0.1.0";
};
  props: {
  alt: string;
  fit: "contain" | "cover";
};
  bindings: {
  asset: {
  kind: "asset";
  id: CommonIdentifier;
};
};
  events: {
  sourceRequested: CommonIdentifier;
};
  style?: PageSpecStyle;
  accessibility?: PageSpecAccessibility;
} | {
  nodeId: CommonIdentifier;
  planSectionId: CommonIdentifier;
  componentRef: {
  id: "timeline";
  version: "0.1.0";
};
  props: {
  title: string;
  headingLevel: number;
  order: "source" | "ascending" | "descending";
  missingTime: "separate";
};
  bindings: {
  items: Array<{
  itemId: CommonIdentifier;
  eventRef: {
  kind: "event";
  id: CommonIdentifier;
};
}>;
};
  events: {
  sourceRequested: CommonIdentifier;
};
  style?: PageSpecStyle;
  accessibility?: PageSpecAccessibility;
} | {
  nodeId: CommonIdentifier;
  planSectionId: CommonIdentifier;
  componentRef: {
  id: "relation_graph";
  version: "0.1.0";
};
  props: {
  title: string;
  headingLevel: number;
  direction: "leftToRight" | "topToBottom";
};
  bindings: {
  edges: Array<{
  edgeId: CommonIdentifier;
  relationRef: {
  kind: "relation";
  id: CommonIdentifier;
};
}>;
};
  events: {
  sourceRequested: CommonIdentifier;
};
  style?: PageSpecStyle;
  accessibility?: PageSpecAccessibility;
} | {
  nodeId: CommonIdentifier;
  planSectionId: CommonIdentifier;
  componentRef: {
  id: "bar_chart";
  version: "0.1.0";
};
  props: {
  title: string;
  headingLevel: number;
  baseline: "zero";
  missingValue: "omit";
};
  bindings: {
  points: Array<{
  pointId: CommonIdentifier;
  claimRef: {
  kind: "claim";
  id: CommonIdentifier;
  claimVersionId: CommonIdentifier;
};
}>;
};
  events: {
  sourceRequested: CommonIdentifier;
};
  style?: PageSpecStyle;
  accessibility?: PageSpecAccessibility;
} | {
  nodeId: CommonIdentifier;
  planSectionId: CommonIdentifier;
  componentRef: {
  id: "tabs";
  version: "0.1.0";
};
  props: {
  title: string;
  headingLevel: number;
};
  bindings: {
  selected: {
  kind: "state";
  stateId: CommonIdentifier;
};
  items: Array<{
  value: CommonIdentifier;
  label: string;
  childNodeId: CommonIdentifier;
}>;
};
  events: {
  selectionRequested: CommonIdentifier;
};
  children: Array<PageSpecNode>;
  style?: PageSpecStyle;
  accessibility?: PageSpecAccessibility;
} | {
  nodeId: CommonIdentifier;
  planSectionId: CommonIdentifier;
  componentRef: {
  id: "derived_value";
  version: "0.1.0";
};
  props: {
  label: "相对变化率";
};
  bindings: {
  derived: {
  calculationId: CommonIdentifier;
  showInputs: true;
};
};
  events: {
  sourceRequested: CommonIdentifier;
};
};

export type PageSpecLegacyNode = {
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
  children: Array<PageSpecLegacyNode>;
};

export type PageSpecSourceRef = {
  kind: "claim";
  id: CommonIdentifier;
  claimVersionId: CommonIdentifier;
} | {
  kind: "event";
  id: CommonIdentifier;
} | {
  kind: "relation";
  id: CommonIdentifier;
} | {
  kind: "asset";
  id: CommonIdentifier;
};

export type PageSpecLayout = {
  type: "stack";
  gapToken: CommonIdentifier;
  widthToken: CommonIdentifier;
} | {
  type: "grid";
  columns: number;
  gapToken: CommonIdentifier;
  widthToken: CommonIdentifier;
} | {
  type: "split";
  ratio: "1:1" | "1:2" | "2:1";
  gapToken: CommonIdentifier;
  widthToken: CommonIdentifier;
};

export type PageSpecStyle = {
  colorToken?: CommonIdentifier;
  backgroundToken?: CommonIdentifier;
  typographyToken?: CommonIdentifier;
  paddingToken?: CommonIdentifier;
  borderToken?: CommonIdentifier;
  radiusToken?: CommonIdentifier;
};

export type PageSpecAccessibility = {
  label?: string;
  description?: string;
  role?: "region" | "group" | "figure";
  headingLevel?: number;
};

export type PageSpecResponsiveLayout = {
  small: PageSpecLayout;
  large: PageSpecLayout;
};

export interface PageSpec {
  protocolVersion: "1.0" | "1.1";
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
} | {
  stateId: CommonIdentifier;
  type: "enum";
  allowedValues: Array<CommonIdentifier>;
  initialValue: CommonIdentifier;
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
  layout: PageSpecLayout;
  children: Array<PageSpecNode>;
  responsiveLayout?: PageSpecResponsiveLayout;
  style?: PageSpecStyle;
  accessibility?: PageSpecAccessibility;
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
} | {
  kind: "eventBoundSource";
  bindingSlot: "paragraphs" | "asset" | "items" | "edges" | "points" | "derived";
};
} | {
  actionId: CommonIdentifier;
  type: "selectValue";
  sourceNodeId: CommonIdentifier;
  targetStateId: CommonIdentifier;
  valueFrom: "event.value";
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
} | {
  type: "semanticFidelity";
  nodeId: CommonIdentifier;
} | {
  type: "assetAvailable";
  nodeId: CommonIdentifier;
} | {
  type: "timelineOrder";
  nodeId: CommonIdentifier;
} | {
  type: "relationIntegrity";
  nodeId: CommonIdentifier;
} | {
  type: "chartComparability";
  nodeId: CommonIdentifier;
} | {
  type: "selectionRoundTrip";
  nodeId: CommonIdentifier;
} | {
  type: "derivedInputs";
  nodeId: CommonIdentifier;
} | {
  type: "responsiveLayout";
  nodeIds: Array<CommonIdentifier>;
  viewports: Array<"small" | "large">;
} | {
  type: "keyboardAccess";
  nodeIds: Array<CommonIdentifier>;
}>;
  reviewRef?: DesignReviewRef;
  calculations?: Array<{
  calculationId: CommonIdentifier;
  method: "percentChange";
  base: {
  kind: "claim";
  id: CommonIdentifier;
  claimVersionId: CommonIdentifier;
};
  current: {
  kind: "claim";
  id: CommonIdentifier;
  claimVersionId: CommonIdentifier;
};
  unit: "%";
}>;
}
