import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type TokenRequest = {
  authorization?: string;
  params: Record<string, string>;
};

type ProviderState = {
  issued: number;
  tokenRequests: TokenRequest[];
  revokeRequests: TokenRequest[];
  apiAuthorizations: Array<string | null>;
  liveRefreshTokens: Set<string>;
  expiresIn: number | undefined;
  refreshDelayMs: number;
  failRefresh: boolean;
};

const readForm = async (req: http.IncomingMessage) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return Object.fromEntries(new URLSearchParams(raw));
};

const send = (res: http.ServerResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};

const issue = (state: ProviderState) => {
  state.issued += 1;
  const refresh = `refresh-${state.issued}`;
  state.liveRefreshTokens.add(refresh);
  return {
    token_type: 'bearer',
    access_token: `access-${state.issued}`,
    refresh_token: refresh,
    scope: 'tweet.read users.read offline.access',
    ...(state.expiresIn === undefined ? {} : { expires_in: state.expiresIn }),
  };
};

const handleToken = async (args: {
  state: ProviderState;
  req: http.IncomingMessage;
  res: http.ServerResponse;
}) => {
  const { state, req, res } = args;
  const params = await readForm(req);
  state.tokenRequests.push({
    authorization: req.headers.authorization,
    params,
  });
  if (params.grant_type === 'authorization_code') {
    if (params.code === 'good-code') send(res, 200, issue(state));
    else send(res, 400, { error: 'invalid_grant' });
    return;
  }
  if (state.refreshDelayMs > 0) {
    await new Promise((resolve) => {
      setTimeout(resolve, state.refreshDelayMs);
    });
  }
  if (
    state.failRefresh ||
    !state.liveRefreshTokens.delete(params.refresh_token)
  ) {
    send(res, 400, { error: 'invalid_grant' });
    return;
  }
  send(res, 200, issue(state));
};

/**
 * An OAuth 2.0 provider on 127.0.0.1 that rotates the refresh token on every
 * use, as X does, and an API route that echoes the bearer it was sent.
 */
export const startFakeOauthProvider = async () => {
  const state: ProviderState = {
    issued: 0,
    tokenRequests: [],
    revokeRequests: [],
    apiAuthorizations: [],
    liveRefreshTokens: new Set<string>(),
    expiresIn: 7200,
    refreshDelayMs: 0,
    failRefresh: false,
  };

  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/token') {
      await handleToken({ state, req, res });
      return;
    }
    if (path === '/revoke') {
      state.revokeRequests.push({
        authorization: req.headers.authorization,
        params: await readForm(req),
      });
      send(res, 200, {});
      return;
    }
    const authorization = req.headers.authorization ?? null;
    state.apiAuthorizations.push(authorization);
    send(res, 200, { authorization });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => {
      return new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
};
