/** Per-session transport: use the runtime's proxy variables, never the SDK's global dispatcher. */
import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';

export function createModelTransport() {
  // Keep the existing environment's HTTP(S)_PROXY / NO_PROXY precedence and TLS validation.
  // The dispatcher belongs to this session; do not install globals or mutate process.env.
  const dispatcher = new EnvHttpProxyAgent({ proxyTunnel: true, allowH2: false });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    // The locked OpenAI adapter passes a URL and RequestInit. A Request from Node's
    // bundled Undici has a different brand; reject it instead of stringifying it.
    if (typeof input !== 'string' && !(input instanceof URL)) throw new TypeError('model_transport_requires_url');
    const body = init?.body;
    if (body != null && typeof body !== 'string') throw new TypeError('model_transport_requires_text_body');
    const headers = init?.headers ? [...new Headers(init.headers)] : undefined;
    // Pi declares the DOM Fetch type; Undici's Headers iterator lacks the DOM-only
    // Symbol.dispose declaration. The SDK uses the standard response/body methods.
    return await undiciFetch(input, { ...init, body, headers, dispatcher }) as unknown as Response;
  };
  return { fetch, dispose: () => dispatcher.destroy() };
}
