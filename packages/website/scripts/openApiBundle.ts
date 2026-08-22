/**
 * Merges the per-module OpenAPI specs (the source of truth for REST, the SDK,
 * the CLI and the MCP tool surface) into the single bundle published at
 * `/openapi.json`, `/openapi.yaml` and `/api/openapi.yaml`, plus the error
 * catalog published at `/errors.json`.
 *
 * Pure functions only — the file writes live in
 * `scripts/generateAgentSurfaces.ts`.
 */

export type ErrorCodeEntry = {
  httpStatus: number;
  description: string;
};

export type ErrorCodes = Record<string, ErrorCodeEntry>;

/**
 * The hint lookups the server resolves an error's `hint` and `docs_url` with,
 * injected rather than imported so the bundle stays a pure function of its
 * inputs (and so the tests can drive it with a synthetic registry).
 */
export type ErrorHints = {
  resolutionFor: (args: { code: string }) => string;
  docsUrlFor: (args: { code: string }) => string;
};

export type OpenApiTag = {
  name: string;
  description?: string;
};

/**
 * The `components` sections OpenAPI 3.0 defines. Every one of them is merged:
 * the module specs reference each other's `parameters` and `responses`, not
 * only their `schemas`, so a bundle carrying schemas alone would publish
 * dangling `$ref`s.
 */
const COMPONENT_SECTIONS = [
  'schemas',
  'responses',
  'parameters',
  'examples',
  'requestBodies',
  'headers',
  'securitySchemes',
  'links',
  'callbacks',
] as const;

export type ComponentSection = (typeof COMPONENT_SECTIONS)[number];

export type SpecComponents = Partial<
  Record<ComponentSection, Record<string, unknown>>
>;

export type ModuleSpec = {
  paths?: Record<string, unknown>;
  tags?: OpenApiTag[];
  components?: SpecComponents;
};

export type BundleComponents = SpecComponents & {
  schemas: Record<string, unknown>;
  securitySchemes: Record<string, unknown>;
};

export type OpenApiBundle = {
  openapi: string;
  info: {
    title: string;
    version: string;
    description: string;
    license: { name: string; url: string };
    contact: { name: string; url: string };
  };
  servers: {
    url: string;
    description: string;
    variables: Record<string, { default: string; description: string }>;
  }[];
  security: Record<string, string[]>[];
  tags: OpenApiTag[];
  paths: Record<string, unknown>;
  components: BundleComponents;
  'x-error-codes': Record<
    string,
    {
      http_status: number;
      description: string;
      resolution: string;
      docs_url: string;
    }
  >;
};

export type ErrorCatalog = {
  $schema: string;
  name: string;
  version: string;
  description: string;
  shape: {
    description: string;
    example: {
      error: {
        code: string;
        message: string;
        hint: string;
        docs_url: string;
      };
    };
  };
  codes: {
    code: string;
    http_status: number;
    description: string;
    resolution: string;
    docs_url: string;
  }[];
};

const BUNDLE_DESCRIPTION = `Complete REST surface of a SOAT deployment, merged from the per-module OpenAPI
specs that also generate the TypeScript SDK, the \`soat\` CLI and the MCP tool
surface. SOAT is self-hosted: point the \`baseUrl\` server variable at your own
deployment — this documentation site serves the description only, not the API.

Authentication is a bearer token: a user JWT from \`POST /api/v1/users/login\`,
or a project key (\`sk_…\`). Request and response bodies are snake_case.

Every error response — including the ones a client is most tempted to
special-case (401, 403, 429, 500) — is JSON of the same shape:
\`{ "error": { "code": "RESOURCE_NOT_FOUND", "message": "…", "hint": "…",
"docs_url": "…", "meta": { … } } }\`.
\`error.code\` is stable and safe to branch on, and \`error.hint\` says what to do
about the failure; the full catalog of codes, their
HTTP statuses and what they mean is in this document's \`x-error-codes\`
extension and at https://soat.ttoss.dev/errors.json.`;

const ERROR_SHAPE_DESCRIPTION =
  'Every 4xx and 5xx response body. `error.code` is a stable identifier safe to branch on; `error.message` is human-readable and may change; `error.hint` says what to do about the failure and `error.docs_url` addresses the reference section for the code; `error.meta` carries per-code context when available.';

const errorResponseSchema = () => {
  return {
    type: 'object',
    required: ['error'],
    description: ERROR_SHAPE_DESCRIPTION,
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message', 'hint', 'docs_url'],
        properties: {
          code: {
            type: 'string',
            description:
              'Stable error code. See the `x-error-codes` extension for the full catalog.',
          },
          message: {
            type: 'string',
            description: 'Human-readable description of what went wrong.',
          },
          hint: {
            type: 'string',
            description:
              'What to do about this error, resolved per code so a caller meeting it for the first time can act without leaving the response.',
          },
          docs_url: {
            type: 'string',
            format: 'uri',
            description:
              'Reference-page anchor documenting this code, e.g. https://soat.ttoss.dev/docs/error-codes#resource_not_found.',
          },
          meta: {
            type: 'object',
            additionalProperties: true,
            description:
              'Optional per-code context, e.g. the id that was not found.',
          },
        },
      },
    },
  };
};

const sortedCodes = (errorCodes: ErrorCodes): string[] => {
  return Object.keys(errorCodes).sort();
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return { ...value };
};

/**
 * Rewrites the cross-file references the module specs use
 * (`./generations.yaml#/components/schemas/Generation`) to the bundle-local
 * component they land on once every spec is merged into one document.
 */
const normalizeRefs = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => {
      return normalizeRefs(item);
    });
  }

  const record = asRecord(value);
  if (!record) return value;

  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => {
      if (key === '$ref' && typeof entry === 'string') {
        const hash = entry.indexOf('#');
        return [key, hash >= 0 ? entry.slice(hash) : entry];
      }
      return [key, normalizeRefs(entry)];
    })
  );
};

const collectRefs = (value: unknown, found: Set<string>) => {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRefs(item, found);
    }
    return;
  }

  const record = asRecord(value);
  if (!record) return;

  for (const [key, entry] of Object.entries(record)) {
    if (key === '$ref' && typeof entry === 'string') {
      found.add(entry);
      continue;
    }
    collectRefs(entry, found);
  }
};

const REF_PATTERN = /^#\/components\/([^/]+)\/(.+)$/;

/**
 * Every `$ref` in the bundle that resolves to nothing — a cross-file reference
 * whose target module was not merged, or a component no spec declares. The
 * generator fails on a non-empty result: a description with dangling
 * references is worse for an agent than none, because the agent cannot tell
 * which half is missing.
 */
export const findDanglingRefs = (args: { bundle: OpenApiBundle }): string[] => {
  const refs = new Set<string>();
  collectRefs(args.bundle.paths, refs);
  collectRefs(args.bundle.components, refs);

  return [...refs]
    .filter((ref) => {
      const match = REF_PATTERN.exec(ref);
      if (!match) return true;

      const section = COMPONENT_SECTIONS.find((candidate) => {
        return candidate === match[1];
      });
      if (!section) return true;

      return args.bundle.components[section]?.[match[2]] === undefined;
    })
    .sort();
};

type MergedSpecs = {
  paths: Record<string, unknown>;
  components: BundleComponents;
  tags: OpenApiTag[];
};

/**
 * Merges the module specs in name order, last definition wins — the same rule
 * the server applies in `getMergedOpenApiSpec`, so the published bundle matches
 * what a deployment serves at /api/v1/openapi.json.
 */
const mergeSpecs = (
  specs: { name: string; spec: ModuleSpec }[]
): MergedSpecs => {
  const paths: Record<string, unknown> = {};
  const components: BundleComponents = { schemas: {}, securitySchemes: {} };
  const tags: OpenApiTag[] = [];
  const seenTags = new Set<string>();

  const ordered = [...specs].sort((a, b) => {
    return a.name.localeCompare(b.name);
  });

  for (const { spec } of ordered) {
    Object.assign(paths, spec.paths ?? {});

    for (const section of COMPONENT_SECTIONS) {
      const incoming = spec.components?.[section];
      if (!incoming) continue;
      components[section] = { ...components[section], ...incoming };
    }

    for (const tag of spec.tags ?? []) {
      if (seenTags.has(tag.name)) continue;
      seenTags.add(tag.name);
      tags.push(tag);
    }
  }

  // Most module specs already declare `ErrorResponse` (identically); it is
  // filled in only when none of them did, so the specs stay the source of
  // truth for the shape.
  if (!components.schemas.ErrorResponse) {
    components.schemas.ErrorResponse = errorResponseSchema();
  }

  return { paths, components, tags };
};

export const buildOpenApiBundle = (args: {
  specs: { name: string; spec: ModuleSpec }[];
  version: string;
  errorCodes: ErrorCodes;
  errorHints: ErrorHints;
}): OpenApiBundle => {
  const { paths, components, tags } = mergeSpecs(args.specs);

  const normalizedPaths = asRecord(normalizeRefs(paths)) ?? {};
  const normalizedComponents = {
    ...components,
    ...asRecord(normalizeRefs(components)),
  };

  return {
    openapi: '3.0.3',
    info: {
      title: 'SOAT REST API',
      version: args.version,
      description: BUNDLE_DESCRIPTION,
      license: {
        name: 'Apache-2.0',
        url: 'https://github.com/ttoss/soat/blob/main/LICENSE',
      },
      contact: {
        name: 'SOAT on GitHub',
        url: 'https://github.com/ttoss/soat',
      },
    },
    servers: [
      {
        url: '{baseUrl}',
        description:
          'Base URL of your SOAT deployment (e.g. https://soat.example.com or http://localhost:5047).',
        variables: {
          baseUrl: {
            default: 'http://localhost:5047',
            description: 'The base URL of your SOAT deployment.',
          },
        },
      },
    ],
    security: [{ bearerAuth: [] }],
    tags,
    paths: normalizedPaths,
    components: normalizedComponents,
    'x-error-codes': Object.fromEntries(
      sortedCodes(args.errorCodes).map((code) => {
        return [
          code,
          {
            http_status: args.errorCodes[code].httpStatus,
            description: args.errorCodes[code].description,
            resolution: args.errorHints.resolutionFor({ code }),
            docs_url: args.errorHints.docsUrlFor({ code }),
          },
        ];
      })
    ),
  };
};

export const buildErrorCatalog = (args: {
  errorCodes: ErrorCodes;
  version: string;
  errorHints: ErrorHints;
}): ErrorCatalog => {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    name: 'SOAT API error codes',
    version: args.version,
    description:
      'Every error code the SOAT REST API, MCP surface and SDK can return, with its HTTP status and what it means. Generated from the server source (packages/server/src/errors/codes.ts).',
    shape: {
      description: ERROR_SHAPE_DESCRIPTION,
      example: {
        error: {
          code: 'RESOURCE_NOT_FOUND',
          message: "Project 'proj_abc123' not found.",
          hint: args.errorHints.resolutionFor({ code: 'RESOURCE_NOT_FOUND' }),
          docs_url: args.errorHints.docsUrlFor({ code: 'RESOURCE_NOT_FOUND' }),
        },
      },
    },
    codes: sortedCodes(args.errorCodes).map((code) => {
      return {
        code,
        http_status: args.errorCodes[code].httpStatus,
        description: args.errorCodes[code].description,
        resolution: args.errorHints.resolutionFor({ code }),
        docs_url: args.errorHints.docsUrlFor({ code }),
      };
    }),
  };
};
