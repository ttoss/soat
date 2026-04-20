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
