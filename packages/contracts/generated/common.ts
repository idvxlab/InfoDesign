// 自动生成，请勿手动修改。
// 来源：packages/contracts/schemas
export type CommonProtocolVersion = string;

export type CommonIdentifier = string;

export type CommonPredicate = string;

export type CommonProjectId = string;

export type CommonTaskId = string;

export type CommonAttemptId = string;

export type CommonDocumentId = string;

export type CommonBlockId = string;

export type CommonSnapshotId = string;

export type CommonReportId = string;

export type CommonContentHash = string;

export type CommonTimestamp = string;

export type CommonDate = string;

export type CommonTaskType = "generate" | "revise" | "update_facts";

export type CommonStage = "facts";

export type CommonSupportStatus = "supported" | "conflicted" | "missing_evidence" | "pending";

export type CommonReviewStatus = "pending" | "passed" | "needs_revision" | "indeterminate";

export type CommonAgentOutputStatus = "completed" | "needs_information" | "blocked" | "failed";

export type CommonReviewMode = "fact";

export type CommonReviewVerdict = "pass" | "revise" | "needs_input";

export type CommonCheckType = "support" | "entity_match" | "value" | "unit" | "time" | "basis" | "source_locator" | "missing" | "conflict" | "traceability";

export type CommonCheckStatus = "pass" | "fail" | "not_run" | "not_applicable";

export type CommonSeverity = "info" | "warning" | "error" | "critical";

export type CommonSuggestedStage = "facts_extraction" | "facts_review" | "needs_input" | "abort";

export type CommonAllowedOperation = "read_document" | "read_evidence" | "submit_candidate" | "submit_report" | "check_source" | "compare_versions";

export type CommonDocumentVersionRef = {
  documentId: CommonDocumentId;
  documentVersionId: CommonIdentifier;
};

export type CommonSourceLocation = CommonParagraphLocation | CommonTableCellLocation | CommonPageRegionLocation | CommonSlideLocation | CommonImageRegionLocation | CommonSheetCellLocation;

export type CommonParagraphLocation = {
  kind: "paragraph";
  paragraphIndex: number;
  charStart?: number;
  charEnd?: number;
};

export type CommonTableCellLocation = {
  kind: "table_cell";
  tableId: CommonIdentifier;
  row: number;
  column: number;
  cellRef?: string;
};

export type CommonPageRegionLocation = {
  kind: "page_region";
  page: number;
  bbox: CommonBoundingBox;
};

export type CommonSlideLocation = {
  kind: "slide";
  slideIndex: number;
  objectId?: string;
};

export type CommonImageRegionLocation = {
  kind: "image_region";
  page: number;
  bbox: CommonBoundingBox;
};

export type CommonSheetCellLocation = {
  kind: "sheet_cell";
  sheet: string;
  cell: string;
  headerRange?: string;
};

export type CommonBoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type CommonFactValue = CommonNumberValue | CommonQuantityValue | CommonTextValue | CommonBooleanValue | CommonDateValue | CommonReferenceValue | CommonEnumValue;

export type CommonNumberValue = {
  type: "number";
  normalized: number;
  unit?: string | null;
  raw?: string;
};

export type CommonQuantityValue = {
  type: "quantity";
  normalized: number;
  unit: string;
  raw?: string;
};

export type CommonTextValue = {
  type: "text";
  text: string;
  raw?: string;
};

export type CommonBooleanValue = {
  type: "boolean";
  value: boolean;
  raw?: string;
};

export type CommonDateValue = {
  type: "date";
  date: CommonDate;
  raw?: string;
};

export type CommonReferenceValue = {
  type: "reference";
  refId: CommonIdentifier;
  refType: "entity" | "product" | "event" | "document" | "asset";
  raw?: string;
};

export type CommonEnumValue = {
  type: "enum";
  option: string;
  raw?: string;
};

export type CommonTimeQualifier = {
  year?: number;
  period?: string;
  asOf?: CommonTimestamp;
};

export type CommonQualifiers = {
  time?: CommonTimeQualifier;
  basis?: string;
  scope?: string;
  measure?: string;
};

export type CommonExtensionBag = Record<string, string | number | boolean | null>;

export type CommonAgentProvenance = {
  role: "evidence" | "review" | "design" | "component_engineer";
  model?: string;
  sessionId?: CommonIdentifier;
  protocolVersion: CommonProtocolVersion;
  promptVersion?: string;
};

export type CommonScope = {
  projectId: CommonProjectId;
  documentRefs: Array<CommonDocumentVersionRef>;
  allowedOperations: Array<CommonAllowedOperation>;
};
