// 自动生成，请勿手动修改。
// 来源：packages/contracts/schemas
import type { CommonProtocolVersion, CommonIdentifier, CommonPredicate, CommonProjectId, CommonTaskId, CommonAttemptId, CommonDocumentId, CommonBlockId, CommonSnapshotId, CommonReportId, CommonContentHash, CommonTimestamp, CommonDate, CommonTaskType, CommonStage, CommonSupportStatus, CommonReviewStatus, CommonAgentOutputStatus, CommonReviewMode, CommonReviewVerdict, CommonCheckType, CommonCheckStatus, CommonSeverity, CommonSuggestedStage, CommonAllowedOperation, CommonDocumentVersionRef, CommonSourceLocation, CommonParagraphLocation, CommonTableCellLocation, CommonPageRegionLocation, CommonSlideLocation, CommonImageRegionLocation, CommonSheetCellLocation, CommonBoundingBox, CommonFactValue, CommonNumberValue, CommonQuantityValue, CommonTextValue, CommonBooleanValue, CommonDateValue, CommonReferenceValue, CommonEnumValue, CommonTimeQualifier, CommonQualifiers, CommonExtensionBag, CommonAgentProvenance, CommonScope } from './common.ts';

export interface ReadSourceResult {
  projectId: CommonProjectId;
  documentId: CommonDocumentId;
  documentVersionId: CommonIdentifier;
  blockId: CommonBlockId;
  contentHash: CommonContentHash;
  blockType: "heading" | "paragraph" | "list" | "table" | "caption" | "image" | "other";
  text: string;
  location: CommonSourceLocation;
  status: string;
  semanticStatus?: "not_run";
  asset: null | {
  assetKind: string;
  path: string;
  sha256: CommonContentHash;
  bytes: number;
  blockId: CommonBlockId;
};
  table: null | {
  status: "candidate_not_reviewed";
  sourceHash: CommonContentHash;
  tablePath: string;
  rows: Array<Array<string | null>>;
  cells: Array<{
  row: number;
  column: number;
  text: string | null;
  location: CommonSourceLocation;
}>;
  warnings: Array<string>;
};
  limitations: Array<string>;
  unsupportedReasons: Array<string>;
}
