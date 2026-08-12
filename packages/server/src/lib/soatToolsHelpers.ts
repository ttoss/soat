/**
 * Helper functions for SOAT Tools processing.
 * Extracts and processes OpenAPI specifications into tool definitions.
 */

import type { JsonObjectSchema } from '@ttoss/http-server-mcp';
import type { JSONSchema7 } from 'ai';
import createDebug from 'debug';

import {
  buildBodyFn,
  buildPathFn,
  buildQueryFn,
  dereferenceSchema,
  forcedToolParamValue,
  isHiddenFromToolSchema,
  modelChosenQueryParams,
  normalizeSubschema,
  resolveParameter as resolveOpenApiParameter,
  resolveSchema as resolveOpenApiSchema,
  sanitizeDescription,
  type ToolQueryParam,
} from './soatToolsSchemaHelpers';

const log = createDebug('soat:tools');

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObjectSchema;
  method: string;
  path: (args: Record<string, unknown>) => string;
  query?: (args: Record<string, unknown>) => string;
  body?: (args: Record<string, unknown>) => Record<string, unknown>;
  iamAction?: string;
  /** snake_case names of every top-level request body property this operation's schema declares, including server-managed ones. */
  acceptedBodyFields: string[];
}

/**
 * The request target an action is called with: its path with the path
 * parameters substituted, followed by the query string its `in: query`
 * parameters build.
 *
 * Both halves live here rather than at each call site because keeping them
 * apart is exactly how #924 happened — the SOAT tool path built the path alone
 * and dropped every query parameter the action advertised, while the MCP
 * handler for the same registry appended both. There is now one way to address
 * an action, so a third caller cannot repeat the omission.
 */
export const buildSoatActionTarget = (args: {
  def: ToolDefinition;
  args: Record<string, unknown>;
}): string => {
  return (
    args.def.path(args.args) + (args.def.query ? args.def.query(args.args) : '')
  );
};

export interface OpenApiSpec {
  paths?: Record<string, Record<string, unknown>>;
  components?: {
    schemas?: Record<string, unknown>;
    parameters?: Record<string, unknown>;
  };
}

export type RequestBodySpec = {
  required?: boolean;
  content?: {
    'application/json'?: {
      schema?: {
        type?: string;
        required?: string[];
        properties?: Record<string, unknown>;
        oneOf?: Array<Record<string, unknown>>;
        anyOf?: Array<Record<string, unknown>>;
        $ref?: string;
      };
    };
  };
};

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
  requestBody?: RequestBodySpec;
  'x-iam-action'?: string;
  /** When true, the operation is excluded from the MCP tool surface. */
  'x-soat-mcp-exclude'?: boolean;
}

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
  return resolveOpenApiSchema(schema, spec);
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
  return resolveOpenApiParameter(param, spec);
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
  'string' | 'number' | 'boolean' | 'array' | 'integer' | 'object' | 'null' => {
  if (schemaType === 'integer' || schemaType === 'number') return 'number';
  if (schemaType === 'boolean') return 'boolean';
  if (schemaType === 'array') return 'array';
  if (schemaType === 'object') return 'object';
  return 'string';
};

/**
 * Builds a single property schema, preserving the parts of the OpenAPI type
 * that a single primitive cannot express.
 *
 * A property declaring `oneOf`/`anyOf` is forwarded verbatim rather than
 * collapsed to a guessed primitive, and `nullable: true` becomes a two-entry
 * `type` array (e.g. `['string', 'null']`) so the property keeps its declared
 * type while still accepting an explicit `null`. Both matter because the
 * schema is what an MCP client is told it may send: collapsing them advertises
 * a stricter contract than the REST API actually enforces, so a documented
 * call — "pass `null` to clear this field" — looks invalid.
 */
const buildTypedProperty = (param: {
  type?: string;
  description: string;
  items?: unknown;
  nullable?: boolean;
  oneOf?: unknown[];
  anyOf?: unknown[];
}): JSONSchema7 => {
  const description = sanitizeDescription(param.description);

  if (param.oneOf && param.oneOf.length > 0) {
    return {
      oneOf: normalizeSubschema(param.oneOf) as JSONSchema7[],
      description,
    };
  }

  if (param.anyOf && param.anyOf.length > 0) {
    return {
      anyOf: normalizeSubschema(param.anyOf) as JSONSchema7[],
      description,
    };
  }

  // A property the spec declares with neither a `type` nor alternatives accepts
  // more than one shape — `tool_choice` is a string *or* an object. Guessing a
  // single type here (the old behaviour guessed `string`) advertises a narrower
  // contract than the REST API enforces, so the object form looks invalid. An
  // absent `type` accepts any shape, including null, matching the spec.
  if (param.type === undefined) {
    return { description };
  }

  const jsonType = getJsonSchemaType(param.type);
  const finalType =
    param.nullable === true ? [jsonType, 'null' as const] : jsonType;

  if (param.type === 'array') {
    const items = param.items
      ? (normalizeSubschema(param.items) as JSONSchema7)
      : { type: 'string' as const };
    return { type: finalType, items, description };
  }

  return { type: finalType, description };
};

/**
 * Builds an MCP tool's `inputSchema` from the operation's path, query, and body
 * parameters. Property names are the spec's own snake_case names, verbatim — the
 * MCP contract is the OpenAPI contract, so a client that read the docs can call
 * a tool with no translation, and nothing can drift between the two.
 */
export const buildInputSchema = (
  pathParams: Array<{ name: string }>,
  allQueryParams: ToolQueryParam[],
  bodyProps: Array<{
    name: string;
    description: string;
    required: boolean;
    /** `undefined` when the spec declares no `type` for this property. */
    type?: string;
    items?: unknown;
    nullable?: boolean;
    oneOf?: unknown[];
    anyOf?: unknown[];
  }>
): JsonObjectSchema => {
  // A forced param is pinned by the platform, so it is never offered here.
  const queryParams = modelChosenQueryParams(allQueryParams);
  if (pathParams.length + queryParams.length + bodyProps.length === 0) {
    return {
      type: 'object',
    };
  }

  const requiredFields = [
    ...pathParams.map((p) => {
      return p.name;
    }),
    ...queryParams
      .filter((p) => {
        return p.required;
      })
      .map((p) => {
        return p.name;
      }),
    ...bodyProps
      .filter((p) => {
        return p.required;
      })
      .map((p) => {
        return p.name;
      }),
  ];

  const properties: Record<string, JSONSchema7> = {};

  // Path params are always required strings and carry no spec description.
  for (const param of pathParams) {
    properties[param.name] = { type: 'string', description: '' };
  }

  for (const param of [...queryParams, ...bodyProps]) {
    properties[param.name] = buildTypedProperty(param);
  }

  // `required` is omitted rather than set to `undefined`: JSON has no
  // `undefined`, so the key was never visible to clients anyway, and leaving
  // explicit `undefined` on the in-memory schema only risks tripping the
  // validator that compiles it at tool-registration time.
  return {
    type: 'object',
    properties,
    ...(requiredFields.length > 0 ? { required: requiredFields } : {}),
  };
};

export const extractPathParams = (args: {
  parameters: Array<{ name?: string; in?: string; [key: string]: unknown }>;
  spec: OpenApiSpec;
}): Array<{ name: string }> => {
  return (args.parameters || [])
    .map((p) => {
      return resolveParameter(p, args.spec);
    })
    .filter((p) => {
      return p.in === 'path';
    })
    .map((p) => {
      return { name: p.name || '' };
    });
};

export const extractQueryParams = (args: {
  parameters: Array<{ name?: string; in?: string; [key: string]: unknown }>;
  spec: OpenApiSpec;
}): ToolQueryParam[] => {
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
        description: p.description || '',
        required: p.required || false,
        type: p.schema?.type || 'string',
        forcedValue: forcedToolParamValue(p),
      };
    });
};

const resolveBodySchema = (args: {
  requestBody?: RequestBodySpec;
  spec: OpenApiSpec;
}) => {
  const rawBodySchema = args.requestBody?.content?.['application/json']?.schema;
  const dereferencedBodySchema = dereferenceSchema(rawBodySchema, args.spec);
  return resolveSchema(dereferencedBodySchema, args.spec);
};

/** snake_case names of every top-level property an operation's request schema declares, including server-managed ones. */
export const extractAcceptedBodyFields = (args: {
  requestBody?: RequestBodySpec;
  spec: OpenApiSpec;
}): string[] => {
  const bodySchema = resolveBodySchema(args);
  return Object.keys(bodySchema?.properties ?? {});
};

export const extractBodyProps = (args: {
  requestBody?: RequestBodySpec;
  spec: OpenApiSpec;
}): Array<{
  name: string;
  description: string;
  required: boolean;
  /** `undefined` when the spec declares no `type` for this property. */
  type?: string;
  items?: unknown;
  nullable?: boolean;
  oneOf?: unknown[];
  anyOf?: unknown[];
}> => {
  const bodySchema = resolveBodySchema(args);
  if (!bodySchema?.properties) return [];
  const allEntries = Object.entries(bodySchema.properties);
  const filtered = allEntries.filter(([, value]: [string, unknown]) => {
    return !isHiddenFromToolSchema(value);
  });
  const excluded = allEntries.length - filtered.length;
  if (excluded > 0) {
    log(
      'extractBodyProps: excluded %d non-callable field(s): %s',
      excluded,
      allEntries
        .filter(([, v]: [string, unknown]) => {
          return isHiddenFromToolSchema(v);
        })
        .map(([k]) => {
          return k;
        })
        .join(', ')
    );
  }
  return filtered.map(([key, value]: [string, unknown]) => {
    const val = value as {
      description?: unknown;
      type?: unknown;
      items?: unknown;
      nullable?: unknown;
      oneOf?: unknown;
      anyOf?: unknown;
    };
    return {
      name: key,
      description: typeof val.description === 'string' ? val.description : '',
      required: (bodySchema.required || []).includes(key),
      // Left undefined when the spec declares none, so buildInputSchema can
      // advertise "any shape" rather than guessing a single type.
      type: typeof val.type === 'string' ? val.type : undefined,
      items: val.items,
      nullable: val.nullable === true,
      oneOf: Array.isArray(val.oneOf) ? val.oneOf : undefined,
      anyOf: Array.isArray(val.anyOf) ? val.anyOf : undefined,
    };
  });
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

  if (args.operation['x-soat-mcp-exclude']) {
    log(
      'processOperation: skipping MCP-excluded operation %s',
      args.operation.operationId
    );
    return null;
  }

  const toolName = operationIdToToolName(args.operation.operationId);
  log(
    'processOperation: %s %s operationId=%s toolName=%s',
    httpMethod,
    args.pathTemplate,
    args.operation.operationId,
    toolName
  );

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

  const acceptedBodyFields = extractAcceptedBodyFields({
    requestBody: args.operation.requestBody,
    spec: args.spec,
  });

  return {
    name: toolName,
    description: (args.operation.description || '')
      .replace(/'/g, "\\'")
      .replace(/\n/g, ' ')
      .trim(),
    inputSchema,
    method: httpMethod,
    path: buildPathFn(args.pathTemplate, pathParams),
    query: buildQueryFn(queryParams),
    body: buildBodyFn(bodyProps),
    iamAction: args.operation['x-iam-action'],
    acceptedBodyFields,
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
