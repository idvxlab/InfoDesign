/**
 * 语义返修保留校验。
 *
 * 结构修正（`validateEvidenceCandidate` 的 `previous` 参数）禁止改写已合法事实值，
 * 那是为了避免“改值过关”。语义返修必须允许修改被审查点名的事实值，但必须：
 *  - 绑定父版本（basedOnSnapshotVersionId = 父 snapshotVersionId）；
 *  - 保持快照身份（snapshotId）不变；
 *  - 保留未被点名事实的稳定标识（claimId/entityId/predicate），不得删除既有事实；
 *  - 不得凭空新增事实；
 *  - 保留既有证据条目与缺失/冲突记录，不能靠删问题过关。
 *
 * 注意：本校验**不**禁止改动未被点名事实的取值。独立审查会在下一轮重新核对全部证据，
 * 因此“返修改坏正确事实能被再审查发现”，而不是被这里静默放行或直接判失败。
 * 改动只作为审计差异由工作流记录。
 */
import type { EvidenceOutput } from '../../../../packages/contracts/generated/evidence-output.ts';
import type { CheckIssue, CheckResult } from '../../../../packages/contracts/src/service-checks.ts';
import { canonicalize } from '../../../../packages/contracts/src/validator.ts';
import type { WithdrawalPermit } from './review-decision.ts';

/**
 * 撤下声明：EvidenceOutput.changes 中显式声明的一条 removed 记录。
 * 模型不能自授撤下许可，但必须在 changes 里**显式申报**它要撤下的事实与理由，
 * 否则服务端视为未申报的偷删。
 */
export interface RemovalDeclaration {
  changeId: string;
  claimId: string;
  description: string;
}

/** 从候选输出的 changes 中收集显式 removed 声明。 */
export function collectRemovalDeclarations(raw: unknown): RemovalDeclaration[] {
  const output = record(raw) as { changes?: unknown };
  if (!Array.isArray(output.changes)) return [];
  const declarations: RemovalDeclaration[] = [];
  for (const entry of output.changes) {
    const change = record(entry);
    if (change.changeType !== 'removed') continue;
    const claimId = change.claimId;
    if (typeof claimId !== 'string') continue;
    declarations.push({
      changeId: typeof change.changeId === 'string' ? change.changeId : '',
      claimId,
      description: typeof change.description === 'string' ? change.description : '',
    });
  }
  return declarations;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

function indexById(items: unknown, field: string): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(items)) return map;
  for (const item of items) {
    const entry = record(item);
    const id = entry[field];
    if (typeof id === 'string') map.set(id, entry);
  }
  return map;
}

export function validateRepairPreservation(
  raw: unknown,
  previous: EvidenceOutput,
  parentVersionId: string,
  allowedChangeClaimIds: readonly string[],
  withdrawalPermits: readonly WithdrawalPermit[] = [],
): CheckResult {
  const issues: CheckIssue[] = [];
  const add = (code: string, path: string) => issues.push({ code, path, message: code });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: true, issues };
  const next = raw as EvidenceOutput;
  if (!next.candidateSnapshot || !previous.candidateSnapshot) return { ok: true, issues };

  const snapshot = next.candidateSnapshot;
  const prior = previous.candidateSnapshot;

  if (snapshot.basedOnSnapshotVersionId !== parentVersionId) {
    add('repair.parent_mismatch', 'candidateSnapshot.basedOnSnapshotVersionId');
  }
  if (snapshot.snapshotId !== prior.snapshotId) {
    add('repair.snapshot_identity_changed', 'candidateSnapshot.snapshotId');
  }

  const allowed = new Set(allowedChangeClaimIds);
  const previousClaims = indexById(prior.claims, 'claimId');
  const previousEvidence = indexById(prior.evidence, 'evidenceId');
  // 服务端许可的撤下：许可是**可选许可**，不是删除指令。仅当许可同时绑定请求父版本与上一快照版本、
  // 点名既存且被允许的事实、reportVersionId 非空、issueIds 非空、理由非空、证据引用非空且全部存在于
  // 上一快照证据中时才生效。模型字段不能自授许可。
  const permitByClaim = new Map<string, WithdrawalPermit>();
  for (const permit of withdrawalPermits) {
    if (permit.parentVersionId !== parentVersionId) continue;
    if (permit.parentVersionId !== prior.snapshotVersionId) continue;
    if (!previousClaims.has(permit.claimId)) continue;
    if (!allowed.has(permit.claimId)) continue;
    if (typeof permit.reportVersionId !== 'string' || permit.reportVersionId.trim().length === 0) continue;
    if (permit.issueIds.length === 0) continue;
    if (permit.reason.trim().length === 0) continue;
    if (permit.evidenceRefs.length === 0) continue;
    if (permit.evidenceRefs.some((ref) => !previousEvidence.has(ref))) continue;
    permitByClaim.set(permit.claimId, permit);
  }
  // 模型显式申报的撤下：每条 removed 声明必须携带非空理由，且不得重复声明同一事实。
  const declarations = collectRemovalDeclarations(raw);
  const declaredByClaim = new Map<string, RemovalDeclaration>();
  for (const declaration of declarations) {
    if (declaration.description.trim().length === 0) {
      add('repair.withdrawal_reason_missing', 'changes');
      continue;
    }
    if (declaredByClaim.has(declaration.claimId)) {
      add('repair.withdrawal_duplicate_declaration', 'changes');
      continue;
    }
    declaredByClaim.set(declaration.claimId, declaration);
  }
  const nextClaims = indexById(snapshot.claims, 'claimId');
  // 撤下只对**确实消失**的事实有效：对仍在候选或不存在的事实声明 removed 属伪造声明。
  for (const claimId of declaredByClaim.keys()) {
    if (nextClaims.has(claimId)) add('repair.withdrawal_claim_still_present', 'changes');
    else if (!previousClaims.has(claimId)) add('repair.withdrawal_claim_not_found', 'changes');
  }
  for (const [claimId, oldClaim] of previousClaims) {
    const newClaim = nextClaims.get(claimId);
    if (!newClaim) {
      // 删除既有事实：必须同时具备服务端许可与模型显式申报（含理由），否则拒绝。
      const permit = permitByClaim.get(claimId);
      const declaration = declaredByClaim.get(claimId);
      if (!permit) { add('repair.removed_fact', 'candidateSnapshot.claims'); continue; }
      if (!declaration) { add('repair.withdrawal_undeclared', 'candidateSnapshot.claims'); continue; }
      continue;
    }
    if (allowed.has(claimId)) continue;
    // 被允许撤下的事实仍可保留或修正：许可只是可选权限，不是删除命令。
    // 未点名事实的取值可以修正，但身份（主体/谓词）必须保持稳定。
    for (const field of ['entityId', 'predicate']) {
      if (canonicalize(oldClaim[field] ?? null) !== canonicalize(newClaim[field] ?? null)) {
        add('repair.changed_identity', 'candidateSnapshot.claims');
      }
    }
  }
  for (const claimId of nextClaims.keys()) {
    if (!previousClaims.has(claimId)) add('repair.added_fact', 'candidateSnapshot.claims');
  }

  const nextEvidence = indexById(snapshot.evidence, 'evidenceId');
  for (const [evidenceId, oldEvidence] of previousEvidence) {
    const newEvidence = nextEvidence.get(evidenceId);
    if (!newEvidence) {
      // 无条件拒绝移除任何既有证据条目：孤立证据是历史证据，不是非法悬挂引用。
      add('repair.removed_evidence', 'candidateSnapshot.evidence');
      continue;
    }
    for (const field of ['documentId', 'documentVersionId', 'blockId', 'locator']) {
      if (canonicalize(oldEvidence[field] ?? null) !== canonicalize(newEvidence[field] ?? null)) {
        add('repair.changed_evidence', 'candidateSnapshot.evidence');
      }
    }
    if (canonicalize(oldEvidence.excerpt ?? null) !== canonicalize(newEvidence.excerpt ?? null)) {
      add('repair.changed_evidence', 'candidateSnapshot.evidence');
    }
  }

  const previousMissing = indexById(prior.missing, 'missingId');
  const nextMissing = indexById(snapshot.missing, 'missingId');
  for (const missingId of previousMissing.keys()) {
    if (!nextMissing.has(missingId)) add('repair.removed_missing', 'candidateSnapshot.missing');
  }

  const previousConflicts = indexById(prior.conflicts, 'conflictId');
  const nextConflicts = indexById(snapshot.conflicts, 'conflictId');
  for (const conflictId of previousConflicts.keys()) {
    if (!nextConflicts.has(conflictId)) add('repair.removed_conflict', 'candidateSnapshot.conflicts');
  }

  // 不得借撤下隐藏冲突：被撤下事实或证据若仍被未解决冲突引用，必须保留冲突记录。
  for (const [conflictId, conflict] of previousConflicts) {
    const nextConflict = nextConflicts.get(conflictId);
    if (!nextConflict) continue; // 已被上面的 removed_conflict 拒绝。
    const claimRefs = record(conflict).claimRefs;
    if (Array.isArray(claimRefs)) {
      for (const ref of claimRefs) {
        if (typeof ref === 'string' && permitByClaim.has(ref) && !nextClaims.has(ref)) {
          add('repair.withdrawal_hides_conflict', 'candidateSnapshot.conflicts');
        }
      }
    }
  }

  // 撤下后事实引用的证据必须真实存在，不得遗留悬挂引用。
  for (const claim of snapshot.claims) {
    const refs = record(claim).evidenceRefs;
    if (!Array.isArray(refs)) continue;
    for (const ref of refs) {
      if (typeof ref === 'string' && !nextEvidence.has(ref)) {
        add('repair.dangling_evidence_ref', 'candidateSnapshot.claims');
      }
    }
  }

  return { ok: issues.length === 0, issues };
}