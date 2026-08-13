import { appendFileSync } from 'node:fs';

import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { getMergedOpenApiSpec, matchOpenApiPath } from 'src/lib/openapiSpec';

// Audit mode: validate EVERY response against its full schema and append
// violations to the given JSONL file instead of throwing. Used to enumerate
// the pre-existing spec drift; never set in CI.
const AUDIT_FILE = process.env.OPENAPI_DRIFT_AUDIT_FILE;

/**
 * OpenAPI ↔ server response contract validator.
 *
 * Responses returned by a `rest/` test through {@link authenticatedTestClient} /
 * {@link testClient} are checked against the OpenAPI schema for their
 * `(path, method, status)` so the shapes issue #661 governs cannot drift again.
 *
 * Enforcement scope (full surface since the 2026-08 drift burn-down, #977):
 * - **Every documented `(path, method, status)` JSON schema** is enforced on
 *   every response a `rest/` test produces. The pre-existing drift (~1900 raw
 *   failures at the time of #661) was enumerated and burned down before this
 *   was switched on; a mapper or spec change that reintroduces drift now
 *   fails the suite with the field named. `additionalProperties: false`
 *   (rejecting undeclared response keys) remains a follow-up.
 * - **List endpoints** are additionally validated against the synthesized
 *   envelope contract `{ data: [], total, limit, offset }`, which asserts
 *   `required` — the list schemas themselves do not.
 * - Only `application/json` responses under `/api/v1` are considered;
 *   `/openapi.json` and `/mcp` (which bypass caseTransform) are excluded.
 * - With `OPENAPI_DRIFT_AUDIT_FILE` set, violations are appended as JSONL
 *   instead of thrown — the enumeration mode used for the burn-down.
 */

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

// OpenAPI-only keywords that are not valid JSON Schema draft-07 and would make
// Ajv strict-mode unhappy. `example(s)` are documentation-only.
const STRIPPED_KEYWORDS = new Set([
  'example',
  'examples',
  'xml',
  'externalDocs',
  'discriminator',
  'deprecated',
]);

/**
 * Rewrites `nullable: true` in place on a sanitized node into a JSON-Schema
 * `null` union, preserving any `$ref`/`oneOf` by wrapping in `anyOf`.
 */
const applyNullable = (out: Record<string, unknown>): void => {
  const nullable = out.nullable;
  delete out.nullable;
  if (nullable !== true) return;

  if (typeof out.type === 'string') {
    out.type = [out.type, 'null'];
  } else if (Array.isArray(out.type)) {
    if (!out.type.includes('null')) out.type.push('null');
  } else {
    // No plain `type` (e.g. a `$ref` / `oneOf` node): express nullability as
    // an explicit union so the ref is preserved.
    const inner = { ...out };
    for (const key of Object.keys(out)) delete out[key];
    out.anyOf = [inner, { type: 'null' }];
  }
};

// The per-file specs are merged into one document, but some use cross-file refs
// like `./tools.yaml#/components/schemas/X`. Every component name is unique
// across the merged doc, so collapse any ref to its local fragment so it
// resolves within the registered spec.
const localizeRef = (value: string): string => {
  return value.includes('#')
    ? `#${value.slice(value.indexOf('#') + 1)}`
    : value;
};

/**
 * Recursively converts an OpenAPI 3.0 schema fragment into a draft-07 schema
 * Ajv understands. Operates on a deep clone so the cached merged spec is never
 * mutated.
 */
const sanitizeSchema = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(sanitizeSchema);
  if (!isRecord(node)) return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (STRIPPED_KEYWORDS.has(key)) continue;
    if (key === '$ref' && typeof value === 'string') {
      out[key] = localizeRef(value);
      continue;
    }
    out[key] = sanitizeSchema(value);
  }

  applyNullable(out);
  return out;
};

let ajv: Ajv | null = null;
const validatorCache = new Map<string, ValidateFunction[]>();

// The whole merged spec is registered under this base id so a response schema's
// internal `$ref: '#/components/schemas/X'` resolves against the spec root.
const SPEC_ID = 'openapi';

const getAjv = (): Ajv => {
  if (ajv) return ajv;

  const sanitized = sanitizeSchema(getMergedOpenApiSpec()) as Record<
    string,
    unknown
  >;

  ajv = new Ajv({
    strict: false,
    allErrors: true,
    validateFormats: false,
  });
  addFormats(ajv);
  ajv.addSchema(sanitized, SPEC_ID);

  return ajv;
};

/** Escapes a single JSON Pointer reference token (RFC 6901). */
const escapePointerToken = (token: string): string => {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
};

/**
 * Returns the raw `application/json` response schema node for this
 * `(template, method, status)`, or `undefined` when none is documented.
 */
const getRawResponseSchema = (args: {
  template: string;
  method: string;
  status: number;
}): Record<string, unknown> | undefined => {
  const pathItem = getMergedOpenApiSpec().paths[args.template];
  if (!isRecord(pathItem)) return undefined;
  const operation = pathItem[args.method];
  if (!isRecord(operation)) return undefined;
  const responses = operation.responses;
  if (!isRecord(responses)) return undefined;
  const response = responses[String(args.status)];
  if (!isRecord(response)) return undefined;
  const content = response.content;
  if (!isRecord(content)) return undefined;
  const json = content['application/json'];
  if (!isRecord(json) || !isRecord(json.schema)) return undefined;
  return json.schema;
};

// The synthesized schema that enforces the list envelope contract at the top
// level. Item shapes are intentionally NOT validated here — per-endpoint tests
// already assert item fields, and the wider API's pre-existing spec drift is a
// separate burn-down. See the module doc comment.
const ENVELOPE_SCHEMA = {
  type: 'object',
  required: ['data', 'total', 'limit', 'offset'],
  properties: {
    data: { type: 'array' },
    total: { type: 'integer' },
    limit: { type: 'integer' },
    offset: { type: 'integer' },
  },
} as const;

/** A list-envelope response schema: an object with data/total/limit/offset. */
const isEnvelopeSchema = (schema: Record<string, unknown>): boolean => {
  if (schema.type !== 'object' || !isRecord(schema.properties)) return false;
  const p = schema.properties;
  return (
    isRecord(p.data) &&
    p.data.type === 'array' &&
    'total' in p &&
    'limit' in p &&
    'offset' in p
  );
};

let envelopeValidator: ValidateFunction | null = null;
const getEnvelopeValidator = (): ValidateFunction => {
  if (!envelopeValidator) {
    envelopeValidator = getAjv().compile(ENVELOPE_SCHEMA);
  }
  return envelopeValidator;
};

/**
 * Returns the validators for a `(path, method, status)`: the full documented
 * response schema (full-surface enforcement — every documented JSON response
 * is validated since the 2026-08 drift burn-down), plus, for list endpoints,
 * the synthesized envelope contract. The envelope check is kept alongside the
 * full schema because it asserts `required` on data/total/limit/offset, which
 * the list schemas themselves do not declare — dropping it would weaken the
 * #661 guarantee.
 */
const getResponseValidators = (args: {
  template: string;
  method: string;
  status: number;
}): ValidateFunction[] => {
  const cacheKey = `${args.method} ${args.template} ${args.status}`;
  const cached = validatorCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const schema = getRawResponseSchema(args);
  const validators: ValidateFunction[] = [];

  if (schema) {
    // Reference the schema inside the registered spec so its nested
    // `#/components/...` refs resolve against the same document.
    const pointer = [
      'paths',
      escapePointerToken(args.template),
      args.method,
      'responses',
      escapePointerToken(String(args.status)),
      'content',
      escapePointerToken('application/json'),
      'schema',
    ].join('/');
    validators.push(getAjv().compile({ $ref: `${SPEC_ID}#/${pointer}` }));

    if (isEnvelopeSchema(schema)) {
      validators.push(getEnvelopeValidator());
    }
  }

  validatorCache.set(cacheKey, validators);
  return validators;
};

const formatErrors = (errors: ErrorObject[] | null | undefined): string => {
  if (!errors || errors.length === 0) return 'unknown validation error';
  return errors
    .slice(0, 8)
    .map((e) => {
      return `  • ${e.instancePath || '(root)'} ${e.message}`;
    })
    .join('\n');
};

const shouldSkip = (path: string): boolean => {
  // Strip query string.
  const clean = path.split('?')[0];
  if (!clean.startsWith('/api/v1')) return true;
  if (clean === '/api/v1/openapi.json' || clean.startsWith('/api/v1/mcp')) {
    return true;
  }
  return false;
};

/**
 * Validates a single supertest response against its OpenAPI response schema.
 * Throws (failing the test) on any shape mismatch. No-ops for responses without
 * a documented JSON schema, non-JSON bodies, or excluded paths.
 */
export const assertResponseMatchesSpec = (args: {
  method: string;
  path: string;
  status: number;
  body: unknown;
  contentType?: string;
}): void => {
  const method = args.method.toLowerCase();
  if (!HTTP_METHODS.has(method)) return;
  if (shouldSkip(args.path)) return;

  // Only JSON bodies are described by the specs.
  const contentType = args.contentType ?? '';
  if (contentType && !contentType.includes('application/json')) return;

  const template = matchOpenApiPath({ path: args.path.split('?')[0] });
  if (!template) return;

  const validators = getResponseValidators({
    template,
    method,
    status: args.status,
  });

  for (const validator of validators) {
    if (validator(args.body)) continue;

    if (AUDIT_FILE) {
      const record = {
        method: method.toUpperCase(),
        template,
        status: args.status,
        errors: (validator.errors ?? []).map((e) => {
          return {
            instancePath: e.instancePath,
            keyword: e.keyword,
            message: e.message,
            params: e.params,
          };
        }),
      };
      appendFileSync(AUDIT_FILE, `${JSON.stringify(record)}\n`);
      continue;
    }

    throw new Error(
      `OpenAPI contract violation: ${method.toUpperCase()} ${template} → ${
        args.status
      }\n${formatErrors(validator.errors)}`
    );
  }
};
