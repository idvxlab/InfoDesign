// 自动生成，请勿手动修改。
// 来源：packages/contracts/schemas
import type { CommonProtocolVersion, CommonIdentifier, CommonPredicate, CommonProjectId, CommonTaskId, CommonAttemptId, CommonDocumentId, CommonBlockId, CommonSnapshotId, CommonReportId, CommonContentHash, CommonTimestamp, CommonDate, CommonTaskType, CommonStage, CommonSupportStatus, CommonReviewStatus, CommonAgentOutputStatus, CommonReviewMode, CommonReviewVerdict, CommonCheckType, CommonCheckStatus, CommonSeverity, CommonSuggestedStage, CommonAllowedOperation, CommonDocumentVersionRef, CommonSourceLocation, CommonParagraphLocation, CommonTableCellLocation, CommonPageRegionLocation, CommonSlideLocation, CommonImageRegionLocation, CommonSheetCellLocation, CommonBoundingBox, CommonFactValue, CommonNumberValue, CommonQuantityValue, CommonTextValue, CommonBooleanValue, CommonDateValue, CommonReferenceValue, CommonEnumValue, CommonTimeQualifier, CommonQualifiers, CommonExtensionBag, CommonAgentProvenance, CommonScope } from './common.ts';

export type DocumentIrBlock = {
  blockId: CommonBlockId;
  index: number;
  type: "heading" | "paragraph" | "list" | "table" | "caption" | "image" | "other";
  text: string;
  location: CommonSourceLocation;
  parentBlockId?: CommonBlockId;
  extensions?: CommonExtensionBag;
};

export type DocumentIrParseInfo = {
  parser: string;
  quality: "complete" | "partial" | "low_confidence";
  unsupported?: Array<DocumentIrUnsupportedContent>;
};

export type DocumentIrUnsupportedContent = {
  blockId: CommonBlockId;
  reason: string;
};

export interface DocumentIr {
  protocolVersion: CommonProtocolVersion;
  documentId: CommonDocumentId;
  documentVersionId: CommonIdentifier;
  projectId: CommonProjectId;
  version: number;
  contentHash: CommonContentHash;
  mimeType: string;
  sourceName: string;
  language?: string;
  createdAt?: CommonTimestamp;
  blocks: Array<DocumentIrBlock>;
  parseInfo?: DocumentIrParseInfo;
  extensions?: CommonExtensionBag;
}
