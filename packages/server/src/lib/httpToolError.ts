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
