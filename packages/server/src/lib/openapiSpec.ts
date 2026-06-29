import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

import yaml from 'js-yaml';

import type { SchemaFields, SchemaWithProperties } from './openapiSchemaFields';
import {
  deriveSchemaFields,
  hasProperties,
  isObjectRecord,
} from './openapiSchemaFields';
import { snakeToCamel } from './soatToolsHelpers';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

type SpecFile = {
  paths?: Record<string, unknown>;
  components?: {
    schemas?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
};

type MergedSpec = {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, unknown>;
  components: {
    schemas: Record<string, unknown>;
    securitySchemes: Record<string, unknown>;
  };
};

const getSpecDir = (): string => {
  const candidate1 = path.resolve(__dirname, '../rest/openapi/v1');
  const candidate2 = path.resolve(__dirname, 'rest/openapi/v1');
  return fs.existsSync(candidate1) ? candidate1 : candidate2;
};

const loadSpecFile = (filePath: string): SpecFile | null => {
  try {
    return yaml.load(fs.readFileSync(filePath, 'utf-8')) as SpecFile;
  } catch {
    return null;
  }
};

export const loadMergedOpenApiSpec = (): MergedSpec => {
  const specDir = getSpecDir();
  const merged: MergedSpec = {
    openapi: '3.0.3',
    info: { title: 'SOAT API', version: '1.0.0' },
    paths: {},
    components: { schemas: {}, securitySchemes: {} },
  };

  if (!fs.existsSync(specDir)) return merged;

  const files = fs
    .readdirSync(specDir)
    .filter((f) => {
      return f.endsWith('.yaml');
    })
    .sort();

  for (const file of files) {
    const spec = loadSpecFile(path.join(specDir, file));
    if (!spec) continue;
    Object.assign(merged.paths, spec.paths ?? {});
    Object.assign(merged.components.schemas, spec.components?.schemas ?? {});
    Object.assign(
      merged.components.securitySchemes,
      spec.components?.securitySchemes ?? {}
    );
  }

  return merged;
};

let cachedSpec: MergedSpec | null = null;

export const getMergedOpenApiSpec = (): MergedSpec => {
  if (!cachedSpec) {
    cachedSpec = loadMergedOpenApiSpec();
  }
  return cachedSpec;
};

// Request bodies are compared in camelCase (after caseTransform), so the
// kernel keys every set/spec by its camelCase name here.
export type RequestSchemaFields = SchemaFields;

const deriveFields = (schema: SchemaWithProperties): RequestSchemaFields => {
  return deriveSchemaFields({ schema, transformKey: snakeToCamel });
};

/**
 * Derives the set of known body fields for a named request schema directly from
 * the OpenAPI specs — the single source of truth for the REST contract, SDK,
 * CLI, and MCP surface. Property names are stored as snake_case in the spec and
 * returned here as camelCase to match the request body after the caseTransform
 * middleware has run.
 */
export const getRequestSchemaFields = (args: {
  schemaName: string;
}): RequestSchemaFields => {
  const schema = getMergedOpenApiSpec().components.schemas[args.schemaName];

  if (!hasProperties(schema)) {
    throw new Error(
      `Schema '${args.schemaName}' has no properties in the OpenAPI spec`
    );
  }

  return deriveFields(schema);
};

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

/**
 * Matches a concrete request path (e.g. `/api/v1/agents/agt_123`) against the
 * OpenAPI path templates in the merged spec and returns the matching template
 * key (e.g. `/api/v1/agents/{agent_id}`), or `null` when none matches.
 *
 * A template segment wrapped in braces (`{agent_id}`) matches any single
 * non-empty concrete segment; every other segment must match literally. When
 * several templates match, the one with the fewest brace segments wins so a
 * static route (`/orchestrations/validate`) is preferred over a parameterized
 * one (`/orchestrations/{orchestration_id}`).
 */
export const matchOpenApiPath = (args: { path: string }): string | null => {
  const requestSegments = args.path.split('/').filter(Boolean);

  let best: string | null = null;
  let bestParamCount = Number.POSITIVE_INFINITY;

  for (const template of Object.keys(getMergedOpenApiSpec().paths)) {
    const templateSegments = template.split('/').filter(Boolean);
    if (templateSegments.length !== requestSegments.length) continue;

    let paramCount = 0;
    const matches = templateSegments.every((segment, index) => {
      const isParam = segment.startsWith('{') && segment.endsWith('}');
      if (isParam) {
        paramCount += 1;
        return requestSegments[index].length > 0;
      }
      return segment === requestSegments[index];
    });

    if (matches && paramCount < bestParamCount) {
      best = template;
      bestParamCount = paramCount;
    }
  }

  return best;
};

/**
 * Normalizes a route as registered on the router (e.g. `/agents/:agent_id`) to
 * the OpenAPI path-key form used in the specs (`/api/v1/agents/{agent_id}`):
 * `:param` → `{param}`, and the `/api/v1` prefix is added if absent.
 */
const normalizeRoutePath = (path: string): string => {
  const withBraces = path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  return withBraces.startsWith('/api/v1') ? withBraces : `/api/v1${withBraces}`;
};

const resolveJsonRequestSchema = (operation: unknown): unknown => {
  if (!isObjectRecord(operation)) return undefined;
  const { requestBody } = operation;
  if (!isObjectRecord(requestBody)) return undefined;
  const { content } = requestBody;
  if (!isObjectRecord(content)) return undefined;
  const json = content['application/json'];
  if (!isObjectRecord(json)) return undefined;
  return json.schema;
};

/**
 * Follows a single `$ref` to its named component schema; returns the schema
 * object unchanged when it is inline (no `$ref`), or `null` when the ref cannot
 * be resolved to an object schema. Used to walk nested request schemas.
 */
export const resolveSchemaRef = (
  schema: unknown
): Record<string, unknown> | null => {
  if (!isObjectRecord(schema)) return null;
  const ref = schema.$ref;
  if (typeof ref !== 'string') return schema;
  const schemaName = ref.split('/').pop();
  if (!schemaName) return null;
  const named = getMergedOpenApiSpec().components.schemas[schemaName];
  return isObjectRecord(named) ? named : null;
};

/**
 * Resolves a route's `application/json` request schema — following a top-level
 * `$ref` to its named component schema, or returning the inline schema. Returns
 * `null` when the route has no JSON object body. The result is the raw schema
 * object (with its `properties`, `oneOf`, `additionalProperties`, …) so callers
 * can walk it; use `getRouteRequestSchemaFields` for the derived field sets.
 */
export const getRouteRequestSchema = (args: {
  method: string;
  path: string;
}): Record<string, unknown> | null => {
  const method = args.method.toLowerCase();
  if (!HTTP_METHODS.has(method)) return null;

  const pathItem = getMergedOpenApiSpec().paths[normalizeRoutePath(args.path)];
  if (!isObjectRecord(pathItem)) return null;

  const schema = resolveJsonRequestSchema(pathItem[method]);
  if (!isObjectRecord(schema)) return null;

  return resolveSchemaRef(schema);
};

/**
 * Resolves the allowed/required body fields for a specific route's
 * `application/json` request schema — handling both inline schemas and `$ref`s
 * to named component schemas. Returns `null` when the route has no
 * property-based object body (no request body, or an open `additionalProperties`
 * map such as a tags endpoint), signalling "nothing to validate".
 */
export const getRouteRequestSchemaFields = (args: {
  method: string;
  path: string;
}): RequestSchemaFields | null => {
  const schema = getRouteRequestSchema(args);
  return hasProperties(schema) ? deriveFields(schema) : null;
};
