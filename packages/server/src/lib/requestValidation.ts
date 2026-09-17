import createDebug from 'debug';

import { DomainError } from '../errors';
import type { FieldSpec } from './openapiSchemaFields';
import {
  deriveSchemaFields,
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
 * The top-level required fields the body does not carry. Only a closed object
 * root has them to enforce: a union root's required set is per branch, and an
 * open root declares none.
 */
const missingRequiredFields = (args: {
  schema: Record<string, unknown>;
  body: Record<string, unknown>;
}): string[] => {
  const { schema, body } = args;
  if (!hasProperties(schema) || isOpenOrAmbiguous(schema)) return [];

  const { requiredFields, fieldSpecs } = deriveSchemaFields({ schema });
  return [...requiredFields].filter((field) => {
    return isMissing(body[field], fieldSpecs[field]);
  });
};

/**
 * Validates a request body against the route's OpenAPI request schema — the
 * single source of truth for the REST contract, SDK, CLI and MCP surface.
 *
 * - **Unknown fields** are rejected at every nesting level (objects, arrays of
 *   objects, `$ref`s) with dotted paths; open levels are skipped, and a union
 *   of closed objects is judged against the union of their fields.
 * - **Required fields** are enforced at the top level only, replacing the
 *   per-handler `"X is required"` checks; nested schemas are less rigorously
 *   specified, so nested enforcement is out of scope.
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

  const missingFields = missingRequiredFields({ schema, body });

  if (unknownFields.length === 0 && missingFields.length === 0) return;

  const parts: string[] = [];
  if (unknownFields.length > 0) {
    parts.push(`Unknown field(s): ${unknownFields.join(', ')}`);
  }
  if (missingFields.length > 0) {
    parts.push(`Missing required field(s): ${missingFields.join(', ')}`);
  }

  log(
    'validateRequestBody: %s %s %s',
    args.method,
    args.path,
    parts.join('. ')
  );

  throw new DomainError('VALIDATION_FAILED', parts.join('. '), {
    ...(unknownFields.length > 0 ? { unknownFields } : {}),
    ...(missingFields.length > 0 ? { missingFields } : {}),
  });
};
