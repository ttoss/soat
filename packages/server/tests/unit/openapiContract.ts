import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { getMergedOpenApiSpec, matchOpenApiPath } from 'src/lib/openapiSpec';

/**
 * OpenAPI ↔ server response contract validator.
 *
 * Responses returned by a `rest/` test through {@link authenticatedTestClient} /
 * {@link testClient} are checked against the OpenAPI schema for their
 * `(path, method, status)` so the shapes issue #661 governs cannot drift again.
 *
 * Enforcement scope (deliberately narrow):
 * - **List endpoints** — validated against the shared envelope contract
 *   `{ data: [], total, limit, offset }` (top level only; item shapes are left to
 *   each endpoint's own assertions).
 * - **`AgentGenerationResponse`** — the two agent generation routes are validated
 *   against the full (now-corrected) schema (Bug 2).
 * - **Everything else is skipped.** A first attempt validated *every* response
 *   against its full schema and surfaced ~1900 failures rooted in pervasive
 *   PRE-EXISTING spec drift across the whole API (e.g. nullable-in-practice
 *   fields typed as non-nullable `string`), cascading through shared fixtures.
 *   That burn-down is real but out of scope for #661; tightening this validator
 *   to the full surface (and `additionalProperties: false`) is a follow-up.
 * - Only `application/json` responses under `/api/v1` are considered;
 *   `/openapi.json` and `/mcp` (which bypass caseTransform) are excluded.
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
const validatorCache = new Map<string, ValidateFunction | null>();

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

/** The `AgentGenerationResponse` schema (issue #661 Bug 2). */
const isAgentGenerationSchema = (schema: Record<string, unknown>): boolean => {
  return (
    typeof schema.$ref === 'string' &&
    schema.$ref.endsWith('/AgentGenerationResponse')
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
 * Returns a validator ONLY for the operations this PR governs — every list
 * endpoint (validated against the envelope contract) and the two agent
 * generation routes (`AgentGenerationResponse`). Every other `(path, method,
 * status)` returns `null` (skipped), deliberately leaving the wider API's
 * pre-existing spec drift for a separate burn-down.
 */
const getResponseValidator = (args: {
  template: string;
  method: string;
  status: number;
}): ValidateFunction | null => {
  const cacheKey = `${args.method} ${args.template} ${args.status}`;
  const cached = validatorCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const schema = getRawResponseSchema(args);
  let validator: ValidateFunction | null = null;

  if (schema && isEnvelopeSchema(schema)) {
    validator = getEnvelopeValidator();
  } else if (schema && isAgentGenerationSchema(schema)) {
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
    validator = getAjv().compile({ $ref: `${SPEC_ID}#/${pointer}` });
  }

  validatorCache.set(cacheKey, validator);
  return validator;
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

  const validator = getResponseValidator({
    template,
    method,
    status: args.status,
  });
  if (!validator) return;

  const valid = validator(args.body);
  if (!valid) {
    throw new Error(
      `OpenAPI contract violation: ${method.toUpperCase()} ${template} → ${
        args.status
      }\n${formatErrors(validator.errors)}`
    );
  }
};
