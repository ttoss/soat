import type { Context } from 'src/Context';

type Next = () => Promise<void>;

const isPlainObject = (obj: unknown): obj is Record<string, unknown> => {
  if (obj === null || typeof obj !== 'object') return false;

  const proto = Object.getPrototypeOf(obj);
  return proto === Object.prototype || proto === null;
};

const camelToSnake = (str: string): string => {
  return str.replace(/[A-Z]/g, (char) => {
    return `_${char.toLowerCase()}`;
  });
};

const snakeToCamel = (str: string): string => {
  return str.replace(/_([a-z])/g, (_, char) => {
    return char.toUpperCase();
  });
};

const transformKeys = (
  obj: unknown,
  transform: (key: string) => string,
  skipKeys: Set<string> = new Set()
): unknown => {
  if (Array.isArray(obj)) {
    return obj.map((item) => {
      return transformKeys(item, transform, skipKeys);
    });
  }
  if (isPlainObject(obj)) {
    return Object.fromEntries(
      Object.entries(obj).map(([key, value]) => {
        const newKey = transform(key);
        if (skipKeys.has(newKey)) {
          // Pass-through fields (e.g. formation templates) must not be
          // recursively transformed — their inner keys are validated against
          // the OpenAPI spec which uses snake_case.
          return [newKey, value];
        }
        return [newKey, transformKeys(value, transform, skipKeys)];
      })
    );
  }
  return obj;
};

// The OpenAPI document is served as authored: valid OpenAPI uses camelCase
// structural keys (operationId, requestBody, …) while the API field names it
// describes stay snake_case. Running it through caseTransform would rewrite
// those structural keys to snake_case and produce an invalid spec, so the spec
// endpoint is excluded from case conversion entirely.
const OPENAPI_SPEC_PATH = '/api/v1/openapi.json';

// Only the documents module treats `metadata` as an arbitrary user-defined
// bag that must round-trip in the exact casing the caller wrote it in (e.g.
// `strapiDocumentId`). Other resources (e.g. conversation/session messages)
// store server-generated camelCase data under `metadata` and rely on the
// normal outbound camelCase → snake_case conversion, so the pass-through
// must be scoped to these paths rather than applied globally.
const METADATA_PASSTHROUGH_PATH_PREFIXES = [
  '/api/v1/documents',
  '/api/v1/knowledge/search',
];

const isMetadataPassthroughPath = (path: string): boolean => {
  return METADATA_PASSTHROUGH_PATH_PREFIXES.some((prefix) => {
    return path === prefix || path.startsWith(`${prefix}/`);
  });
};

// A tool's `input` is not part of SOAT's own resource contract — it is an
// opaque payload the tool forwards to its target (an `http` tool serializes it
// as the request body verbatim; a `pipeline` step's `input` mapping keys become
// the sub-tool's body keys). Case-transforming it would rewrite the field names
// a caller authored in snake_case (e.g. `fundamental_truth` → `fundamentalTruth`)
// before they reach the target API, which then rejects them. So on the tools
// routes `input` rounds-trips verbatim in both directions, exactly like
// `execute` and document `metadata`.
const TOOL_INPUT_PASSTHROUGH_PATH_PREFIX = '/api/v1/tools';

const isToolInputPassthroughPath = (path: string): boolean => {
  return (
    path === TOOL_INPUT_PASSTHROUGH_PATH_PREFIX ||
    path.startsWith(`${TOOL_INPUT_PASSTHROUGH_PATH_PREFIX}/`)
  );
};

// The inbound (snake→camel) pass-through keys for a given path.
// 'template' is a pass-through user document (formation templates),
// 'parameters' is the formation deploy-time value bag keyed against
// `template.parameters` and must stay in lockstep with those (also
// pass-through) names — independently case-transforming it would silently
// break the lookup for any parameter name containing an underscore.
// 'presetParameters' (the camelCase form of the request's preset_parameters
// field) is verbatim converter-tool input, and 'execute'/'mcp' are
// pass-through tool configs whose inner keys (HTTP header names, `body_mode`,
// …) must be preserved verbatim. 'metadata' (documents) and 'input' (tools)
// are path-scoped pass-throughs. This mirrors the outbound set below so each
// key round-trips unchanged.
const buildBodySkipKeys = (path: string): Set<string> => {
  const keys = new Set([
    'template',
    'parameters',
    'presetParameters',
    'execute',
    'mcp',
  ]);
  if (isMetadataPassthroughPath(path)) keys.add('metadata');
  if (isToolInputPassthroughPath(path)) keys.add('input');
  return keys;
};

// The outbound (camel→snake) pass-through keys — the mirror of the inbound set.
// 'preset_parameters' is the snake_case form of the response's presetParameters.
// 'template' is a pass-through user document (formation templates): its inner
// keys — resource logical IDs and parameter names — are author-chosen
// identifiers that are stored verbatim on the way in, so they must be returned
// verbatim on the way out. Rewriting them (e.g. `DefaultProvider` →
// `_default_provider`, `aiProviderName` → `ai_provider_name`) would make the
// returned template diverge from what was stored and break `--parameter`
// overrides that reference the original key. 'parameters' and 'mcp' mirror
// the inbound set for the same reason (tool `parameters` is a free-form JSON
// Schema; `mcp` carries HTTP header names, same as `execute`).
const buildResponseSkipKeys = (path: string): Set<string> => {
  const keys = new Set([
    'template',
    'parameters',
    'execute',
    'mcp',
    'preset_parameters',
  ]);
  if (isMetadataPassthroughPath(path)) keys.add('metadata');
  if (isToolInputPassthroughPath(path)) keys.add('input');
  return keys;
};

export const caseTransformMiddleware = async (ctx: Context, next: Next) => {
  if (!ctx.path.startsWith('/api/v1') || ctx.path === OPENAPI_SPEC_PATH) {
    await next();
    return;
  }

  // Transform incoming request body from snake_case to camelCase.
  if (isPlainObject(ctx.request.body) || Array.isArray(ctx.request.body)) {
    ctx.request.body = transformKeys(
      ctx.request.body,
      snakeToCamel,
      buildBodySkipKeys(ctx.path)
    ) as typeof ctx.request.body;
  }

  // Transform incoming query params from snake_case to camelCase
  const rawQuery = ctx.query as Record<string, unknown>;
  if (isPlainObject(rawQuery)) {
    ctx.query = transformKeys(rawQuery, snakeToCamel) as typeof ctx.query;
  }

  await next();

  // Transform outgoing response body from camelCase to snake_case.
  if (isPlainObject(ctx.body) || Array.isArray(ctx.body)) {
    ctx.body = transformKeys(
      ctx.body,
      camelToSnake,
      buildResponseSkipKeys(ctx.path)
    );
  }
};
