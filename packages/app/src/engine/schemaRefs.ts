import type { OpenApiSchema, OpenApiSpec } from './types';

// The served spec snake_cases component keys while leaving $ref strings on the
// original name, so an absent exact key falls back to the snake_cased one.
const lookupRefKey = (obj: Record<string, unknown>, part: string): string => {
  if (part in obj) return part;
  const snake = part.replace(/[A-Z]/g, (char) => {
    return `_${char.toLowerCase()}`;
  });
  return snake in obj ? snake : part;
};

const resolveRef = (
  ref: string,
  spec: OpenApiSpec
): OpenApiSchema | undefined => {
  // The served spec merges every file's components, so `./file.yaml#/…` and
  // `#/…` name the same place.
  const parts = ref.replace(/^[^#]*#\//, '').split('/');
  let current: Record<string, unknown> = spec as Record<string, unknown>;
  for (const part of parts) {
    if (typeof current !== 'object') return undefined;
    current = current[lookupRefKey(current, part)] as Record<string, unknown>;
    if (!current) return undefined;
  }
  return current as OpenApiSchema;
};

// A list's `allOf: [Page, { properties: { data: { items } } }]` as the one
// object it describes: properties merged key by key, so `data` carries both
// `type: array` and its item schema.
const mergeAllOf = (
  members: OpenApiSchema[],
  resolve: (schema: OpenApiSchema) => OpenApiSchema | undefined
): OpenApiSchema => {
  const properties: Record<string, OpenApiSchema> = {};
  for (const member of members) {
    const resolved = resolve(member);
    for (const [key, value] of Object.entries(resolved?.properties ?? {})) {
      properties[key] = { ...properties[key], ...value };
    }
  }
  return { type: 'object', properties };
};

export const resolveSchema = (
  schema: OpenApiSchema | undefined,
  spec: OpenApiSpec
): OpenApiSchema | undefined => {
  if (!schema) return undefined;
  if (schema.$ref) return resolveRef(schema.$ref, spec);
  if (schema.allOf) {
    return mergeAllOf(schema.allOf, (member) => {
      return resolveSchema(member, spec);
    });
  }
  return schema;
};
