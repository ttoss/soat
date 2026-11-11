import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { createScopedPrincipal } from '../../fixtures/bootstrap';
import { startFakeOauthProvider } from '../../fixtures/fakeOauthProvider';
import { authenticatedTestClient, testClient } from '../../testClient';

type Provider = Awaited<ReturnType<typeof startFakeOauthProvider>>;

describe('POST /api/v1/tools/:tool_id/call with actor_id', () => {
  let turn: AgentToolTurn;
  let provider: Provider;
  let clientId: string;
  let oauthToolId: string;

  const createActor = async (
    args: { projectId?: string; externalId?: string } = {}
  ): Promise<string> => {
    const res = await turn
      .api()
      .post('/api/v1/actors')
      .send({
        project_id: args.projectId ?? turn.projectId,
        name: turn.unique('actor'),
        ...(args.externalId ? { external_id: args.externalId } : {}),
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const connect = async (actorId: string): Promise<string> => {
    const started = await turn
      .api()
      .post('/api/v1/oauth-connections')
      .send({ oauth_client_id: clientId, actor_id: actorId });
    expect(started.status).toBe(201);
    const state = new URL(started.body.authorize_url).searchParams.get(
      'state'
    ) as string;
    const done = await testClient
      .get('/api/v1/oauth-connections/callback')
      .query({ code: 'good-code', state });
    expect(done.status).toBe(200);
    return started.body.id;
  };

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'toolcallactor' });
    provider = await startFakeOauthProvider();

    const secret = await turn
      .api()
      .post('/api/v1/secrets')
      .send({ project_id: turn.projectId, name: 'cs', value: 'shh' });
    const client = await turn
      .api()
      .post('/api/v1/oauth-clients')
      .send({
        project_id: turn.projectId,
        name: 'fake',
        authorize_url: `${provider.url}/authorize`,
        token_url: `${provider.url}/token`,
        client_id: 'fake-client',
        client_secret: `{{secret:${secret.body.id}}}`,
        scopes: ['users.read'],
        redirect_uri: 'https://app.example.com/cb',
      });
    expect(client.status).toBe(201);
    clientId = client.body.id;

    const tool = await turn.createTool({
      parameters: { type: 'object', properties: {} },
      execute: {
        url: `${provider.url}/2/users/me`,
        method: 'GET',
        auth: { type: 'oauth_connection', oauth_client_id: clientId },
      },
    });
    oauthToolId = tool.id;
  });

  afterAll(async () => {
    await provider.close();
    await turn.close();
  });

  beforeEach(() => {
    provider.state.expiresIn = 7200;
    provider.state.failRefresh = false;
    provider.state.refreshStatus = 200;
  });

  test("an oauth_connection tool sends the named actor's access token", async () => {
    const actorId = await createActor();
    await connect(actorId);
    const issued = provider.state.issued;

    const res = await turn
      .api()
      .post(`/api/v1/tools/${oauthToolId}/call`)
      .send({ actor_id: actorId });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authorization: `Bearer access-${issued}` });
  });

  test('an actor with no connection is refused with 409 OAUTH_CONNECTION_REQUIRED', async () => {
    const actorId = await createActor();

    const res = await turn
      .api()
      .post(`/api/v1/tools/${oauthToolId}/call`)
      .send({ actor_id: actorId });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OAUTH_CONNECTION_REQUIRED');
    expect(res.body.error.meta).toEqual({
      oauth_client_id: clientId,
      actor_id: actorId,
    });
  });

  test('a refused refresh is refused with 409 OAUTH_CONNECTION_REQUIRED', async () => {
    provider.state.expiresIn = 0;
    const actorId = await createActor();
    const connectionId = await connect(actorId);
    provider.state.failRefresh = true;

    const res = await turn
      .api()
      .post(`/api/v1/tools/${oauthToolId}/call`)
      .send({ actor_id: actorId });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OAUTH_CONNECTION_REQUIRED');
    expect(res.body.error.meta).toEqual({
      oauth_client_id: clientId,
      actor_id: actorId,
      oauth_connection_id: connectionId,
    });
  });

  test('a provider that cannot refresh is 502 TOOL_AUTH_FAILED', async () => {
    provider.state.expiresIn = 0;
    const actorId = await createActor();
    await connect(actorId);
    provider.state.refreshStatus = 503;

    const res = await turn
      .api()
      .post(`/api/v1/tools/${oauthToolId}/call`)
      .send({ actor_id: actorId });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('TOOL_AUTH_FAILED');
    expect(res.body.error.meta.reason).toBe('provider_unavailable');
  });

  test('stamps the actor identity over a forged tool_context', async () => {
    const actorId = await createActor({ externalId: 'ext-42' });
    const tool = await turn.createTool();

    const res = await turn
      .api()
      .post(`/api/v1/tools/${tool.id}/call`)
      .send({
        actor_id: actorId,
        input: { amount: 1 },
        tool_context: { actor_id: 'actor_forged', tenant: 'acme' },
      });

    expect(res.status).toBe(200);
    const [request] = turn.target.requestsAt(`/${tool.name}`).slice(-1);
    expect(request.headers['x-soat-context-actor_id']).toBe(actorId);
    expect(request.headers['x-soat-context-actor_external_id']).toBe('ext-42');
    expect(request.headers['x-soat-context-tenant']).toBe('acme');
    expect(request.headers['x-soat-context-session_id']).toBeUndefined();
  });

  test('an unknown actor is refused with ACTOR_NOT_FOUND', async () => {
    const res = await turn
      .api()
      .post(`/api/v1/tools/${oauthToolId}/call`)
      .send({ actor_id: 'actor_doesnotexist0' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ACTOR_NOT_FOUND');
  });

  test('an actor of another project is refused with ACTOR_NOT_FOUND', async () => {
    const other = await turn
      .api()
      .post('/api/v1/projects')
      .send({ name: turn.unique('other') });
    expect(other.status).toBe(201);
    const actorId = await createActor({ projectId: other.body.id });

    const res = await turn
      .api()
      .post(`/api/v1/tools/${oauthToolId}/call`)
      .send({ actor_id: actorId });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ACTOR_NOT_FOUND');
  });

  test('the caller must be allowed UseOauthConnection', async () => {
    const actorId = await createActor();
    await connect(actorId);
    const callerToken = await createScopedPrincipal({
      adminToken: turn.adminToken,
      projectId: turn.projectId,
      username: turn.unique('actorcaller'),
      actions: ['tools:CallTool'],
    });
    const before = provider.state.apiAuthorizations.length;

    const res = await authenticatedTestClient(callerToken)
      .post(`/api/v1/tools/${oauthToolId}/call`)
      .send({ actor_id: actorId });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toContain(
      'oauth-connections:UseOauthConnection'
    );
    expect(provider.state.apiAuthorizations.length).toBe(before);
  });

  test('a non-string actor_id is refused with VALIDATION_FAILED', async () => {
    const res = await turn
      .api()
      .post(`/api/v1/tools/${oauthToolId}/call`)
      .send({ actor_id: 42 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});
