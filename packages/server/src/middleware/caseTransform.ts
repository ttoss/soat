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

export const caseTransformMiddleware = async (ctx: Context, next: Next) => {
  if (!ctx.path.startsWith('/api/v1') || ctx.path === OPENAPI_SPEC_PATH) {
    await next();
    return;
  }

  const metadataPassthrough = isMetadataPassthroughPath(ctx.path);

  // Transform incoming request body from snake_case to camelCase
  // The 'template' key is a pass-through user document (formation templates),
  // 'presetParameters' (the camelCase form of the request's preset_parameters
  // field) is verbatim converter-tool input, and 'execute' is a pass-through
  // tool execute config whose inner keys (HTTP header names, `body_mode`, …)
  // must be preserved verbatim — none may have their inner keys transformed.
  // This mirrors the outbound RESPONSE_SKIP_KEYS below so execute round-trips
  // unchanged in snake_case.
  const BODY_SKIP_KEYS = new Set(['template', 'presetParameters', 'execute']);
  if (metadataPassthrough) BODY_SKIP_KEYS.add('metadata');
  if (isPlainObject(ctx.request.body) || Array.isArray(ctx.request.body)) {
    ctx.request.body = transformKeys(
      ctx.request.body,
      snakeToCamel,
      BODY_SKIP_KEYS
    ) as typeof ctx.request.body;
  }

  // Transform incoming query params from snake_case to camelCase
  const rawQuery = ctx.query as Record<string, unknown>;
  if (isPlainObject(rawQuery)) {
    ctx.query = transformKeys(rawQuery, snakeToCamel) as typeof ctx.query;
  }

  await next();

  // Transform outgoing response body from camelCase to snake_case.
  // The 'execute' key is a pass-through user document (tool execute configs)
  // whose inner keys (e.g. HTTP headers like Content-Type) must not be
  // transformed — they are arbitrary user-defined strings, not camelCase
  // fields. 'preset_parameters' (the snake_case form of the response's
  // presetParameters field) is the same verbatim converter-tool input.
  const RESPONSE_SKIP_KEYS = new Set(['execute', 'preset_parameters']);
  if (metadataPassthrough) RESPONSE_SKIP_KEYS.add('metadata');
  if (isPlainObject(ctx.body) || Array.isArray(ctx.body)) {
    ctx.body = transformKeys(ctx.body, camelToSnake, RESPONSE_SKIP_KEYS);
  }
};
