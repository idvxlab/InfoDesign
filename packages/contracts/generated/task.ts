// 自动生成，请勿手动修改。
// 来源：packages/contracts/schemas
import type { CommonProtocolVersion, CommonIdentifier, CommonPredicate, CommonProjectId, CommonTaskId, CommonAttemptId, CommonDocumentId, CommonBlockId, CommonSnapshotId, CommonReportId, CommonContentHash, CommonTimestamp, CommonDate, CommonTaskType, CommonStage, CommonSupportStatus, CommonReviewStatus, CommonAgentOutputStatus, CommonReviewMode, CommonReviewVerdict, CommonCheckType, CommonCheckStatus, CommonSeverity, CommonSuggestedStage, CommonAllowedOperation, CommonDocumentVersionRef, CommonSourceLocation, CommonParagraphLocation, CommonTableCellLocation, CommonPageRegionLocation, CommonSlideLocation, CommonImageRegionLocation, CommonSheetCellLocation, CommonBoundingBox, CommonFactValue, CommonNumberValue, CommonQuantityValue, CommonTextValue, CommonBooleanValue, CommonDateValue, CommonReferenceValue, CommonEnumValue, CommonTimeQualifier, CommonQualifiers, CommonExtensionBag, CommonAgentProvenance, CommonScope } from './common.ts';

export type TaskBaseVersionRef = {
  artifactType: "snapshot";
  artifactId: CommonIdentifier;
  versionId: CommonIdentifier;
  contentHash?: CommonContentHash;
};

export type TaskInputRef = {
  refType: "document" | "snapshot";
  refId: CommonIdentifier;
  versionId?: CommonIdentifier;
  contentHash?: CommonContentHash;
};

export type TaskConstraints = {
  preserveFacts: boolean;
  forbiddenNewFacts: boolean;
  immutableNodeIds?: Array<CommonIdentifier>;
  brand?: string;
  notes?: string;
};

export interface Task {
  protocolVersion: CommonProtocolVersion;
  taskId: CommonTaskId;
  attemptId: CommonAttemptId;
  projectId: CommonProjectId;
  taskType: CommonTaskType;
  stage: CommonStage;
  userIntent: string;
  baseVersions: Array<TaskBaseVersionRef>;
  inputRefs: Array<TaskInputRef>;
  targetNodeIds?: Array<CommonIdentifier>;
  constraints: TaskConstraints;
  executionPolicyRef: CommonIdentifier;
  createdAt: CommonTimestamp;
  extensions?: CommonExtensionBag;
}
