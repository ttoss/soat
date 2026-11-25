import { Ajv, type ValidateFunction } from 'ajv';

import { isObjectRecord } from './openapiSchemaFields';
import { getMergedOpenApiSpec } from './openapiSpec';

// OpenAPI-only keywords that are not JSON Schema draft-07; `example(s)` are
// documentation-only.
const STRIPPED_KEYWORDS = new Set([
  'example',
  'examples',
  'xml',
  'externalDocs',
  'discriminator',
  'deprecated',
]);

/**
 * Rewrites `nullable: true` in place into a JSON-Schema `null` union,
 * preserving any `$ref`/`oneOf` by wrapping in `anyOf`.
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
    const inner = { ...out };
    for (const key of Object.keys(out)) delete out[key];
    out.anyOf = [inner, { type: 'null' }];
  }
};

// Component names are unique across the merged document, so a cross-file ref
// (`./tools.yaml#/components/schemas/X`) resolves as its local fragment.
const localizeRef = (value: string): string => {
  return value.includes('#')
    ? `#${value.slice(value.indexOf('#') + 1)}`
    : value;
};

/**
 * An OpenAPI 3.0 schema fragment as the draft-07 schema ajv reads, built on a
 * copy so the cached merged spec is never mutated.
 */
export const toJsonSchema = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(toJsonSchema);
  if (!isObjectRecord(node)) return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (STRIPPED_KEYWORDS.has(key)) continue;
    if (key === '$ref' && typeof value === 'string') {
      out[key] = localizeRef(value);
      continue;
    }
    out[key] = toJsonSchema(value);
  }

  applyNullable(out);
  return out;
};

/** Escapes a single JSON Pointer reference token (RFC 6901). */
export const escapePointerToken = (token: string): string => {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
};

const SPEC_ID = 'openapi';

type MergedSpec = ReturnType<typeof getMergedOpenApiSpec>;

const specAjvs = new WeakMap<MergedSpec, Ajv>();
const requestValidators = new WeakMap<
  MergedSpec,
  Map<string, ValidateFunction | null>
>();

const ajvFor = (spec: MergedSpec): Ajv => {
  const cached = specAjvs.get(spec);
  if (cached) return cached;
  // `format` stays an annotation: asserting it would refuse values whose
  // schema author never claimed them invalid.
  const ajv = new Ajv({
    strict: false,
    allErrors: true,
    validateFormats: false,
    // An enum refusal names the value it got.
    verbose: true,
  });
  const schema = toJsonSchema(spec);
  if (isObjectRecord(schema)) ajv.addSchema(schema, SPEC_ID);
  specAjvs.set(spec, ajv);
  return ajv;
};

// A `#/...` ref inside a fragment names a place in the spec, not the fragment.
const anchorRefs = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(anchorRefs);
  if (!isObjectRecord(node)) return node;
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => {
      return key === '$ref' &&
        typeof value === 'string' &&
        value.startsWith('#')
        ? [key, `${SPEC_ID}${value}`]
        : [key, anchorRefs(value)];
    })
  );
};

const fragmentValidators = new WeakMap<object, ValidateFunction>();

/**
 * The validator of one fragment of the compiled spec, such as a branch of a
 * union a request body failed, with its `$ref`s resolved inside the spec.
 */
export const getSpecFragmentValidator = (
  fragment: Record<string, unknown>
): ValidateFunction => {
  const cached = fragmentValidators.get(fragment);
  if (cached) return cached;
  const schema = anchorRefs(fragment);
  const validator = ajvFor(getMergedOpenApiSpec()).compile(
    isObjectRecord(schema) ? schema : {}
  );
  fragmentValidators.set(fragment, validator);
  return validator;
};

const hasJsonRequestBody = (args: {
  spec: MergedSpec;
  template: string;
  method: string;
}): boolean => {
  const pathItem = args.spec.paths[args.template];
  if (!isObjectRecord(pathItem)) return false;
  const operation = pathItem[args.method];
  if (!isObjectRecord(operation)) return false;
  const { requestBody } = operation;
  if (!isObjectRecord(requestBody)) return false;
  const { content } = requestBody;
  return isObjectRecord(content) && isObjectRecord(content['application/json']);
};

/**
 * The compiled validator for an operation's `application/json` request body,
 * resolved inside the whole spec so its nested `$ref`s resolve; `null` when the
 * operation declares no JSON body. `template` is the OpenAPI path key.
 */
export const getRequestBodyValidator = (args: {
  template: string;
  method: string;
}): ValidateFunction | null => {
  const spec = getMergedOpenApiSpec();
  const method = args.method.toLowerCase();
  const key = `${method} ${args.template}`;
  const validators = requestValidators.get(spec) ?? new Map();
  requestValidators.set(spec, validators);
  const cached = validators.get(key);
  if (cached !== undefined) return cached;

  const pointer = [
    'paths',
    escapePointerToken(args.template),
    method,
    'requestBody',
    'content',
    escapePointerToken('application/json'),
    'schema',
  ].join('/');
  const validator = hasJsonRequestBody({
    spec,
    template: args.template,
    method,
  })
    ? ajvFor(spec).compile({ $ref: `${SPEC_ID}#/${pointer}` })
    : null;
  validators.set(key, validator);
  return validator;
};
