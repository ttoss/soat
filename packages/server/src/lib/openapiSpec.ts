import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

import yaml from 'js-yaml';

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

type SchemaWithProperties = {
  properties: Record<string, unknown>;
  required?: unknown;
};

const hasProperties = (value: unknown): value is SchemaWithProperties => {
  if (typeof value !== 'object' || value === null) return false;
  const { properties } = value as { properties?: unknown };
  return typeof properties === 'object' && properties !== null;
};

export type RequestSchemaFields = {
  /** Allowed body field names, converted to camelCase (internal convention). */
  allowedFields: Set<string>;
  /** Required body field names, converted to camelCase. */
  requiredFields: Set<string>;
};

/**
 * Derives the set of known body fields for a request schema directly from the
 * OpenAPI specs — the single source of truth for the REST contract, SDK, CLI,
 * and MCP surface. Property names are stored as snake_case in the spec and
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

  const required = Array.isArray(schema.required) ? schema.required : [];

  return {
    allowedFields: new Set(Object.keys(schema.properties).map(snakeToCamel)),
    requiredFields: new Set(
      required
        .filter((f): f is string => {
          return typeof f === 'string';
        })
        .map(snakeToCamel)
    ),
  };
};
