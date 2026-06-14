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

describe('OAuth authorization server + consent screen', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'oauthadmin', password: 'supersecret' });
    adminToken = await loginAs('oauthadmin', 'supersecret');

    await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'oauth-bob', password: 'bobpass' });
    userToken = await loginAs('oauth-bob', 'bobpass');

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

  // ── consent screen page (src/oauth/consentPage.ts) ─────────────────────────
  describe('GET /oauth/consent', () => {
    test('renders the consent screen for an authenticated user', async () => {
      const res =
        await authenticatedTestClient(adminToken).get('/oauth/consent');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text).toContain('Authorize MCP access');
      expect(res.text).toContain('class="module-cb"');
    });

    test('401 when unauthenticated', async () => {
      const res = await testClient.get('/oauth/consent');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /oauth/consent/decision', () => {
    test('standalone (no oauth params) returns the resolved grant', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/oauth/consent/decision')
        .type('form')
        .send({ project_id: projectId, grant_all: '1' });
      expect(res.status).toBe(200);
      expect(res.body.scopes).toEqual(['*']);
      expect(getConsentCookie(res.headers['set-cookie'])).toMatch(
        /^soat_consent=/
      );
    });

    test('401 when unauthenticated', async () => {
      const res = await testClient
        .post('/oauth/consent/decision')
        .type('form')
        .send({ project_id: projectId, grant_all: '1' });
      expect(res.status).toBe(401);
    });

    test('400 when project_id is missing', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/oauth/consent/decision')
        .type('form')
        .send({ grant_all: '1' });
      expect(res.status).toBe(400);
    });

    test('403 when the user cannot access the project', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/oauth/consent/decision')
        .type('form')
        .send({ project_id: projectId, grant_all: '1' });
      expect(res.status).toBe(403);
    });
  });

  describe('GET /authorize without consent', () => {
    test('redirects to the consent screen when no consent cookie is present', async () => {
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
      expect(res.headers.location).toContain('/oauth/consent');
    });
  });

  // ── full authorize → token flow (src/oauth/server.ts hooks) ────────────────
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
      const oauthParams = {
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: 'mcp:access',
        state: 'state-123',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      };

      // 2. User consents → sets consent cookie, redirects back to /authorize.
      const decision = await authenticatedTestClient(adminToken)
        .post('/oauth/consent/decision')
        .type('form')
        .send({
          ...oauthParams,
          project_id: projectId,
          action: 'agents:CreateAgent',
        });
      expect(decision.status).toBe(302);
      expect(decision.headers.location).toContain('/authorize?');
      const cookie = getConsentCookie(decision.headers['set-cookie']);

      // 3. Authorize with the consent cookie → redirect to client with a code.
      const authorize = await testClient
        .get('/authorize')
        .query(oauthParams)
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
