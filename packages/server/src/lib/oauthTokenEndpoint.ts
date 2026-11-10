import createDebug from 'debug';

import { readCappedText } from './cappedBody';
import type { ResolvedOauthClient } from './oauthClients';
import { PROTOCOL_ANSWER_MAX_BYTES } from './requestBounds';
import { fetchWithEgressGuard } from './toolEgress';

const log = createDebug('soat:oauth-connections');

export type TokenSet = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[] | null;
};

export type TokenEndpointResult =
  | { ok: true; tokens: TokenSet }
  | { ok: false; status: number | null; error: string };

const clientAuth = (args: {
  client: ResolvedOauthClient;
  params: URLSearchParams;
}): Record<string, string> => {
  const { client, params } = args;
  if (
    client.clientSecret &&
    client.tokenEndpointAuthMethod === 'client_secret_basic'
  ) {
    const encode = (value: string) => {
      return encodeURIComponent(value);
    };
    const pair = `${encode(client.clientId)}:${encode(client.clientSecret)}`;
    return { Authorization: `Basic ${Buffer.from(pair).toString('base64')}` };
  }
  params.set('client_id', client.clientId);
  if (client.clientSecret) params.set('client_secret', client.clientSecret);
  return {};
};

const postForm = async (args: {
  client: ResolvedOauthClient;
  url: string;
  params: URLSearchParams;
}): Promise<Response> => {
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
    ...clientAuth({ client: args.client, params: args.params }),
  };
  return fetchWithEgressGuard(
    args.url,
    { method: 'POST', headers, body: args.params.toString() },
    { noun: 'OAuth token endpoint', credentialHeaders: ['Authorization'] }
  );
};

const readTokens = (args: {
  body: Record<string, unknown>;
  now: Date;
}): TokenSet | null => {
  const { body } = args;
  if (typeof body.access_token !== 'string' || !body.access_token) return null;
  const expiresIn = Number(body.expires_in);
  return {
    accessToken: body.access_token,
    refreshToken:
      typeof body.refresh_token === 'string' && body.refresh_token
        ? body.refresh_token
        : null,
    expiresAt: Number.isFinite(expiresIn)
      ? new Date(args.now.getTime() + expiresIn * 1000)
      : null,
    scopes:
      typeof body.scope === 'string'
        ? body.scope.split(' ').filter(Boolean)
        : null,
  };
};

const describeFailure = (body: Record<string, unknown>, status: number) => {
  const error = typeof body.error === 'string' ? body.error : `HTTP ${status}`;
  return typeof body.error_description === 'string'
    ? `${error}: ${body.error_description}`
    : error;
};

const messageOf = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

/** A token endpoint answers JSON, or form-encoded from older providers. */
const parseAnswer = (text: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return Object.fromEntries(new URLSearchParams(text));
  }
};

const readAnswer = async (response: Response) => {
  return parseAnswer(
    await readCappedText({
      response,
      maxBytes: PROTOCOL_ANSWER_MAX_BYTES,
      refusal: () => {
        return new Error('the token endpoint answer is too large');
      },
    })
  );
};

/** One grant request to the client's token endpoint. */
export const requestTokens = async (args: {
  client: ResolvedOauthClient;
  params: Record<string, string>;
  now?: Date;
}): Promise<TokenEndpointResult> => {
  log('requestTokens: grant_type=%s', args.params.grant_type);
  let response: Response;
  let body: Record<string, unknown>;
  try {
    response = await postForm({
      client: args.client,
      url: args.client.tokenUrl,
      params: new URLSearchParams(args.params),
    });
  } catch (error) {
    return { ok: false, status: null, error: messageOf(error) };
  }
  try {
    body = await readAnswer(response);
  } catch (error) {
    return { ok: false, status: response.status, error: messageOf(error) };
  }
  const tokens = response.ok
    ? readTokens({ body, now: args.now ?? new Date() })
    : null;
  if (!tokens) {
    return {
      ok: false,
      status: response.status,
      error: describeFailure(body, response.status),
    };
  }
  return { ok: true, tokens };
};

/** RFC 7009 revocation; best effort, since the grant is deleted either way. */
export const revokeToken = async (args: {
  client: ResolvedOauthClient;
  token: string;
  tokenTypeHint: 'refresh_token' | 'access_token';
}): Promise<void> => {
  if (!args.client.revocationUrl) return;
  try {
    const response = await postForm({
      client: args.client,
      url: args.client.revocationUrl,
      params: new URLSearchParams({
        token: args.token,
        token_type_hint: args.tokenTypeHint,
      }),
    });
    log('revokeToken: status=%d', response.status);
  } catch (error) {
    log('revokeToken: failed %s', error instanceof Error ? error.message : '');
  }
};
