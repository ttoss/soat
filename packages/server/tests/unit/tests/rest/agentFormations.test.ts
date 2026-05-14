import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('AgentFormations', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectId: string;
  let noPermToken: string;
  let formationId: string;

  const simpleTemplate = {
    resources: {
      MyMemory: {
        type: 'memory',
        properties: {
          name: 'Formation Test Memory',
        },
      },
    },
    outputs: {
      memoryId: { ref: 'MyMemory' },
    },
  };

  const invalidTemplate = {
    resources: {
      BadAgent: {
        type: 'agent',
        properties: {
          name: 'Bad Agent',
          ai_provider_id: { ref: 'NonExistent' },
        },
      },
    },
  };

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'afadmin', password: 'supersecret' });

    adminToken = await loginAs('afadmin', 'supersecret');

    const createUserRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'afuser', password: 'afpass' });
    userId = createUserRes.body.id;
    userToken = await loginAs('afuser', 'afpass');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'AgentFormations Test Project' });
    projectId = projectRes.body.id;

    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: [
                'agent-formations:ValidateAgentFormation',
                'agent-formations:PlanAgentFormation',
                'agent-formations:CreateAgentFormation',
                'agent-formations:ListAgentFormations',
                'agent-formations:GetAgentFormation',
                'agent-formations:UpdateAgentFormation',
                'agent-formations:DeleteAgentFormation',
                'agent-formations:ListAgentFormationEvents',
                'memories:CreateMemory',
                'memories:DeleteMemory',
              ],
            },
          ],
        },
      });

    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userId}/policies`)
      .send({ policy_ids: [policyRes.body.id] });

    const noPermRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'afnoperm', password: 'nopass' });
    noPermToken = await loginAs(
      'afnoperm',
      noPermRes.body.username ?? 'nopass'
    );
    await loginAs('afnoperm', 'nopass');
    noPermToken = await loginAs('afnoperm', 'nopass');
  });

  // ── Validate ──────────────────────────────────────────────────────────────

  describe('POST /api/v1/agent-formations/validate', () => {
    test('valid template returns valid=true', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/agent-formations/validate')
        .send({ template: simpleTemplate });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.errors).toHaveLength(0);
    });

    test('invalid ref returns valid=false', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/agent-formations/validate')
        .send({ template: invalidTemplate });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.errors.length).toBeGreaterThan(0);
    });

    test('unauthenticated returns 401', async () => {
      const res = await testClient
        .post('/api/v1/agent-formations/validate')
        .send({ template: simpleTemplate });

      expect(res.status).toBe(401);
    });
  });

  // ── Plan ──────────────────────────────────────────────────────────────────

  describe('POST /api/v1/agent-formations/plan', () => {
    test('returns plan with create actions', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/agent-formations/plan')
        .send({ project_id: projectId, template: simpleTemplate });

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.changes)).toBe(true);
      expect(res.body.changes[0].action).toBe('create');
      expect(res.body.changes[0].logical_id).toBe('MyMemory');
    });

    test('unauthenticated returns 401', async () => {
      const res = await testClient
        .post('/api/v1/agent-formations/plan')
        .send({ project_id: projectId, template: simpleTemplate });

      expect(res.status).toBe(401);
    });

    test('no permission returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .post('/api/v1/agent-formations/plan')
        .send({ project_id: projectId, template: simpleTemplate });

      expect(res.status).toBe(403);
    });
  });

  // ── Create ────────────────────────────────────────────────────────────────

  describe('POST /api/v1/agent-formations', () => {
    test('creates a formation and provisions resources', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/agent-formations')
        .send({
          project_id: projectId,
          name: 'test-formation',
          template: simpleTemplate,
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.id).toMatch(/^af_/);
      expect(res.body.name).toBe('test-formation');
      expect(res.body.status).toBe('active');
      expect(res.body.project_id).toBe(projectId);
      expect(Array.isArray(res.body.resources)).toBe(true);
      expect(res.body.resources).toHaveLength(1);
      expect(res.body.resources[0].logical_id).toBe('MyMemory');
      expect(res.body.resources[0].status).toBe('created');
      expect(res.body.resources[0].physical_resource_id).toBeDefined();
      expect(res.body.outputs).toBeDefined();

      formationId = res.body.id;
    });

    test('duplicate name returns 409', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/agent-formations')
        .send({
          project_id: projectId,
          name: 'test-formation',
          template: simpleTemplate,
        });

      expect(res.status).toBe(409);
    });

    test('invalid template returns 400', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/agent-formations')
        .send({
          project_id: projectId,
          name: 'bad-formation',
          template: invalidTemplate,
        });

      expect(res.status).toBe(400);
    });

    test('unauthenticated returns 401', async () => {
      const res = await testClient
        .post('/api/v1/agent-formations')
        .send({ project_id: projectId, name: 'x', template: simpleTemplate });

      expect(res.status).toBe(401);
    });

    test('no permission returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .post('/api/v1/agent-formations')
        .send({ project_id: projectId, name: 'x', template: simpleTemplate });

      expect(res.status).toBe(403);
    });
  });

  // ── List ──────────────────────────────────────────────────────────────────

  describe('GET /api/v1/agent-formations', () => {
    test('returns list of formations', async () => {
      const res = await authenticatedTestClient(userToken)
        .get('/api/v1/agent-formations')
        .query({ project_id: projectId });

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body[0].id).toBeDefined();
    });

    test('unauthenticated returns 401', async () => {
      const res = await testClient
        .get('/api/v1/agent-formations')
        .query({ project_id: projectId });

      expect(res.status).toBe(401);
    });
  });

  // ── Get ───────────────────────────────────────────────────────────────────

  describe('GET /api/v1/agent-formations/:formation_id', () => {
    test('returns formation details', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/agent-formations/${formationId}`
      );

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(formationId);
      expect(res.body.name).toBe('test-formation');
      expect(Array.isArray(res.body.resources)).toBe(true);
    });

    test('unknown id returns 404', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/agent-formations/af_nonexistent'
      );

      expect(res.status).toBe(404);
    });

    test('unauthenticated returns 401', async () => {
      const res = await testClient.get(
        `/api/v1/agent-formations/${formationId}`
      );
      expect(res.status).toBe(401);
    });

    test('no permission returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/agent-formations/${formationId}`
      );
      expect(res.status).toBe(403);
    });
  });

  // ── Update ────────────────────────────────────────────────────────────────

  describe('PUT /api/v1/agent-formations/:formation_id', () => {
    test('updates a formation', async () => {
      const updatedTemplate = {
        resources: {
          MyMemory: {
            type: 'memory',
            properties: {
              name: 'Updated Memory Name',
            },
          },
          MyMemory2: {
            type: 'memory',
            properties: {
              name: 'Second Memory',
            },
          },
        },
      };

      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/agent-formations/${formationId}`)
        .send({ template: updatedTemplate });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('active');
      expect(res.body.resources).toHaveLength(2);
    });

    test('invalid template returns 400', async () => {
      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/agent-formations/${formationId}`)
        .send({ template: invalidTemplate });

      expect(res.status).toBe(400);
    });

    test('unknown id returns 404', async () => {
      const res = await authenticatedTestClient(userToken)
        .put('/api/v1/agent-formations/af_nonexistent')
        .send({ template: simpleTemplate });

      expect(res.status).toBe(404);
    });

    test('unauthenticated returns 401', async () => {
      const res = await testClient
        .put(`/api/v1/agent-formations/${formationId}`)
        .send({ template: simpleTemplate });

      expect(res.status).toBe(401);
    });

    test('no permission returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .put(`/api/v1/agent-formations/${formationId}`)
        .send({ template: simpleTemplate });

      expect(res.status).toBe(403);
    });
  });

  // ── Events ────────────────────────────────────────────────────────────────

  describe('GET /api/v1/agent-formations/:formation_id/events', () => {
    test('returns operation events', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/agent-formations/${formationId}/events`
      );

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body[0].id).toBeDefined();
      expect(res.body[0].operation_type).toBeDefined();
    });

    test('unknown formation returns 404', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/agent-formations/af_nonexistent/events'
      );
      expect(res.status).toBe(404);
    });

    test('unauthenticated returns 401', async () => {
      const res = await testClient.get(
        `/api/v1/agent-formations/${formationId}/events`
      );
      expect(res.status).toBe(401);
    });
  });

  // ── Delete ────────────────────────────────────────────────────────────────

  describe('DELETE /api/v1/agent-formations/:formation_id', () => {
    test('deletes the formation and returns 204', async () => {
      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/agent-formations/${formationId}`
      );

      expect(res.status).toBe(204);
    });

    test('deleted formation is no longer found', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/agent-formations/${formationId}`
      );
      expect(res.status).toBe(404);
    });

    test('unknown id returns 404', async () => {
      const res = await authenticatedTestClient(userToken).delete(
        '/api/v1/agent-formations/af_nonexistent'
      );
      expect(res.status).toBe(404);
    });

    test('unauthenticated returns 401', async () => {
      const res = await testClient.delete(
        `/api/v1/agent-formations/${formationId}`
      );
      expect(res.status).toBe(401);
    });
  });
});
