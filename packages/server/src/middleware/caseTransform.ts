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

export const caseTransformMiddleware = async (ctx: Context, next: Next) => {
  if (!ctx.path.startsWith('/api/v1')) {
    await next();
    return;
  }

  // Transform incoming request body from snake_case to camelCase
  // The 'template' key is a pass-through user document (formation templates)
  // whose inner keys must not be transformed.
  const BODY_SKIP_KEYS = new Set(['template']);
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

  // Transform outgoing response body from camelCase to snake_case
  if (isPlainObject(ctx.body) || Array.isArray(ctx.body)) {
    ctx.body = transformKeys(ctx.body, camelToSnake);
  }
};
