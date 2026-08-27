import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

import createDebug from 'debug';

import type { Context } from '../Context';
import { DomainError } from '../errors';

const log = createDebug('soat:inprocess');

/**
 * The host a synthetic request reports. Nothing routes on it — the app matches
 * on path — but `Host` is mandatory in HTTP/1.1 and some middleware reads it,
 * so it is set rather than left absent.
 */
const SYNTHETIC_HOST = 'localhost';

/**
 * Bounds how long a caller waits for a SOAT action, replacing the
 * `AbortSignal.timeout` that bounded the loopback request before #888.
 *
 * It bounds the *wait*, not the work — which is exactly what the aborted fetch
 * bounded too. Aborting a request never stopped the handler on the other end;
 * it only stopped the client listening for the answer. An agent whose `soat`
 * tool reaches a genuinely stuck action still gets its tool call back instead of
 * hanging for the rest of the generation.
 */
export const withCallTimeout = async <T>(args: {
  promise: Promise<T>;
  ms: number;
  label: string;
}): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      args.promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(`${args.label} timed out after ${args.ms}ms`, {
              cause: 'SOAT_TOOL_CALL_TIMEOUT_MS',
            })
          );
        }, args.ms);
      }),
    ]);
  } finally {
    // Without this the losing timer keeps the event loop alive for the full
    // timeout after every successful call.
    if (timer) clearTimeout(timer);
  }
};

export type InProcessApiResponse = {
  status: number;
  /** The response body, projected to JSON (see {@link toWireBody}). */
  body: unknown;
};

/**
 * Builds the `IncomingMessage` the app will serve. It is a real one, on a real
 * (unconnected) socket, rather than a hand-shaped stand-in: Koa reaches through
 * to `req.socket`, `req.headers`, and the raw readable stream, and every
 * body-reading middleware in the chain (`hookRawBody`, `bodyParser`) consumes it
 * as a stream. A duck-typed object would have to keep pace with all of that; a
 * real request is correct by construction.
 */
const buildRequest = (args: {
  method: string;
  path: string;
  headers?: Record<string, string | undefined>;
  body?: unknown;
}): IncomingMessage => {
  const req = new IncomingMessage(new Socket());
  req.method = args.method.toUpperCase();
  req.url = args.path;
  req.httpVersion = '1.1';
  req.httpVersionMajor = 1;
  req.httpVersionMinor = 1;

  const headers: Record<string, string> = { host: SYNTHETIC_HOST };
  for (const [name, value] of Object.entries(args.headers ?? {})) {
    if (value !== undefined) headers[name.toLowerCase()] = value;
  }

  const payload =
    args.body === undefined
      ? undefined
      : Buffer.from(JSON.stringify(args.body), 'utf8');

  if (payload) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(payload.byteLength);
  }

  req.headers = headers;

  if (payload) req.push(payload);
  req.push(null);

  return req;
};

const isReadableStream = (
  value: object
): value is { pipe: () => void; destroy: () => void } => {
  return (
    'pipe' in value &&
    typeof value.pipe === 'function' &&
    'destroy' in value &&
    typeof value.destroy === 'function'
  );
};

/**
 * Projects the handler's `ctx.body` onto the JSON value a client would have
 * received.
 *
 * Handing back the live `ctx.body` would return a different value than the REST
 * contract describes — a `Date` instead of its ISO string, an `undefined` value
 * instead of an absent key — and would alias an object the handler still holds.
 * One in-memory round trip keeps the seam's output identical to the wire's.
 *
 * A stream body (a file download) has no JSON projection and would leak its
 * file descriptor if dropped, so it is destroyed and refused.
 */
const toWireBody = (args: {
  body: unknown;
  method: string;
  path: string;
}): unknown => {
  const { body } = args;
  if (body === undefined || body === null) return undefined;

  if (typeof body === 'object' && isReadableStream(body)) {
    body.destroy();
    throw new DomainError(
      'TOOL_CALL_NOT_SUPPORTED',
      `SOAT action ${args.method} ${args.path} streams binary content, which cannot be returned as a tool result. Use the base64 variant of the action instead.`
    );
  }

  if (typeof body !== 'object') return body;

  const projected: unknown = JSON.parse(JSON.stringify(body));
  return projected;
};

/**
 * Serves one API request against this process's own app, with no network — the
 * seam a `soat` tool calls instead of fetching `http://localhost:$PORT` (#888).
 *
 * It runs **the app's real middleware stack** against a synthetic request and
 * reads the response off the resulting Koa context. Running the stack, rather
 * than reaching past it to a lib function with an explicit principal, is the
 * point: permission enforcement, strict-field validation, audit, metering,
 * quota and the response contract are all owned by that chain, so there is no
 * second copy to keep in step.
 *
 * Identity still arrives as a credential in the `Authorization` header, because
 * the auth middleware is where a token's markers become `authUser` fields —
 * `isRunToken` bounds a composed dispatch→transition cycle (#885) and
 * `apiKeyPublicId` attributes a key-started chain (#887). Passing a principal
 * object would strip both silently while HTTP-path tests kept passing.
 *
 * Each call gets a fresh context, so a self-call is metered, audited and
 * authorized as its own request.
 */
export const dispatchApiRequest = async (args: {
  method: string;
  /** Path plus any query string, e.g. `/api/v1/agents/agt_1`. */
  path: string;
  headers?: Record<string, string | undefined>;
  /** Serialized as a JSON request body. `undefined` sends none. */
  body?: unknown;
}): Promise<InProcessApiResponse> => {
  // Imported at call time: `app` mounts the REST router, which reaches this
  // module through the tool layer, so a static import would close that cycle at
  // module-evaluation time. By the time anything dispatches, `app` is built.
  const { app } = await import('../app');

  const method = args.method.toUpperCase();
  const req = buildRequest(args);
  const ctx: Context = app.createContext(req, new ServerResponse(req));

  // Koa's own `handleRequest` seeds this, so an unmatched route reports 404
  // rather than a `ServerResponse`'s default of 200.
  ctx.res.statusCode = 404;

  log('dispatch: %s %s', method, args.path);

  await app.compose(app.middleware)(ctx);

  const status = typeof ctx.status === 'number' ? ctx.status : 500;
  log('dispatch result: %s %s status=%d', method, args.path, status);

  return {
    status,
    body: toWireBody({ body: ctx.body, method, path: args.path }),
  };
};

/**
 * Dispatches an API request and resolves with its body **only** when the status
 * says the action succeeded.
 *
 * Returning an error body as data made an unauthorized action
 * indistinguishable from a successful one: an orchestration tool node stored
 * the error as its artifact and carried on, and the MCP surface rendered a `401`
 * as a tool result for years (#888).
 *
 * Both callers reach the platform the same way; all that differs is how a
 * failure is spelled — an `HttpToolError` carrying the status for the agent's
 * retry logic, a plain `Error` for MCP — which is what `wrapError` supplies.
 */
export const dispatchApiRequestOrThrow = async (args: {
  method: string;
  path: string;
  headers?: Record<string, string | undefined>;
  body?: unknown;
  /** Builds the error thrown for a non-2xx response, in the caller's own vocabulary. */
  wrapError: (response: InProcessApiResponse) => Error;
}): Promise<unknown> => {
  const response = await dispatchApiRequest({
    method: args.method,
    path: args.path,
    headers: args.headers,
    body: args.body,
  });

  if (response.status < 200 || response.status >= 300) {
    throw args.wrapError(response);
  }

  return response.body;
};
