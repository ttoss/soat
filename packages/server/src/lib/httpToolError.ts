import { DomainError } from '../errors';
import { isFetchFailure } from './providerError';

/**
 * Thrown when an `http`-type tool's target responds with a non-2xx status.
 * `toHttpToolDomainError` (agentToolResolver) maps it to a `TOOL_HTTP_ERROR`
 * `DomainError` so the real upstream status survives to the caller instead of
 * a generic 500, and so `isRetriableError` can read `meta.tool_status_code` to
 * tell a terminal 4xx from a transient 5xx.
 */
export class HttpToolError extends Error {
  status: number;
  body: string;
  // The body parsed, when the whole of it is JSON (`readToolErrorBody`).
  json: { value: unknown } | null;
  url: string;
  method: string;

  constructor(
    message: string,
    status: number,
    body: { text: string; json: { value: unknown } | null },
    url: string,
    method: string
  ) {
    super(message);
    this.name = 'HttpToolError';
    this.status = status;
    this.body = body.text;
    this.json = body.json;
    this.url = url;
    this.method = method;
  }

  toJSON() {
    return {
      message: this.message,
      name: this.name,
      status: this.status,
      url: this.url,
      method: this.method,
      body: this.body,
    };
  }
}

/**
 * A tool call that never got a response — the host did not resolve, refused or
 * dropped the connection, or timed out — as a `TOOL_UNREACHABLE` naming the
 * reason, which `fetch` keeps only on its cause. Null for any other failure.
 * The original stays the cause, so a timeout still reads as one.
 */
export const toToolUnreachableError = (args: {
  error: unknown;
  url: string;
  method: string;
}): DomainError | null => {
  if (!isFetchFailure(args.error)) return null;
  // `fetch failed` always carries the network error as its cause.
  const cause: { message?: unknown } | undefined = Reflect.get(
    args.error,
    'cause'
  );
  return new DomainError(
    'TOOL_UNREACHABLE',
    `Tool target could not be reached: ${String(cause?.message)}`,
    { tool_url: args.url, tool_method: args.method },
    { cause: args.error }
  );
};
