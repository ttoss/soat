import createDebug from 'debug';

import type { Context } from '../Context';
import { DomainError } from '../errors';
import { getDeclaredQueryParams, matchOpenApiPath } from '../lib/openapiSpec';
import { validateRequestBody } from '../lib/requestValidation';

const log = createDebug('soat:strictFields');

type Next = () => Promise<void>;

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Routes that must stay lenient even though they have a property-based request
 * schema. Keyed by `<METHOD> <OpenAPI path template>`.
 *
 * These are the intentional exclusions from the strict-field-validation PRD:
 * LLM passthrough endpoints that legitimately accept extra sampling params,
 * open input endpoints, the accept-and-ignore file create endpoints (a
 * documented security behavior), and the public auth flows. Everything else
 * with a property schema is validated automatically; routes with no
 * property-based body schema (no body, or an open `additionalProperties` map
 * such as a tags endpoint) no-op on their own via the spec resolver.
 */
export const STRICT_FIELDS_OPT_OUT: ReadonlySet<string> = new Set([
  // LLM completion passthrough — accept temperature, top_p, … beyond the spec.
  'POST /api/v1/chat/completions',
  // Open / passthrough input.
  'POST /api/v1/embeddings',
  'POST /api/v1/tools/{tool_id}/call',
  // POST /files accepts-and-ignores client storage fields as a documented
  // robustness behavior. The multipart upload routes carry no JSON schema, so
  // the resolver skips them on its own.
  'POST /api/v1/files',
  // Public auth flows — left untouched.
  'POST /api/v1/users/login',
  'POST /api/v1/users/bootstrap',
]);

/**
 * Routes whose query string is validated against the parameters their spec
 * declares. Every entry is a static path (no `{}` segment), so the lookup is on
 * the request path itself rather than a template match run on every request.
 *
 * Opt-in rather than universal: an unknown query parameter has been ignored on
 * every read route since the API existed, and rejecting them everywhere at once
 * would break callers that work today. These two are where ignoring one is a
 * *wrong* answer rather than a missing one — `model`, `session_id` and
 * `actor_id` all name real dimensions of a usage rollup, so a dropped filter
 * hands back the project-wide total under the caller's belief that it is one
 * model's or one end user's (#1265).
 */
export const STRICT_QUERY_ROUTES: ReadonlySet<string> = new Set([
  'GET /api/v1/usage/aggregate',
  'GET /api/v1/usage/events',
]);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

// Rejects query parameters the route's spec does not declare, for the routes
// that opted in. The declared set comes from the spec, so it cannot drift from
// the contract the SDK, CLI and MCP surface are generated from.
const validateQueryParams = (ctx: Context): void => {
  if (!ctx.authUser) return;
  if (!STRICT_QUERY_ROUTES.has(`${ctx.method} ${ctx.path}`)) return;

  const declared = getDeclaredQueryParams({
    method: ctx.method,
    path: ctx.path,
  });
  if (!declared) return;

  const unknown = Object.keys(ctx.query).filter((name) => {
    return !declared.has(name);
  });
  if (unknown.length === 0) return;

  log('unknown query params: %s %s %o', ctx.method, ctx.path, unknown);
  throw new DomainError(
    'VALIDATION_FAILED',
    `Unknown query parameter(s): ${unknown.sort().join(', ')}. Accepted: ${[
      ...declared,
    ]
      .sort()
      .join(', ')}.`,
    { unknown_query_parameters: unknown.sort() }
  );
};

/**
 * Validates request bodies against the route's OpenAPI request schema, and the
 * query strings of `STRICT_QUERY_ROUTES` against the parameters it declares —
 * both derived
 * from the spec, the single source of truth for the REST contract, SDK, CLI,
 * and MCP surface — so an allowlist can never drift from the schema. Rejects
 * unknown fields (at every nesting level) and missing top-level required fields
 * with `VALIDATION_FAILED` (400); see `validateRequestBody`.
 *
 * Runs after `authMiddleware`, so `ctx.authUser` is resolved. The body is
 * compared exactly as the client sent it — snake_case, the wire contract, with
 * no key rewriting anywhere in between. Validation is skipped for
 * unauthenticated requests, leaving the `401` to the route handler (so a
 * validation error never preempts the auth error or leaks the schema pre-auth).
 */
export const strictFieldsMiddleware = async (ctx: Context, next: Next) => {
  validateQueryParams(ctx);

  if (
    !MUTATING_METHODS.has(ctx.method) ||
    !ctx.authUser ||
    !ctx.path.startsWith('/api/v1')
  ) {
    await next();
    return;
  }

  const body = ctx.request?.body;
  if (!isPlainObject(body)) {
    await next();
    return;
  }

  const template = matchOpenApiPath({ path: ctx.path });
  if (!template || STRICT_FIELDS_OPT_OUT.has(`${ctx.method} ${template}`)) {
    if (template) {
      log('skip opt-out: %s %s', ctx.method, template);
    }
    await next();
    return;
  }

  // `validateRequestBody` throws `VALIDATION_FAILED` on an unknown field at any
  // nesting level, or a missing top-level required one; it no-ops for a route
  // with no property-based body schema.
  validateRequestBody({ method: ctx.method, path: template, body });

  await next();
};
