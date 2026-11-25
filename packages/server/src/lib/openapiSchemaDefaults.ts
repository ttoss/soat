/**
 * Fills the defaults an OpenAPI schema declares into a value that omits them,
 * so a value written with a default left out and the same value read back with
 * it filled in compare equal. Values only: no key is renamed.
 */

import { holdsFormationExpression } from './formation-modules/formationSpecLoader';
import type { SchemaRefResolver } from './openapiSchemaFields';
import { isObjectRecord } from './openapiSchemaFields';

type Fill = (
  rawSchema: unknown,
  value: unknown,
  resolveRef: SchemaRefResolver
) => unknown;

const fillProperties = (
  properties: Record<string, unknown>,
  value: Record<string, unknown>,
  resolveRef: SchemaRefResolver,
  fill: Fill
): Record<string, unknown> => {
  const result: Record<string, unknown> = { ...value };
  for (const [name, rawProperty] of Object.entries(properties)) {
    const property = resolveRef(rawProperty);
    if (!isObjectRecord(property)) continue;
    if (result[name] !== undefined) {
      result[name] = fill(rawProperty, result[name], resolveRef);
    } else if ('default' in property) {
      result[name] = structuredClone(property.default);
    }
  }
  return result;
};

const fillDefaults: Fill = (rawSchema, value, resolveRef) => {
  const schema = resolveRef(rawSchema);
  if (!isObjectRecord(schema) || holdsFormationExpression(value)) return value;

  let filled = value;
  for (const branch of Array.isArray(schema.allOf) ? schema.allOf : []) {
    filled = fillDefaults(branch, filled, resolveRef);
  }
  if (Array.isArray(filled)) {
    return filled.map((entry) => {
      return fillDefaults(schema.items, entry, resolveRef);
    });
  }
  return isObjectRecord(filled) && isObjectRecord(schema.properties)
    ? fillProperties(schema.properties, filled, resolveRef, fillDefaults)
    : filled;
};

/**
 * `properties` with every `default` its schema declares filled in where the
 * value omits it, at every level the schema reaches through `$ref`, `allOf`,
 * object properties and array items. A union (`oneOf`/`anyOf`) names no single
 * shape, so its level is left as it is.
 */
export const applySchemaDefaults = (args: {
  schema: unknown;
  properties: Record<string, unknown>;
  resolveRef: SchemaRefResolver;
}): Record<string, unknown> => {
  const filled = fillDefaults(args.schema, args.properties, args.resolveRef);
  return isObjectRecord(filled) ? filled : args.properties;
};
