/** 测试专用：真实 SDK 对本机 SSE 伪响应，不提供语义判定或真实调用入口。 */
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { EvidenceInput, EvidenceOutput, ReadDocumentRequest } from '../../../packages/contracts/generated/index.ts';
import { readModelConfig } from '../../../apps/server/src/config/env.ts';
import { runEvidenceAgent } from '../../../apps/server/src/agents/evidence/agent.ts';
import type { CandidateEnvelope } from '../../../apps/server/src/agents/evidence/context.ts';
import { MemoryCandidateStore } from '../../../apps/server/src/domain/evidence.service.ts';
import { createDocumentReader } from '../../../apps/server/src/runtime/pi/read-document-tool.ts';
import { RequestSpendBudget, type SpendReservation } from '../../../apps/server/src/runtime/pi/spend-budget.ts';
import { validateEvidenceCandidate } from '../../../apps/server/src/domain/result-validator.ts';
import { loadFixture, registry } from '../../helpers/fixtures.ts';
export const cases = ['quantities', 'reconciliation', 'coverage'] as const;
export type QualityCase = typeof cases[number];
export const qualityLimits = { timeoutMs: 5000, maxModelCalls: 4, maxToolCalls: 2, maxOutputTokens: 4096, maxContextBytes: 60000 };
export function fixture(name: QualityCase) {
  return { input: loadFixture<EvidenceInput>(`b3-quality/${name}-input.json`), reference: loadFixture<EvidenceOutput>(`b3-quality/${name}-reference.json`) };
}
export function reads(input: EvidenceInput): ReadDocumentRequest[] {
  return input.documents.flatMap(d => d.blocks.filter(b => b.location.kind === 'paragraph' && !!b.text).map(b => ({ documentId: d.documentId, documentVersionId: d.documentVersionId, blockId: b.blockId })));
}
export function receipts(input: EvidenceInput) {
  const read = createDocumentReader({ scope: input.scope, documents: input.documents }, registry);
  return reads(input).map(request => read(request));
}
export function validate(input: EvidenceInput, output: EvidenceOutput, actualReads = receipts(input), previous?: EvidenceOutput) {
  const { snapshotId, snapshotVersionId, createdAt, producedBy } = output.candidateSnapshot;
  return validateEvidenceCandidate(output, input, { snapshotId, snapshotVersionId, createdAt, producedBy }, actualReads, registry, previous);
}
export type RequestBody = { messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>; tools: Array<{ function: { name: string } }>; max_tokens?: number; max_completion_tokens?: number };
function send(res: ServerResponse, data: string | ReadDocumentRequest[]) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (delta: unknown, finish_reason: string | null) => res.write('data: ' + JSON.stringify({ id: 'quality_mock', object: 'chat.completion.chunk', model: 'synthetic-model', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
  if (Array.isArray(data)) {
    chunk({ role: 'assistant', tool_calls: data.map((args, index) => ({ index, id: `quality_read_${index}`, type: 'function', function: { name: 'read_document', arguments: JSON.stringify(args) } })) }, null);
    chunk({}, 'tool_calls');
  } else { chunk({ role: 'assistant', content: data }, null); chunk({}, 'stop'); }
  res.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 256, completion_tokens: 128, total_tokens: 384 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
}
export async function replay(input: EvidenceInput, reference: EvidenceOutput, response: (output: EvidenceOutput, request: number) => unknown = o => o) {
  const requests: RequestBody[] = [], store = new MemoryCandidateStore();
  let reservations: readonly SpendReservation[] = [], handlerError: unknown;
  const spendBudget = new RequestSpendBudget({ limitMicros: 5000000, safetyMicros: 1000000, inputCnyPerMillion: 2, outputCnyPerMillion: 8, inputTokensPerByte: 2, inputTokenOverhead: 8192 }, next => { reservations = next; });
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as RequestBody; requests.push(body);
      if (requests.length === 1) return send(res, reads(input));
      const user = body.messages.findLast(m => m.role === 'user')!.content;
      const task = JSON.parse(typeof user === 'string' ? user : user.map(c => c.text ?? '').join('')) as { envelope: CandidateEnvelope };
      const output = structuredClone(reference); Object.assign(output.candidateSnapshot, task.envelope); output.producedBy = task.envelope.producedBy;
      send(res, JSON.stringify(response(output, requests.length)));
    } catch (error) { handlerError = error; res.writeHead(500); res.end('{}'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('mock_listen_failed');
  const config = readModelConfig({ APP_MODEL_PROVIDER: 'quality-local', APP_MODEL_ID: 'synthetic-model', APP_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`, APP_MODEL_API_KEY: 'quality-synthetic-secret' }, { allowLoopbackHttp: true });
  try {
    const outcome = await runEvidenceAgent({ input, config, registry, store, limits: qualityLimits, spendBudget });
    if (handlerError) throw handlerError;
    return { outcome, requests, records: store.list(), reservations };
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
