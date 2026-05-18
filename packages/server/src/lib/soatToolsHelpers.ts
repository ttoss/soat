/**
 * Helper functions for SOAT Tools processing.
 * Extracts and processes OpenAPI specifications into tool definitions.
 */

import type { JsonObjectSchema } from '@ttoss/http-server-mcp';
import type { JSONSchema7 } from 'ai';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObjectSchema;
  method: string;
  path: (args: Record<string, unknown>) => string;
  body?: (args: Record<string, unknown>) => Record<string, unknown>;
  iamAction?: string;
}

export interface OpenApiSpec {
  paths?: Record<string, Record<string, unknown>>;
  components?: {
    schemas?: Record<string, unknown>;
    parameters?: Record<string, unknown>;
  };
}

export interface OperationSpec {
  operationId?: string;
  description?: string;
  parameters?: Array<{
    name?: string;
    in?: string;
    required?: boolean;
    description?: string;
    schema?: {
      type?: string;
      items?: { type?: string };
    };
    $ref?: string;
  }>;
  requestBody?: {
    required?: boolean;
    content?: {
      'application/json'?: {
        schema?: {
          type?: string;
          required?: string[];
          properties?: Record<string, unknown>;
          $ref?: string;
        };
      };
    };
  };
  'x-iam-action'?: string;
}

export const snakeToCamel = (str: string): string => {
  return str.replace(/[_-]([a-z])/g, (_, letter) => {
    return letter.toUpperCase();
  });
};

export const resolveSchema = (
  schema: Record<string, unknown> | undefined,
  spec: OpenApiSpec
): {
  type?: string;
  required?: string[];
  properties?: Record<string, unknown>;
} => {
  if (!schema) return {};
  if (typeof schema.$ref === 'string') {
    const refName = schema.$ref.replace('#/components/schemas/', '');
    const resolved = spec.components?.schemas?.[refName];
    return resolved || {};
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

export const operationIdToToolName = (operationId: string): string => {
  // Convert camelCase to kebab-case (listActors -> list-actors)
  return operationId
    .replace(/([A-Z])/g, '-$1')
    .toLowerCase()
    .replace(/^-/, '');
};

export const getJsonSchemaType = (
  schemaType: string | undefined
):
  | 'string'
  | 'number'
  | 'boolean'
  | 'array'
  | 'integer'
  | 'object'
  | 'null' => {
  if (schemaType === 'integer' || schemaType === 'number') return 'number';
  if (schemaType === 'boolean') return 'boolean';
  if (schemaType === 'array') return 'array';
  return 'string';
};

export const buildInputSchema = (
  pathParams: Array<{ name: string; camelName: string }>,
  queryParams: Array<{
    name: string;
    camelName: string;
    description: string;
    required: boolean;
    type: string;
  }>,
  bodyProps: Array<{
    snakeName: string;
    camelName: string;
    description: string;
    required: boolean;
    type: string;
    items?: unknown;
  }>
): JsonObjectSchema => {
  const allParams = [...pathParams, ...queryParams, ...bodyProps];

  if (allParams.length === 0) {
    return {
      type: 'object',
    };
  }

  const requiredFields = [
    ...pathParams.map((p) => {
      return p.camelName;
    }),
    ...queryParams
      .filter((p) => {
        return p.required;
      })
      .map((p) => {
        return p.camelName;
      }),
    ...bodyProps
      .filter((p) => {
        return p.required;
      })
      .map((p) => {
        return p.camelName;
      }),
  ];

  const properties: Record<string, JSONSchema7> = {};
  for (const param of allParams) {
    if ('type' in param) {
      const jsonType = getJsonSchemaType(param.type);
      const description = (param.description || '')
        .replace(/'/g, "\\'")
        .replace(/\n/g, ' ')
        .trim();
      if (param.type === 'array') {
        const itemsSchema =
          'items' in param && param.items
            ? (param.items as JSONSchema7)
            : { type: 'string' as const };
        properties[param.camelName] = {
          type: 'array',
          items: itemsSchema,
          description,
        };
      } else {
        properties[param.camelName] = {
          type: jsonType,
          description,
        };
      }
    } else {
      // path param
      properties[param.camelName] = {
        type: 'string',
        description: '',
      };
    }
  }

  return {
    type: 'object',
    properties,
    required: requiredFields.length > 0 ? requiredFields : undefined,
  };
};

export const buildPathFn = (
  pathTemplate: string,
  pathParams: Array<{ name: string; camelName: string }>
): ((args: Record<string, unknown>) => string) => {
  return (args: Record<string, unknown>) => {
    let result = pathTemplate;
    for (const { name, camelName } of pathParams) {
      const value = args[camelName];
      if (value !== undefined) {
        result = result.replace(`{${name}}`, encodeURIComponent(String(value)));
      }
    }
    return result;
  };
};

export const buildBodyFn = (
  bodyProps: Array<{
    snakeName: string;
    camelName: string;
  }>
): ((args: Record<string, unknown>) => Record<string, unknown>) | undefined => {
  if (bodyProps.length === 0) return undefined;

  return (args: Record<string, unknown>) => {
    const body: Record<string, unknown> = {};
    for (const { snakeName, camelName } of bodyProps) {
      if (args[camelName] !== undefined) {
        body[snakeName] = args[camelName];
      }
    }
    return body;
  };
};

export const extractPathParams = (args: {
  parameters: Array<{ name?: string; in?: string; [key: string]: unknown }>;
  spec: OpenApiSpec;
}): Array<{ name: string; camelName: string }> => {
  return (args.parameters || [])
    .map((p) => {
      return resolveParameter(p, args.spec);
    })
    .filter((p) => {
      return p.in === 'path';
    })
    .map((p) => {
      return {
        name: p.name || '',
        camelName: snakeToCamel(p.name || ''),
      };
    });
};

export const extractQueryParams = (args: {
  parameters: Array<{ name?: string; in?: string; [key: string]: unknown }>;
  spec: OpenApiSpec;
}): Array<{
  name: string;
  camelName: string;
  description: string;
  required: boolean;
  type: string;
}> => {
  return (args.parameters || [])
    .map((p) => {
      return resolveParameter(p, args.spec);
    })
    .filter((p) => {
      return p.in === 'query';
    })
    .map((p) => {
      return {
        name: p.name || '',
        camelName: snakeToCamel(p.name || ''),
        description: p.description || '',
        required: p.required || false,
        type: p.schema?.type || 'string',
      };
    });
};

export const extractBodyProps = (args: {
  requestBody?: {
    required?: boolean;
    content?: {
      'application/json'?: {
        schema?: {
          type?: string;
          required?: string[];
          properties?: Record<string, unknown>;
          $ref?: string;
        };
      };
    };
  };
  spec: OpenApiSpec;
}): Array<{
  snakeName: string;
  camelName: string;
  description: string;
  required: boolean;
  type: string;
  items?: unknown;
}> => {
  const rawBodySchema = args.requestBody?.content?.['application/json']?.schema;
  const bodySchema = resolveSchema(rawBodySchema, args.spec);
  return bodySchema?.properties
    ? Object.entries(bodySchema.properties).map(
        ([key, value]: [string, unknown]) => {
          const val = value as {
            description?: unknown;
            type?: unknown;
            items?: unknown;
          };
          return {
            snakeName: key,
            camelName: snakeToCamel(key),
            description:
              typeof val.description === 'string' ? val.description : '',
            required: (bodySchema.required || []).includes(key),
            type: typeof val.type === 'string' ? val.type : 'string',
            items: val.items,
          };
        }
      )
    : [];
};

export const processOperation = (args: {
  pathTemplate: string;
  method: string;
  operation: OperationSpec;
  spec: OpenApiSpec;
}): ToolDefinition | null => {
  const httpMethod = args.method.toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(httpMethod)) {
    return null;
  }

  if (!args.operation.operationId) return null;

  const toolName = operationIdToToolName(args.operation.operationId);

  // Extract parameters
  const pathParams = extractPathParams({
    parameters: args.operation.parameters || [],
    spec: args.spec,
  });

  const queryParams = extractQueryParams({
    parameters: args.operation.parameters || [],
    spec: args.spec,
  });

  const bodyProps = extractBodyProps({
    requestBody: args.operation.requestBody,
    spec: args.spec,
  });

  const inputSchema = buildInputSchema(pathParams, queryParams, bodyProps);

  return {
    name: toolName,
    description: (args.operation.description || '')
      .replace(/'/g, "\\'")
      .replace(/\n/g, ' ')
      .trim(),
    inputSchema,
    method: httpMethod,
    path: buildPathFn(args.pathTemplate, pathParams),
    body: buildBodyFn(bodyProps),
    iamAction: args.operation['x-iam-action'],
  };
};

export const processPath = (args: {
  pathTemplate: string;
  pathItem: Record<string, OperationSpec>;
  spec: OpenApiSpec;
}): ToolDefinition[] => {
  const tools: ToolDefinition[] = [];
  for (const [method, operation] of Object.entries(args.pathItem)) {
    const tool = processOperation({
      pathTemplate: args.pathTemplate,
      method,
      operation,
      spec: args.spec,
    });
    if (tool) {
      tools.push(tool);
    }
  }
  return tools;
};
