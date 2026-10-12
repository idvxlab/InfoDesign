/**
 * 受控事实工作流状态。
 *
 * 与 `docs/design/project-spec.md` 第 10 节（版本、状态、重试与提交）的语义一致：
 * 任务级 status 表达“任务对调用方的可用结论”，独立 stage 表达当前执行阶段，二者不得互相冒充。
 * 命名差异：spec §10.2 以 `succeeded` 表示成功终态；本实现按 B5 明确要求使用 `passed`/`not_passed`
 * 以区分“审查通过”与“未通过”。二者通过 executionStatus 映射显式对齐：
 *  - status 表达业务结论（passed/not_passed），executionStatus 表达任务执行终态（spec 语义）。
 *  - 映射契约（见 executionStatusFor）：passed → succeeded；已处理的业务停止
 *    （repair_limit_reached / no_substantive_change / repeated_issue / review_unactionable）
 *    在 status 为 not_passed 时 → succeeded，且 passed 仍为 false；waiting_for_input 保持自身；
 *    技术失败（candidate_invalid / repair_failed / evidence_failed / review_execution_failed /
 *    review_inconsistent / budget_exhausted / timeout / unrecoverable_error）→ failed；
 *    cancelled 保持 cancelled。非法候选 schema/来源/版本与返修执行失败属技术失败，不构成有效事实结论。
 *  - “通过”是审查结论，不等于正式采纳；正式采纳由后续版本指针流程处理。
 *  - executionStatus 不表示采纳：succeeded 亦可对应业务 not_passed，候选始终停留在 pending。
 *  - “达到返修上限”只能落到 not_passed，绝不能自动转成 passed。
 *  - 正常退出（进程结束、Agent 返回）不等于通过。
 *
 * 状态：仅实现状态模型与终止判定，不含编排副作用；编排见 `fact-workflow.ts`。
 */

/** 任务级状态；供调用方判断结果，不代替审查结论。 */
export type FactTaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_input'
  | 'waiting_for_component'
  | 'passed'
  | 'not_passed'
  | 'failed'
  | 'cancelled'
  | 'superseded';

/** 执行阶段；可独立于 status 变化，用于观测当前正在做什么。 */
export type FactStage =
  | 'extracting'
  | 'validating'
  | 'reviewing'
  | 'repairing'
  | 'deciding'
  | 'done';

/**
 * 停止原因码。程序据此决定是否继续、返修、等待或停止；
 * 自然语言 detail 只作补充，不能替代原因码。
 */
export type StopReasonCode =
  | 'passed_all_checks'
  | 'needs_user_input'
  | 'repair_limit_reached'
  | 'no_substantive_change'
  | 'repeated_issue'
  | 'review_execution_failed'
  | 'review_inconsistent'
  | 'review_unactionable'
  | 'evidence_failed'
  | 'candidate_invalid'
  | 'repair_failed'
  | 'budget_exhausted'
  | 'timeout'
  | 'cancelled'
  | 'unrecoverable_error';

/**
 * spec §10.2 的执行终态。与业务 status 分离：succeeded 表示“任务执行完成”，
 * 不蕴含审查通过，也不蕴含正式采纳；passed 仍仅由 status === 'passed' 表达。
 */
export type ExecutionStatus = 'succeeded' | 'failed' | 'cancelled' | 'waiting_for_input';

/** 视为“已处理完成”的业务停止码：执行成功但业务结论为 not_passed。 */
export const HANDLED_BUSINESS_STOPS: readonly StopReasonCode[] = [
  'repair_limit_reached', 'no_substantive_change', 'repeated_issue', 'review_unactionable',
];

/** 技术失败停止码：不构成有效事实结论，执行终态必须为 failed。 */
export const TECHNICAL_FAILURE_STOPS: readonly StopReasonCode[] = [
  'candidate_invalid', 'repair_failed', 'evidence_failed', 'review_execution_failed',
  'review_inconsistent', 'budget_exhausted', 'timeout', 'unrecoverable_error',
];

/**
 * 唯一 state 映射函数：由业务 status + 停止码派生 spec 执行终态。
 * 契约：
 *   - cancelled → cancelled（取消独立于成功/失败）。
 *   - waiting_for_input → waiting_for_input。
 *   - failed（技术失败）→ failed。
 *   - passed → succeeded。
 *   - not_passed 且停止码属已处理业务停止 → succeeded，但 passed 仍为 false。
 *   - not_passed 且停止码属技术失败 → failed（非法候选/返修执行失败不得视为有效拒绝）。
 */
export function executionStatusFor(status: FactTaskStatus, reason: StopReasonCode): ExecutionStatus {
  if (status === 'cancelled' || reason === 'cancelled') return 'cancelled';
  if (status === 'waiting_for_input') return 'waiting_for_input';
  if (status === 'failed') return 'failed';
  if (status === 'passed') return 'succeeded';
  if (status === 'not_passed') {
    if (TECHNICAL_FAILURE_STOPS.includes(reason)) return 'failed';
    if (HANDLED_BUSINESS_STOPS.includes(reason)) return 'succeeded';
    return 'failed';
  }
  // queued/running/waiting_for_component/superseded 均非本映射的终态输入。
  return 'failed';
}

/** 终态：到达后调用方可以读取最终结论，程序不得再发起新的模型调用。 */
export const TERMINAL_STATUSES: readonly FactTaskStatus[] = [
  'passed', 'not_passed', 'failed', 'cancelled', 'superseded',
];

export function isTerminalStatus(status: FactTaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** 只有 passed 表示审查通过；其余一切终态都不是通过。 */
export function isPassed(status: FactTaskStatus): boolean {
  return status === 'passed';
}

/** 阶段与状态的默认映射；编排过程中可以显式指定更细的阶段。 */
export function stageForStatus(status: FactTaskStatus): FactStage {
  switch (status) {
    case 'queued': return 'extracting';
    case 'running': return 'extracting';
    case 'waiting_for_input': return 'deciding';
    case 'waiting_for_component': return 'deciding';
    case 'passed':
    case 'not_passed':
    case 'failed':
    case 'cancelled':
    case 'superseded':
      return 'done';
    default: return 'done';
  }
}

/** 预算/取消/超时终止码是否属于“未完成但非语义结论”。 */
export function isTechnicalStop(reason: StopReasonCode): boolean {
  return TECHNICAL_FAILURE_STOPS.includes(reason) || reason === 'cancelled';
}

/** 把 AbortSignal / 执行预算的停止码映射为工作流终止码。 */
export function stopReasonFromStopCode(code: string | undefined): StopReasonCode {
  switch (code) {
    case 'timeout': return 'timeout';
    case 'cancelled': return 'cancelled';
    case 'budget_exhausted': return 'budget_exhausted';
    default: return 'unrecoverable_error';
  }
}