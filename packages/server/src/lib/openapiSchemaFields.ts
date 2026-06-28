/**
 * Shared kernel for deriving field metadata from an OpenAPI object schema.
 *
 * Both runtime validators are built on this:
 * - REST strict-field validation (`openapiSpec.ts` → `requestValidation.ts`)
 *   reads request-body schemas and compares in camelCase.
 * - Formation template validation (`formation-modules/formationSpecLoader.ts`)
 *   reads `*ResourceProperties` schemas and compares in snake_case.
 *
 * Each layer keeps its own policy (key casing, throw-vs-accumulate, depth,
 * type checking); this module only owns the one thing they had duplicated —
 * turning a `{ properties, required }` schema into `{ allowedFields,
 * requiredFields, fieldSpecs }`.
 */

export type FieldSpec = {
  type?: string;
  nullable: boolean;
};

export type SchemaFields = {
  /** Field names declared by the schema's `properties`. */
  allowedFields: Set<string>;
  /** Field names listed in the schema's `required` array. */
  requiredFields: Set<string>;
  /** Per-field `{ type, nullable }`, keyed identically to `allowedFields`. */
  fieldSpecs: Record<string, FieldSpec>;
};

export type SchemaWithProperties = {
  properties: Record<string, unknown>;
  required?: unknown;
};

export const isObjectRecord = (
  value: unknown
): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

export const hasProperties = (
  value: unknown
): value is SchemaWithProperties => {
  if (!isObjectRecord(value)) return false;
  return isObjectRecord(value.properties);
};

const identity = (key: string): string => {
  return key;
};

/**
 * Derives the allowed/required field sets and per-field type specs from an
 * OpenAPI object schema. `transformKey` maps spec property names to the
 * convention the caller compares against (e.g. `snakeToCamel` for REST request
 * bodies); it defaults to identity, which keeps the spec's snake_case keys.
 */
export const deriveSchemaFields = (args: {
  schema: SchemaWithProperties;
  transformKey?: (key: string) => string;
}): SchemaFields => {
  const transform = args.transformKey ?? identity;
  const required = Array.isArray(args.schema.required)
    ? args.schema.required
    : [];

  const fieldSpecs: Record<string, FieldSpec> = {};
  for (const [key, value] of Object.entries(args.schema.properties)) {
    const propertySchema = isObjectRecord(value) ? value : {};
    fieldSpecs[transform(key)] = {
      type:
        typeof propertySchema.type === 'string'
          ? propertySchema.type
          : undefined,
      nullable: propertySchema.nullable === true,
    };
  }

  return {
    allowedFields: new Set(Object.keys(args.schema.properties).map(transform)),
    requiredFields: new Set(
      required
        .filter((field): field is string => {
          return typeof field === 'string';
        })
        .map(transform)
    ),
    fieldSpecs,
  };
};
