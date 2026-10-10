/** 任务级追加式候选存储；只保存待审成果与失败版本，不维护可用版本指针。 */
import type { EvidenceOutput } from '../../../../packages/contracts/generated/index.ts';
import type { CheckIssue } from '../../../../packages/contracts/src/service-checks.ts';

export interface CandidateRecord {
  snapshotVersionId: string;
  recordedAt: string;
  state: 'invalid' | 'pending_review';
  /** 私有任务数据，不能直接写入公共日志。 */
  rawOutput: string;
  output?: EvidenceOutput;
  issues: CheckIssue[];
}
export interface CandidateStore {
  append(record: CandidateRecord): void;
}
/** B3 本地开发存储。无跨进程持久性；持久存储与原子采纳属于 B6。 */
export class MemoryCandidateStore implements CandidateStore {
  private readonly records = new Map<string, CandidateRecord>();
  append(record: CandidateRecord): void {
    if (this.records.has(record.snapshotVersionId)) throw new Error('candidate_version_exists');
    this.records.set(record.snapshotVersionId, structuredClone(record));
  }
  list(): CandidateRecord[] { return structuredClone([...this.records.values()]); }
}
