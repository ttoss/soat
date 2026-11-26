import type { SoatEvent } from 'src/lib/eventBus';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { captureEvents } from '../../fixtures/eventCapture';
import { startFakeOauthProvider } from '../../fixtures/fakeOauthProvider';
import { pollUntil } from '../../fixtures/poll';
import { authenticatedTestClient, testClient } from '../../testClient';

type Provider = Awaited<ReturnType<typeof startFakeOauthProvider>>;

/**
 * `oauth_connections.connected` and `.disconnected` on the bus, driven through
 * the callback; the refresh transitions are in `oauthConnectionTools.test.ts`.
 */
describe('OAuth connection events', () => {
  let provider: Provider;
  let userToken: string;
  let policyId: string;
  let projectId: string;
  let clientId: string;
  let otherClientId: string;
  let seq = 0;

  const api = () => {
    return authenticatedTestClient(userToken);
  };

  const createActor = async (): Promise<string> => {
    seq += 1;
    const res = await api()
      .post('/api/v1/actors')
      .send({ project_id: projectId, name: `ev-actor-${seq}` });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createClient = async (name: string): Promise<string> => {
    const secret = await api()
      .post('/api/v1/secrets')
      .send({ project_id: projectId, name: `${name}-secret`, value: 'shh' });
    const res = await api()
      .post('/api/v1/oauth-clients')
      .send({
        project_id: projectId,
        name,
        authorize_url: `${provider.url}/authorize`,
        token_url: `${provider.url}/token`,
        client_id: `${name}-client`,
        client_secret: `{{secret:${secret.body.id}}}`,
        scopes: ['users.read'],
        redirect_uri: 'https://app.example.com/cb',
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  /** Starts a connection and answers the callback with `code`. */
  const authorize = async (args: {
    actorId: string;
    code: string;
    oauthClientId?: string;
  }) => {
    const started = await api()
      .post('/api/v1/oauth-connections')
      .send({
        oauth_client_id: args.oauthClientId ?? clientId,
        actor_id: args.actorId,
      });
    expect([200, 201]).toContain(started.status);
    const state = new URL(started.body.authorize_url).searchParams.get(
      'state'
    ) as string;
    await testClient
      .get('/api/v1/oauth-connections/callback')
      .query({ code: args.code, state });
    return started.body.id as string;
  };

  const capture = (args: {
    type: string;
    actorId: string;
    action: () => Promise<unknown>;
    count?: number;
  }): Promise<SoatEvent[]> => {
    return captureEvents({
      type: args.type,
      where: (event) => {
        return (event.data as { actor_id?: string }).actor_id === args.actorId;
      },
      action: args.action,
      count: args.count,
    });
  };

  beforeAll(async () => {
    provider = await startFakeOauthProvider();
    const setup = await setupProjectWithUsers({
      prefix: 'oauthconnevents',
      policyActions: [
        'oauth-clients:*',
        'oauth-connections:*',
        'actors:*',
        'secrets:CreateSecret',
        'secrets:UseSecret',
        'triggers:CreateTrigger',
        'triggers:ListTriggerFirings',
        'orchestrations:CreateOrchestration',
        'orchestrations:StartRun',
        'orchestrations:GetRun',
      ],
      createNoPermUser: false,
    });
    userToken = setup.userToken;
    policyId = setup.policyId as string;
    projectId = setup.projectId;
    clientId = await createClient('events');
    otherClientId = await createClient('events-other');
  });

  afterAll(async () => {
    await provider.close();
  });

  test('a successful callback emits connected once, carrying the record without tokens', async () => {
    const actorId = await createActor();
    let connectionId = '';

    const events = await capture({
      type: 'oauth_connections.connected',
      actorId,
      count: 2,
      action: async () => {
        connectionId = await authorize({ actorId, code: 'good-code' });
      },
    });

    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.resourceType).toBe('oauth_connection');
    expect(event.resourceId).toBe(connectionId);
    expect(event.data).toMatchObject({
      id: connectionId,
      actor_id: actorId,
      oauth_client_id: clientId,
      status: 'connected',
      scopes: expect.arrayContaining(['users.read']),
    });
    expect(JSON.stringify(event.data)).not.toMatch(/access-|refresh-/);
  });

  test('a re-authorization emits connected again', async () => {
    const actorId = await createActor();
    await authorize({ actorId, code: 'good-code' });

    const events = await capture({
      type: 'oauth_connections.connected',
      actorId,
      count: 2,
      action: () => {
        return authorize({ actorId, code: 'good-code' });
      },
    });

    expect(events).toHaveLength(1);
  });

  test('a failed first authorization emits disconnected once', async () => {
    const actorId = await createActor();

    const events = await capture({
      type: 'oauth_connections.disconnected',
      actorId,
      count: 2,
      action: () => {
        return authorize({ actorId, code: 'bad-code' });
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({
      status: 'disconnected',
      error: { code: 'OAUTH_CALLBACK_FAILED' },
    });
  });

  test('a failure that moves nothing emits nothing', async () => {
    const connectedActor = await createActor();
    await authorize({ actorId: connectedActor, code: 'good-code' });
    const disconnectedActor = await createActor();
    await authorize({ actorId: disconnectedActor, code: 'bad-code' });

    const [keptConnected, stayedDisconnected] = await Promise.all([
      capture({
        type: 'oauth_connections.disconnected',
        actorId: connectedActor,
        action: () => {
          return authorize({ actorId: connectedActor, code: 'bad-code' });
        },
      }),
      capture({
        type: 'oauth_connections.disconnected',
        actorId: disconnectedActor,
        action: () => {
          return authorize({ actorId: disconnectedActor, code: 'bad-code' });
        },
      }),
    ]);

    expect(keptConnected).toEqual([]);
    expect(stayedDisconnected).toEqual([]);
  });

  test('an event trigger filtered on oauth_client_id fires on connected', async () => {
    const orchestration = await api()
      .post('/api/v1/orchestrations')
      .send({
        project_id: projectId,
        name: 'on-connected',
        nodes: [{ id: 'noop', type: 'transform', expression: 42 }],
        edges: [],
      });
    expect(orchestration.status).toBe(201);
    const createTrigger = async (oauthClientId: string) => {
      seq += 1;
      const res = await api()
        .post('/api/v1/triggers')
        .send({
          project_id: projectId,
          name: `on-connected-${seq}`,
          type: 'event',
          events: ['oauth_connections.connected'],
          event_data: { oauth_client_id: oauthClientId },
          target_type: 'orchestration',
          target_id: orchestration.body.id,
          policy_ids: [policyId],
        });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    const listFirings = async (triggerId: string) => {
      const res = await api().get(
        `/api/v1/trigger-firings?trigger_id=${triggerId}&limit=100`
      );
      expect(res.status).toBe(200);
      return res.body.data as Array<{
        status: string;
        input: Record<string, unknown>;
      }>;
    };
    const matching = await createTrigger(otherClientId);
    const other = await createTrigger(clientId);
    const actorId = await createActor();

    await authorize({
      actorId,
      code: 'good-code',
      oauthClientId: otherClientId,
    });

    const firings = await pollUntil({
      read: async () => {
        return (await listFirings(matching)).filter((firing) => {
          return firing.status === 'completed' || firing.status === 'failed';
        });
      },
      done: (settled) => {
        return settled.length > 0;
      },
    });
    expect(firings).toHaveLength(1);
    expect(firings[0].input).toMatchObject({
      event: 'oauth_connections.connected',
      resource_type: 'oauth_connection',
      data: { actor_id: actorId, oauth_client_id: otherClientId },
    });
    expect(await listFirings(other)).toHaveLength(0);
  }, 60_000);
});
