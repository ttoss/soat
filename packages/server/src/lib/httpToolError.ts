import { DomainError } from '../errors';
import { isFetchFailure } from './providerError';

/**
 * Thrown when a tool call's target responds with a non-2xx status: an
 * `http`-type tool's external endpoint, or a `soat`-type tool's loopback call
 * to this server's own REST API. `toHttpToolDomainError` (agentToolResolver)
 * maps it to a `TOOL_HTTP_ERROR` `DomainError` so the real upstream status
 * survives to the caller instead of a generic 500 — and so
 * `isRetriableError` can read `meta.tool_status_code` to tell a terminal 4xx
 * from a transient 5xx.
 *
 * It lives in its own module because both throw sites need it:
 * `agentToolResolver` (http) and `agentToolResolverExternalTools` (soat), and
 * the former imports the latter — importing it back would be a cycle.
 */
export class HttpToolError extends Error {
  status: number;
  body: string;
  url: string;
  method: string;

  constructor(
    message: string,
    status: number,
    body: string,
    url: string,
    method: string
  ) {
    super(message);
    this.name = 'HttpToolError';
    this.status = status;
    this.body = body;
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

const causeOf = (error: object): string | null => {
  const cause = 'cause' in error ? error.cause : undefined;
  if (typeof cause === 'object' && cause !== null && 'message' in cause) {
    return String(cause.message);
  }
  return cause === undefined ? null : String(cause);
};

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
  const reason = causeOf(args.error);
  return new DomainError(
    'TOOL_UNREACHABLE',
    `Tool target could not be reached${reason ? `: ${reason}` : '.'}`,
    { tool_url: args.url, tool_method: args.method },
    { cause: args.error }
  );
};
