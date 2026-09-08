import { fetchWithEgressGuard } from './toolEgress';

/**
 * `fetch` for an outbound request whose destination a tenant chose but which is
 * not a tool call — above all the AI SDK's provider requests, where the
 * destination comes from a provider record's `base_url` or from a host the SDK
 * builds out of its `config` (`region`, `location`, `resourceName`).
 *
 * Every AI SDK provider takes a `fetch`, so handing it this one is what puts
 * those requests behind the guard an `http` tool's target already passes,
 * without a second implementation of the address rules.
 *
 * A `Request` argument is flattened back into `(url, init)`: the guard follows
 * redirects itself, and re-issuing a hop needs a body it can send again, which
 * a `Request` whose stream is already consumed cannot give it.
 */
const toGuardedCall = async (
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<{ url: string; init: RequestInit }> => {
  if (typeof input === 'string') return { url: input, init: init ?? {} };
  if (input instanceof URL) return { url: input.href, init: init ?? {} };

  const request = new Request(input, init);
  const bodyless = request.method === 'GET' || request.method === 'HEAD';
  return {
    url: request.url,
    init: {
      method: request.method,
      headers: request.headers,
      signal: request.signal,
      ...(bodyless ? {} : { body: await request.arrayBuffer() }),
    },
  };
};

export const egressGuardedFetch: typeof fetch = async (input, init) => {
  const call = await toGuardedCall(input, init);
  return fetchWithEgressGuard(call.url, call.init, { noun: 'Request target' });
};
