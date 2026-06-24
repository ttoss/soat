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

export const caseTransformMiddleware = async (ctx: Context, next: Next) => {
  if (!ctx.path.startsWith('/api/v1') || ctx.path === OPENAPI_SPEC_PATH) {
    await next();
    return;
  }

  // Transform incoming request body from snake_case to camelCase
  // The 'template' key is a pass-through user document (formation templates)
  // whose inner keys must not be transformed. The 'pipeline' key is a
  // declarative pipeline-tool document whose inner keys (tool_id,
  // input_mapping, output_mapping, …) are part of the external snake_case
  // contract and must be stored verbatim, so the executor and formation
  // module read the same shape regardless of how the tool was created.
  const BODY_SKIP_KEYS = new Set(['template', 'pipeline']);
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
  // transformed — they are arbitrary user-defined strings, not camelCase fields.
  // The 'pipeline' key is a pass-through pipeline-tool document already stored
  // in snake_case (see BODY_SKIP_KEYS) and must be echoed verbatim.
  const RESPONSE_SKIP_KEYS = new Set(['execute', 'pipeline']);
  if (isPlainObject(ctx.body) || Array.isArray(ctx.body)) {
    ctx.body = transformKeys(ctx.body, camelToSnake, RESPONSE_SKIP_KEYS);
  }
};
