import { createHash, randomBytes } from 'node:crypto';

import jwt from 'jsonwebtoken';

import { db } from '../../../../src/db';
import { JWT_SECRET } from '../../../../src/middleware/auth';
import { verifyOauthAccessToken } from '../../../../src/oauth/server';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

const REDIRECT_URI = 'https://client.example.com/cb';

const pkce = () => {
  const verifier = randomBytes(32).toString('hex');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
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

  describe('verifyOauthAccessToken', () => {
    test('rejects a malformed token', () => {
      expect(verifyOauthAccessToken('not-a-jwt')).toBeNull();
    });
  });

  // ── consent decision stores grant by code_challenge and returns authorize URL
  describe('POST /api/v1/oauth/consent with authorize_query', () => {
    test('stores the consent grant by code_challenge and returns authorize_url', async () => {
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
      // No cookie in the new PKCE-based flow
      const cookies = res.headers['set-cookie'];
      const consentCookie = Array.isArray(cookies)
        ? cookies.find((c: string) => {
            return c.startsWith('soat_consent=');
          })
        : undefined;
      expect(consentCookie).toBeUndefined();
    });

    test('400 when authorize_query is missing code_challenge', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/oauth/consent')
        .send({
          project_id: projectId,
          selection: { kind: 'all' },
          authorize_query: 'client_id=abc&redirect_uri=https://example.com/cb',
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  // ── /authorize redirects to the app consent screen when no grant stored ────
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

  // ── /authorize without a state param (state is optional) ──────────────────
  describe('GET /authorize without a state param', () => {
    test('redirects to the app consent screen without a state param', async () => {
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
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('/app/oauth/consent');
    });
  });

  // ── /token rejects an authorization code that was never issued ─────────────
  describe('POST /token with an unknown authorization code', () => {
    test('rejects with invalid_grant', async () => {
      const reg = await testClient.post('/register').send({
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'none',
      });
      const { verifier } = pkce();

      const res = await testClient.post('/token').type('form').send({
        grant_type: 'authorization_code',
        code: 'never-issued-code',
        redirect_uri: REDIRECT_URI,
        client_id: reg.body.client_id,
        code_verifier: verifier,
      });
      expect(res.status).toBe(400);
    });
  });

  // ── consent grant is single-use ──────────────────────────────────────────
  describe('GET /authorize after grant consumed', () => {
    test('second /authorize call redirects back to consent screen', async () => {
      const reg = await testClient.post('/register').send({
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'none',
      });
      const clientId = reg.body.client_id;
      const { challenge } = pkce();
      const query = authorizeQuery(clientId, challenge);

      await authenticatedTestClient(adminToken)
        .post('/api/v1/oauth/consent')
        .send({
          project_id: projectId,
          selection: { kind: 'all' },
          authorize_query: query,
        });

      // First /authorize consumes the grant
      const first = await testClient
        .get('/authorize')
        .query(Object.fromEntries(new URLSearchParams(query)));
      expect(first.status).toBe(302);
      expect(first.headers.location).toContain(REDIRECT_URI);

      // Second /authorize — grant is gone, redirect to consent screen
      const second = await testClient
        .get('/authorize')
        .query(Object.fromEntries(new URLSearchParams(query)));
      expect(second.status).toBe(302);
      expect(second.headers.location).toContain('/app/oauth/consent');
    });
  });

  // ── full register → consent → authorize → token flow ───────────────────────
  describe('authorization code flow with PKCE', () => {
    test('issues an access token and refresh token carrying the consented scope and project', async () => {
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

      // 2. App records the consent decision (bearer auth) → authorize_url (no cookie).
      const decision = await authenticatedTestClient(adminToken)
        .post('/api/v1/oauth/consent')
        .send({
          project_id: projectId,
          selection: { kind: 'actions', actions: ['agents:CreateAgent'] },
          authorize_query: query,
        });
      expect(decision.status).toBe(200);
      expect(decision.body.authorize_url).toBe(`/authorize?${query}`);

      // 3. App navigates back to /authorize — server finds the consent grant by
      //    code_challenge and approves without a cookie.
      const authorize = await testClient.get(decision.body.authorize_url);
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
      // A refresh token must be issued alongside the access token.
      expect(token.body.refresh_token).toBeTruthy();

      // 5. The issued token carries the subject, granted scope, and project.
      const payload = verifyOauthAccessToken(token.body.access_token);
      expect(payload).not.toBeNull();
      expect(payload?.sub).toBeTruthy();
      expect(payload?.publicId).toBeTruthy();
      expect(payload?.publicId).toBe(payload?.sub);
      expect(payload?.role).toBe('admin');
      expect(payload?.prj).toBe(projectId);
      expect(String(payload?.scope)).toContain('agents:CreateAgent');
    });
  });

  // ── refresh_token grant ──────────────────────────────────────────────────
  describe('refresh_token grant', () => {
    const completeAuthFlow = async () => {
      const reg = await testClient.post('/register').send({
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'none',
        client_name: 'Refresh Token Test Client',
      });
      const id = reg.body.client_id as string;

      const { verifier, challenge } = pkce();
      const query = authorizeQuery(id, challenge);

      await authenticatedTestClient(adminToken)
        .post('/api/v1/oauth/consent')
        .send({
          project_id: projectId,
          selection: { kind: 'all' },
          authorize_query: query,
        });

      const authorize = await testClient.get(`/authorize?${query}`);
      const code = new URL(
        authorize.headers.location as string
      ).searchParams.get('code');

      const token = await testClient.post('/token').type('form').send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: id,
        code_verifier: verifier,
      });

      return { clientId: id, refreshToken: token.body.refresh_token as string };
    };

    test('exchanges a refresh token for a new access token and rotated refresh token', async () => {
      const { clientId, refreshToken } = await completeAuthFlow();

      const res = await testClient.post('/token').type('form').send({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      });
      expect(res.status).toBe(200);
      expect(res.body.access_token).toBeTruthy();
      // Rotation: a new refresh token is issued.
      expect(res.body.refresh_token).toBeTruthy();
      expect(res.body.refresh_token).not.toBe(refreshToken);

      const payload = verifyOauthAccessToken(res.body.access_token);
      expect(payload?.sub).toBeTruthy();
    });

    test('an expired refresh token is rejected and deleted from the store', async () => {
      const { clientId, refreshToken } = await completeAuthFlow();

      const row = await db.OauthRefreshToken.findOne({
        where: { clientId },
        order: [['id', 'DESC']],
      });
      expect(row).not.toBeNull();
      await row!.update({ expiresAt: new Date(Date.now() - 1000) });

      const res = await testClient.post('/token').type('form').send({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      });
      // The OAuth2 library rejects an expired refresh token with the
      // standard invalid_grant error (400).
      expect(res.status).toBe(400);

      const afterRow = await db.OauthRefreshToken.findOne({
        where: { id: row!.id as number },
      });
      expect(afterRow).toBeNull();
    });

    test('replayed refresh token is rejected (reuse detection)', async () => {
      const { clientId, refreshToken } = await completeAuthFlow();

      // Use the refresh token once to rotate it.
      const first = await testClient.post('/token').type('form').send({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      });
      expect(first.status).toBe(200);

      // Presenting the same (now-consumed) token again must be rejected.
      const second = await testClient.post('/token').type('form').send({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      });
      expect([400, 401]).toContain(second.status);
    });
  });

  // ── consent is enforced at request time (not just carried in the token) ─────
  describe('access token consent enforcement', () => {
    const issueAccessToken = async (selection: unknown): Promise<string> => {
      const reg = await testClient.post('/register').send({
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'none',
      });
      const clientId = reg.body.client_id as string;
      const { verifier, challenge } = pkce();
      const query = authorizeQuery(clientId, challenge);

      await authenticatedTestClient(adminToken)
        .post('/api/v1/oauth/consent')
        .send({ project_id: projectId, selection, authorize_query: query });

      const authorize = await testClient.get(`/authorize?${query}`);
      const code = new URL(
        authorize.headers.location as string
      ).searchParams.get('code');

      const token = await testClient.post('/token').type('form').send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: verifier,
      });
      return token.body.access_token as string;
    };

    test('module-scoped consent denies actions outside the consented module', async () => {
      // Token consents only to the `agents` module; reading the project itself
      // is an action outside that module and must be denied — even though the
      // subject is an admin (whose JWT would otherwise have full access).
      const accessToken = await issueAccessToken({
        kind: 'modules',
        modules: ['agents'],
      });

      const res = await authenticatedTestClient(accessToken).get(
        `/api/v1/projects/${projectId}`
      );
      expect(res.status).toBe(403);
    });

    test('all-permissions consent allows access within the consented project', async () => {
      const accessToken = await issueAccessToken({ kind: 'all' });

      const res = await authenticatedTestClient(accessToken).get(
        `/api/v1/projects/${projectId}`
      );
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(projectId);
    });

    test('consent cannot reach beyond the consented project', async () => {
      const other = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'oauth-other-project' });

      const accessToken = await issueAccessToken({ kind: 'all' });

      const res = await authenticatedTestClient(accessToken).get(
        `/api/v1/projects/${other.body.id}`
      );
      expect(res.status).toBe(403);
    });
  });

  // ── the owning user's policies are the ceiling, even via OAuth ──────────────
  describe('access token cannot exceed the owning user (user ceiling)', () => {
    let fileId: string;
    let readOnlyOauthToken: string;

    beforeAll(async () => {
      // A non-admin user whose own policies permit reading files but not
      // deleting them.
      const userRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/users')
        .send({ username: 'oauthceiling', password: 'supersecret' });
      const userPublicId = userRes.body.id;

      const policyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [{ effect: 'Allow', action: ['files:GetFile'] }],
          },
        });

      await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${userPublicId}/policies`)
        .send({ policy_ids: [policyRes.body.id] });

      const fileRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/files')
        .send({ project_id: projectId, filename: 'ceiling.txt' });
      fileId = fileRes.body.id;

      // An OAuth token for that user consenting to ALL permissions (`*`). The
      // broad consent must not let the token exceed the user's read-only ceiling.
      readOnlyOauthToken = jwt.sign(
        {
          sub: userPublicId,
          publicId: userPublicId,
          role: 'user',
          scope: `* mcp:access prj:${projectId}`,
          prj: projectId,
        },
        JWT_SECRET,
        { expiresIn: '1h' }
      );
    });

    test('an all-permissions token can still do what the user is allowed (read)', async () => {
      const res = await authenticatedTestClient(readOnlyOauthToken).get(
        `/api/v1/files/${fileId}`
      );
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(fileId);
    });

    test('an all-permissions token cannot do what the user is denied (delete)', async () => {
      const res = await authenticatedTestClient(readOnlyOauthToken).delete(
        `/api/v1/files/${fileId}`
      );
      expect(res.status).toBe(403);
    });
  });
});
