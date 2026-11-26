import createDebug from 'debug';

import { DomainError } from '../errors';
import type { FieldSpec } from './openapiSchemaFields';
import {
  deriveSchemaFields,
  fieldTypeError,
  hasProperties,
  isObjectRecord,
} from './openapiSchemaFields';
import {
  getRouteRequestSchema,
  normalizeRoutePath,
  resolveSchemaRef,
} from './openapiSpec';
import {
  collectMissingRequiredFields,
  collectUnknownFields,
  isOpenOrAmbiguous,
} from './openapiUnknownFields';
import { collectSchemaViolations } from './requestSchemaViolations';

const log = createDebug('soat:requestValidation');

const isMissing = (
  value: unknown,
  fieldSpec: FieldSpec | undefined
): boolean => {
  if (value === undefined) return true;
  // A required nullable field is sent as `null` to clear what it names.
  if (value === null) return fieldSpec?.nullable !== true;
  // Treat an empty string as absent for required string fields, matching the
  // `if (!field)` presence checks this enforcement replaces.
  return fieldSpec?.type === 'string' && value === '';
};

/**
 * The declared types a body value is checked against. A scalar is read as a
 * column value, where an object becomes a query operator and an array `IN`.
 * Collection fields keep their routes' documented coercions (a JSON-encoded
 * guardrail `document`, a scalar `document_paths`).
 */
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean']);

/**
 * The required fields the body does not carry below the top level, by dotted
 * path, from the walk that finds unknown keys.
 */
const nestedMissingFields = (args: {
  schema: Record<string, unknown>;
  body: Record<string, unknown>;
}): string[] => {
  return collectMissingRequiredFields(
    { schema: args.schema, value: args.body },
    { resolveRef: resolveSchemaRef }
  )
    .filter((field) => {
      return !field.topLevel;
    })
    .map((field) => {
      return field.path;
    });
};

/**
 * The top-level required fields the body does not carry, and the present ones
 * whose value is not of the declared type. Only a closed object root has them
 * to enforce: a union root's fields are per branch, and an open root declares
 * none.
 */
const topLevelFieldErrors = (args: {
  schema: Record<string, unknown>;
  body: Record<string, unknown>;
}): {
  missingFields: string[];
  typeErrors: Array<{ field: string; message: string }>;
} => {
  const { schema, body } = args;
  if (!hasProperties(schema) || isOpenOrAmbiguous(schema)) {
    return { missingFields: [], typeErrors: [] };
  }

  const { requiredFields, fieldSpecs } = deriveSchemaFields({
    schema,
    resolveRef: resolveSchemaRef,
  });
  const missingFields = [...requiredFields].filter((field) => {
    return isMissing(body[field], fieldSpecs[field]);
  });
  const typeErrors = Object.entries(fieldSpecs).flatMap(
    ([fieldName, fieldSpec]) => {
      const value = body[fieldName];
      if (value === undefined || missingFields.includes(fieldName)) return [];
      if (!SCALAR_TYPES.has(fieldSpec.type ?? '')) return [];
      const message = fieldTypeError({ fieldName, fieldSpec, value });
      return message ? [{ field: fieldName, message }] : [];
    }
  );
  return { missingFields, typeErrors };
};

/**
 * Validates a request body against the route's OpenAPI request schema — the
 * single source of truth for the REST contract, SDK, CLI and MCP surface.
 *
 * - **Unknown fields** are rejected at every nesting level (objects, arrays of
 *   objects, `$ref`s) with dotted paths; open levels are skipped, and a union
 *   of closed objects is judged against the union of their fields.
 * - **Required fields** at every level the unknown-field walk reads are named
 *   field by field (`missing_fields`), nested ones by dotted path; **scalar
 *   types** at the top level (`invalid_fields`).
 * - **The full schema** is checked once those pass: a value of any depth that
 *   breaks its type, union, enum, bound or required list is in
 *   `invalid_fields`; a union names what breaks the one branch its value is
 *   of, and a key that closed branch does not declare is in `unknown_fields`.
 *
 * `path` is the route as registered (`/agents/:agent_id`), normalized to the
 * OpenAPI path key internally. Field names are compared against the spec's own
 * snake_case names — nothing rewrites keys in between. No-ops when the route
 * has no property-based JSON body schema.
 *
 * @throws {DomainError} `VALIDATION_FAILED` (400).
 */
export const validateRequestBody = (args: {
  method: string;
  path: string;
  body: unknown;
}): void => {
  const schema = getRouteRequestSchema({
    method: args.method,
    path: args.path,
  });

  if (!schema) return;

  const body = isObjectRecord(args.body) ? args.body : {};

  const walkedUnknownFields = collectUnknownFields(
    { schema, value: body },
    { resolveRef: resolveSchemaRef }
  ).map((field) => {
    return field.path;
  });

  const template = normalizeRoutePath(args.path);
  const fieldErrors = topLevelFieldErrors({ schema, body });
  const missingFields = [
    ...fieldErrors.missingFields,
    ...nestedMissingFields({ schema, body }),
  ];
  const violations =
    walkedUnknownFields.length > 0 ||
    missingFields.length > 0 ||
    fieldErrors.typeErrors.length > 0
      ? []
      : collectSchemaViolations({
          template,
          method: args.method,
          body,
        });
  const unknownFields = [
    ...walkedUnknownFields,
    ...violations.flatMap((violation) => {
      return violation.kind === 'unknown' ? [violation.field] : [];
    }),
  ];
  const typeErrors = [
    ...fieldErrors.typeErrors,
    ...violations.flatMap((violation) => {
      return violation.kind === 'invalid' ? [violation] : [];
    }),
  ];
  const invalidFields = typeErrors.map((typeError) => {
    return typeError.field;
  });

  const lists = {
    unknown_fields: unknownFields,
    missing_fields: missingFields,
    invalid_fields: invalidFields,
  };
  const parts = [
    unknownFields.length > 0 && `Unknown field(s): ${unknownFields.join(', ')}`,
    missingFields.length > 0 &&
      `Missing required field(s): ${missingFields.join(', ')}`,
    ...typeErrors.map((typeError) => {
      return typeError.message;
    }),
  ].filter((part): part is string => {
    return typeof part === 'string';
  });
  if (parts.length === 0) return;

  log(
    'validateRequestBody: %s %s %s',
    args.method,
    args.path,
    parts.join('. ')
  );

  throw new DomainError(
    'VALIDATION_FAILED',
    parts.join('. '),
    Object.fromEntries(
      Object.entries(lists).filter(([, fields]) => {
        return fields.length > 0;
      })
    )
  );
};
