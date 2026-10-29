import { readFile } from 'node:fs/promises';

import { GetWebIdentityTokenCommand, STSClient } from '@aws-sdk/client-sts';
import createDebug from 'debug';

import { DomainError } from '../errors';

const log = createDebug('soat:anthropic-federation');

export const ANTHROPIC_API_URL = 'https://api.anthropic.com';

/** Refresh this long before expiry, so a request never carries a dying token. */
const REFRESH_MARGIN_MS = 60_000;

const IDENTITY_TOKEN_SECONDS = 900;

export type AnthropicFederationSettings = {
  federationRuleId: string;
  organizationId: string;
  serviceAccountId: string;
  workspaceId?: string;
  identityTokenFile?: string;
};

type Env = Record<string, string | undefined>;

const readEnv = (env: Env, name: string): string | undefined => {
  const value = env[name];
  return value ? value : undefined;
};

/**
 * The deployment's Anthropic workload identity federation, or `undefined` when
 * the operator configured none. Read per call, like the ambient opt-in.
 */
export const readAnthropicFederationSettings = (
  env: Env = process.env
): AnthropicFederationSettings | undefined => {
  const federationRuleId = readEnv(env, 'ANTHROPIC_FEDERATION_RULE_ID');
  const organizationId = readEnv(env, 'ANTHROPIC_ORGANIZATION_ID');
  const serviceAccountId = readEnv(env, 'ANTHROPIC_SERVICE_ACCOUNT_ID');
  if (!federationRuleId || !organizationId || !serviceAccountId) {
    return undefined;
  }
  return {
    federationRuleId,
    organizationId,
    serviceAccountId,
    workspaceId: readEnv(env, 'ANTHROPIC_WORKSPACE_ID'),
    identityTokenFile: readEnv(env, 'ANTHROPIC_IDENTITY_TOKEN_FILE'),
  };
};

/* istanbul ignore next -- calling real STS cannot run in CI; the exchange
   around it is driven through `identityToken`. */
const stsWebIdentityToken = async (): Promise<string> => {
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (!region) {
    throw new DomainError(
      'AI_PROVIDER_MISCONFIGURED',
      'Federating an AWS identity to Anthropic needs a region: set AWS_REGION (or AWS_DEFAULT_REGION) on the process. GetWebIdentityToken is served only by regional STS endpoints.'
    );
  }
  const output = await new STSClient({ region }).send(
    new GetWebIdentityTokenCommand({
      Audience: [ANTHROPIC_API_URL],
      SigningAlgorithm: 'RS256',
      DurationSeconds: IDENTITY_TOKEN_SECONDS,
    })
  );
  if (!output.WebIdentityToken) {
    throw new DomainError(
      'AI_PROVIDER_MISCONFIGURED',
      'AWS STS GetWebIdentityToken returned no token for Anthropic federation.'
    );
  }
  return output.WebIdentityToken;
};

/**
 * The OIDC token proving the deployment's identity: a projected token file
 * when the operator names one, otherwise one AWS STS signs for the process's
 * own AWS identity. Minted per exchange: a token carrying `jti` is single-use.
 */
const defaultIdentityToken = async (
  settings: AnthropicFederationSettings
): Promise<string> => {
  if (settings.identityTokenFile) {
    return (await readFile(settings.identityTokenFile, 'utf8')).trim();
  }
  return stsWebIdentityToken();
};

type ExchangeFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

type CachedToken = { accessToken: string; expiresAt: number };

const parseTokenResponse = (body: string): CachedToken | undefined => {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const accessToken =
      'access_token' in parsed ? parsed.access_token : undefined;
    const expiresIn = 'expires_in' in parsed ? parsed.expires_in : undefined;
    if (typeof accessToken !== 'string' || typeof expiresIn !== 'number') {
      return undefined;
    }
    return { accessToken, expiresAt: Date.now() + expiresIn * 1000 };
  } catch {
    return undefined;
  }
};

const exchange = async (args: {
  settings: AnthropicFederationSettings;
  identityToken: () => Promise<string>;
  fetchImpl: ExchangeFetch;
}): Promise<CachedToken> => {
  const response = await args.fetchImpl(`${ANTHROPIC_API_URL}/v1/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: await args.identityToken(),
      federation_rule_id: args.settings.federationRuleId,
      organization_id: args.settings.organizationId,
      service_account_id: args.settings.serviceAccountId,
      ...(args.settings.workspaceId
        ? { workspace_id: args.settings.workspaceId }
        : {}),
    }),
  });
  const body = await response.text();
  const token = response.ok ? parseTokenResponse(body) : undefined;
  if (!token) {
    // Every denial is the same opaque 401; the reason is in the Console's
    // authentication history, not in this body.
    log('exchange failed: %d %s', response.status, body);
    throw new DomainError(
      'AI_PROVIDER_MISCONFIGURED',
      `Anthropic workload identity federation refused the token exchange (HTTP ${response.status}). The deny reason is in the Anthropic Console's workload identity authentication history.`
    );
  }
  return token;
};

/**
 * A source of Anthropic access tokens for one federation configuration. Caches
 * the token until shortly before it expires, and shares one exchange between
 * concurrent callers.
 */
export const createAnthropicTokenSource = (args: {
  settings: AnthropicFederationSettings;
  identityToken?: () => Promise<string>;
  fetchImpl?: ExchangeFetch;
}): (() => Promise<string>) => {
  let cached: CachedToken | undefined;
  let pending: Promise<CachedToken> | undefined;
  const identityToken =
    args.identityToken ??
    (() => {
      return defaultIdentityToken(args.settings);
    });
  const fetchImpl = args.fetchImpl ?? fetch;

  return async () => {
    if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
      return cached.accessToken;
    }
    pending ??= exchange({
      settings: args.settings,
      identityToken,
      fetchImpl,
    }).finally(() => {
      pending = undefined;
    });
    cached = await pending;
    return cached.accessToken;
  };
};

/**
 * The deployment's federation, refused when the operator configured none.
 * Checked when a model is built, so a missing setting is a refusal rather than
 * a failure inside the provider's HTTP call.
 */
export const requireAnthropicFederationSettings =
  (): AnthropicFederationSettings => {
    const settings = readAnthropicFederationSettings();
    if (!settings) {
      throw new DomainError(
        'AI_PROVIDER_MISCONFIGURED',
        "An 'anthropic' AI provider that links no secret signs with the deployment's Anthropic workload identity federation, and this deployment configures none: set ANTHROPIC_FEDERATION_RULE_ID, ANTHROPIC_ORGANIZATION_ID and ANTHROPIC_SERVICE_ACCOUNT_ID, or link a secret holding an API key."
      );
    }
    return settings;
  };

const sources = new Map<string, () => Promise<string>>();

/** An access token for the deployment's own Anthropic identity. */
export const anthropicFederatedAccessToken = async (): Promise<string> => {
  const settings = requireAnthropicFederationSettings();
  const key = JSON.stringify(settings);
  let source = sources.get(key);
  if (!source) {
    log(
      'anthropicFederatedAccessToken: new source for rule %s',
      settings.federationRuleId
    );
    source = createAnthropicTokenSource({ settings });
    sources.set(key, source);
  }
  return source();
};

/**
 * Wraps a `fetch` so each request carries a current federated token in place
 * of the API key header the AI SDK always writes.
 */
export const withAnthropicFederatedToken = (args: {
  fetchImpl: typeof fetch;
  accessToken?: () => Promise<string>;
}): typeof fetch => {
  const accessToken = args.accessToken ?? anthropicFederatedAccessToken;
  return async (input, init) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    );
    headers.delete('x-api-key');
    headers.set('authorization', `Bearer ${await accessToken()}`);
    return args.fetchImpl(input, { ...init, headers });
  };
};
