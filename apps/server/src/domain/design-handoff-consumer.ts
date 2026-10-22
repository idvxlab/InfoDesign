/**
 * 薄消费适配层：把可信交底核验结果转换为可交给设计模型的任务输入。
 * 授权、store、pins、目录、主题与设计目标均由独立可信调用方提供，
 * 绝不从被提交交接包反推。不提供 Shell/URL/网络/文件路径/任意回调能力。
 * 本层只读交接包与上下文，不写 store、不执行采纳。
 */
import type { SchemaRegistry } from '../../../../packages/contracts/src/schema-registry.ts';
import { fingerprint } from '../../../../packages/contracts/src/fingerprint.ts';
import {
  verifyDesignHandoff,
  DESIGN_HANDOFF_PACKAGE_VERSION,
  type DesignHandoffReadyPackage,
  type HandoffContextPins,
  type HandoffReason,
} from './design-handoff.ts';
import type { FactRunStore } from './fact-run.service.ts';
import {
  checkDesignInput,
  type DesignTaskContext,
} from '../../../../packages/contracts/src/design-agent-checks.ts';
import type { DesignContext } from '../../../../packages/contracts/src/design-checks.ts';
import type { CheckResult } from '../../../../packages/contracts/src/service-checks.ts';
import type { DesignInput, DesignReviewRef } from '../../../../packages/contracts/generated/index.ts';

/** 由独立可信调用方注入的设计侧可信上下文（不从 submitted 包读取）。 */
export interface HandoffConsumerTrustedContext {
  /** 设计任务身份，依据现有检查器实际契约提供。 */
  design: DesignContext;
  /**
   * 可选的输入指纹「期望钉」：仅当存在时，用于严格对照服务自行计算出的
   * fingerprint(input)。调用方无法提供真实指纹时省略；服务绝不使用任意
   * 传入值冒充真实输入指纹。
   */
  expectedInputHash?: string;
  /** 设计目标与受众等由可信调用方给定的输入片段。 */
  audience: DesignInput['audience'];
  goal: DesignInput['goal'];
  visualGuidance: string[];
  constraints: DesignInput['constraints'];
}

export interface HandoffConsumptionSuccess {
  ok: true;
  /** 服务组装的复核关联引用（克隆，不与输入/上下文共享可变引用）。 */
  reviewRef: DesignReviewRef;
  /** 服务组装的待执行设计输入（克隆）。 */
  input: DesignInput;
  /** 独立的设计任务上下文（克隆）。 */
  context: DesignTaskContext;
  /** 既有检查器复核结果。 */
  check: CheckResult;
}

export interface HandoffConsumptionBlocked {
  ok: false;
  reasons: HandoffReason[];
}

export type HandoffConsumptionResult = HandoffConsumptionSuccess | HandoffConsumptionBlocked;

const fail = (code: string, message: string, path?: string): HandoffConsumptionBlocked => ({
  ok: false,
  reasons: [{ code, message, ...(path ? { path } : {}) }],
});

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}

const FINGERPRINT_RE = /^sha256:[0-9a-f]{64}$/;

/** 仅接受结构完整的 ready 包；结构合法不构成信任，仍需核验与绑定检查。 */
function isReadyPackage(value: unknown): value is DesignHandoffReadyPackage {
  return isObject(value) && value.kind === 'ready';
}

/**
 * 先核验 ready 包、版本、身份、候选/报告/绑定指纹、所需检查与允许文档；
 * 失败返回安全原因，不返回可消费设计任务，也不调用设计模型。
 * 成功才组装 reviewRef、DesignInput 与独立 DesignTaskContext，并复用既有 checkDesignInput。
 */
export function consumeDesignHandoff(
  submitted: unknown,
  store: FactRunStore,
  registry: SchemaRegistry,
  pins: HandoffContextPins,
  trusted: HandoffConsumerTrustedContext,
): HandoffConsumptionResult {
  // 1) 可信核验：复用真实四参数 verifyDesignHandoff 重新派生并规范化等值比较。
  //    不信任 submitted 自述、不自己构造假通过、不从提交包反推 store/pins 权限。
  const verified = verifyDesignHandoff(submitted, store, registry, pins);
  if (!verified.ok) {
    return {
      ok: false,
      reasons: verified.reasons.length
        ? verified.reasons
        : [{ code: 'consume.not_verified', message: '交接包未通过可信核验' }],
    };
  }
  if (!isReadyPackage(submitted)) {
    return fail('consume.not_ready', '提交包不是可消费的就绪包', 'kind');
  }

  const ready: DesignHandoffReadyPackage = submitted;

  // 2) 版本与身份范围校验（以独立 pins 为准，不以包内自述为准）。
  //    仅支持常量 1.0；拒绝 99.99 或任何未知版本。
  if (ready.packageVersion !== DESIGN_HANDOFF_PACKAGE_VERSION) {
    return fail('consume.package_version', '交接包版本不受支持', 'packageVersion');
  }
  const identity = ready.identity;
  if (!isObject(identity)) return fail('consume.identity_missing', '就绪包缺少身份块', 'identity');
  for (const field of ['runId', 'projectId', 'taskId', 'attemptId'] as const) {
    if (identity[field] !== pins[field]) {
      return fail('consume.identity_scope', '交接包身份超出可信范围', 'identity.' + field);
    }
  }
  if (pins.expectedCandidateVersionId !== null && identity.candidateVersionId !== pins.expectedCandidateVersionId) {
    return fail('consume.candidate_version', '候选版本与可信期望不一致', 'identity.candidateVersionId');
  }
  if (pins.expectedReportVersionId !== null && identity.reportVersionId !== pins.expectedReportVersionId) {
    return fail('consume.report_version', '报告版本与可信期望不一致', 'identity.reportVersionId');
  }

  // 3) 指纹存在性与一致性。
  //    identity 仅有 candidateFingerprint/reportFingerprint；bindingFingerprint
  //    仅存在于包根。绝无 identity.bindingFingerprint。
  for (const field of ['candidateFingerprint', 'reportFingerprint'] as const) {
    if (!FINGERPRINT_RE.test(String(identity[field] ?? ''))) {
      return fail('consume.fingerprint_shape', '身份指纹字段不合法', 'identity.' + field);
    }
  }
  if (!FINGERPRINT_RE.test(String(ready.bindingFingerprint ?? ''))) {
    return fail('consume.fingerprint_shape', '包级绑定指纹不合法', 'bindingFingerprint');
  }

  // 4) 所需检查集合：非空、无重复，且覆盖可信 pins 的要求。
  const checksRequired = ready.checksRequired;
  if (!Array.isArray(checksRequired) || checksRequired.length === 0) {
    return fail('consume.checks_empty', '所需检查集合为空', 'checksRequired');
  }
  if (new Set(checksRequired).size !== checksRequired.length) {
    return fail('consume.checks_duplicate', '所需检查集合存在重复', 'checksRequired');
  }
  const required = new Set(pins.checksRequired);
  for (const check of required) {
    if (!checksRequired.includes(check)) {
      return fail('consume.checks_missing', '缺少可信要求的检查类别', 'checksRequired');
    }
  }

  // 5) 允许文档：提交包文档必须落在可信允许集合内。
  const allowedDocs = new Set(pins.allowedDocumentRefs.map(d => `${d.documentId}@${d.documentVersionId}`));
  const documents = Array.isArray(ready.documents) ? ready.documents : [];
  for (const doc of documents) {
    if (!isObject(doc)) return fail('consume.document_shape', '文档引用结构非法', 'documents');
    if (!allowedDocs.has(`${doc.documentId}@${doc.documentVersionId}`)) {
      return fail('consume.document_forbidden', '文档引用超出可信允许范围', 'documents');
    }
  }

  // 6) 信任边界：结构与核验通过仍不等于授权；设计上下文必须由可信调用方提供，
  //    目录、主题、允许来源与快照指纹均来自独立可信上下文，不从包内自证。
  if (!trusted || !isObject(trusted.design)) {
    return fail('consume.context_missing', '缺少独立可信设计上下文');
  }
  const design = trusted.design;
  if (!FINGERPRINT_RE.test(String(design.snapshotHash ?? ''))) {
    return fail('consume.snapshot_hash_shape', '可信快照指纹不合法', 'design.snapshotHash');
  }
  for (const field of ['projectId', 'taskId', 'attemptId'] as const) {
    if (design[field] !== identity[field]) {
      return fail('consume.context_scope', '可信设计上下文与交接包身份不一致', 'design.' + field);
    }
  }
  // 快照指纹必须与真实候选指纹严格一致。候选指纹即幸存于包内 identity 的
  // candidateFingerprint；快照指纹来自独立可信上下文。二者相等才允许消费。
  if (design.snapshotHash !== identity.candidateFingerprint) {
    return fail('consume.candidate_fingerprint', '可信快照指纹与候选指纹不一致', 'candidateFingerprint');
  }

  // 7) 组装 reviewRef：仅取自核验后的 ready 身份与包根绑定指纹。
  const reviewRef: DesignReviewRef = {
    packageVersion: DESIGN_HANDOFF_PACKAGE_VERSION,
    runId: identity.runId,
    projectId: identity.projectId,
    taskId: identity.taskId,
    attemptId: identity.attemptId,
    candidateVersionId: identity.candidateVersionId,
    reportVersionId: identity.reportVersionId,
    candidateFingerprint: identity.candidateFingerprint,
    reportFingerprint: identity.reportFingerprint,
    bindingFingerprint: ready.bindingFingerprint,
    reviewVerdict: identity.reviewVerdict as DesignReviewRef['reviewVerdict'],
    stopReason: identity.stopReason as DesignReviewRef['stopReason'],
    checksRequired: [...checksRequired],
  };

  // 8) reviewRef 结构自身必须通过权威 Schema。
  const refCheck = registry.validate('urn:tju-mas:contracts:design-review-ref', reviewRef);
  if (!refCheck.valid) {
    return fail('consume.review_ref_schema', '复核关联引用不满足权威 Schema', 'reviewRef');
  }

  // 9) 组装 DesignInput：所有可变字段克隆自可信来源/核验快照，避免与
  //    submitted/trusted 共享可变引用。
  const snapshot = structuredClone(ready.evidenceOutput.candidateSnapshot) as unknown as DesignInput['snapshot'];
  const input = {
    protocolVersion: '1.0',
    projectId: identity.projectId,
    taskId: identity.taskId,
    attemptId: identity.attemptId,
    taskType: 'generate',
    snapshot,
    snapshotRef: {
      snapshotId: snapshot.snapshotId,
      snapshotVersionId: snapshot.snapshotVersionId,
      contentHash: design.snapshotHash,
    },
    reviewRef: structuredClone(reviewRef),
    audience: structuredClone(trusted.audience),
    goal: trusted.goal,
    visualGuidance: [...trusted.visualGuidance],
    constraints: structuredClone(trusted.constraints),
    catalog: structuredClone(design.catalog),
    theme: structuredClone(design.theme),
    ...(design.pageSpecVersion ? { pageSpecVersion: design.pageSpecVersion } : {}),
    ...(design.resources ? { resources: structuredClone(design.resources) } : {}),
  } as DesignInput;

  // 10) 设计任务上下文：以可信上下文为准，并附上已核验 reviewRef。
  const designContext: DesignContext = { ...design, reviewRef: structuredClone(reviewRef) };

  // 11) 输入指纹由可信服务在完整组装 DesignInput 之后计算，写入返回上下文。
  //     若调用方提供了可选期望钉，则仅在其存在时严格对照；绝不使用任意传入值。
  const computedInputHash = fingerprint(input);
  if (trusted.expectedInputHash !== undefined) {
    if (!FINGERPRINT_RE.test(String(trusted.expectedInputHash))) {
      return fail('consume.input_hash_shape', '期望输入指纹不合法', 'expectedInputHash');
    }
    if (trusted.expectedInputHash !== computedInputHash) {
      return fail('consume.input_hash_mismatch', '组装输入指纹与期望钉不一致', 'expectedInputHash');
    }
  }
  const taskContext: DesignTaskContext = { inputHash: computedInputHash, design: designContext };

  // 12) 复用既有 checkDesignInput 校验组装后的输入与独立上下文。
  const check = checkDesignInput(input, registry, taskContext);
  if (!check.ok) {
    return {
      ok: false,
      reasons: check.issues.map(i => ({ code: i.code, message: i.message ?? i.code, ...(i.path ? { path: i.path } : {}) })),
    };
  }

  // 13) 不回写 store、不执行采纳；返回克隆后的可消费任务，调用方负责后续模型调用。
  return {
    ok: true,
    reviewRef: structuredClone(reviewRef),
    input: structuredClone(input),
    context: { inputHash: taskContext.inputHash, design: structuredClone(designContext) },
    check,
  };
}
