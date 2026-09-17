import createDebug from 'debug';

import type { Context } from '../Context';
import { isObjectRecord } from '../lib/openapiSchemaFields';
import {
  getRouteResponseSchema,
  matchOpenApiPath,
  resolveSchemaRef,
} from '../lib/openapiSpec';
// The same "not checkable at this level" rule the inbound walk applies.
import { isOpenOrAmbiguous } from '../lib/openapiUnknownFields';

const log = createDebug('soat:responseContract');

type Next = () => Promise<void>;

/**
 * Keeps responses on the documented contract as a check, never a rewrite.
 *
 * Every response body is serialized field by field in a lib mapper, so a mapper
 * emitting `projectId` where the spec says `project_id` is a plain bug. This
 * turns it into a deterministic failure, using the route's OpenAPI response
 * schema to decide what a key should have been called.
 *
 * It only ever *reads* the body, and two properties follow:
 *
 * - **Opaque bags are untouchable.** A guardrail `document`, a `tool_context`,
 *   a `tags` map — anything the spec models as an open object — is a *value*
 *   here. There is no skip list to forget a bag from, because a bag is never
 *   at risk.
 * - **Failures are loud, not silent.** A key-blind rewrite makes a mismatched
 *   key look correct; this makes it fail.
 *
 * Two severities on purpose. A **camelCase key** is a hard failure: under a
 * snake_case wire contract it can only mean a mapper skipped serialization. A
 * **snake_case key the spec does not declare** is logged, because it is spec
 * drift — ~1900 cases, documented in `tests/unit/openapiContract.ts` — and
 * throwing would turn this check into a burn-down of all of them.
 */

/** Statuses whose bodies are error envelopes, not the documented resource. */
const isErrorStatus = (status: number): boolean => {
  return status >= 400;
};

/** A key carrying an interior capital — `projectId`, `createdAt`, `PascalKey`. */
const isCamelCase = (key: string): boolean => {
  return /[a-z][A-Z]/.test(key);
};

type Finding = { key: string; camel: boolean };

/**
 * The item schema of a list envelope's `data` array, or `null` when this level
 * is not an envelope. Resolving it is the only non-recursive half of the descent.
 */
const envelopeItemSchema = (
  properties: Record<string, unknown>
): Record<string, unknown> | null => {
  const dataSchema = resolveSchemaRef(properties.data);
  const itemSchema = isObjectRecord(dataSchema)
    ? resolveSchemaRef(dataSchema.items)
    : null;

  return isObjectRecord(itemSchema) ? itemSchema : null;
};

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

  const own = Object.keys(args.value)
    .filter((key) => {
      return !declared.has(key);
    })
    .map((key) => {
      return {
        key: args.path ? `${args.path}.${key}` : key,
        camel: isCamelCase(key),
      };
    });

  // Exactly one level, into a list envelope's `data`. Deeper is deliberately
  // not walked: the spec thins out below a resource's top level, and a false
  // positive in a guardrail is worse than a missed key.
  const itemSchema = envelopeItemSchema(properties);
  const data = args.value.data;

  if (!itemSchema || !Array.isArray(data)) return own;

  return [
    ...own,
    ...data.flatMap((element, index) => {
      return findings({
        schema: itemSchema,
        value: element,
        path: `data.${index}`,
      });
    }),
  ];
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

/** The response body worth checking, or `null` when the route is out of scope. */
const checkableBody = (
  ctx: Context
): { body: unknown; status: number } | null => {
  if (!isEnabled() || !ctx.path.startsWith('/api/v1')) return null;

  const status = typeof ctx.status === 'number' ? ctx.status : 0;
  if (isErrorStatus(status)) return null;

  const body = ctx.body;
  if (!isObjectRecord(body) && !Array.isArray(body)) return null;

  return { body, status };
};

const keyList = (found: Finding[]): string => {
  return found
    .map((f) => {
      return f.key;
    })
    .join(', ');
};

/** Logs pre-existing spec drift; returns the camelCase findings to act on. */
const reportDrift = (args: { found: Finding[]; where: string }): Finding[] => {
  const drifted = args.found.filter((f) => {
    return !f.camel;
  });

  if (drifted.length > 0) {
    log(
      '%s: key(s) not declared by the OpenAPI schema: %s (pre-existing spec ' +
        'drift — see tests/unit/openapiContract.ts)',
      args.where,
      keyList(drifted)
    );
  }

  return args.found.filter((f) => {
    return f.camel;
  });
};

export const responseContractMiddleware = async (ctx: Context, next: Next) => {
  await next();

  const checkable = checkableBody(ctx);
  if (!checkable) return;

  const template = matchOpenApiPath({ path: ctx.path });
  if (!template) return;

  const schema = getRouteResponseSchema({
    method: ctx.method,
    path: template,
    status: checkable.status,
  });
  if (!schema) return;

  const found = collectFindings({ schema, body: checkable.body });
  if (found.length === 0) return;

  const where = `${ctx.method} ${template} (${checkable.status})`;
  const camel = reportDrift({ found, where });
  if (camel.length === 0) return;

  const message =
    `Response for ${where} contains camelCase key(s): ${keyList(camel)}. The ` +
    `wire contract is snake_case in both directions — the lib mapper for this ` +
    `resource must serialize every field with its spec name. Nothing rewrites ` +
    `keys at the boundary any more, so an unconverted field reaches the ` +
    `client as-is.`;

  log(message);

  if (process.env.NODE_ENV === 'test') {
    throw new Error(message);
  }
};
