/** B5 合成夹具：仅用于合成实时 B5 验收的单模块。
 *  复用 tests/helpers/fact-workflow-harness.ts 的 makeEvidenceInput / makeCandidate。
 *  导入该辅助模块不会启动其模拟服务器；本模块绝不调用 runFactScenario。
 *  全部数据为合成/虚构（60 人、成立于 2018 年），只验证程序编排与受控决策。
 *  不向模型指令写入任何期望答案字符串或评分输出；资料文本本身已陈述 60。
 *  seeded-repair 的种子是“显式手工构造的错误输入候选”，
 *  不是真实抽取结果，也不是真实会话的 Agent 输出；
 *  仅用于确定性的返修路径验收，不用于生产恢复。 */
import type { EvidenceInput, EvidenceOutput } from '../../packages/contracts/generated/index.ts';
import {
  makeEvidenceInput,
  makeCandidate,
  type Envelope,
} from '../../tests/helpers/fact-workflow-harness.ts';

export const B5_CASE_IDS = ['correct', 'missing', 'seeded-repair'] as const;
export type B5CaseId = (typeof B5_CASE_IDS)[number];

/** 验收期望的最终状态：仅这两种。'passed' 表示流程以通过结束。 */
export type B5ExpectedStatus = 'passed' | 'waiting_for_input';

export interface B5Case {
  caseId: B5CaseId;
  input: EvidenceInput;
  expectedStatus: B5ExpectedStatus;
  seededForEvaluation: boolean;
  seed?: EvidenceOutput;
}

/** seeded-repair 种子信封：合成、确定性、仅用于返修路径验收。 */
const SEED_ENVELOPE: Envelope = {
  snapshotId: 'snap_b5_seed',
  snapshotVersionId: 'snapv_b5_seed_1',
  createdAt: '2025-01-10T08:00:00Z',
  producedBy: {
    role: 'evidence',
    protocolVersion: '1.0',
    model: 'synthetic_fixture',
    sessionId: 'session_synthetic_seed',
    promptVersion: 'b5_seed_v1',
  },
};

/** 默认输入：两个虚构段落块（60 人、成立于 2018 年），来源文本文档保持不变。 */
function defaultInput(): EvidenceInput {
  return makeEvidenceInput();
}

/** missing 变体：追加受信任务约束，要求 2025 年度营业收入；因来源未披露，必须登记缺失数据。 */
function missingInput(): EvidenceInput {
  const base = makeEvidenceInput();
  const notes = [
    base.constraints.notes,
    '额外受信任务约束：需要 2025 年度营业收入；来源资料未披露该项，必须登记缺失数据（missing），不得臆造。',
  ].filter((n): n is string => typeof n === 'string' && n.length > 0).join(' ');
  return {
    ...base,
    constraints: { ...base.constraints, notes },
  };
}

/**
 * 构造指定 B5 用例；未知 ID 抛出错误。
 * 返回 {caseId,input,expectedStatus,seededForEvaluation,seed?}。
 * 不返回任何答案字符串或评分输出。
 */
export function makeB5Case(caseId: string): B5Case {
  switch (caseId) {
    case 'correct':
      return {
        caseId: 'correct',
        input: defaultInput(),
        expectedStatus: 'passed',
        seededForEvaluation: false,
      };
    case 'missing':
      return {
        caseId: 'missing',
        input: missingInput(),
        expectedStatus: 'waiting_for_input',
        seededForEvaluation: false,
      };
    case 'seeded-repair': {
      // 显式手工构造的错误输入候选：等第（rd）被改为 600。
      // 这不是真实抽取，也不是真实会话的 Agent 输出。
      const seed = makeCandidate(SEED_ENVELOPE, { rd: 600, founded: 2018 });
      return {
        caseId: 'seeded-repair',
        input: defaultInput(),
        expectedStatus: 'passed',
        seededForEvaluation: true,
        seed,
      };
    }
    default:
      throw new Error('未知 B5 用例 ID：' + caseId);
  }
}