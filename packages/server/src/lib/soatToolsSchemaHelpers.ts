import type { OpenApiSpec } from './soatToolsHelpers';

export const resolveSchema = (
  schema: Record<string, unknown> | undefined,
  spec: OpenApiSpec
): {
  type?: string;
  required?: string[];
  properties?: Record<string, unknown>;
  oneOf?: Array<Record<string, unknown>>;
  anyOf?: Array<Record<string, unknown>>;
} => {
  if (!schema) return {};
  if (typeof schema.$ref === 'string') {
    const refName = schema.$ref.replace('#/components/schemas/', '');
    const resolved = spec.components?.schemas?.[refName];
    return resolveSchema(resolved as Record<string, unknown> | undefined, spec);
  }

  const alternatives = (
    Array.isArray(schema.oneOf) && schema.oneOf.length > 0
      ? schema.oneOf
      : Array.isArray(schema.anyOf) && schema.anyOf.length > 0
        ? schema.anyOf
        : undefined
  ) as Array<Record<string, unknown>> | undefined;

  if (alternatives) {
    const resolvedAlternatives = alternatives.map((candidate) => {
      return resolveSchema(candidate, spec);
    });

    const mergedProperties = Object.assign(
      {},
      ...resolvedAlternatives.map((candidate) => {
        return candidate.properties ?? {};
      })
    );

    const requiredIntersection = resolvedAlternatives.reduce<
      string[] | undefined
    >((current, candidate) => {
      const required = candidate.required ?? [];

      if (current === undefined) {
        return [...required];
      }

      return current.filter((field) => {
        return required.includes(field);
      });
    }, undefined);

    return {
      type: 'object',
      properties:
        Object.keys(mergedProperties).length > 0 ? mergedProperties : undefined,
      required:
        requiredIntersection && requiredIntersection.length > 0
          ? requiredIntersection
          : undefined,
    };
  }

  return schema;
};

export const resolveParameter = (
  param: Record<string, unknown> | undefined,
  spec: OpenApiSpec
): {
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  schema?: {
    type?: string;
    items?: { type?: string };
  };
} => {
  if (!param) return {};
  if (typeof param.$ref === 'string') {
    const refName = param.$ref.replace('#/components/parameters/', '');
    const resolved = spec.components?.parameters?.[refName];
    return resolved || {};
  }
  return param;
};
