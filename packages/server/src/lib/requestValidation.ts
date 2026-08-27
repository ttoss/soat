import createDebug from 'debug';

import { DomainError } from '../errors';
import type { FieldSpec, SchemaWithProperties } from './openapiSchemaFields';
import {
  deriveSchemaFields,
  hasProperties,
  isObjectRecord,
} from './openapiSchemaFields';
import { getRouteRequestSchema, resolveSchemaRef } from './openapiSpec';

const log = createDebug('soat:requestValidation');

const joinPath = (base: string, key: string): string => {
  return base ? `${base}.${key}` : key;
};

/**
 * A schema level is "open or ambiguous" — and therefore not walked — when it
 * accepts arbitrary keys or could take multiple shapes:
 * - `oneOf`/`anyOf`/`allOf` — the concrete branch is unknown, so any property
 *   set could be valid.
 * - `additionalProperties: true` or a schema map — an open key/value map
 *   (tags, `tool_context`, `input_mapping`, …).
 * - no `properties` — a free-form object (`metadata`, JSON-logic blobs, …).
 */
const isOpenOrAmbiguous = (schema: Record<string, unknown>): boolean => {
  if ('oneOf' in schema || 'anyOf' in schema || 'allOf' in schema) {
    return true;
  }
  const additional = schema.additionalProperties;
  if (additional === true || isObjectRecord(additional)) {
    return true;
  }
  return !isObjectRecord(schema.properties);
};

type WalkFrame = { schema: unknown; value: unknown; path: string };

// One frame per present property — an array of objects yields an indexed frame
// per element against the `items` schema. `$ref`s are resolved here.
const childFrames = (
  schema: SchemaWithProperties,
  value: Record<string, unknown>,
  path: string
): WalkFrame[] => {
  const frames: WalkFrame[] = [];
  for (const [propName, rawProp] of Object.entries(schema.properties)) {
    const childValue = value[propName];
    if (childValue === undefined || childValue === null) continue;

    const propSchema = resolveSchemaRef(rawProp);
    if (!isObjectRecord(propSchema)) continue;

    const childPath = joinPath(path, propName);
    const itemSchema = resolveSchemaRef(propSchema.items);
    if (Array.isArray(childValue) && isObjectRecord(itemSchema)) {
      for (const [index, element] of childValue.entries()) {
        frames.push({
          schema: itemSchema,
          value: element,
          path: `${childPath}.${index}`,
        });
      }
    } else {
      frames.push({ schema: propSchema, value: childValue, path: childPath });
    }
  }
  return frames;
};

/**
 * Walks a request body against its OpenAPI schema (iteratively), collecting the
 * dotted paths of every field not declared by a closed object level. Descends
 * through nested objects, arrays of objects, and `$ref`s; skips open/ambiguous
 * levels (see `isOpenOrAmbiguous`) so passthrough maps and `oneOf` unions are
 * never flagged.
 */
const collectUnknownFields = (
  rootSchema: unknown,
  rootValue: unknown,
  out: string[]
): void => {
  const stack: WalkFrame[] = [
    { schema: rootSchema, value: rootValue, path: '' },
  ];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) continue;

    const schema = resolveSchemaRef(frame.schema);
    if (!isObjectRecord(schema) || !isObjectRecord(frame.value)) continue;
    if (isOpenOrAmbiguous(schema) || !hasProperties(schema)) continue;

    const { allowedFields } = deriveSchemaFields({ schema });
    for (const key of Object.keys(frame.value)) {
      if (!allowedFields.has(key)) out.push(joinPath(frame.path, key));
    }

    stack.push(...childFrames(schema, frame.value, frame.path));
  }
};

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
 * Validates a request body against the route's OpenAPI request schema — the
 * single source of truth for the REST contract, SDK, CLI and MCP surface.
 *
 * - **Unknown fields** are rejected at every nesting level (objects, arrays of
 *   objects, `$ref`s) with dotted paths; open/ambiguous levels are skipped.
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

  if (!hasProperties(schema) || isOpenOrAmbiguous(schema)) return;

  const body = isObjectRecord(args.body) ? args.body : {};

  const unknownFields: string[] = [];
  collectUnknownFields(schema, body, unknownFields);

  const { requiredFields, fieldSpecs } = deriveSchemaFields({ schema });
  const missingFields = [...requiredFields].filter((field) => {
    return isMissing(body[field], fieldSpecs[field]);
  });

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
