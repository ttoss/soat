import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

const LIST_ACTIONS = [
  'agents:ListSessions',
  'conversations:ListConversations',
  'actors:ListActors',
  'memories:ListMemoryStores',
];

/**
 * With no `project_id` a list spans every project the caller reaches, and a
 * conditioned Deny removes the same rows it removes for one named project.
 */
describe('Lists without project_id apply the row-level policy filter', () => {
  let adminToken: string;
  let restrictedToken: string;
  let projectId: string;
  const finance: Record<string, string> = {};
  const eng: Record<string, string> = {};

  const tag = async (args: { route: string; id: string; team: string }) => {
    const res = await authenticatedTestClient(adminToken)
      .put(`/api/v1/${args.route}/${args.id}/tags`)
      .send({ team: args.team });
    expect(res.status).toBe(200);
  };

  const create = async (args: {
    route: string;
    body: Record<string, unknown>;
    team: string;
  }) => {
    const res = await authenticatedTestClient(adminToken)
      .post(`/api/v1/${args.route}`)
      .send(args.body);
    expect(res.status).toBe(201);
    const id = res.body.id as string;
    await tag({ route: args.route, id, team: args.team });
    return id;
  };

  const listIds = async (args: { token: string; route: string }) => {
    const res = await authenticatedTestClient(args.token).get(
      `/api/v1/${args.route}`
    );
    expect(res.status).toBe(200);
    return (res.body.data as Array<{ id: string }>).map((row) => {
      return row.id;
    });
  };

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'unscopedadmin', password: 'supersecret' });
    adminToken = await loginAs('unscopedadmin', 'supersecret');

    projectId = (
      await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Unscoped List Project' })
    ).body.id;

    const aiProviderId = (
      await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'Unscoped List Provider',
          provider: 'ollama',
          default_model: 'llama3.2',
        })
    ).body.id as string;
    const agentId = (
      await authenticatedTestClient(adminToken).post('/api/v1/agents').send({
        project_id: projectId,
        ai_provider_id: aiProviderId,
        name: 'Unscoped List Agent',
      })
    ).body.id as string;

    for (const [bag, team] of [
      [finance, 'finance'],
      [eng, 'eng'],
    ] as const) {
      bag.sessions = await create({
        route: 'sessions',
        body: { agent_id: agentId, name: `${team} session` },
        team,
      });
      bag.conversations = await create({
        route: 'conversations',
        body: { project_id: projectId },
        team,
      });
      bag.actors = await create({
        route: 'actors',
        body: { project_id: projectId, name: `${team} actor` },
        team,
      });
      bag['memory-stores'] = await create({
        route: 'memory-stores',
        body: { project_id: projectId, name: `${team}-store` },
        team,
      });
    }

    const userRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'unscopeduser', password: 'unscopedpass' });
    expect(userRes.status).toBe(201);
    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: LIST_ACTIONS,
              resource: [`srn:${projectId}:*:*`],
            },
            {
              effect: 'Deny',
              action: LIST_ACTIONS,
              resource: ['*'],
              condition: {
                StringEquals: { 'soat:ResourceTag/team': 'finance' },
              },
            },
          ],
        },
      });
    expect(policyRes.status).toBe(201);
    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userRes.body.id}/policies`)
      .send({ policy_ids: [policyRes.body.id] });
    restrictedToken = await loginAs('unscopeduser', 'unscopedpass');
  });

  describe.each(['sessions', 'conversations', 'actors', 'memory-stores'])(
    'GET /api/v1/%s',
    (route) => {
      test('omits the row a conditioned Deny removes', async () => {
        const ids = await listIds({ token: restrictedToken, route });

        expect(ids).toContain(eng[route]);
        expect(ids).not.toContain(finance[route]);
      });

      test('admin, unrestricted, still sees both', async () => {
        const ids = await listIds({ token: adminToken, route });

        expect(ids).toEqual(
          expect.arrayContaining([eng[route], finance[route]])
        );
      });
    }
  );

  test('unauthenticated returns 401', async () => {
    const res = await testClient.get('/api/v1/conversations');

    expect(res.status).toBe(401);
  });
});
