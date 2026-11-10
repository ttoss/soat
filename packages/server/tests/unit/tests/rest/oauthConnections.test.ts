import crypto from 'node:crypto';

import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { startFakeOauthProvider } from '../../fixtures/fakeOauthProvider';
import { authenticatedTestClient, testClient } from '../../testClient';

type Provider = Awaited<ReturnType<typeof startFakeOauthProvider>>;

describe('OAuth connections', () => {
  let provider: Provider;
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let otherProjectId: string;
  let clientId: string;
  let actorSeq = 0;

  const api = () => {
    return authenticatedTestClient(userToken);
  };

  const createActor = async (): Promise<string> => {
    actorSeq += 1;
    const res = await api()
      .post('/api/v1/actors')
      .send({ project_id: projectId, name: `actor-${actorSeq}` });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const start = (actorId: string, extra: Record<string, unknown> = {}) => {
    return api()
      .post('/api/v1/oauth-connections')
      .send({ oauth_client_id: clientId, actor_id: actorId, ...extra });
  };

  const stateOf = (authorizeUrl: string): string => {
    return new URL(authorizeUrl).searchParams.get('state') as string;
  };

  const callback = (query: Record<string, string>) => {
    return testClient.get('/api/v1/oauth-connections/callback').query(query);
  };

  const connect = async (actorId: string) => {
    const started = await start(actorId);
    expect(started.status).toBe(201);
    const done = await callback({
      code: 'good-code',
      state: stateOf(started.body.authorize_url),
    });
    expect(done.status).toBe(200);
    return done.body as { id: string; status: string };
  };

  beforeAll(async () => {
    provider = await startFakeOauthProvider();
    const setup = await setupProjectWithUsers({
      prefix: 'oauthconns',
      policyActions: [
        'oauth-clients:*',
        'oauth-connections:*',
        'actors:*',
        'secrets:CreateSecret',
        'secrets:UseSecret',
      ],
      createOtherProject: true,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId as string;

    const secret = await api()
      .post('/api/v1/secrets')
      .send({ project_id: projectId, name: 'client-secret', value: 'shh' });
    const client = await api()
      .post('/api/v1/oauth-clients')
      .send({
        project_id: projectId,
        name: 'fake',
        authorize_url: `${provider.url}/authorize?audience=api`,
        token_url: `${provider.url}/token`,
        revocation_url: `${provider.url}/revoke`,
        client_id: 'fake-client',
        client_secret: `{{secret:${secret.body.id}}}`,
        scopes: ['tweet.read', 'offline.access'],
        redirect_uri: 'https://app.example.com/oauth/callback',
        authorize_params: { prompt: 'consent' },
      });
    expect(client.status).toBe(201);
    clientId = client.body.id;
  });

  afterAll(async () => {
    await provider.close();
  });

  describe('POST /api/v1/oauth-connections', () => {
    test('returns a pending connection and a PKCE authorize_url', async () => {
      const actorId = await createActor();
      const res = await start(actorId);

      expect(res.status).toBe(201);
      expect(res.body.id).toMatch(/^ocon_/);
      expect(res.body).toMatchObject({
        project_id: projectId,
        oauth_client_id: clientId,
        actor_id: actorId,
        status: 'pending',
      });
      expect(res.body.authorize_url_expires_at).toBeDefined();
      const url = new URL(res.body.authorize_url);
      expect(`${url.origin}${url.pathname}`).toBe(`${provider.url}/authorize`);
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        audience: 'api',
        prompt: 'consent',
        response_type: 'code',
        client_id: 'fake-client',
        redirect_uri: 'https://app.example.com/oauth/callback',
        scope: 'tweet.read offline.access',
        code_challenge_method: 'S256',
      });
      expect(url.searchParams.get('state')).toMatch(/^[\w-]{43}$/);
      expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    });

    test('starting again for the same actor restarts the same connection', async () => {
      const actorId = await createActor();
      const first = await start(actorId);
      const again = await start(actorId);

      expect(again.status).toBe(200);
      expect(again.body.id).toBe(first.body.id);
      expect(stateOf(again.body.authorize_url)).not.toBe(
        stateOf(first.body.authorize_url)
      );
    });

    test('an unknown oauth_client_id is 400', async () => {
      const actorId = await createActor();
      const res = await api()
        .post('/api/v1/oauth-connections')
        .send({ oauth_client_id: 'oauc_missing', actor_id: actorId });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('OAUTH_CLIENT_NOT_FOUND');
    });

    test('an unknown actor is 400', async () => {
      const res = await start('actor_missing');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ACTOR_NOT_FOUND');
    });

    test('a return_url that is not http(s) is 400', async () => {
      const actorId = await createActor();
      const res = await start(actorId, { return_url: 'javascript:alert(1)' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('unauthenticated is 401', async () => {
      const res = await testClient
        .post('/api/v1/oauth-connections')
        .send({ oauth_client_id: clientId, actor_id: 'actor_x' });
      expect(res.status).toBe(401);
    });

    test('without permission is 403', async () => {
      const actorId = await createActor();
      const res = await authenticatedTestClient(noPermToken)
        .post('/api/v1/oauth-connections')
        .send({ oauth_client_id: clientId, actor_id: actorId });
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/v1/oauth-connections/callback', () => {
    test('exchanges the code with the PKCE verifier and connects', async () => {
      const actorId = await createActor();
      const started = await start(actorId);
      const challenge = new URL(started.body.authorize_url).searchParams.get(
        'code_challenge'
      );

      const res = await callback({
        code: 'good-code',
        state: stateOf(started.body.authorize_url),
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: started.body.id,
        status: 'connected',
        scopes: ['tweet.read', 'users.read', 'offline.access'],
      });
      expect(res.body.authorize_url).toBeUndefined();
      const exchange = provider.state.tokenRequests.at(-1);
      expect(exchange?.params).toMatchObject({
        grant_type: 'authorization_code',
        code: 'good-code',
        redirect_uri: 'https://app.example.com/oauth/callback',
      });
      expect(
        crypto
          .createHash('sha256')
          .update(exchange?.params.code_verifier ?? '')
          .digest('base64url')
      ).toBe(challenge);
      expect(exchange?.authorization).toBe(
        `Basic ${Buffer.from('fake-client:shh').toString('base64')}`
      );
    });

    test('redirects to the return_url with the outcome', async () => {
      const actorId = await createActor();
      const started = await start(actorId, {
        return_url: 'https://app.example.com/done?from=x',
      });

      const res = await callback({
        code: 'good-code',
        state: stateOf(started.body.authorize_url),
      });

      expect(res.status).toBe(302);
      const location = new URL(res.headers.location);
      expect(location.origin + location.pathname).toBe(
        'https://app.example.com/done'
      );
      expect(Object.fromEntries(location.searchParams)).toEqual({
        from: 'x',
        oauth_connection_id: started.body.id,
        status: 'connected',
      });
    });

    test('a state is single-use', async () => {
      const actorId = await createActor();
      const started = await start(actorId);
      const state = stateOf(started.body.authorize_url);
      await callback({ code: 'good-code', state });

      const res = await callback({ code: 'good-code', state });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('OAUTH_CALLBACK_FAILED');
    });

    test('an unknown state is 400', async () => {
      const res = await callback({ code: 'good-code', state: 'forged' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('OAUTH_CALLBACK_FAILED');
    });

    test('a code the provider rejects is 400 and leaves the connection unconnected', async () => {
      const actorId = await createActor();
      const started = await start(actorId);

      const res = await callback({
        code: 'bad-code',
        state: stateOf(started.body.authorize_url),
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('OAUTH_CALLBACK_FAILED');

      const read = await api().get(
        `/api/v1/oauth-connections/${started.body.id}`
      );
      expect(read.body.status).toBe('disconnected');
      expect(read.body.error.code).toBe('OAUTH_CALLBACK_FAILED');
    });

    test('a consent the person denied is 400', async () => {
      const actorId = await createActor();
      const started = await start(actorId);

      const res = await callback({
        error: 'access_denied',
        state: stateOf(started.body.authorize_url),
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('OAUTH_CALLBACK_FAILED');
      expect(res.body.error.message).toContain('access_denied');
    });
  });

  describe('GET /api/v1/oauth-connections', () => {
    test('lists connections filtered by actor, never with tokens', async () => {
      const actorId = await createActor();
      const { id } = await connect(actorId);

      const res = await api()
        .get('/api/v1/oauth-connections')
        .query({ project_id: projectId, actor_id: actorId });

      expect(res.status).toBe(200);
      expect(
        res.body.data.map((row: { id: string }) => {
          return row.id;
        })
      ).toEqual([id]);
      expect(JSON.stringify(res.body)).not.toMatch(/access-|refresh-/);
    });

    test('filters by oauth_client_id', async () => {
      const res = await api()
        .get('/api/v1/oauth-connections')
        .query({ project_id: projectId, oauth_client_id: 'oauc_missing' });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    test('unauthenticated is 401', async () => {
      const res = await testClient.get('/api/v1/oauth-connections');
      expect(res.status).toBe(401);
    });

    test('another project is 403', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .get('/api/v1/oauth-connections')
        .query({ project_id: otherProjectId });
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/v1/oauth-connections/:oauth_connection_id', () => {
    test('reads one connection without tokens', async () => {
      const actorId = await createActor();
      const { id } = await connect(actorId);

      const res = await api().get(`/api/v1/oauth-connections/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('connected');
      expect(res.body.access_token).toBeUndefined();
      expect(res.body.refresh_token).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toMatch(/access-|refresh-/);
    });

    test('without permission is hidden as 404', async () => {
      const actorId = await createActor();
      const { id } = await connect(actorId);
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/oauth-connections/${id}`
      );
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/v1/oauth-connections/:oauth_connection_id', () => {
    test('revokes the refresh token at the provider and deletes', async () => {
      const actorId = await createActor();
      const { id } = await connect(actorId);
      const issued = provider.state.issued;

      const res = await api().delete(`/api/v1/oauth-connections/${id}`);
      expect(res.status).toBe(204);
      expect(provider.state.revokeRequests.at(-1)?.params).toEqual({
        token: `refresh-${issued}`,
        token_type_hint: 'refresh_token',
      });

      const read = await api().get(`/api/v1/oauth-connections/${id}`);
      expect(read.status).toBe(404);
    });

    test('without project access is hidden as 404', async () => {
      const actorId = await createActor();
      const { id } = await connect(actorId);
      const res = await authenticatedTestClient(noPermToken).delete(
        `/api/v1/oauth-connections/${id}`
      );
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE by a reader', () => {
    test('is 403', async () => {
      const actorId = await createActor();
      const { id } = await connect(actorId);
      const readerToken = await createScopedPrincipal({
        adminToken,
        projectId,
        username: 'oauthconnsreader',
        actions: ['oauth-connections:GetOauthConnection'],
      });
      const res = await authenticatedTestClient(readerToken).delete(
        `/api/v1/oauth-connections/${id}`
      );
      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /api/v1/actors/:actor_id', () => {
    test("removes the actor's connections", async () => {
      const actorId = await createActor();
      const { id } = await connect(actorId);

      const res = await api().delete(`/api/v1/actors/${actorId}`);
      expect(res.status).toBe(204);

      const read = await api().get(`/api/v1/oauth-connections/${id}`);
      expect(read.status).toBe(404);
    });
  });
});
