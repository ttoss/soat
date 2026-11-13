import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { createScopedPrincipal } from '../../fixtures/bootstrap';
import { startFakeOauthProvider } from '../../fixtures/fakeOauthProvider';
import { authenticatedTestClient, testClient } from '../../testClient';

type Provider = Awaited<ReturnType<typeof startFakeOauthProvider>>;

/**
 * An `http` tool with `auth.type: oauth_connection` sends the bearer of the
 * connection the turn's actor holds, refreshing it under a per-connection lock.
 */
describe('http tool auth oauth_connection', () => {
  let turn: AgentToolTurn;
  let provider: Provider;
  let clientId: string;
  let toolName: string;
  let agentId: string;

  const createActor = async (): Promise<string> => {
    const res = await turn
      .api()
      .post('/api/v1/actors')
      .send({ project_id: turn.projectId, name: turn.unique('actor') });
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

  const callTool = async (args: {
    actorId?: string;
    count?: number;
    agent?: string;
    token?: string;
  }): Promise<Array<Record<string, unknown>>> => {
    const calls = Array.from({ length: args.count ?? 1 }, () => {
      return { name: toolName, args: {} };
    });
    if (!args.actorId) {
      const { results } = await turn.generate({
        agentId: args.agent ?? agentId,
        calls,
      });
      return results;
    }
    const api = () => {
      return args.token ? authenticatedTestClient(args.token) : turn.api();
    };
    const session = await api()
      .post('/api/v1/sessions')
      .send({ agent_id: args.agent ?? agentId, actor_id: args.actorId });
    expect(session.status).toBe(201);
    const message = await api()
      .post(`/api/v1/sessions/${session.body.id}/messages`)
      .send({ message: JSON.stringify({ calls }) });
    expect(message.status).toBe(201);
    const res = await api()
      .post(`/api/v1/sessions/${session.body.id}/generate?wait=true`)
      .send({});
    expect(res.status).toBe(200);
    return JSON.parse(res.body.content);
  };

  const toolIdByName = async () => {
    const res = await turn
      .api()
      .get('/api/v1/tools')
      .query({ project_id: turn.projectId });
    return (res.body.data as Array<{ id: string; name: string }>).find(
      (row) => {
        return row.name === toolName;
      }
    )?.id;
  };

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'oauthconntools' });
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

    toolName = turn.unique('me');
    const tool = await turn.createTool({
      name: toolName,
      parameters: { type: 'object', properties: {} },
      execute: {
        url: `${provider.url}/2/users/me`,
        method: 'GET',
        auth: { type: 'oauth_connection', oauth_client_id: clientId },
      },
    });
    agentId = await turn.createAgent({ tool_bindings: [{ tool_id: tool.id }] });
  });

  afterAll(async () => {
    await provider.close();
    await turn.close();
  });

  beforeEach(() => {
    provider.state.expiresIn = 7200;
    provider.state.refreshDelayMs = 0;
    provider.state.failRefresh = false;
    provider.state.refreshStatus = 200;
  });

  test('an unknown oauth_client_id is refused at write time', async () => {
    const res = await turn
      .api()
      .post('/api/v1/tools')
      .send({
        project_id: turn.projectId,
        name: turn.unique('bad'),
        type: 'http',
        execute: {
          url: `${provider.url}/x`,
          auth: { type: 'oauth_connection' },
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('execute.auth.oauth_client_id');
  });

  test("sends the actor's access token", async () => {
    const actorId = await createActor();
    await connect(actorId);
    const issued = provider.state.issued;

    const [result] = await callTool({ actorId });

    expect(result).toEqual({ authorization: `Bearer access-${issued}` });
  });

  test('refreshes an expired token and keeps the rotated refresh token', async () => {
    provider.state.expiresIn = 0;
    const actorId = await createActor();
    await connect(actorId);

    const [first] = await callTool({ actorId });
    const [second] = await callTool({ actorId });

    const refreshes = provider.state.tokenRequests.filter((request) => {
      return request.params.grant_type === 'refresh_token';
    });
    expect(refreshes.at(-1)?.params.refresh_token).toBe(
      `refresh-${provider.state.issued - 1}`
    );
    expect(first).not.toEqual(second);
    expect(second).toEqual({
      authorization: `Bearer access-${provider.state.issued}`,
    });
  });

  test('concurrent calls refresh once', async () => {
    provider.state.expiresIn = 0;
    const actorId = await createActor();
    await connect(actorId);
    provider.state.expiresIn = 7200;
    provider.state.refreshDelayMs = 200;
    const before = provider.state.tokenRequests.length;

    const results = await callTool({ actorId, count: 3 });

    expect(provider.state.tokenRequests.length - before).toBe(1);
    expect(
      new Set(
        results.map((r) => {
          return JSON.stringify(r);
        })
      ).size
    ).toBe(1);
    expect(results[0]).toEqual({
      authorization: `Bearer access-${provider.state.issued}`,
    });
  });

  test('a refused refresh disconnects the connection with a reconnect error', async () => {
    provider.state.expiresIn = 0;
    const actorId = await createActor();
    const connectionId = await connect(actorId);
    provider.state.failRefresh = true;

    const [result] = await callTool({ actorId });

    expect(JSON.stringify(result)).toContain('reconnect');
    const read = await turn
      .api()
      .get(`/api/v1/oauth-connections/${connectionId}`);
    expect(read.body.status).toBe('disconnected');
    expect(read.body.error.code).toBe('OAUTH_CONNECTION_REFRESH_FAILED');
  });

  test('a provider that cannot refresh fails the call and keeps the connection', async () => {
    provider.state.expiresIn = 0;
    const actorId = await createActor();
    const connectionId = await connect(actorId);
    provider.state.refreshStatus = 503;

    const [result] = await callTool({ actorId });

    expect(JSON.stringify(result)).toContain('temporarily_unavailable');
    const read = await turn
      .api()
      .get(`/api/v1/oauth-connections/${connectionId}`);
    expect(read.body.status).toBe('connected');
  });

  test('an actor with no connection gets a reconnect error', async () => {
    const actorId = await createActor();

    const [result] = await callTool({ actorId });

    const text = JSON.stringify(result);
    expect(text).toContain('must reconnect');
    // The message is relayed by fronting APIs that serve other paths.
    expect(text).not.toContain('/api/v1');
  });

  test('a turn with no actor is refused', async () => {
    const [result] = await callTool({});

    expect(JSON.stringify(result)).toContain('needs an actor');
  });

  test('builtin actions on a client and a connection are scoped by their SRNs', async () => {
    const actorId = await createActor();
    const connectionId = await connect(actorId);
    const tool = await turn.createTool({
      type: 'builtin',
      execute: undefined,
      parameters: undefined,
      actions: ['get-oauth-client', 'get-oauth-connection'],
    });
    const scoped = await turn.createAgent({
      tool_bindings: [{ tool_id: tool.id }],
      policy_ids: [
        await turn.createPolicy({
          statement: [
            {
              effect: 'Allow',
              action: [
                'oauth-clients:GetOauthClient',
                'oauth-connections:GetOauthConnection',
              ],
              resource: [
                `srn:${turn.projectId}:oauth_client:${clientId}`,
                `srn:${turn.projectId}:oauth_connection:${connectionId}`,
              ],
            },
          ],
        }),
      ],
    });

    const { results } = await turn.generate({
      agentId: scoped,
      calls: [
        {
          name: `${tool.name}_get-oauth-client`,
          args: { oauth_client_id: clientId },
        },
        {
          name: `${tool.name}_get-oauth-connection`,
          args: { oauth_connection_id: connectionId },
        },
      ],
    });

    expect(
      results.map((result) => {
        return result.id;
      })
    ).toEqual([clientId, connectionId]);
  });

  test("the agent's policy_ids must allow UseOauthConnection", async () => {
    const actorId = await createActor();
    await connect(actorId);
    const policyId = await turn.createPolicy({
      statement: [{ effect: 'Allow', action: ['tools:*'] }],
    });
    const bounded = await turn.createAgent({
      tool_bindings: [{ tool_id: (await toolIdByName()) as string }],
      policy_ids: [policyId],
    });
    const before = provider.state.apiAuthorizations.length;

    const [result] = await callTool({ actorId, agent: bounded });

    expect(JSON.stringify(result)).toContain(
      `Forbidden: agent ${bounded}'s policies deny oauth-connections:UseOauthConnection`
    );
    expect(provider.state.apiAuthorizations.length).toBe(before);
  });

  test('the caller must be allowed UseOauthConnection', async () => {
    const actorId = await createActor();
    await connect(actorId);
    const callerToken = await createScopedPrincipal({
      adminToken: turn.adminToken,
      projectId: turn.projectId,
      username: turn.unique('oauthcaller'),
      actions: ['agents:*'],
    });
    const before = provider.state.apiAuthorizations.length;

    const [result] = await callTool({ actorId, token: callerToken });

    expect(JSON.stringify(result)).toContain(
      'oauth-connections:UseOauthConnection'
    );
    expect(provider.state.apiAuthorizations.length).toBe(before);
  });
});
