import createClient from 'openapi-fetch';

import type { paths } from './generated/openapi.js';

export type { paths };

export const createSoatClient = (args: { baseUrl: string; token?: string }) => {
  const { baseUrl, token } = args;

  return createClient<paths>({
    baseUrl,
    ...(token && {
      headers: { Authorization: `Bearer ${token}` },
    }),
  });
};

/**
 * Unwraps the discriminated-union response from `openapi-fetch`.
 *
 * Throws if `error` is present; otherwise returns `data` with its full type
 * intact — no `any` cast required.
 *
 * @example
 * ```ts
 * import { createSoatClient, unwrap } from '@soat/sdk';
 *
 * const soat = createSoatClient({ baseUrl: '...', token: '...' });
 *
 * const files = unwrap(await soat.GET('/api/v1/files'));
 * // `files` is fully typed as the 200-response body
 * ```
 */
export const unwrap = <T>(response: {
  data: T;
  error?: never;
  response: Response;
} | {
  data?: never;
  error: unknown;
  response: Response;
}): T => {
  if (response.error !== undefined) {
    const status = response.response.status;
    const msg =
      typeof response.error === 'object' &&
      response.error !== null &&
      'message' in response.error
        ? String((response.error as { message: unknown }).message)
        : String(response.error);
    throw new Error(`${status}: ${msg}`);
  }

  // TypeScript cannot narrow `data` to `T` here because `error: unknown`
  // overlaps with `error?: never` (both allow `undefined`). The assertion is
  // safe: the parameter type guarantees `data: T` whenever `error` is absent.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return response.data!;
};
