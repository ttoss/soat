/**
 * SOAT Tools - Dynamically loads available tools from MCP tool definitions.
 * Each tool represents a platform action that can be invoked by agents.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

import type { JsonObjectSchema } from '@ttoss/http-server-mcp';
import type { JSONSchema7 } from 'ai';
import yaml from 'js-yaml';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObjectSchema;
  method: string;
  path: (args: Record<string, unknown>) => string;
  body?: (args: Record<string, unknown>) => Record<string, unknown>;
  iamAction?: string;
}

interface OpenApiSpec {
  paths?: Record<string, Record<string, unknown>>;
  components?: {
    schemas?: Record<string, unknown>;
    parameters?: Record<string, unknown>;
  };
}

interface OperationSpec {
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

const snakeToCamel = (str: string): string => {
  return str.replace(/[_-]([a-z])/g, (_, letter) => {
    return letter.toUpperCase();
  });
};

const resolveSchema = (
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

/**
 * Resolves a parameter that may contain a $ref.
 * If the parameter has a $ref property, looks it up in components.parameters.
 * Otherwise returns the parameter as-is.
 */
const resolveParameter = (
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

const operationIdToToolName = (operationId: string): string => {
  // Convert camelCase to kebab-case (listActors -> list-actors)
  return operationId
    .replace(/([A-Z])/g, '-$1')
    .toLowerCase()
    .replace(/^-/, '');
};

const getJsonSchemaType = (
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

/**
 * Builds an input schema for a tool from path, query, and body parameters
 */
const buildInputSchema = (
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
        properties[param.camelName] = {
          type: 'array',
          items: { type: 'string' },
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

/**
 * Generates a path function that interpolates path parameters
 */
const buildPathFn = (
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

/**
 * Generates a body function that extracts body parameters from args
 */
const buildBodyFn = (
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

/**
 * Extracts and normalizes path parameters from an operation
 */
const extractPathParams = (args: {
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

/**
 * Extracts and normalizes query parameters from an operation
 */
const extractQueryParams = (args: {
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

/**
 * Extracts and normalizes body properties from an operation
 */
const extractBodyProps = (args: {
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
}> => {
  const rawBodySchema = args.requestBody?.content?.['application/json']?.schema;
  const bodySchema = resolveSchema(rawBodySchema, args.spec);
  return bodySchema?.properties
    ? Object.entries(bodySchema.properties).map(
        ([key, value]: [string, unknown]) => {
          const val = value as { description?: unknown; type?: unknown };
          return {
            snakeName: key,
            camelName: snakeToCamel(key),
            description:
              typeof val.description === 'string' ? val.description : '',
            required: (bodySchema.required || []).includes(key),
            type: typeof val.type === 'string' ? val.type : 'string',
          };
        }
      )
    : [];
};

/**
 * Processes a single operation to create a tool definition
 */
const processOperation = (args: {
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

/**
 * Processes all operations in a single path
 */
const processPath = (args: {
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

/**
 * Loads and processes YAML specs to generate tool definitions
 */
const loadToolDefinitions = (): ToolDefinition[] => {
  const specDir = path.resolve(__dirname, '../rest/openapi/v1');
  const tools: ToolDefinition[] = [];

  if (!fs.existsSync(specDir)) return tools;

  const files = fs
    .readdirSync(specDir)
    .filter((f) => {
      return f.endsWith('.yaml');
    })
    .sort();

  for (const file of files) {
    try {
      const filePath = path.join(specDir, file);
      const spec = yaml.load(fs.readFileSync(filePath, 'utf-8')) as OpenApiSpec;
      const paths = spec.paths || {};

      for (const [pathTemplate, pathItem] of Object.entries(paths)) {
        const pathItemObj = pathItem as Record<string, OperationSpec>;
        const pathTools = processPath({
          pathTemplate,
          pathItem: pathItemObj,
          spec,
        });
        tools.push(...pathTools);
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`Error processing ${file}:`, error);
    }
  }

  return tools;
};

export const soatTools = loadToolDefinitions();
