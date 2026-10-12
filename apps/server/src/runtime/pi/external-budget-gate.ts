/**
 * 只读预检/审计：核对“既有外部预算代理”的账本与配置，而不是第二套预算实现。
 * 本模块绝不写入/重置/预留/释放账本，也绝不读取 API 凭据。
 * 真正的隔离由受信启动器 + 容器网络（全部出网强制经过代理）+ 既有代理
 * （每次上游 HTTP 之前原子预留）共同提供；本只读回执本身不构成隔离。
 */
import { readFileSync } from 'node:fs';
import type { ModelConfig } from '../../config/env.ts';
import { RequestSpendBudget, type SpendPolicy, type SpendReservation } from './spend-budget.ts';

export type GatePhase = 'before' | 'after';

export interface ExternalBudgetGateOptions {
  config: ModelConfig;
  authorizationId: string;
  taskLedgerPath: string;
  totalLedgerPath: string;
  phase: GatePhase;
}

export interface ExternalBudgetGateReceipt {
  authorizationId: string;
  currency: 'CNY';
  reservedMicros: number;
  recordCount: number;
  limitMicros: number;
  safetyMicros: number;
  attemptCount: number;
  maxCalls: number;
  maxOutputTokens: number;
  deadline: number;
  stopReason: string | null;
}

/** 通用失败码：不回显原始数据或配置。 */
type GateErrorCode =
  | 'gate_config'
  | 'gate_authorization'
  | 'gate_ledger_read'
  | 'gate_ledger_invalid'
  | 'gate_policy_mismatch'
  | 'gate_history_mismatch'
  | 'gate_phase_state';

class GateError extends Error {
  readonly code: GateErrorCode;
  constructor(code: GateErrorCode) {
    super(code);
    this.name = 'GateError';
    this.code = code;
  }
}

function fail(code: GateErrorCode): never {
  throw new GateError(code);
}

const AUTHORIZED_POLICY: Readonly<SpendPolicy> = Object.freeze({
  limitMicros: 400_000_000,
  safetyMicros: 10_000_000,
  inputCnyPerMillion: 2,
  outputCnyPerMillion: 8,
  inputTokensPerByte: 2,
  inputTokenOverhead: 8192,
});

const POLICY_KEYS: ReadonlyArray<keyof SpendPolicy> = [
  'limitMicros', 'safetyMicros', 'inputCnyPerMillion',
  'outputCnyPerMillion', 'inputTokensPerByte', 'inputTokenOverhead',
];

const TOTAL_KEYS = ['authorizationId', 'policy', 'records', 'reservedMicros'] as const;
const TASK_KEYS = [
  'startedAt', 'deadline', 'policy', 'maxCalls', 'maxOutputTokens', 'maxBodyBytes',
  'minRequestIntervalMs', 'toolProfile', 'records', 'reservedMicros', 'attempts', 'stopReason',
] as const;

const MAX_ATTEMPTS_WINDOW_MS = 900_000;
const MAX_CALLS_LIMIT = 18;
const MAX_OUTPUT_TOKENS_LIMIT = 8_192;
const MAX_BODY_BYTES_LIMIT = 256_000;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** 稳定序列化（键排序），用于不受键序影响的等价比较。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(',')}}`;
}

function readJson(path: string): unknown {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch { return fail('gate_ledger_read'); }
  try { return JSON.parse(raw) as unknown; } catch { return fail('gate_ledger_invalid'); }
}

/** 与已授权值逐字段相等；使用稳定序列化避免键序差异。 */
function assertAuthorizedPolicy(value: unknown): void {
  if (!isObject(value) || Object.keys(value).length !== POLICY_KEYS.length) fail('gate_policy_mismatch');
  for (const key of POLICY_KEYS) {
    const expected = AUTHORIZED_POLICY[key];
    const actual = value[key];
    if (actual !== expected) fail('gate_policy_mismatch');
  }
  if (stableStringify(value) !== stableStringify(AUTHORIZED_POLICY)) fail('gate_policy_mismatch');
}

/** 仅接受精确形状的预留记录；交给既有预算类校验内容。 */
function assertRecords(value: unknown): readonly SpendReservation[] {
  if (!Array.isArray(value)) fail('gate_history_mismatch');
  for (const item of value) {
    if (!isObject(item) || Object.keys(item).length !== 5) fail('gate_history_mismatch');
    for (const key of ['sequence', 'contextBytes', 'reservedInputTokens', 'requestedOutputTokens', 'reservedMicros']) {
      if (!Number.isSafeInteger(item[key])) fail('gate_history_mismatch');
    }
  }
  return value as readonly SpendReservation[];
}

const sumReserved = (records: readonly SpendReservation[]): number =>
  records.reduce((n, r) => n + r.reservedMicros, 0);

/** 用既有 RequestSpendBudget 校验完整历史；禁止触发 reserve（persist 抛错）。 */
function buildBudget(policy: Readonly<SpendPolicy>, records: readonly SpendReservation[]): RequestSpendBudget {
  try {
    return new RequestSpendBudget({ ...policy }, () => { throw new Error('gate_read_only'); }, records);
  } catch { return fail('gate_history_mismatch'); }
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length) fail('gate_history_mismatch');
  for (const key of keys) if (!(key in value)) fail('gate_history_mismatch');
}

/** 校验 baseUrl：精确 HTTP 回环主机、显式非空端口、/v1 或 /v1/、无凭据/查询/片段。 */
function validateBaseUrl(config: ModelConfig): void {
  if (config.provider !== 'company-gateway' || config.modelId !== 'deepseek-v4.1-flash') fail('gate_config');
  const raw = config.baseUrl;
  if (typeof raw !== 'string' || raw.length === 0 || /[\s]/.test(raw)) fail('gate_config');
  let url: URL;
  try { url = new URL(raw); } catch { return fail('gate_config'); }
  if (url.protocol !== 'http:') fail('gate_config');
  if (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') fail('gate_config');
  if (!url.port) fail('gate_config');
  const port = Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) fail('gate_config');
  if (url.username || url.password || url.search || url.hash) fail('gate_config');
  if (url.pathname !== '/v1' && url.pathname !== '/v1/') fail('gate_config');
}

export function readExternalBudgetGate(options: ExternalBudgetGateOptions): ExternalBudgetGateReceipt {
  if (!isObject(options)) fail('gate_config');
  const { config, authorizationId, taskLedgerPath, totalLedgerPath, phase } = options;
  if (phase !== 'before' && phase !== 'after') fail('gate_phase_state');
  if (typeof authorizationId !== 'string' || authorizationId.trim().length === 0) fail('gate_authorization');
  if (!isObject(config)) fail('gate_config');
  validateBaseUrl(config);

  // ---- 总账本 ----
  const total = readJson(totalLedgerPath);
  if (!isObject(total)) fail('gate_ledger_invalid');
  assertExactKeys(total, TOTAL_KEYS);
  const totalReservedBase: unknown = total.reservedMicros;
  if (typeof total.authorizationId !== 'string' || total.authorizationId.length === 0) fail('gate_authorization');
  if (total.authorizationId !== authorizationId) fail('gate_authorization');
  const totalPolicy = total.policy;
  assertAuthorizedPolicy(totalPolicy);
  const totalRecords = assertRecords(total.records);
  if (!Number.isSafeInteger(totalReservedBase) || (totalReservedBase as number) < 0) fail('gate_ledger_invalid');
  if (sumReserved(totalRecords) !== totalReservedBase) fail('gate_history_mismatch');
  const totalBudget = buildBudget(AUTHORIZED_POLICY, totalRecords);
  if (totalBudget.reservedMicros !== totalReservedBase) fail('gate_history_mismatch');

  // ---- 任务账本 ----
  const task = readJson(taskLedgerPath);
  if (!isObject(task)) fail('gate_ledger_invalid');
  assertExactKeys(task, TASK_KEYS);
  const taskPolicy = task.policy;
  assertAuthorizedPolicy(taskPolicy);
  const taskRecords = assertRecords(task.records);
  const taskReservedBase: unknown = task.reservedMicros;
  if (!Number.isSafeInteger(taskReservedBase) || (taskReservedBase as number) < 0) fail('gate_ledger_invalid');
  if (sumReserved(taskRecords) !== taskReservedBase) fail('gate_history_mismatch');
  const taskBudget = buildBudget(AUTHORIZED_POLICY, taskRecords);
  if (taskBudget.reservedMicros !== taskReservedBase) fail('gate_history_mismatch');

  // 总账本与任务账本必须一致：策略、记录、预留额。
  if (stableStringify(taskPolicy) !== stableStringify(totalPolicy)) fail('gate_policy_mismatch');
  if (stableStringify(taskRecords) !== stableStringify(totalRecords)) fail('gate_history_mismatch');
  if (taskReservedBase !== totalReservedBase) fail('gate_history_mismatch');

  // ---- 任务元数据 ----
  const minRequestIntervalMs: unknown = task.minRequestIntervalMs;
  if (!Number.isSafeInteger(minRequestIntervalMs) || (minRequestIntervalMs as number) < 0) fail('gate_phase_state');
  if (task.toolProfile !== 'business') fail('gate_phase_state');
  const bounds: ReadonlyArray<[unknown, number]> = [
    [task.maxCalls, MAX_CALLS_LIMIT],
    [task.maxOutputTokens, MAX_OUTPUT_TOKENS_LIMIT],
    [task.maxBodyBytes, MAX_BODY_BYTES_LIMIT],
  ];
  for (const [value, max] of bounds) {
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) fail('gate_phase_state');
  }
  const startedAtBase: unknown = task.startedAt;
  const deadlineBase: unknown = task.deadline;
  if (!Number.isSafeInteger(startedAtBase) || !Number.isSafeInteger(deadlineBase)) fail('gate_phase_state');
  const windowMs = (deadlineBase as number) - (startedAtBase as number);
  if (windowMs <= 0 || windowMs > MAX_ATTEMPTS_WINDOW_MS) fail('gate_phase_state');
  if (!Array.isArray(task.attempts)) fail('gate_phase_state');
  const attempts = task.attempts;
  const stopReasonValue = task.stopReason;
  if (attempts.length > (task.maxCalls as number)) fail('gate_phase_state');
  if (stopReasonValue !== null && typeof stopReasonValue !== 'string') fail('gate_phase_state');

  // ---- 阶段状态 ----
  const remainingMicros = taskBudget.availableMicros - taskBudget.reservedMicros;
  if (phase === 'before') {
    if (attempts.length !== 0) fail('gate_phase_state');
    if (stopReasonValue !== null) fail('gate_phase_state');
    if (Date.now() >= (deadlineBase as number)) fail('gate_phase_state');
    if (remainingMicros <= 0) fail('gate_phase_state');
  }

  return {
    authorizationId,
    currency: 'CNY',
    reservedMicros: taskReservedBase as number,
    recordCount: taskRecords.length,
    limitMicros: AUTHORIZED_POLICY.limitMicros,
    safetyMicros: AUTHORIZED_POLICY.safetyMicros,
    attemptCount: attempts.length,
    maxCalls: task.maxCalls as number,
    maxOutputTokens: task.maxOutputTokens as number,
    deadline: deadlineBase as number,
    stopReason: phase === 'after' ? (stopReasonValue as string | null) : null,
  };
}