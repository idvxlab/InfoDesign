/** 仅记录请求计数、HTTP 状态和固定错误码；不读取响应正文、URL、请求头或原始异常。 */
const CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);
export interface TransportDiagnostics {
  attempts: number;
  httpStatuses: number[];
  failureCodes: string[];
}
function failureCode(error: unknown): string {
  const seen = new Set<unknown>();
  let current = error;
  for (let n = 0; n < 4 && current && typeof current === 'object' && !seen.has(current); n++) {
    seen.add(current);
    const e = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof e.code === 'string' && CODES.has(e.code)) return e.code;
    if (e.name === 'AbortError') return 'aborted';
    current = e.cause;
  }
  return 'unknown';
}
export function createDiagnosticFetch(target: typeof globalThis.fetch, diagnostics: TransportDiagnostics): typeof globalThis.fetch {
  return async (...args) => {
    diagnostics.attempts++;
    try {
      const response = await target(...args);
      if (diagnostics.httpStatuses.length < 8) diagnostics.httpStatuses.push(response.status);
      return response;
    } catch (error) {
      if (diagnostics.failureCodes.length < 8) diagnostics.failureCodes.push(failureCode(error));
      throw error;
    }
  };
}
