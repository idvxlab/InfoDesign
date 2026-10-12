/**
 * 事实工作流的本地追加式运行记录。
 *
 * 复用既有 MemoryCandidateStore / MemoryReviewStore 保存候选与报告；本存储只补充
 * “本次运行”的编排记录：每轮决策、返修修改项、调用用量、预算预留与最终停止原因。
 * 不引入新数据库；审查通过与正式采纳在此分开记录（passed 只表示审查结论）。
 *
 * 同时提供文件系统实现 FileSystemFactRunStore：私有原子落盘、跨进程可回读，仅供审计，
 * 不构成生产多写者存储或自动恢复；预算记账仍走既有外部经纪（不在本单元内直写）。
 */
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { EvidenceInput } from '../../../../packages/contracts/generated/evidence-input.ts';
import type { EvidenceOutput } from '../../../../packages/contracts/generated/evidence-output.ts';
import type { TokenUsage } from '../runtime/pi/event-bridge.ts';
import type { ReviewIssueFeedback, WithdrawalPermit } from './review-decision.ts';
import type { ExecutionStatus, FactStage, FactTaskStatus, StopReasonCode } from '../orchestration/state.ts';
import { executionStatusFor } from '../orchestration/state.ts';
import { canonicalize } from '../../../../packages/contracts/src/validator.ts';
export interface FactChange {
  kind: 'claim' | 'evidence' | 'missing' | 'conflict' | 'relation' | 'event';
  id: string;
  fields: string[];
}

export interface UsageRecord {
  usage: TokenUsage | null;
  modelCalls: number;
  toolCalls: number;
  usageReportedResponses: number;
  usageUnreportedResponses: number;
}

export interface FactWorkflowRound {
  round: number;
  stage: FactStage;
  candidateVersionId: string;
  reportVersionId?: string;
  decision: 'pass' | 'repair' | 'wait_input' | 'stop';
  reason?: string;
  issues: ReviewIssueFeedback[];
  /** 产生本候选的返修所引入的差异（首版为空）。 */
  changes: FactChange[];
  /**
   * 本审查轮由服务端从已校验报告派生的撤下许可（可选）。
   * 与父候选、报告、问题、来源、理由绑定；仅审计记录，模型不可自授。
   */
  withdrawalPermits?: WithdrawalPermit[];
  usage: UsageRecord;
}

export interface FactRunRecord {
  runId: string;
  taskId: string;
  attemptId: string;
  projectId: string;
  status: FactTaskStatus;
  /** spec §10.2 执行终态（由 status + stopReason 经 executionStatusFor 派生）；不蕴涵 passed/采纳。 */
  executionStatus: ExecutionStatus;
  stage: FactStage;
  passed: boolean;
  stopReason: StopReasonCode;
  stopDetail?: string;
  currentVersionId?: string;
  candidateVersions: string[];
  reportVersions: string[];
  repairRounds: number;
  remainingIssues: ReviewIssueFeedback[];
  evidenceRefs: string[];
  rounds: FactWorkflowRound[];
  /** 每次 Agent 调用的类型化历史（提取/结构修正、语义返修、审查），含失败尝试。仅审计。 */
  attempts: FactRunAttempt[];
  budget?: { reservedMicrosTotal: number; currency: 'CNY' };
  /** 原始输入快照（克隆）；内存存储丢失后仍可读取原始文档文本与文档版本。 */
  inputSnapshot?: EvidenceInput;
  createdAt: string;
  updatedAt: string;
  /**
   * 本次运行实际产生的候选/报告记录快照（仅限本 run 的 versionId）。
   * 用作审计回读：内存存储丢失后仍可看到被审查的候选内容与报告内容。
   * 该快照为历史只读副本，工作流不再回写；缺失（如失败较早）时字段可省略。
   */
  artifacts?: FactRunArtifact[];
}

/** 单条历史工件：绑定本次运行的版本与原始输出，仅供审计，不驱动任何采纳。 */
export interface FactRunArtifact {
  kind: 'candidate' | 'report';
  versionId: string;
  state: 'invalid' | 'pending_review' | 'reviewed';
  /** 内存存储丢失后仍可回读的原始输出；失败/非法尝试可能无输出。 */
  rawOutput: string;
  output?: unknown;
  /** 非法输出仍保留的服务端校验问题（码/路径/消息）；可选以兼容旧记录。 */
  issues?: FactRunArtifactIssue[];
}

/** 工件校验问题的安全子集：仅码/路径/消息，绝不包含凭据或隐藏推理。 */
export interface FactRunArtifactIssue {
  code: string;
  path: string;
  message: string;
}

/** 单次 Agent 调用的历史（提取/结构修正、语义返修、审查），含失败尝试。 */
export interface FactRunAttempt {
  attempt: number;
  stage: FactStage;
  kind: 'extract' | 'review' | 'repair';
  parentVersionId?: string;
  candidateVersionId?: string;
  reportVersionId?: string;
  /** 实际 Pi 会话 id（若已创建会话）；失败较早时省略。 */
  sessionId?: string;
  modelCalls: number;
  toolCalls: number;
  successfulReads: number;
  /** 真实用量；未知时为 null，绝不臆造为零。 */
  usage: TokenUsage | null;
  usageReportedResponses: number;
  usageUnreportedResponses: number;
  /** 本次尝试产出的版本 id（提取/返修为候选，审查为报告）。 */
  versions: string[];
  outcomeReason?: string;
  outcomeStatus: string;
  resourcesDisposed: boolean;
}

export interface FactRunStore {
  save(record: FactRunRecord): void;
  get(runId: string): FactRunRecord | undefined;
  list(): FactRunRecord[];
}

/** B5 本地开发存储；无跨进程持久性。运行之间按 runId 隔离，不回写历史。 */
export class MemoryFactRunStore implements FactRunStore {
  private readonly records = new Map<string, FactRunRecord>();
  save(record: FactRunRecord): void {
    this.records.set(record.runId, structuredClone(record));
  }
  get(runId: string): FactRunRecord | undefined {
    const found = this.records.get(runId);
    return found ? structuredClone(found) : undefined;
  }
  list(): FactRunRecord[] { return structuredClone([...this.records.values()]); }
}

/* ── 文件系统运行记录存储（审计/回读，非生产多写者存储，不构成自动恢复）───────────── */

/** 受控单段标识：仅允许字母数字与 . _ -；拒绝路径分隔、上跳与空段。 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FILE_SUFFIX = '.json';

export class FactRunStoreError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'FactRunStoreError';
    this.code = code;
  }
}

/** runId/projectId 必须为受控单段标识；任何路径分隔、上跳或空段都拒绝。 */
export function assertSafeRunId(id: unknown, field: string): string {
  if (typeof id !== 'string' || !SAFE_ID.test(id) || id === '.' || id === '..') {
    throw new FactRunStoreError('unsafe_' + field);
  }
  return id;
}

interface RunEnvelope {
  version: 1;
  projectId: string;
  runId: string;
  contentHash: string;
  record: FactRunRecord;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function hashOfRun(record: FactRunRecord): string {
  return 'sha256:' + createHash('sha256').update(canonicalize(record)).digest('hex');
}

/** 必需字段（非可选字符串）的运行时校验。 */
const REQUIRED_STRING_FIELDS = [
  'runId', 'taskId', 'attemptId', 'projectId', 'status', 'executionStatus', 'stage', 'stopReason', 'createdAt', 'updatedAt',
] as const;
const EXECUTION_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'waiting_for_input']);
const ATTEMPT_KINDS = new Set(['extract', 'review', 'repair']);
const ARTIFACT_ISSUE_MAX_COUNT = 64;
/** 必需数组字段，逐一与记录中的实际元素对应。 */
const REQUIRED_ARRAY_FIELDS = ['candidateVersions', 'reportVersions', 'remainingIssues', 'evidenceRefs', 'rounds'] as const;
const ARTIFACT_KINDS = new Set(['candidate', 'report']);
const ARTIFACT_STATES = new Set(['invalid', 'pending_review', 'reviewed']);

/**
 * 形状校验：必需字段、字段类型、数组、以及每个 artifact 的 kind/versionId 归属。
 * 限定于本存储实际需要的不变量，不引入通用 schema 框架；哈希仅作完整性校验。
 */
function assertRecordShape(record: FactRunRecord): void {
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof record[field] !== 'string' || (record[field] as string).length === 0) {
      throw new FactRunStoreError('invalid_record_shape:' + field);
    }
  }
  if (typeof record.passed !== 'boolean') throw new FactRunStoreError('invalid_record_shape:passed');
  if (!EXECUTION_STATUSES.has(record.executionStatus as string)) {
    throw new FactRunStoreError('invalid_record_shape:executionStatus');
  }
  // 映射契约校验：executionStatus 必须与 status + stopReason 派生结果一致，防止伪造“已成功”。
  if (record.executionStatus !== executionStatusFor(record.status, record.stopReason)) {
    throw new FactRunStoreError('execution_status_mismatch');
  }
  if (!Number.isSafeInteger(record.repairRounds) || record.repairRounds < 0) {
    throw new FactRunStoreError('invalid_record_shape:repairRounds');
  }
  for (const field of REQUIRED_ARRAY_FIELDS) {
    if (!Array.isArray(record[field])) throw new FactRunStoreError('invalid_record_shape:' + field);
  }
  for (const versionId of record.candidateVersions) {
    if (typeof versionId !== 'string') throw new FactRunStoreError('invalid_record_shape:candidateVersions_item');
  }
  for (const versionId of record.reportVersions) {
    if (typeof versionId !== 'string') throw new FactRunStoreError('invalid_record_shape:reportVersions_item');
  }
  for (const round of record.rounds) {
    if (!isObject(round) || typeof round.round !== 'number' || typeof round.candidateVersionId !== 'string') {
      throw new FactRunStoreError('invalid_record_shape:round');
    }
    // 轮次引用的候选版本必须是本次运行产生并记录的版本。
    if (!record.candidateVersions.includes(round.candidateVersionId)) {
      throw new FactRunStoreError('artifact_version_not_owned:candidate');
    }
    if (round.reportVersionId !== undefined && !record.reportVersions.includes(round.reportVersionId)) {
      throw new FactRunStoreError('artifact_version_not_owned:report');
    }
  }
  if (record.artifacts !== undefined) {
    if (!Array.isArray(record.artifacts)) throw new FactRunStoreError('invalid_record_shape:artifacts');
    for (const artifact of record.artifacts) {
      if (!isObject(artifact) || !ARTIFACT_KINDS.has(artifact.kind as string)
        || typeof artifact.versionId !== 'string' || !ARTIFACT_STATES.has(artifact.state as string)
        || typeof artifact.rawOutput !== 'string') {
        throw new FactRunStoreError('invalid_record_shape:artifact');
      }
      // artifact 的 kind 决定它必须归属到对应的版本列表，避免跨类/跨运行冒充。
      const owned = artifact.kind === 'candidate' ? record.candidateVersions : record.reportVersions;
      if (!owned.includes(artifact.versionId)) throw new FactRunStoreError('artifact_version_not_owned:' + artifact.kind);
      // 校验问题（若保留）必须是安全子集：仅码/路径/消息字符串。
      if (artifact.issues !== undefined) {
        if (!Array.isArray(artifact.issues) || artifact.issues.length > ARTIFACT_ISSUE_MAX_COUNT) {
          throw new FactRunStoreError('invalid_record_shape:artifact_issues');
        }
        for (const issue of artifact.issues) {
          if (!isObject(issue) || typeof issue.code !== 'string'
            || typeof issue.path !== 'string' || typeof issue.message !== 'string') {
            throw new FactRunStoreError('invalid_record_shape:artifact_issue');
          }
        }
      }
      // 有合法校验输出时，其项目/任务/尝试与 kind 专属版本必须与记录一致。
      if (artifact.output !== undefined) {
        if (!isObject(artifact.output)) throw new FactRunStoreError('invalid_record_shape:artifact_output');
        const output = artifact.output;
        if (output.projectId !== record.projectId || output.taskId !== record.taskId
          || output.attemptId !== record.attemptId) {
          throw new FactRunStoreError('artifact_output_not_owned');
        }
        // 直接安全取属性：候选工件读 candidateSnapshot.snapshotVersionId，报告工件读 report.reportVersionId。
        const boundary = artifact.kind === 'candidate'
          ? (isObject(output.candidateSnapshot) ? output.candidateSnapshot.snapshotVersionId : undefined)
          : (isObject(output.report) ? output.report.reportVersionId : undefined);
        const outputVersionId = typeof boundary === 'string' ? boundary : undefined;
        if (outputVersionId === undefined || outputVersionId !== artifact.versionId) {
          throw new FactRunStoreError('artifact_version_mismatch:' + artifact.kind);
        }
      }
    }
  }
  if (!Array.isArray(record.attempts)) throw new FactRunStoreError('invalid_record_shape:attempts');
  for (const attempt of record.attempts) {
    if (!isObject(attempt) || !ATTEMPT_KINDS.has(attempt.kind as string)
      || !Number.isSafeInteger(attempt.attempt) || (attempt.attempt as number) < 1
      || typeof attempt.stage !== 'string'
      || typeof attempt.outcomeStatus !== 'string' || attempt.outcomeStatus.length === 0
      || typeof attempt.resourcesDisposed !== 'boolean') {
      throw new FactRunStoreError('invalid_record_shape:attempt');
    }
    for (const field of ['modelCalls', 'toolCalls', 'successfulReads', 'usageReportedResponses', 'usageUnreportedResponses'] as const) {
      if (!Number.isSafeInteger(attempt[field]) || (attempt[field] as number) < 0) {
        throw new FactRunStoreError('invalid_record_shape:attempt_' + field);
      }
    }
    if (attempt.usage !== null && !isObject(attempt.usage)) {
      throw new FactRunStoreError('invalid_record_shape:attempt_usage');
    }
    if (!Array.isArray(attempt.versions)) throw new FactRunStoreError('invalid_record_shape:attempt_versions');
    for (const versionId of attempt.versions) {
      if (typeof versionId !== 'string') throw new FactRunStoreError('invalid_record_shape:attempt_versions_item');
      const owned = attempt.kind === 'review' ? record.reportVersions : record.candidateVersions;
      if (!owned.includes(versionId)) throw new FactRunStoreError('attempt_version_not_owned:' + attempt.kind);
    }
    for (const field of ['parentVersionId', 'candidateVersionId', 'reportVersionId', 'sessionId', 'outcomeReason'] as const) {
      const value = attempt[field];
      if (value !== undefined && typeof value !== 'string') {
        throw new FactRunStoreError('invalid_record_shape:attempt_' + field);
      }
    }
  }
  if (record.inputSnapshot !== undefined) {
    if (!isObject(record.inputSnapshot)) throw new FactRunStoreError('invalid_record_shape:inputSnapshot');
    const snapshot = record.inputSnapshot;
    if (snapshot.projectId !== record.projectId || snapshot.taskId !== record.taskId
      || snapshot.attemptId !== record.attemptId) {
      throw new FactRunStoreError('input_snapshot_not_owned');
    }
  }
  if (record.budget !== undefined) {
    if (!isObject(record.budget) || !Number.isSafeInteger(record.budget.reservedMicrosTotal)
      || (record.budget.reservedMicrosTotal as number) < 0 || record.budget.currency !== 'CNY') {
      throw new FactRunStoreError('invalid_record_shape:budget');
    }
  }
}
const frozen = (value: unknown): string => canonicalize(value ?? null);

/** 私有目录强制权限位：仅属主可读写执行。 */
const PRIVATE_MODE = 0o700;

/**
 * 校验一个已存在的目录必须是「属主私有 0700、非符号链接」的实体目录。
 * 作为历史存储根时必须排除：符号链接、非目录、以及组/其他可访问的宽权限。
 * 允许 /tmp 等祖先目录为世界可写：仅校验本项目自有的 root 与 project 层。
 */
function assertPrivateDir(dir: string, code: string): void {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch {
    throw new FactRunStoreError('missing_' + code);
  }
  if (stat.isSymbolicLink()) throw new FactRunStoreError('symlink_rejected:' + code);
  if (!stat.isDirectory()) throw new FactRunStoreError('not_a_directory:' + code);
  if ((stat.mode & 0o777) !== PRIVATE_MODE) throw new FactRunStoreError('insecure_' + code + '_mode');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new FactRunStoreError('wrong_owner:' + code);
  }
}

/**
 * 逐段解析路径，确保从现存祖先到目标之间没有符号链接组件。
 * 处理 existsSync=false 的悬空符号链接：此时最终段可能是不存在的文件，仍不能被符号链接穿越。
 */
function assertNoSymlinkAncestors(target: string): void {
  const parts = target.split('/').filter((p) => p.length > 0);
  let current = target.startsWith('/') ? '' : '.';
  for (const part of parts) {
    current = current === '' ? '/' + part : current + '/' + part;
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      // 路径组件尚不存在（如目标文件）：其后不再有现存组件，安全。
      return;
    }
    if (stat.isSymbolicLink() || (current !== target && !stat.isDirectory())) {
      throw new FactRunStoreError('symlink_rejected:ancestor');
    }
  }
}

/** 原子写：同目录临时文件 → fsync → rename（0600 私有模式）。任何失败不落半成品。
 *  用 writeFileSync(fd) 完整写出，避免 writeSync 短写导致截断内容落盘。 */
function atomicWriteRun(target: string, contents: string): void {
  const tmp = target + '.tmp-' + process.pid + '-' + Date.now().toString(36);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, contents, { encoding: 'utf8' });
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, target);
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* noop */ } }
    if (existsSync(tmp)) { try { unlinkSync(tmp); } catch { /* noop */ } }
    throw new FactRunStoreError('persist_failed:' + (error instanceof Error ? error.name : 'unknown'));
  }
}

/**
 * 文件系统运行记录存储。绑定可信 projectId；读取/写入均校验项目与运行归属。
 * rootDir 由调用方提供（生产为受控私有目录，测试为临时目录）。
 */
export class FileSystemFactRunStore implements FactRunStore {
  private readonly rootDir: string;
  private readonly projectId: string;
  private readonly projectDir: string;

  constructor(rootDir: string, projectId: string) {
    if (typeof rootDir !== 'string' || rootDir.length === 0) throw new FactRunStoreError('invalid_root_dir');
    this.rootDir = rootDir;
    this.projectId = assertSafeRunId(projectId, 'project_id');
    // 现存祖先不得含符号链接组件，避免穿越到非私有位置。
    assertNoSymlinkAncestors(rootDir);
    mkdirSync(rootDir, { recursive: true, mode: PRIVATE_MODE });
    assertPrivateDir(rootDir, 'root');
    this.projectDir = join(rootDir, this.projectId);
    mkdirSync(this.projectDir, { recursive: true, mode: PRIVATE_MODE });
    assertPrivateDir(this.projectDir, 'project');
  }

  /** 每次读写前复核私有前提：防构造后被替换为宽松权限或符号链接。 */
  private recheckPrivate(): void {
    assertNoSymlinkAncestors(this.projectDir);
    assertPrivateDir(this.rootDir, 'root');
    assertPrivateDir(this.projectDir, 'project');
  }

  private pathFor(runId: string): string {
    return join(this.projectDir, assertSafeRunId(runId, 'run_id') + FILE_SUFFIX);
  }

  save(record: FactRunRecord): void {
    if (!isObject(record)) throw new FactRunStoreError('invalid_record');
    assertSafeRunId(record.runId, 'run_id');
    if (record.projectId !== this.projectId) throw new FactRunStoreError('project_mismatch');
    assertRecordShape(record);
    this.recheckPrivate();
    const target = this.pathFor(record.runId);
    const existing = this.readEnvelope(record.runId);
    if (existing) {
      // 终态历史不可静默改写：只接受与已存记录逐字相同的幂等重存。
      // 不主张追加/恢复语义；任何字段差异（含状态、决策、内容）一律拒绝。
      if (existing.contentHash !== hashOfRun(record)) {
        throw new FactRunStoreError('history_rewrite_rejected');
      }
      return;
    }
    const envelope: RunEnvelope = {
      version: 1, projectId: this.projectId, runId: record.runId,
      contentHash: hashOfRun(record), record: structuredClone(record),
    };
    atomicWriteRun(target, JSON.stringify(envelope));
  }

  get(runId: string): FactRunRecord | undefined {
    this.recheckPrivate();
    const envelope = this.readEnvelope(runId);
    return envelope ? structuredClone(envelope.record) : undefined;
  }

  list(): FactRunRecord[] {
    this.recheckPrivate();
    const out: FactRunRecord[] = [];
    for (const name of readdirSync(this.projectDir).sort()) {
      if (!name.endsWith(FILE_SUFFIX)) continue;
      const envelope = this.readEnvelope(name.slice(0, -FILE_SUFFIX.length));
      if (envelope) out.push(structuredClone(envelope.record));
    }
    return out;
  }

  /** 读取并校验：拒绝符号链接（含祖先组件）、畸形/截断、哈希不符与错误归属。 */
  private readEnvelope(runId: string): RunEnvelope | undefined {
    const target = this.pathFor(runId);
    assertNoSymlinkAncestors(target);
    let stat;
    try {
      stat = lstatSync(target);
    } catch {
      return undefined; // 不存在（或悬空软链后不可达）
    }
    if (stat.isSymbolicLink()) throw new FactRunStoreError('symlink_rejected');
    if (!stat.isFile()) throw new FactRunStoreError('not_a_regular_file');
    if ((stat.mode & 0o777) !== 0o600) throw new FactRunStoreError('insecure_file_mode');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new FactRunStoreError('wrong_owner_file');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(target, 'utf8'));
    } catch {
      throw new FactRunStoreError('malformed_record');
    }
    if (!isObject(parsed)) throw new FactRunStoreError('malformed_record');
    const envelope = parsed as Partial<RunEnvelope>;
    if (envelope.version !== 1 || !isObject(envelope.record)) throw new FactRunStoreError('malformed_record');
    if (envelope.projectId !== this.projectId) throw new FactRunStoreError('project_mismatch');
    if (envelope.runId !== runId) throw new FactRunStoreError('run_id_mismatch');
    const record = envelope.record as unknown as FactRunRecord;
    assertRecordShape(record);
    if (record.projectId !== this.projectId) throw new FactRunStoreError('project_mismatch');
    if (record.runId !== runId) throw new FactRunStoreError('run_id_mismatch');
    if (typeof envelope.contentHash !== 'string' || envelope.contentHash !== hashOfRun(record)) {
      throw new FactRunStoreError('content_hash_mismatch');
    }
    return envelope as RunEnvelope;
  }
}

const record = (value: unknown): Record<string, unknown> =>
  isObject(value) ? value : {};

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

function diffRecords(
  before: Map<string, Record<string, unknown>>,
  after: Map<string, Record<string, unknown>>,
  kind: FactChange['kind'],
  fields: readonly string[],
): FactChange[] {
  const changes: FactChange[] = [];
  for (const [id, oldItem] of before) {
    const newItem = after.get(id);
    if (!newItem) { changes.push({ kind, id, fields: ['removed'] }); continue; }
    const changed = fields.filter((field) => canonicalize(oldItem[field] ?? null) !== canonicalize(newItem[field] ?? null));
    if (changed.length) changes.push({ kind, id, fields: changed });
  }
  for (const id of after.keys()) {
    if (!before.has(id)) changes.push({ kind, id, fields: ['added'] });
  }
  return changes;
}

/**
 * 计算两次候选之间的实质差异（忽略 envelope/版本字段）。
 * 返回空数组表示“没有实质修改”，可用于停止无意义的返修循环。
 */
export function computeRepairChanges(previous: EvidenceOutput, next: EvidenceOutput): FactChange[] {
  const before = previous.candidateSnapshot;
  const after = next.candidateSnapshot;
  return [
    ...diffRecords(indexById(before.claims, 'claimId'), indexById(after.claims, 'claimId'), 'claim', ['entityId', 'predicate', 'value', 'qualifiers', 'evidenceRefs', 'supportStatus']),
    ...diffRecords(indexById(before.evidence, 'evidenceId'), indexById(after.evidence, 'evidenceId'), 'evidence', ['documentId', 'documentVersionId', 'blockId', 'locator', 'excerpt']),
    ...diffRecords(indexById(before.missing, 'missingId'), indexById(after.missing, 'missingId'), 'missing', ['entityId', 'expectedPredicate', 'description', 'severity']),
    ...diffRecords(indexById(before.conflicts, 'conflictId'), indexById(after.conflicts, 'conflictId'), 'conflict', ['claimRefs', 'description', 'resolutionStatus']),
    ...diffRecords(indexById(before.relations, 'relationId'), indexById(after.relations, 'relationId'), 'relation', ['fromEntityId', 'toEntityId', 'relationType', 'evidenceRefs']),
    ...diffRecords(indexById(before.events, 'eventId'), indexById(after.events, 'eventId'), 'event', ['entityId', 'eventType', 'time', 'description', 'evidenceRefs']),
  ];
}/* probe */