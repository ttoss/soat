export type ApiError = { message: string; code?: string };

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: ApiError };

const extractError = async (res: Response): Promise<ApiError> => {
  try {
    const body = (await res.json()) as {
      error?: { message?: string; code?: string } | string;
    };
    if (typeof body.error === 'string') return { message: body.error };
    if (typeof body.error === 'object' && body.error !== null) {
      return {
        message: body.error.message ?? `HTTP ${res.status}`,
        code: body.error.code,
      };
    }
  } catch {
    // ignore parse error
  }
  return { message: `HTTP ${res.status}` };
};

export const apiFetch = async <T>(args: {
  url: string;
  method?: string;
  body?: unknown;
  token: string;
}): Promise<ApiResult<T>> => {
  const res = await fetch(args.url, {
    method: args.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${args.token}`,
    },
    body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
  });

  if (!res.ok) {
    const error = await extractError(res);
    return { ok: false, status: res.status, error };
  }

  const data = (await res.json()) as T;
  return { ok: true, data };
};
