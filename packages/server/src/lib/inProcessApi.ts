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
 * This is deliberate work, not a leftover of the network hop it replaces.
 * Handing back the live `ctx.body` would hand back a different value than the
 * REST contract describes — a `Date` instead of its ISO string, a key whose
 * value is `undefined` instead of an absent key — and would alias an object the
 * handler still holds. One in-memory round trip keeps the seam's output
 * identical to the wire's, which is the property that makes replacing the
 * transport a transport-only change.
 *
 * A stream body (a file download) has no JSON projection and would leak its
 * file descriptor if simply dropped, so it is destroyed and refused. Over the
 * loopback that case already failed — as an opaque JSON parse error, after the
 * bytes had been read.
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
 * Serves one API request against this process's own app, with no network.
 *
 * This is the seam a `soat` tool calls instead of `fetch`-ing
 * `http://localhost:$PORT` (#888). It runs **the app's real middleware stack** —
 * the same `authMiddleware`, `auditMiddleware`, `requestAttributionMiddleware`,
 * `strictFields`, `responseContract`, and route handler a client request runs —
 * against a synthetic request, and reads the response off the resulting Koa
 * context instead of a socket.
 *
 * Running the stack, rather than reaching past it to a lib function with an
 * explicit principal, is the whole point. Permission enforcement, strict-field
 * validation, audit records, request metering and quota, and the snake_case
 * response contract are all owned by that chain; a seam that re-implemented any
 * of them would be a second copy to keep in step. Here there is nothing to keep
 * in step — the same code runs.
 *
 * Identity still arrives as a **credential**, in the `Authorization` header,
 * exactly as it did over the wire. That is not a leftover either: the auth
 * middleware is where a token's markers become `authUser` fields, and two of
 * them are load-bearing beyond authorization — `isRunToken` is what lets the
 * task engine bound a composed dispatch→transition cycle (#885), and
 * `apiKeyPublicId` is what attributes a key-started chain (#887). Passing a
 * principal object instead would strip both, silently, while every test that
 * drives the HTTP path kept passing.
 *
 * Each call gets a fresh context, so a self-call is metered, audited, and
 * authorized as its own request — as it was when it was one.
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
