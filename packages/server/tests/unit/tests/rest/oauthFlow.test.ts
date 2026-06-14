import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  putConsentSession,
  takeConsentSession,
  verifyOauthAccessToken,
} from '../../../../src/oauth/server';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

const REDIRECT_URI = 'https://client.example.com/cb';

const pkce = () => {
  const verifier = randomBytes(32).toString('hex');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
};

const getConsentCookie = (setCookie: string | string[] | undefined): string => {
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : setCookie
      ? [setCookie]
      : [];
  const header = cookies.find((c) => {
    return c.startsWith('soat_consent=');
  });
  if (!header) throw new Error('soat_consent cookie not set');
  return header.split(';')[0];
};

const authorizeQuery = (clientId: string, challenge: string): string => {
  return new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'mcp:access',
    state: 'state-123',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
};

describe('OAuth authorization server (SPA consent)', () => {
  let adminToken: string;
  let projectId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'oauthadmin', password: 'supersecret' });
    adminToken = await loginAs('oauthadmin', 'supersecret');

    const project = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'oauth-flow-project' });
    projectId = project.body.id;
  });

  // ── consent session helpers (src/oauth/server.ts) ──────────────────────────
  describe('consent session store', () => {
    test('a stored grant can be taken exactly once', () => {
      const id = randomUUID();
      putConsentSession({ id, subject: 'usr_1', scopes: ['*'] });
      const first = takeConsentSession(id);
      expect(first?.subject).toBe('usr_1');
      expect(takeConsentSession(id)).toBeUndefined();
    });

    test('an unknown id yields undefined', () => {
      expect(takeConsentSession('nope')).toBeUndefined();
    });
  });

  describe('verifyOauthAccessToken', () => {
    test('rejects a malformed token', () => {
      expect(verifyOauthAccessToken('not-a-jwt')).toBeNull();
    });
  });

  // ── consent decision sets a cookie and returns the authorize URL ───────────
  describe('POST /api/v1/oauth/consent with authorize_query', () => {
    test('sets the consent cookie and returns authorize_url', async () => {
      const { challenge } = pkce();
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/oauth/consent')
        .send({
          project_id: projectId,
          selection: { kind: 'all' },
          authorize_query: authorizeQuery('client-abc', challenge),
        });
      expect(res.status).toBe(200);
      expect(res.body.authorize_url).toContain('/authorize?');
      expect(getConsentCookie(res.headers['set-cookie'])).toMatch(
        /^soat_consent=/
      );
    });
  });

  // ── /authorize redirects to the app consent screen when not yet consented ──
  describe('GET /authorize without consent', () => {
    test('redirects to the app consent screen', async () => {
      const reg = await testClient.post('/register').send({
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'none',
      });
      const { challenge } = pkce();
      const res = await testClient.get('/authorize').query({
        client_id: reg.body.client_id,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: 'mcp:access',
        state: 'no-cookie',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('/app/oauth/consent');
    });
  });

  // ── full register → consent → authorize → token flow ───────────────────────
  describe('authorization code flow with PKCE', () => {
    test('issues an access token carrying the consented scope and project', async () => {
      // 1. Dynamic client registration (public client).
      const reg = await testClient.post('/register').send({
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'none',
        client_name: 'Test MCP Client',
      });
      expect([200, 201]).toContain(reg.status);
      const clientId = reg.body.client_id;
      expect(clientId).toBeTruthy();

      const { verifier, challenge } = pkce();
      const query = authorizeQuery(clientId, challenge);

      // 2. App records the consent decision (bearer auth) → cookie + authorize_url.
      const decision = await authenticatedTestClient(adminToken)
        .post('/api/v1/oauth/consent')
        .send({
          project_id: projectId,
          selection: { kind: 'actions', actions: ['agents:CreateAgent'] },
          authorize_query: query,
        });
      expect(decision.status).toBe(200);
      expect(decision.body.authorize_url).toBe(`/authorize?${query}`);
      const cookie = getConsentCookie(decision.headers['set-cookie']);

      // 3. App navigates back to /authorize with the cookie → code.
      const authorize = await testClient
        .get(decision.body.authorize_url)
        .set('Cookie', cookie);
      expect(authorize.status).toBe(302);
      const location = authorize.headers.location as string;
      expect(location.startsWith(REDIRECT_URI)).toBe(true);
      const code = new URL(location).searchParams.get('code');
      expect(code).toBeTruthy();

      // 4. Exchange the code for an access token (PKCE verifier).
      const token = await testClient.post('/token').type('form').send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: verifier,
      });
      expect(token.status).toBe(200);
      expect(token.body.access_token).toBeTruthy();

      // 5. The issued token carries the subject, granted scope, and project.
      const payload = verifyOauthAccessToken(token.body.access_token);
      expect(payload).not.toBeNull();
      expect(payload?.prj).toBe(projectId);
      expect(String(payload?.scope)).toContain('agents:CreateAgent');
    });
  });
});
