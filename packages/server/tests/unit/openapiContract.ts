import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { getMergedOpenApiSpec, matchOpenApiPath } from 'src/lib/openapiSpec';

/**
 * OpenAPI ↔ server response contract validator.
 *
 * Every response returned by a `rest/` test through {@link authenticatedTestClient}
 * / {@link testClient} is checked against the OpenAPI 200/4xx schema declared for
 * its `(path, method, status)`. This turns the existing supertest suite into a
 * contract suite so spec-vs-server drift (issue #661) cannot recur.
 *
 * Scope / deliberate leniency:
 * - Only `application/json` responses under `/api/v1` are validated.
 * - `/openapi.json` and `/mcp` bypass the caseTransform middleware, so they are
 *   excluded (their bodies are camelCase, not the snake_case the specs describe).
 * - `additionalProperties` is left open (the OpenAPI default): the validator
 *   enforces declared field *types*, `required`, `enum`, and `nullable`, but does
 *   not fail on undocumented extra fields. Tightening to `additionalProperties:
 *   false` is a follow-up once the pre-existing field burn-down is complete.
 * - A `(path, method, status)` with no documented JSON schema is skipped rather
 *   than failed, to keep the blast radius bounded.
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
 * Returns `true` when the merged spec documents an `application/json` schema for
 * this `(template, method, status)`.
 */
const hasResponseSchema = (args: {
  template: string;
  method: string;
  status: number;
}): boolean => {
  const pathItem = getMergedOpenApiSpec().paths[args.template];
  if (!isRecord(pathItem)) return false;
  const operation = pathItem[args.method];
  if (!isRecord(operation)) return false;
  const responses = operation.responses;
  if (!isRecord(responses)) return false;
  const response = responses[String(args.status)];
  if (!isRecord(response)) return false;
  const content = response.content;
  if (!isRecord(content)) return false;
  const json = content['application/json'];
  return isRecord(json) && json.schema !== undefined;
};

const getResponseValidator = (args: {
  template: string;
  method: string;
  status: number;
}): ValidateFunction | null => {
  const cacheKey = `${args.method} ${args.template} ${args.status}`;
  const cached = validatorCache.get(cacheKey);
  if (cached !== undefined) return cached;

  if (!hasResponseSchema(args)) {
    validatorCache.set(cacheKey, null);
    return null;
  }

  // Reference the exact response schema inside the registered spec so that its
  // nested `#/components/...` refs resolve against the same document.
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

  const validator = getAjv().compile({ $ref: `${SPEC_ID}#/${pointer}` });
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
