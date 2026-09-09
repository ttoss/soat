import type { AiProviderSlug } from '@soat/postgresdb';
import createDebug from 'debug';

import { DomainError } from '../errors';
import { egressGuardedFetch } from './egressFetch';

const log = createDebug('soat:provider-models:http');

/** The pinned API version Anthropic requires on every request. */
export const ANTHROPIC_VERSION = '2023-06-01';

/**
 * The slice of `fetch` this module uses. Narrow on purpose: it is the seam the
 * tests replace, and a narrow shape is one a fake can satisfy without pulling
 * in the whole `Response` surface.
 */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> }
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

/**
 * Adapts the guarded `fetch` to the narrow shape above. Guarded rather than
 * plain: `base_url` is tenant-written and this is a `GET` the server performs
 * on their behalf, so it can name the deployment's own network exactly as an
 * `http` tool's target can.
 */
export const nodeFetch: FetchLike = (url, init) => {
  return egressGuardedFetch(url, init);
};

export const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
};

export const asArray = (value: unknown): unknown[] => {
  return Array.isArray(value) ? value : [];
};

export const asString = (value: unknown): string | undefined => {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

/** Provider vocabulary is SHOUTING; ours is not. */
export const lowercaseAll = (values: unknown): string[] | undefined => {
  const mapped = asArray(values)
    .map((value) => {
      return asString(value)?.toLowerCase();
    })
    .filter((value): value is string => {
      return value !== undefined;
    });
  return mapped.length > 0 ? mapped : undefined;
};

export const readJson = async (args: {
  fetchImpl: FetchLike;
  url: string;
  headers: Record<string, string>;
  provider: AiProviderSlug;
}): Promise<Record<string, unknown>> => {
  const response = await args.fetchImpl(args.url, {
    method: 'GET',
    headers: args.headers,
  });
  const body = await response.text();

  if (!response.ok) {
    // The status is carried through; the body is not. `base_url` names the host
    // that wrote this body, so relaying it would answer a caller with whatever
    // the host they chose said — the read half of an SSRF. It goes to the
    // server log instead, where an operator debugging a real provider can see
    // it and a tenant cannot.
    log(
      'readJson: %s listing failed status=%d body=%s',
      args.provider,
      response.status,
      body.slice(0, 500)
    );
    throw new DomainError(
      'MODEL_LISTING_FAILED',
      `The ${args.provider} provider rejected the model listing request (HTTP ${response.status}).`
    );
  }

  try {
    return asRecord(JSON.parse(body)) ?? {};
  } catch {
    throw new DomainError(
      'MODEL_LISTING_FAILED',
      `The ${args.provider} provider answered the model listing request with a body that is not JSON.`
    );
  }
};

export const requireSecret = (args: {
  secretValue?: string | null;
  provider: AiProviderSlug;
}): string => {
  if (!args.secretValue) {
    throw new DomainError(
      'AI_PROVIDER_MISCONFIGURED',
      `Listing models from a ${args.provider} provider needs its API key: link a secret to the provider first.`
    );
  }
  return args.secretValue;
};
