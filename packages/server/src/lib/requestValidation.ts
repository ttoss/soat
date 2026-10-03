import createDebug from 'debug';

import { DomainError } from '../errors';
import type { FieldSpec } from './openapiSchemaFields';
import {
  deriveSchemaFields,
  fieldTypeError,
  hasProperties,
  isObjectRecord,
} from './openapiSchemaFields';
import { getRouteRequestSchema, resolveSchemaRef } from './openapiSpec';
import {
  collectUnknownFields,
  isOpenOrAmbiguous,
} from './openapiUnknownFields';

const log = createDebug('soat:requestValidation');

const isMissing = (
  value: unknown,
  fieldSpec: FieldSpec | undefined
): boolean => {
  if (value === undefined || value === null) return true;
  // Treat an empty string as absent for required string fields, matching the
  // `if (!field)` presence checks this enforcement replaces.
  return fieldSpec?.type === 'string' && value === '';
};

/**
 * The declared types a body value is checked against. A scalar is read as a
 * column value, where an object becomes a query operator and an array `IN`.
 * Collection fields keep their routes' documented coercions (a JSON-encoded
 * `parameters`, a scalar `document_paths`).
 */
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean']);

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

  const { requiredFields, fieldSpecs } = deriveSchemaFields({ schema });
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
 * - **Required fields and scalar types** are enforced at the top level only,
 *   replacing the per-handler `"X is required"` checks; nested schemas are
 *   less rigorously specified, so nested enforcement is out of scope.
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

  const unknownFields = collectUnknownFields(
    { schema, value: body },
    { resolveRef: resolveSchemaRef }
  ).map((field) => {
    return field.path;
  });

  const { missingFields, typeErrors } = topLevelFieldErrors({ schema, body });
  const invalidFields = typeErrors.map((typeError) => {
    return typeError.field;
  });

  const lists = { unknownFields, missingFields, invalidFields };
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
