import createDebug from 'debug';

import type { Context } from '../Context';
import { isObjectRecord } from '../lib/openapiSchemaFields';
import {
  getRouteResponseSchema,
  matchOpenApiPath,
  resolveSchemaRef,
} from '../lib/openapiSpec';

const log = createDebug('soat:responseContract');

type Next = () => Promise<void>;

/**
 * The single job the deleted `caseTransform` middleware actually did well — keep
 * responses on the documented contract — expressed as a check instead of a
 * rewrite.
 *
 * Every response body is now serialized field by field in a lib mapper, so a
 * mapper that emits `projectId` where the spec says `project_id` is a plain bug
 * with no middleware to paper over it. This middleware turns that bug into a
 * deterministic failure, using the route's OpenAPI response schema — the same
 * specs that drive the SDK, CLI, and MCP tool surface — to decide what a key
 * should have been called.
 *
 * It only ever *reads* the body. Two properties follow from that, and they are
 * the whole point of the design:
 *
 * - **Opaque bags are untouchable.** A guardrail `document`, a `tool_context`, a
 *   `tags` map, an orchestration `input` — anything the spec models as an open
 *   object — is a *value* here, never a set of keys to inspect or rewrite. There
 *   is no skip list to forget a bag from, because bags were never at risk.
 * - **Failures are loud, not silent.** A key-blind rewrite made a mismatched key
 *   look correct; this makes it fail.
 *
 * ## Two severities, on purpose
 *
 * - A **camelCase key** is a hard failure. Under a snake_case wire contract it
 *   can only mean a mapper skipped serialization, which is exactly the bug class
 *   this issue removes the machinery for.
 * - A **snake_case key the spec does not declare** is logged, not thrown. That
 *   is pre-existing spec drift, and it is pervasive: the response-shape validator
 *   in `tests/unit/openapiContract.ts` documents ~1900 such cases and
 *   deliberately narrows itself to the list-envelope and agent-generation shapes
 *   for the same reason. Throwing here would silently expand this change into
 *   that burn-down; keeping it as a log leaves the drift visible without
 *   coupling the two.
 */

/** Statuses whose bodies are error envelopes, not the documented resource. */
const isErrorStatus = (status: number): boolean => {
  return status >= 400;
};

/**
 * A schema level is not checkable when it accepts arbitrary keys or could take
 * several shapes: `oneOf`/`anyOf`/`allOf` (the concrete branch is unknown),
 * `additionalProperties` (an open map), or no `properties` at all (a free-form
 * object). Mirrors `requestValidation`'s rule for the inbound direction.
 */
const isOpenOrAmbiguous = (schema: Record<string, unknown>): boolean => {
  if ('oneOf' in schema || 'anyOf' in schema || 'allOf' in schema) return true;
  const additional = schema.additionalProperties;
  if (additional === true || isObjectRecord(additional)) return true;
  return !isObjectRecord(schema.properties);
};

/** A key carrying an interior capital — `projectId`, `createdAt`, `PascalKey`. */
const isCamelCase = (key: string): boolean => {
  return /[a-z][A-Z]/.test(key);
};

type Finding = { key: string; camel: boolean };

const findings = (args: {
  schema: Record<string, unknown>;
  value: unknown;
  path: string;
}): Finding[] => {
  if (!isObjectRecord(args.value)) return [];
  if (isOpenOrAmbiguous(args.schema)) return [];

  const properties = args.schema.properties;
  if (!isObjectRecord(properties)) return [];

  const declared = new Set(Object.keys(properties));
  const found: Finding[] = [];

  for (const key of Object.keys(args.value)) {
    if (declared.has(key)) continue;
    found.push({
      key: args.path ? `${args.path}.${key}` : key,
      camel: isCamelCase(key),
    });
  }

  // Descend exactly one level into a list envelope's `data` array — the other
  // place a resource mapper's own keys surface. Deeper nesting is deliberately
  // not walked: below a resource's top level the spec thins out, and a false
  // positive in a guardrail is worse than a missed key.
  const dataSchema = resolveSchemaRef(properties.data);
  const itemSchema = isObjectRecord(dataSchema)
    ? resolveSchemaRef(dataSchema.items)
    : null;
  const data = args.value.data;
  if (isObjectRecord(itemSchema) && Array.isArray(data)) {
    for (const [index, element] of data.entries()) {
      found.push(
        ...findings({
          schema: itemSchema,
          value: element,
          path: `data.${index}`,
        })
      );
    }
  }

  return found;
};

const collectFindings = (args: {
  schema: Record<string, unknown>;
  body: unknown;
}): Finding[] => {
  // A bare-array response (e.g. a list route that returns items directly) is
  // checked element-wise against the schema's `items`.
  if (Array.isArray(args.body)) {
    const itemSchema = resolveSchemaRef(args.schema.items);
    if (!isObjectRecord(itemSchema)) return [];
    return args.body.flatMap((element, index) => {
      return findings({
        schema: itemSchema,
        value: element,
        path: String(index),
      });
    });
  }

  return findings({ schema: args.schema, value: args.body, path: '' });
};

/**
 * Enabled outside production only. In tests a camelCase key throws, so the REST
 * suite is the enforcement mechanism; in development everything logs, so no
 * check ever blocks local work. Production never pays the cost.
 */
const isEnabled = (): boolean => {
  return process.env.NODE_ENV !== 'production';
};

export const responseContractMiddleware = async (ctx: Context, next: Next) => {
  await next();

  if (!isEnabled() || !ctx.path.startsWith('/api/v1')) return;

  const status = typeof ctx.status === 'number' ? ctx.status : 0;
  if (isErrorStatus(status)) return;

  const body = ctx.body;
  if (!isObjectRecord(body) && !Array.isArray(body)) return;

  const template = matchOpenApiPath({ path: ctx.path });
  if (!template) return;

  const schema = getRouteResponseSchema({
    method: ctx.method,
    path: template,
    status,
  });
  if (!schema) return;

  const found = collectFindings({ schema, body });
  if (found.length === 0) return;

  const where = `${ctx.method} ${template} (${status})`;

  const drifted = found.filter((f) => {
    return !f.camel;
  });
  if (drifted.length > 0) {
    log(
      '%s: key(s) not declared by the OpenAPI schema: %s (pre-existing spec ' +
        'drift — see tests/unit/openapiContract.ts)',
      where,
      drifted
        .map((f) => {
          return f.key;
        })
        .join(', ')
    );
  }

  const camel = found.filter((f) => {
    return f.camel;
  });
  if (camel.length === 0) return;

  const message =
    `Response for ${where} contains camelCase key(s): ` +
    `${camel
      .map((f) => {
        return f.key;
      })
      .join(', ')}. The wire contract is snake_case in both directions — the ` +
    `lib mapper for this resource must serialize every field with its spec ` +
    `name. Nothing rewrites keys at the boundary any more, so an unconverted ` +
    `field reaches the client as-is.`;

  log(message);

  if (process.env.NODE_ENV === 'test') {
    throw new Error(message);
  }
};
