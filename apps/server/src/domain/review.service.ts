/** 任务级追加式审查结果存储；只保存审查报告版本与失败版本，不维护采纳指针。 */
import type { ReviewOutput } from '../../../../packages/contracts/generated/review-output.ts';
import type { CheckIssue } from '../../../../packages/contracts/src/service-checks.ts';

export interface ReviewRecord {
  reportVersionId: string;
  recordedAt: string;
  state: 'invalid' | 'reviewed';
  /** 私有任务数据，不能直接写入公共日志。 */
  rawOutput: string;
  output?: ReviewOutput;
  issues: CheckIssue[];
}

export interface ReviewStore {
  append(record: ReviewRecord): void;
}

export class ReviewRecordError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'ReviewRecordError';
    this.code = code;
  }
}

/** 校验记录自洽性：非法记录不得携带公共输出；有效记录必须有输出且版本一致。 */
function assertRecordConsistent(record: ReviewRecord): void {
  if (!record.reportVersionId) throw new ReviewRecordError('missing_report_version');
  if (record.state === 'invalid') {
    if (record.output !== undefined) throw new ReviewRecordError('invalid_record_has_output');
    return;
  }
  if (record.state === 'reviewed') {
    if (!record.output) throw new ReviewRecordError('reviewed_record_missing_output');
    if (record.output.report.reportVersionId !== record.reportVersionId) {
      throw new ReviewRecordError('report_version_mismatch');
    }
    return;
  }
  throw new ReviewRecordError('invalid_state');
}

/** B4 本地开发存储。无跨进程持久性；持久存储与原子采纳属于后续批次。 */
export class MemoryReviewStore implements ReviewStore {
  private readonly records = new Map<string, ReviewRecord>();
  append(record: ReviewRecord): void {
    assertRecordConsistent(record);
    if (this.records.has(record.reportVersionId)) throw new ReviewRecordError('review_version_exists');
    this.records.set(record.reportVersionId, structuredClone(record));
  }
  list(): ReviewRecord[] { return structuredClone([...this.records.values()]); }
}