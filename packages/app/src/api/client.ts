import { createClient } from '@soat/sdk';

export type ApiError = { message: string; code?: string };

/**
 * The app is served from the same origin as the API (the server mounts both
 * `/app` and `/api/v1`), so requests resolve against the current origin. An
 * explicit base URL is required because the SDK builds a `Request` object,
 * whose constructor rejects relative URLs outside the browser.
 */
export const apiBaseUrl = (): string | undefined => {
  return typeof window !== 'undefined' ? window.location.origin : undefined;
};

export type ApiResult<T> =
  { ok: true; data: T } | { ok: false; status: number; error: ApiError };

const extractError = (errorBody: unknown, status: number): ApiError => {
  if (typeof errorBody === 'object' && errorBody !== null) {
    const body = errorBody as Record<string, unknown>;
    const err = body['error'];
    if (typeof err === 'string') return { message: err };
    if (typeof err === 'object' && err !== null) {
      const e = err as Record<string, unknown>;
      return {
        message:
          typeof e['message'] === 'string' ? e['message'] : `HTTP ${status}`,
        code: typeof e['code'] === 'string' ? e['code'] : undefined,
      };
    }
  }
  return { message: `HTTP ${status}` };
};

export const apiFetchMultipart = async <T>(args: {
  url: string;
  formData: FormData;
  token: string;
}): Promise<ApiResult<T>> => {
  const baseUrl = apiBaseUrl() ?? '';
  const fullUrl = args.url.startsWith('http')
    ? args.url
    : `${baseUrl}${args.url}`;
  const response = await fetch(fullUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${args.token}` },
    body: args.formData,
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: extractError(body, response.status),
    };
  }
  return { ok: true, data: body as T };
};

export const apiFetch = async <T>(args: {
  url: string;
  method?: string;
  body?: unknown;
  token: string;
}): Promise<ApiResult<T>> => {
  const client = createClient({
    baseUrl: apiBaseUrl(),
    headers: { Authorization: `Bearer ${args.token}` },
  });

  type Method =
    'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  const result = await client.request({
    url: args.url,
    method: (args.method ?? 'GET') as Method,
    body: args.body,
  });

  if (result.error !== undefined) {
    const status = result.response?.status ?? 0;
    return { ok: false, status, error: extractError(result.error, status) };
  }

  return { ok: true, data: result.data as T };
};
