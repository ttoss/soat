import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

import createDebug from 'debug';
import yaml from 'js-yaml';

import type { ValidationError } from '../formationsTypes';

const log = createDebug('soat:formations:specLoader');

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// ── OpenAPI types ────────────────────────────────────────────────────────

type OpenApiSchema = {
  type?: string;
  nullable?: boolean;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
};

type OpenApiSpec = {
  components?: {
    schemas?: Record<string, OpenApiSchema>;
  };
};

// ── Module spec ──────────────────────────────────────────────────────────

export type FieldSpec = {
  type?: string;
  nullable: boolean;
};

export type ModuleOpenApiSpec = {
  allowedFields: Set<string>;
  requiredFields: Set<string>;
  fieldSpecs: Record<string, FieldSpec>;
};

// ── Type validators ──────────────────────────────────────────────────────

type TypeValidationArgs = {
  fieldName: string;
  nullable: boolean;
  value: unknown;
};

const typeValidators: Record<
  string,
  (args: TypeValidationArgs) => string | null
> = {
  string: ({ fieldName, nullable, value }) => {
    const valid = typeof value === 'string' || (nullable && value === null);
    if (valid) return null;
    return nullable
      ? `\`${fieldName}\` must be a string or null`
      : `\`${fieldName}\` must be a string`;
  },
  boolean: ({ fieldName, nullable, value }) => {
    const valid = typeof value === 'boolean' || (nullable && value === null);
    if (valid) return null;
    return nullable
      ? `\`${fieldName}\` must be a boolean or null`
      : `\`${fieldName}\` must be a boolean`;
  },
  integer: ({ fieldName, nullable, value }) => {
    const valid =
      (typeof value === 'number' && Number.isInteger(value)) ||
      (nullable && value === null);
    if (valid) return null;
    return nullable
      ? `\`${fieldName}\` must be an integer or null`
      : `\`${fieldName}\` must be an integer`;
  },
  number: ({ fieldName, nullable, value }) => {
    const valid = typeof value === 'number' || (nullable && value === null);
    if (valid) return null;
    return nullable
      ? `\`${fieldName}\` must be a number or null`
      : `\`${fieldName}\` must be a number`;
  },
  array: ({ fieldName, nullable, value }) => {
    const valid = Array.isArray(value) || (nullable && value === null);
    if (valid) return null;
    return nullable
      ? `\`${fieldName}\` must be an array or null`
      : `\`${fieldName}\` must be an array`;
  },
  object: ({ fieldName, nullable, value }) => {
    const valid =
      (typeof value === 'object' && value !== null && !Array.isArray(value)) ||
      (nullable && value === null);
    if (valid) return null;
    return nullable
      ? `\`${fieldName}\` must be an object or null`
      : `\`${fieldName}\` must be an object`;
  },
};

// ── Spec path resolution ─────────────────────────────────────────────────

const resolveFormationSpecPath = (): string => {
  const candidates = [
    path.resolve(__dirname, '../../rest/openapi/v1/formations.yaml'),
    path.resolve(__dirname, '../../../src/rest/openapi/v1/formations.yaml'),
    path.resolve(process.cwd(), 'src/rest/openapi/v1/formations.yaml'),
    path.resolve(
      process.cwd(),
      'packages/server/src/rest/openapi/v1/formations.yaml'
    ),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    'Could not locate formations OpenAPI spec file to load formation fields'
  );
};

// ── Spec loading ─────────────────────────────────────────────────────────

const specCache: Record<string, ModuleOpenApiSpec> = {};

export const loadModuleSpec = (args: {
  schemaName: string;
}): ModuleOpenApiSpec => {
  const cached = specCache[args.schemaName];
  if (cached) return cached;

  const specPath = resolveFormationSpecPath();
  log(
    'loading formation spec for schema %s from %s',
    args.schemaName,
    specPath
  );
  const raw = fs.readFileSync(specPath, 'utf-8');
  const spec = yaml.load(raw) as OpenApiSpec;
  const schema = spec.components?.schemas?.[args.schemaName];

  if (!schema || !schema.properties) {
    throw new Error(
      `${args.schemaName} schema is missing in formations OpenAPI spec`
    );
  }

  const fieldSpecs = Object.fromEntries(
    Object.entries(schema.properties).map(([key, propertySchema]) => {
      return [
        key,
        {
          type: propertySchema?.type,
          nullable: propertySchema?.nullable === true,
        },
      ];
    })
  ) as Record<string, FieldSpec>;

  const result: ModuleOpenApiSpec = {
    allowedFields: new Set(Object.keys(schema.properties)),
    requiredFields: new Set(schema.required ?? []),
    fieldSpecs,
  };

  specCache[args.schemaName] = result;
  return result;
};

// ── Guard helpers ────────────────────────────────────────────────────────

export const isObjectRecord = (
  value: unknown
): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

export const isFormationExpression = (value: unknown): boolean => {
  if (!isObjectRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  const key = keys[0];
  if (!['ref', 'param', 'sub'].includes(key)) return false;
  return typeof value[key] === 'string';
};

// ── Generic validation push helpers ─────────────────────────────────────

export const pushUnknownFieldErrors = (args: {
  spec: ModuleOpenApiSpec;
  resourceLabel: string;
  properties: Record<string, unknown>;
  basePath: string;
  errors: ValidationError[];
}): void => {
  for (const key of Object.keys(args.properties)) {
    if (args.properties[key] === undefined) continue;
    if (!args.spec.allowedFields.has(key)) {
      args.errors.push({
        path: `${args.basePath}.${key}`,
        message: `Unknown ${args.resourceLabel} field '${key}'. Allowed: ${[
          ...args.spec.allowedFields,
        ].join(', ')}`,
      });
    }
  }
};

export const pushRequiredFieldErrors = (args: {
  spec: ModuleOpenApiSpec;
  properties: Record<string, unknown>;
  basePath: string;
  errors: ValidationError[];
}): void => {
  for (const requiredField of args.spec.requiredFields) {
    if (args.properties[requiredField] === undefined) {
      args.errors.push({
        path: `${args.basePath}.${requiredField}`,
        message: `\`${requiredField}\` is required`,
      });
    }
  }
};

export const pushFieldTypeErrors = (args: {
  spec: ModuleOpenApiSpec;
  properties: Record<string, unknown>;
  basePath: string;
  errors: ValidationError[];
}): void => {
  for (const [fieldName, fieldSpec] of Object.entries(args.spec.fieldSpecs)) {
    const value = args.properties[fieldName];
    if (value === undefined || isFormationExpression(value)) continue;

    const validator = fieldSpec.type
      ? typeValidators[fieldSpec.type]
      : undefined;
    if (!validator) continue;

    const message = validator({
      fieldName,
      nullable: fieldSpec.nullable,
      value,
    });
    if (message) {
      args.errors.push({ path: `${args.basePath}.${fieldName}`, message });
    }
  }
};
