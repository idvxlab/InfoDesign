/** 白名单诊断：不转发提示、参数、结果原文、错误消息或凭据。 */
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
export type ModelStopReason = 'pending' | 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | 'deferred' | 'unknown';
export function safeStopReason(reason: unknown): ModelStopReason {
  return typeof reason === 'string' && ['pending', 'stop', 'length', 'toolUse', 'error', 'aborted', 'deferred'].includes(reason)
    ? reason as ModelStopReason : 'unknown';
}
export interface RuntimeEvent {
  type: 'model_response' | 'tool_start' | 'tool_end';
  toolName?: string;
  ok?: boolean;
  stopReason?: ModelStopReason;
  usage?: TokenUsage | null;
}
export interface TokenUsage { input: number; output: number; cacheRead: number; cacheWrite: number }
export class RuntimeTrace {
  readonly events: RuntimeEvent[] = [];
  usage: TokenUsage | null = null;
  usageReportedResponses = 0;
  usageUnreportedResponses = 0;
  observe(event: AgentSessionEvent): void {
    // 只白名单事实角色的两个受控读工具名，其余一律折叠为 'unrecognized'。
    const known = (name: string): string => name === 'read_document' || name === 'read_source' ? name : 'unrecognized';
    if (event.type === 'tool_execution_start') {
      this.events.push({ type: 'tool_start', toolName: known(event.toolName) });
    } else if (event.type === 'tool_execution_end') {
      this.events.push({ type: 'tool_end', toolName: known(event.toolName), ok: !event.isError });
    } else if (event.type === 'message_end' && event.message.role === 'assistant') {
      const source = event.message.usage;
      const values = [source.input, source.output, source.cacheRead, source.cacheWrite];
      const usage = values.every(x => Number.isFinite(x) && x >= 0) && values.some(x => x > 0)
        ? { input: source.input, output: source.output, cacheRead: source.cacheRead, cacheWrite: source.cacheWrite } : null;
      const stopReason = safeStopReason(event.message.stopReason);
      this.events.push({ type: 'model_response', stopReason, ok: stopReason === 'stop' || stopReason === 'toolUse', usage });
      if (usage) {
        this.usageReportedResponses++;
        this.usage ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) this.usage[key] += source[key];
      } else {
        this.usageUnreportedResponses++;
      }
    }
  }
}
