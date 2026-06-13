import { createClient } from '@soat/sdk';

export type ApiError = { message: string; code?: string };

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: ApiError };

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

export const apiFetch = async <T>(args: {
  url: string;
  method?: string;
  body?: unknown;
  token: string;
}): Promise<ApiResult<T>> => {
  const client = createClient({
    headers: { Authorization: `Bearer ${args.token}` },
  });

  type Method =
    | 'GET'
    | 'POST'
    | 'PUT'
    | 'PATCH'
    | 'DELETE'
    | 'HEAD'
    | 'OPTIONS';
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
