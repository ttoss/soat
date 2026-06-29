import createDebug from 'debug';

import type { Context } from '../Context';
import { matchOpenApiPath } from '../lib/openapiSpec';
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
  'POST /api/v1/chats/{chat_id}/completions',
  // Open / passthrough input.
  'POST /api/v1/embeddings',
  'POST /api/v1/tools/{tool_id}/call',
  // POST /files intentionally accepts-and-ignores client storage fields
  // (path, storage_*) as a documented robustness behavior. The multipart
  // upload routes carry no application/json schema, so the resolver skips
  // them on its own.
  'POST /api/v1/files',
  // Public auth flows — left untouched.
  'POST /api/v1/users/login',
  'POST /api/v1/users/bootstrap',
]);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

/**
 * Validates request bodies against the route's OpenAPI request schema — derived
 * from the spec, the single source of truth for the REST contract, SDK, CLI,
 * and MCP surface — so an allowlist can never drift from the schema. Rejects
 * unknown fields (at every nesting level) and missing top-level required fields
 * with `VALIDATION_FAILED` (400); see `validateRequestBody`.
 *
 * Runs after `authMiddleware` and `caseTransformMiddleware`, so the body is
 * already camelCase and `ctx.authUser` is resolved. Validation is skipped for
 * unauthenticated requests, leaving the `401` to the route handler (so a
 * validation error never preempts the auth error or leaks the schema pre-auth).
 */
export const strictFieldsMiddleware = async (ctx: Context, next: Next) => {
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

  // `validateRequestBody` resolves the route's request schema and throws a
  // `DomainError('VALIDATION_FAILED')` (400) on any unknown field (at any
  // nesting level) or missing top-level required field; it no-ops when the
  // route has no property-based body schema.
  validateRequestBody({ method: ctx.method, path: template, body });

  await next();
};
