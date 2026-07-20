/* eslint-disable max-depth */
/**
 * Reads all OpenAPI YAML specs and generates src/generated/routes.ts —
 * a typed manifest mapping kebab-case CLI command names to their SDK
 * service class, operationId, and parameter lists.
 *
 * Run via: pnpm generate
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

import { load } from 'js-yaml';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const SPECS_DIR = path.resolve(__dirname, '../../server/src/rest/openapi/v1');
const OUT_FILE = path.resolve(__dirname, '../src/generated/routes.ts');
const MODULE_DOCS_BASE_URL = 'https://soat.ttoss.dev/docs/modules';

interface OpenApiParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  $ref?: string;
}
interface OpenApiSchema {
  type?: string;
  default?: unknown;
}

interface OpenApiParameterFull extends OpenApiParameter {
  description?: string;
  required?: boolean;
  schema?: OpenApiSchema;
}

interface OpenApiRequestBodyProperty {
  type?: string;
  description?: string;
  nullable?: boolean;
  $ref?: string;
}

interface OpenApiRequestBodySchema {
  required?: string[];
  properties?: Record<string, OpenApiRequestBodyProperty>;
  oneOf?: OpenApiRequestBodySchema[];
}

interface OpenApiRequestBody {
  required?: boolean;
  content?: {
    'application/json'?: {
      schema?: OpenApiRequestBodySchema;
    };
  };
}

interface OpenApiOperation {
  operationId?: string;
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: OpenApiParameterFull[];
  requestBody?: OpenApiRequestBody;
}

interface OpenApiPathItem {
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  put?: OpenApiOperation;
  patch?: OpenApiOperation;
  delete?: OpenApiOperation;
  parameters?: OpenApiParameterFull[];
}

interface OpenApiComponents {
  parameters?: Record<string, OpenApiParameterFull>;
  schemas?: Record<string, OpenApiRequestBodySchema & { $ref?: string }>;
}

interface OpenApiSpec {
  tags?: Array<{ name: string }>;
  paths?: Record<string, OpenApiPathItem>;
  components?: OpenApiComponents;
}

/** Convert camelCase operationId to kebab-case CLI command name. */
const toKebab = (s: string) => {
  return s
    .replace(/([A-Z])/g, (c) => {
      return `-${c.toLowerCase()}`;
    })
    .replace(/^-/, '');
};

/** Derive the SDK class name from a tag string (e.g. "AI Providers" → "AiProviders"). */
const toClassName = (tag: string) => {
  return tag
    .split(/\s+/)
    .map((w) => {
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join('');
};

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

interface Route {
  serviceClass: string;
  operationId: string;
  description: string;
  moduleDocsUrl: string;
  /** HTTP method the operation is mounted on (get, post, put, patch, delete) */
  httpMethod: (typeof HTTP_METHODS)[number];
  pathParams: string[];
  queryParams: string[];
}

/** Metadata for a single CLI flag, used to render --help output. */
export interface Flag {
  /** flag name in snake_case (e.g. project_id) */
  name: string;
  description: string;
  required: boolean;
  type: string;
  /** where the value is sent: path, query, or body */
  in: 'path' | 'query' | 'body';
}

interface RouteWithFlags extends Route {
  flags: Flag[];
}

const routes: Record<string, RouteWithFlags> = {};

const files = fs
  .readdirSync(SPECS_DIR)
  .filter((f) => {
    return f.endsWith('.yaml');
  })
  .sort();

for (const file of files) {
  const spec = load(
    fs.readFileSync(path.join(SPECS_DIR, file), 'utf8')
  ) as OpenApiSpec;
  const moduleSlug = path.basename(file, '.yaml');
  const moduleDocsUrl = `${MODULE_DOCS_BASE_URL}/${moduleSlug}`;

  const moduleTag = spec.tags?.[0]?.name;

  /** Resolve a parameter that may be a $ref to components/parameters. */
  const resolveParam = (p: OpenApiParameterFull): OpenApiParameterFull => {
    if (p.$ref) {
      const refKey = p.$ref.replace('#/components/parameters/', '');
      return spec.components?.parameters?.[refKey] ?? p;
    }
    return p;
  };

  /** Resolve a schema that may be a $ref to components/schemas. */
  const resolveSchema = (
    schema: OpenApiRequestBodySchema & { $ref?: string }
  ): OpenApiRequestBodySchema => {
    if (schema.$ref) {
      const refKey = schema.$ref.replace('#/components/schemas/', '');
      return spec.components?.schemas?.[refKey] ?? schema;
    }
    return schema;
  };

  /**
   * Resolves a body property that is itself a bare `$ref` (e.g. `reasoning:
   * $ref: '#/components/schemas/ReasoningConfig'`) so its description/type
   * still reach the CLI flag metadata. Same-file refs only — no request body
   * property currently points across files.
   */
  const resolveProperty = (
    property: OpenApiRequestBodyProperty
  ): OpenApiRequestBodyProperty => {
    if (property.$ref && property.$ref.startsWith('#/components/schemas/')) {
      const refKey = property.$ref.replace('#/components/schemas/', '');
      const resolved = spec.components?.schemas?.[refKey];
      if (resolved) return resolved;
    }
    return property;
  };

  for (const [, pathItem] of Object.entries(spec.paths ?? {})) {
    // Collect path-level parameters (inherited by all operations)
    const pathLevelParams = (pathItem.parameters ?? []).map(resolveParam);

    for (const method of HTTP_METHODS) {
      const op = (pathItem as Record<string, OpenApiOperation>)[method];
      if (!op?.operationId) continue;

      const tag = op.tags?.[0] ?? moduleTag;
      if (!tag) {
        continue;
      }

      const kebab = toKebab(op.operationId);
      // Merge path-level params with operation-level params (operation takes precedence)
      const opParams = (op.parameters ?? []).map(resolveParam);
      const opParamNames = new Set(
        opParams.map((p) => {
          return p.name;
        })
      );
      const params = [
        ...pathLevelParams.filter((p) => {
          return !opParamNames.has(p.name);
        }),
        ...opParams,
      ];

      // Build the flags array from path/query params + requestBody properties
      const flags: Flag[] = [];

      for (const p of params) {
        if (p.in !== 'path' && p.in !== 'query') continue;
        flags.push({
          name: p.name,
          description: p.description ?? '',
          required: p.required ?? p.in === 'path',
          type: p.schema?.type ?? 'string',
          in: p.in,
        });
      }

      const rawBodySchema =
        op.requestBody?.content?.['application/json']?.schema;
      const bodySchema = rawBodySchema
        ? resolveSchema(
            rawBodySchema as OpenApiRequestBodySchema & { $ref?: string }
          )
        : undefined;
      if (bodySchema) {
        const mergedProperties: Record<string, OpenApiRequestBodyProperty> = {};
        const requiredInAll = new Set<string>();

        const collectFromSchema = (schema: OpenApiRequestBodySchema) => {
          if (schema.properties) {
            const required = new Set(schema.required ?? []);
            for (const [propName, propSchema] of Object.entries(
              schema.properties
            )) {
              if (!mergedProperties[propName]) {
                mergedProperties[propName] = resolveProperty(propSchema);
                if (required.has(propName)) requiredInAll.add(propName);
              }
            }
          }
        };

        if (bodySchema.oneOf) {
          for (const variant of bodySchema.oneOf) {
            collectFromSchema(variant);
          }
          // A field is only required if it appears as required in ALL variants
          const requiredEvery = new Set<string>();
          for (const propName of Object.keys(mergedProperties)) {
            if (
              bodySchema.oneOf.every((v) => {
                return v.required?.includes(propName);
              })
            ) {
              requiredEvery.add(propName);
            }
          }
          for (const [propName, propSchema] of Object.entries(
            mergedProperties
          )) {
            flags.push({
              name: propName,
              description: propSchema.description ?? '',
              required: requiredEvery.has(propName),
              type: propSchema.type ?? 'string',
              in: 'body',
            });
          }
        } else {
          collectFromSchema(bodySchema);
          for (const [propName, propSchema] of Object.entries(
            mergedProperties
          )) {
            flags.push({
              name: propName,
              description: propSchema.description ?? '',
              required: requiredInAll.has(propName),
              type: propSchema.type ?? 'string',
              in: 'body',
            });
          }
        }
      }

      routes[kebab] = {
        serviceClass: toClassName(tag),
        operationId: op.operationId,
        description: (op.description ?? op.summary ?? op.operationId)
          .replace(/\s+/g, ' ')
          .trim(),
        moduleDocsUrl,
        httpMethod: method,
        pathParams: params
          .filter((p) => {
            return p.in === 'path';
          })
          .map((p) => {
            return p.name;
          }),
        queryParams: params
          .filter((p) => {
            return p.in === 'query';
          })
          .map((p) => {
            return p.name;
          }),
        flags,
      };
    }
  }
}

const lines = [
  '// AUTO-GENERATED — do not edit. Run `pnpm generate` to regenerate.',
  '',
  'export interface Route {',
  '  serviceClass: string;',
  '  operationId: string;',
  '  /** operation summary/description */',
  '  description: string;',
  '  /** URL to module documentation page */',
  '  moduleDocsUrl: string;',
  '  /** HTTP method the operation is mounted on */',
  "  httpMethod: 'get' | 'post' | 'put' | 'patch' | 'delete';",
  '  /** snake_case path parameter names */',
  '  pathParams: string[];',
  '  /** snake_case query parameter names */',
  '  queryParams: string[];',
  '  /** snake_case flags (path, query, body) with metadata for --help. */',
  '  flags: Flag[];',
  '}',
  '',
  '/** Metadata for a single CLI flag, used to render --help output. */',
  'export interface Flag {',
  '  name: string;',
  '  description: string;',
  '  required: boolean;',
  '  type: string;',
  "  in: 'path' | 'query' | 'body';",
  '}',
  '',
  'export const routes: Record<string, Route> = {',
  ...Object.entries(routes).map(([cmd, r]) => {
    const flags = JSON.stringify(r.flags);
    return `  '${cmd}': { serviceClass: '${r.serviceClass}', operationId: '${r.operationId}', description: ${JSON.stringify(r.description)}, moduleDocsUrl: ${JSON.stringify(r.moduleDocsUrl)}, httpMethod: '${r.httpMethod}', pathParams: ${JSON.stringify(r.pathParams)}, queryParams: ${JSON.stringify(r.queryParams)}, flags: ${flags} },`;
  }),
  '};',
  '',
];

fs.writeFileSync(OUT_FILE, lines.join('\n'));
// eslint-disable-next-line no-console
console.log(`Generated ${Object.keys(routes).length} routes → ${OUT_FILE}`);
