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

import yaml from 'js-yaml';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const SPECS_DIR = path.resolve(__dirname, '../../server/src/rest/openapi/v1');
const OUT_FILE = path.resolve(__dirname, '../src/generated/routes.ts');

interface OpenApiParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  $ref?: string;
}

interface OpenApiOperation {
  operationId?: string;
  tags?: string[];
  parameters?: OpenApiParameter[];
}

interface OpenApiPathItem {
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  put?: OpenApiOperation;
  patch?: OpenApiOperation;
  delete?: OpenApiOperation;
  parameters?: OpenApiParameter[];
}

interface OpenApiComponents {
  parameters?: Record<string, OpenApiParameter>;
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
  pathParams: string[];
  queryParams: string[];
}

const routes: Record<string, Route> = {};

const files = fs
  .readdirSync(SPECS_DIR)
  .filter((f) => {
    return f.endsWith('.yaml');
  })
  .sort();

for (const file of files) {
  const spec = yaml.load(
    fs.readFileSync(path.join(SPECS_DIR, file), 'utf8')
  ) as OpenApiSpec;

  const moduleTag = spec.tags?.[0]?.name;

  /** Resolve a parameter that may be a $ref to components/parameters. */
  const resolveParam = (p: OpenApiParameter): OpenApiParameter => {
    if (p.$ref) {
      const refKey = p.$ref.replace('#/components/parameters/', '');
      return spec.components?.parameters?.[refKey] ?? p;
    }
    return p;
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

      routes[kebab] = {
        serviceClass: toClassName(tag),
        operationId: op.operationId,
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
  '  /** snake_case path parameter names */',
  '  pathParams: string[];',
  '  /** snake_case query parameter names */',
  '  queryParams: string[];',
  '}',
  '',
  'export const routes: Record<string, Route> = {',
  ...Object.entries(routes).map(([cmd, r]) => {
    return `  '${cmd}': { serviceClass: '${r.serviceClass}', operationId: '${r.operationId}', pathParams: ${JSON.stringify(r.pathParams)}, queryParams: ${JSON.stringify(r.queryParams)} },`;
  }),
  '};',
  '',
];

fs.writeFileSync(OUT_FILE, lines.join('\n'));
// eslint-disable-next-line no-console
console.log(`Generated ${Object.keys(routes).length} routes → ${OUT_FILE}`);
