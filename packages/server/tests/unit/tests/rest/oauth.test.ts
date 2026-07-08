import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('OAuth consent API', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });
    adminToken = await loginAs('admin', 'supersecret');

    await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'consent-alice', password: 'alicepass' });
    userToken = await loginAs('consent-alice', 'alicepass');

    const project = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'consent-project' });
    projectId = project.body.id;
  });

  describe('GET /api/v1/oauth/consent-info', () => {
    test('returns projects and the permission catalog', async () => {
      const res = await authenticatedTestClient(adminToken).get(
        '/api/v1/oauth/consent-info'
      );
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.projects)).toBe(true);
      expect(Array.isArray(res.body.modules)).toBe(true);
      const agents = res.body.modules.find((m: { module: string }) => {
        return m.module === 'agents';
      });
      expect(agents).toBeDefined();
      expect(
        agents.actions.some((a: { action: string }) => {
          return a.action === 'agents:CreateAgent';
        })
      ).toBe(true);
    });

    test('401 when unauthenticated', async () => {
      const res = await testClient.get('/api/v1/oauth/consent-info');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/v1/oauth/consent', () => {
    test('resolves a module selection into scopes and a project-scoped policy', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/oauth/consent')
        .send({
          project_id: projectId,
          selection: { kind: 'modules', modules: ['agents'] },
        });
      expect(res.status).toBe(200);
      expect(res.body.project_id).toBe(projectId);
      expect(res.body.scopes).toEqual(['agents:*']);
      expect(res.body.policy.statement[0].resource).toEqual([
        `soat:${projectId}:*:*`,
      ]);
    });

    test('"all" selection grants the wildcard', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/oauth/consent')
        .send({ project_id: projectId, selection: { kind: 'all' } });
      expect(res.status).toBe(200);
      expect(res.body.scopes).toEqual(['*']);
    });

    test('400 on an unknown action', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/oauth/consent')
        .send({
          project_id: projectId,
          selection: { kind: 'actions', actions: ['agents:Nope'] },
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('400 when selection is not an object', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/oauth/consent')
        .send({ project_id: projectId, selection: 'not-an-object' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('400 when selection.kind is unrecognized', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/oauth/consent')
        .send({ project_id: projectId, selection: { kind: 'bogus' } });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('400 when selection.modules is not an array', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/oauth/consent')
        .send({
          project_id: projectId,
          selection: { kind: 'modules', modules: 'agents' },
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('400 when selection.actions is not an array', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/oauth/consent')
        .send({
          project_id: projectId,
          selection: { kind: 'actions', actions: 'agents:Nope' },
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('400 when project_id is missing', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/oauth/consent')
        .send({ selection: { kind: 'all' } });
      expect(res.status).toBe(400);
    });

    test('401 when unauthenticated', async () => {
      const res = await testClient
        .post('/api/v1/oauth/consent')
        .send({ project_id: projectId, selection: { kind: 'all' } });
      expect(res.status).toBe(401);
    });

    test('403 when the user cannot access the project', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/oauth/consent')
        .send({ project_id: projectId, selection: { kind: 'all' } });
      expect(res.status).toBe(403);
    });
  });
});
