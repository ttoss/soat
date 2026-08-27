/**
 * Shared kernel for deriving field metadata from an OpenAPI object schema —
 * turning a `{ properties, required }` schema into
 * `{ allowedFields, requiredFields, fieldSpecs }`.
 *
 * Both runtime validators build on it: REST strict-field validation
 * (`openapiSpec.ts` → `requestValidation.ts`) over request bodies, and
 * formation template validation (`formationSpecLoader.ts`) over
 * `*ResourceProperties`. Both compare against the spec's own snake_case names,
 * so there is no casing to reconcile; each keeps its own throw-vs-accumulate
 * policy.
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

/**
 * Derives the allowed/required field sets and per-field type specs from an
 * OpenAPI object schema, keyed by the spec's own property names. Callers compare
 * against those names verbatim — there is deliberately no key-transform hook, so
 * a field name can never be rewritten on its way from the spec to a validator.
 */
export const deriveSchemaFields = (args: {
  schema: SchemaWithProperties;
}): SchemaFields => {
  const required = Array.isArray(args.schema.required)
    ? args.schema.required
    : [];

  const fieldSpecs: Record<string, FieldSpec> = {};
  for (const [key, value] of Object.entries(args.schema.properties)) {
    const propertySchema = isObjectRecord(value) ? value : {};
    fieldSpecs[key] = {
      type:
        typeof propertySchema.type === 'string'
          ? propertySchema.type
          : undefined,
      nullable: propertySchema.nullable === true,
    };
  }

  return {
    allowedFields: new Set(Object.keys(args.schema.properties)),
    requiredFields: new Set(
      required.filter((field): field is string => {
        return typeof field === 'string';
      })
    ),
    fieldSpecs,
  };
};
