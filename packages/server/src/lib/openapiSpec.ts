import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

import { load } from 'js-yaml';

import type { SchemaFields, SchemaWithProperties } from './openapiSchemaFields';
import {
  deriveSchemaFields,
  hasProperties,
  isObjectRecord,
} from './openapiSchemaFields';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

type SpecFile = {
  paths?: Record<string, unknown>;
  components?: {
    schemas?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
    parameters?: Record<string, unknown>;
  };
};

type MergedSpec = {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, unknown>;
  components: {
    schemas: Record<string, unknown>;
    securitySchemes: Record<string, unknown>;
    // Merged like the schemas: a per-file spec may `$ref` a parameter it
    // declares here, and dropping the section left those refs dangling in the
    // published document.
    parameters: Record<string, unknown>;
  };
};

const getSpecDir = (): string => {
  const candidate1 = path.resolve(__dirname, '../rest/openapi/v1');
  const candidate2 = path.resolve(__dirname, 'rest/openapi/v1');
  return fs.existsSync(candidate1) ? candidate1 : candidate2;
};

// Every `components` section merged across the per-module spec files. A section
// missing here is one whose `$ref`s dangle in the published document.
const COMPONENT_SECTIONS = [
  'schemas',
  'securitySchemes',
  'parameters',
] as const;

const loadSpecFile = (filePath: string): SpecFile | null => {
  try {
    return load(fs.readFileSync(filePath, 'utf-8')) as SpecFile;
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
    components: { schemas: {}, securitySchemes: {}, parameters: {} },
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
    for (const section of COMPONENT_SECTIONS) {
      Object.assign(
        merged.components[section],
        spec.components?.[section] ?? {}
      );
    }
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

// Request bodies arrive in the wire contract's snake_case, so the kernel keys
// every set/spec by the spec's own property name — no conversion in between.
export type RequestSchemaFields = SchemaFields;

const deriveFields = (schema: SchemaWithProperties): RequestSchemaFields => {
  return deriveSchemaFields({ schema });
};

/**
 * Derives the set of known body fields for a named request schema directly from
 * the OpenAPI specs — the single source of truth for the REST contract, SDK,
 * CLI, and MCP surface. Property names are snake_case in the spec and returned
 * verbatim, matching the snake_case request body as the client sent it.
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
type IndexedTemplate = {
  template: string;
  segments: string[];
  paramCount: number;
};

let cachedTemplates: Map<number, IndexedTemplate[]> | null = null;

/**
 * The spec's path templates split once and bucketed by segment count, fewest
 * brace segments first.
 *
 * `matchOpenApiPath` runs on every authenticated request now that the query
 * check is not opt-in, and re-splitting ~275 templates per request to compare a
 * handful of segments is work the spec already knows the answer to. Rebuilt
 * only when the spec cache is.
 */
const templateIndex = (): Map<number, IndexedTemplate[]> => {
  if (cachedTemplates) return cachedTemplates;

  const index = new Map<number, IndexedTemplate[]>();
  for (const template of Object.keys(getMergedOpenApiSpec().paths)) {
    const segments = template.split('/').filter(Boolean);
    const paramCount = segments.filter((segment) => {
      return segment.startsWith('{') && segment.endsWith('}');
    }).length;
    const bucket = index.get(segments.length) ?? [];
    bucket.push({ template, segments, paramCount });
    index.set(segments.length, bucket);
  }
  for (const bucket of index.values()) {
    bucket.sort((a, b) => {
      return a.paramCount - b.paramCount;
    });
  }

  cachedTemplates = index;
  return index;
};

export const matchOpenApiPath = (args: { path: string }): string | null => {
  const requestSegments = args.path.split('/').filter(Boolean);

  for (const candidate of templateIndex().get(requestSegments.length) ?? []) {
    const matches = candidate.segments.every((segment, index) => {
      return segment.startsWith('{') && segment.endsWith('}')
        ? requestSegments[index].length > 0
        : segment === requestSegments[index];
    });
    if (matches) return candidate.template;
  }

  return null;
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

const resolveJsonContentSchema = (container: unknown): unknown => {
  if (!isObjectRecord(container)) return undefined;
  const { content } = container;
  if (!isObjectRecord(content)) return undefined;
  const json = content['application/json'];
  if (!isObjectRecord(json)) return undefined;
  return json.schema;
};

/**
 * Resolves the `application/json` response schema an operation declares for a
 * given status code — following a top-level `$ref` to its named component
 * schema. Returns `null` when the operation declares no JSON body for that
 * status (a `204`, a stream, an unspecified status).
 *
 * `path` is the OpenAPI path template (e.g. `/api/v1/agents/{agent_id}`).
 */
export const getRouteResponseSchema = (args: {
  method: string;
  path: string;
  status: number;
}): Record<string, unknown> | null => {
  const method = args.method.toLowerCase();
  if (!HTTP_METHODS.has(method)) return null;

  const pathItem = getMergedOpenApiSpec().paths[normalizeRoutePath(args.path)];
  if (!isObjectRecord(pathItem)) return null;

  const operation = pathItem[method];
  if (!isObjectRecord(operation)) return null;

  const { responses } = operation;
  if (!isObjectRecord(responses)) return null;

  const schema = resolveJsonContentSchema(responses[String(args.status)]);
  if (!isObjectRecord(schema)) return null;

  return resolveSchemaRef(schema);
};

// Follows a `$ref` into `components.parameters`, or returns an inline parameter
// object unchanged. Null when the ref names nothing.
const resolveParameterRef = (
  parameter: unknown
): Record<string, unknown> | null => {
  if (!isObjectRecord(parameter)) return null;
  const ref = parameter.$ref;
  if (typeof ref !== 'string') return parameter;
  const name = ref.split('/').pop();
  if (!name) return null;
  const named = getMergedOpenApiSpec().components.parameters[name];
  return isObjectRecord(named) ? named : null;
};

const queryParamNames = (parameters: unknown): string[] => {
  if (!Array.isArray(parameters)) return [];
  return parameters.flatMap((parameter) => {
    const resolved = resolveParameterRef(parameter);
    if (!resolved || resolved.in !== 'query') return [];
    return typeof resolved.name === 'string' ? [resolved.name] : [];
  });
};

/**
 * Every query parameter an operation declares — the path item's shared
 * parameters and the operation's own, with `$ref`s followed. Returns `null`
 * when the (template, method) names no operation, so a caller can tell "no
 * parameters declared" from "no such operation".
 *
 * `path` is the OpenAPI path template, so the result is the spec's contract for
 * the route rather than a hand-kept allowlist beside it.
 */
export const getDeclaredQueryParams = (args: {
  method: string;
  path: string;
}): Set<string> | null => {
  const method = args.method.toLowerCase();
  if (!HTTP_METHODS.has(method)) return null;

  const pathItem = getMergedOpenApiSpec().paths[normalizeRoutePath(args.path)];
  if (!isObjectRecord(pathItem)) return null;

  const operation = pathItem[method];
  if (!isObjectRecord(operation)) return null;

  return new Set([
    ...queryParamNames(pathItem.parameters),
    ...queryParamNames(operation.parameters),
  ]);
};
