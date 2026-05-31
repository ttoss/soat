import type { OpenApiSpec } from './soatToolsHelpers';

type ResolvedSchema = {
  type?: string;
  required?: string[];
  properties?: Record<string, unknown>;
  oneOf?: Array<Record<string, unknown>>;
  anyOf?: Array<Record<string, unknown>>;
};

const getAlternativeSchemas = (
  schema: Record<string, unknown>
): Array<Record<string, unknown>> | undefined => {
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return schema.oneOf as Array<Record<string, unknown>>;
  }

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return schema.anyOf as Array<Record<string, unknown>>;
  }

  return undefined;
};

const mergeResolvedSchemas = (
  resolvedAlternatives: ResolvedSchema[]
): ResolvedSchema => {
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
};

export const resolveSchema = (
  schema: Record<string, unknown> | undefined,
  spec: OpenApiSpec
): ResolvedSchema => {
  if (!schema) return {};
  if (typeof schema.$ref === 'string') {
    const refName = schema.$ref.replace('#/components/schemas/', '');
    const resolved = spec.components?.schemas?.[refName];
    return resolveSchema(resolved as Record<string, unknown> | undefined, spec);
  }

  const alternatives = getAlternativeSchemas(schema);

  if (alternatives) {
    return mergeResolvedSchemas(
      alternatives.map((candidate) => {
        return resolveSchema(candidate, spec);
      })
    );
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
