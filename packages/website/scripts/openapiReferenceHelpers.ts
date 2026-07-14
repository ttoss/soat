/**
 * Shared helpers for the MCP tools and SDK services reference generators.
 *
 * Both surfaces are derived from the same OpenAPI specs in
 * `packages/server/src/rest/openapi/v1/*.yaml`, so the loading, `$ref`
 * resolution, and parameter/body extraction live here once instead of being
 * duplicated per generator.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

import camelCase from 'camelcase';
import { load } from 'js-yaml';

const scriptsDir = path.dirname(url.fileURLToPath(import.meta.url));

export const SPECS_DIR = path.resolve(
  scriptsDir,
  '../../server/src/rest/openapi/v1'
);

export const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

export interface JsonSchema {
  $ref?: string;
  type?: string;
  description?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: JsonSchema | boolean;
  enum?: unknown[];
  default?: unknown;
  example?: unknown;
  nullable?: boolean;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  items?: JsonSchema;
  /** Body properties the server sets itself — excluded from the MCP tool surface. */
  'x-soat-server-managed'?: boolean;
}

export interface ParameterSpec {
  name: string;
  in: 'path' | 'query' | string;
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
  example?: unknown;
}

export interface RequestBodySpec {
  required?: boolean;
  content?: Record<string, { schema?: JsonSchema }>;
}

export interface OperationSpec {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: ParameterSpec[];
  requestBody?: RequestBodySpec;
  /** When true the operation is excluded from the MCP tool surface. */
  'x-soat-mcp-exclude'?: boolean;
}

export interface OpenApiSpec {
  tags?: Array<{ name: string }>;
  paths?: Record<string, Record<string, OperationSpec>>;
  components?: { schemas?: Record<string, JsonSchema> };
}

/**
 * Map spec filenames to a different module doc page when the spec belongs to
 * a sub-resource whose documentation lives inside a parent module's page.
 */
const DOC_OVERRIDES: Record<string, string> = {
  memoryEntries: 'memories',
};

export interface ModuleConfig {
  /** Spec filename without extension, e.g. `ai-providers` or `memoryEntries`. */
  file: string;
  /** Human tag label, e.g. `AI Providers`. */
  label: string;
  /** SDK client accessor and MCP grouping key, e.g. `aiProviders`. */
  accessor: string;
  /** Module doc filename to cross-link, honouring {@link DOC_OVERRIDES}. */
  docFile: string;
  spec: OpenApiSpec;
}

const toTitleCase = (file: string): string => {
  return file
    .split('-')
    .map((w) => {
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
};

export const loadModules = (): ModuleConfig[] => {
  return fs
    .readdirSync(SPECS_DIR)
    .filter((f) => {
      return f.endsWith('.yaml');
    })
    .sort()
    .map((f) => {
      const file = f.replace(/\.yaml$/, '');
      const spec = load(
        fs.readFileSync(path.join(SPECS_DIR, f), 'utf-8')
      ) as OpenApiSpec;
      const label = spec.tags?.[0]?.name ?? toTitleCase(file);
      const accessor = camelCase(label);
      const docFile = DOC_OVERRIDES[file] ?? file;
      return { file, label, accessor, docFile, spec };
    });
};

export const resolveSchemaRef = (args: {
  schema: JsonSchema;
  spec: OpenApiSpec;
}): JsonSchema => {
  const { schema, spec } = args;
  if (!schema.$ref || !schema.$ref.startsWith('#/components/schemas/')) {
    return schema;
  }
  const name = schema.$ref.replace('#/components/schemas/', '');
  return spec.components?.schemas?.[name] ?? schema;
};

/**
 * JSON-Schema primitive the MCP `inputSchema` collapses a value to, mirroring
 * `getJsonSchemaType` in the server's `soatToolsHelpers.ts`. This is the type an
 * MCP client actually sees, so the MCP docs report it rather than the richer
 * OpenAPI label.
 */
export const getMcpTypeLabel = (args: {
  schema?: JsonSchema;
  spec: OpenApiSpec;
}): string => {
  const { schema, spec } = args;
  if (!schema) return 'string';
  const resolved = resolveSchemaRef({ schema, spec });
  const type = resolved.type;
  if (type === 'integer' || type === 'number') return 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'object') return 'object';
  if (type === 'array') {
    const itemType = getMcpTypeLabel({ schema: resolved.items, spec });
    return `array<${itemType}>`;
  }
  return 'string';
};

export const camelize = (name: string): string => {
  return name.replace(/[_-]([a-z])/g, (_, letter) => {
    return letter.toUpperCase();
  });
};

/**
 * MCP tool name: naive camelCase→kebab-case (no digit boundary split), matching
 * `operationIdToToolName` in the server. e.g. `downloadFileBase64` →
 * `download-file-base64`.
 */
export const mcpToolName = (operationId: string): string => {
  return operationId
    .replace(/([A-Z])/g, '-$1')
    .toLowerCase()
    .replace(/^-/, '');
};

/**
 * REST reference page slug for an operation, matching the slug the
 * `docusaurus-plugin-openapi-docs` plugin generates (lodash `kebabCase`, which
 * also splits letter↔digit boundaries). e.g. `downloadFileBase64` →
 * `download-file-base-64`. Verified against all generated pages.
 */
export const restPageSlug = (operationId: string): string => {
  return operationId
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/([a-zA-Z])([0-9])/g, '$1-$2')
    .replace(/([0-9])([a-zA-Z])/g, '$1-$2')
    .toLowerCase();
};

export interface OperationParam {
  name: string;
  camelName: string;
  in: 'path' | 'query';
  required: boolean;
  type: string;
  description: string;
}

export const getOperationParams = (args: {
  operation: OperationSpec;
  spec: OpenApiSpec;
}): OperationParam[] => {
  const { operation, spec } = args;
  return (operation.parameters ?? [])
    .filter((p) => {
      return p.in === 'path' || p.in === 'query';
    })
    .map((p) => {
      return {
        name: p.name,
        camelName: camelize(p.name),
        in: p.in as 'path' | 'query',
        required: p.in === 'path' ? true : Boolean(p.required),
        type: getMcpTypeLabel({ schema: p.schema, spec }),
        description: p.description ?? '',
      };
    });
};

export interface BodyProp {
  snakeName: string;
  camelName: string;
  required: boolean;
  type: string;
  description: string;
}

const getBodySchema = (args: {
  operation: OperationSpec;
  spec: OpenApiSpec;
}): JsonSchema | undefined => {
  const content = args.operation.requestBody?.content;
  if (!content) return undefined;
  const schema =
    content['application/json']?.schema ??
    Object.values(content)[0]?.schema ??
    undefined;
  if (!schema) return undefined;
  return resolveSchemaRef({ schema, spec: args.spec });
};

export const hasRequestBody = (operation: OperationSpec): boolean => {
  return Boolean(operation.requestBody?.content);
};

/**
 * Top-level request-body properties. `excludeServerManaged` drops
 * `x-soat-server-managed` fields, matching what the MCP tool surface exposes.
 */
export const getBodyProps = (args: {
  operation: OperationSpec;
  spec: OpenApiSpec;
  excludeServerManaged?: boolean;
}): BodyProp[] => {
  const { operation, spec, excludeServerManaged } = args;
  const bodySchema = getBodySchema({ operation, spec });
  if (!bodySchema?.properties) return [];

  const required = new Set(bodySchema.required ?? []);

  return Object.entries(bodySchema.properties)
    .filter(([, raw]) => {
      if (!excludeServerManaged) return true;
      const resolved = resolveSchemaRef({ schema: raw, spec });
      return (
        !raw['x-soat-server-managed'] && !resolved['x-soat-server-managed']
      );
    })
    .map(([name, raw]) => {
      const resolved = resolveSchemaRef({ schema: raw, spec });
      return {
        snakeName: name,
        camelName: camelize(name),
        required: required.has(name),
        type: getMcpTypeLabel({ schema: raw, spec }),
        description: resolved.description ?? raw.description ?? '',
      };
    });
};

export interface OperationEntry {
  operationId: string;
  httpMethod: string;
  apiPath: string;
  description: string;
  operation: OperationSpec;
}

/** All documentable operations in a module spec, in declaration order. */
export const loadOperations = (spec: OpenApiSpec): OperationEntry[] => {
  const entries: OperationEntry[] = [];
  for (const [apiPath, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method) || !operation.operationId) continue;
      entries.push({
        operationId: operation.operationId,
        httpMethod: method.toUpperCase(),
        // Spec paths already include the `/api/v1` prefix.
        apiPath,
        description: operation.summary ?? operation.description ?? '',
        operation,
      });
    }
  }
  return entries;
};

export const sanitizeInline = (text: string): string => {
  return text.replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim();
};
