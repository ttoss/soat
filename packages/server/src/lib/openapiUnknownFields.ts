/**
 * The one walk that finds the keys a value carries and its OpenAPI schema does
 * not declare — at every nesting level the schema describes.
 *
 * Two validators read the same contract from opposite ends: REST bodies
 * (`requestValidation.ts`) and formation templates
 * (`formation-modules/formationSpecLoader.ts`). A key a schema does not declare
 * is meaningless by construction, so both refuse it at the same depth: one walk
 * rather than two, because two would let the paths to the same resource
 * disagree about what a field list means — a template deploying green on a
 * nested key its own route answers `400` for.
 *
 * The walk only ever *reads* the value. It reports; each caller decides whether
 * to throw or accumulate, and how to word the refusal.
 */

import type { SchemaWithProperties } from './openapiSchemaFields';
import {
  deriveSchemaFields,
  hasProperties,
  isObjectRecord,
} from './openapiSchemaFields';

/** Follows a `$ref`, or returns an inline schema unchanged. */
export type SchemaRefResolver = (
  schema: unknown
) => Record<string, unknown> | null;

/**
 * Resolver for a schema document that declares no components to point at — an
 * operator's registered resource-type schema. An inline level is returned as
 * written; a `$ref` names nothing resolvable, so the level is skipped rather
 * than judged against a same-named schema of SOAT's own.
 */
export const resolveInlineSchema: SchemaRefResolver = (schema) => {
  if (!isObjectRecord(schema)) return null;
  return '$ref' in schema ? null : schema;
};

/** One key the schema does not declare, with the field list it was judged against. */
export type UnknownField = {
  /** Dotted path from the walked root: `knowledge_config.extraction`. */
  path: string;
  /** The declared field names at that level, in schema order. */
  allowedFields: string[];
};

const joinPath = (base: string, key: string): string => {
  return base ? `${base}.${key}` : key;
};

/**
 * A schema level is "open or ambiguous" — no single field list to read a key
 * against — when it accepts arbitrary keys or could take multiple shapes:
 * - `oneOf`/`anyOf`/`allOf` — the concrete branch is unknown, so any property
 *   set could be valid. {@link collectUnknownFields} takes the one case this
 *   still answers (every branch closed) before consulting this.
 * - `additionalProperties: true` or a schema map — an open key/value map
 *   (tags, `tool_context`, `input_mapping`, …).
 * - no `properties` — a free-form object (`metadata`, JSON-logic blobs, …).
 *
 * `additionalProperties: false` and an absent `additionalProperties` both read
 * as closed: the declared field list is the whole list. Every schema a request
 * or a template reaches states which of the two it is — pinned by
 * `tests/unit/tests/lib/openapiClosedSchemas.test.ts`.
 */
export const isOpenOrAmbiguous = (schema: Record<string, unknown>): boolean => {
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

type Level = {
  schema: SchemaWithProperties;
  value: Record<string, unknown>;
  path: string;
};

type WalkOptions = {
  resolveRef: SchemaRefResolver;
  /**
   * Values to treat as opaque wherever they appear. A formation template writes
   * `{ "param": "kc" }` where the schema declares an object, and the whole
   * value resolves at deploy time — reading its keys against the schema would
   * refuse every parameterised template.
   */
  isOpaque?: (value: unknown) => boolean;
};

// One frame per present property — an array of objects yields an indexed frame
// per element against the `items` schema. `$ref`s are resolved here.
const childFrames = (args: Level, options: WalkOptions): WalkFrame[] => {
  const frames: WalkFrame[] = [];
  for (const [propName, rawProp] of Object.entries(args.schema.properties)) {
    const childValue = args.value[propName];
    if (childValue === undefined || childValue === null) continue;

    const propSchema = options.resolveRef(rawProp);
    if (!isObjectRecord(propSchema)) continue;

    const childPath = joinPath(args.path, propName);
    const itemSchema = options.resolveRef(propSchema.items);
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

const unknownKeysIn = (args: {
  value: Record<string, unknown>;
  path: string;
  allowedFields: string[];
}): UnknownField[] => {
  const allowed = new Set(args.allowedFields);
  const out: UnknownField[] = [];
  for (const [key, value] of Object.entries(args.value)) {
    if (value === undefined || allowed.has(key)) continue;
    out.push({
      path: joinPath(args.path, key),
      allowedFields: args.allowedFields,
    });
  }
  return out;
};

/**
 * Every field any branch of a `oneOf`/`anyOf` declares, when all of them are
 * closed object schemas — a union of field lists is still a finite field list,
 * so a key none of them names is unknown whichever branch the value means.
 * Which branch it is stays the handler's question, so the level is judged
 * against the union and never descended into.
 *
 * `null` when the level is not such a union: one open or non-object branch
 * means any key could be valid.
 */
const closedUnionFields = (
  schema: Record<string, unknown>,
  options: WalkOptions
): string[] | null => {
  const branches = schema.oneOf ?? schema.anyOf;
  if (!Array.isArray(branches) || branches.length === 0) return null;

  const fields: string[] = [];
  for (const rawBranch of branches) {
    const branch = options.resolveRef(rawBranch);
    if (!isObjectRecord(branch)) return null;
    if (isOpenOrAmbiguous(branch) || !hasProperties(branch)) return null;
    for (const name of Object.keys(branch.properties)) {
      if (!fields.includes(name)) fields.push(name);
    }
  }
  return fields;
};

/**
 * One frame's reading: the keys its level does not declare, and the frames its
 * present properties open. A frame with nothing to judge a key against — a
 * scalar, an opaque value, an open level, an unresolvable `$ref` — reads as
 * neither.
 */
const readFrame = (
  frame: WalkFrame,
  options: WalkOptions
): { unknown: UnknownField[]; children: WalkFrame[] } => {
  const nothing = { unknown: [], children: [] };

  const schema = options.resolveRef(frame.schema);
  if (!isObjectRecord(schema) || !isObjectRecord(frame.value)) return nothing;
  if (options.isOpaque?.(frame.value)) return nothing;

  const unionFields = closedUnionFields(schema, options);
  if (unionFields) {
    return {
      unknown: unknownKeysIn({
        value: frame.value,
        path: frame.path,
        allowedFields: unionFields,
      }),
      children: [],
    };
  }

  if (isOpenOrAmbiguous(schema) || !hasProperties(schema)) return nothing;

  const level: Level = { schema, value: frame.value, path: frame.path };
  const { allowedFields } = deriveSchemaFields({ schema });
  return {
    unknown: unknownKeysIn({
      value: level.value,
      path: level.path,
      allowedFields: [...allowedFields],
    }),
    children: childFrames(level, options),
  };
};

/**
 * Walks a value against its OpenAPI schema (iteratively), collecting every key
 * a closed object level does not declare. Descends through nested objects,
 * arrays of objects and `$ref`s; skips open levels (see
 * {@link isOpenOrAmbiguous}) so passthrough maps are never flagged. A union of
 * closed objects is judged against the union of their fields
 * ({@link closedUnionFields}).
 *
 * A key whose value is `undefined` is absent, not unknown: a formation property
 * resolving to `undefined` means its parameter was kept.
 */
export const collectUnknownFields = (
  args: { schema: unknown; value: unknown },
  options: WalkOptions
): UnknownField[] => {
  const out: UnknownField[] = [];
  const stack: WalkFrame[] = [
    { schema: args.schema, value: args.value, path: '' },
  ];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) continue;

    const { unknown, children } = readFrame(frame, options);
    out.push(...unknown);
    stack.push(...children);
  }

  return out;
};
