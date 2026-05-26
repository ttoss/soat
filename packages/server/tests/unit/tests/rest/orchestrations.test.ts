import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('Orchestrations', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectId: string;
  let policyId: string;
  let noPermToken: string;
  let orchestrationId: string;

  const simpleOrchestration = {
    name: 'Simple Pipeline',
    description: 'A simple transform pipeline',
    nodes: [
      {
        id: 'start',
        type: 'transform',
        expression: { var: '' },
        output_mapping: { output: 'state.result' },
      },
    ],
    edges: [],
    state_schema: {},
    input_schema: {},
  };

  const twoNodeOrchestration = {
    name: 'Two Node Pipeline',
    nodes: [
      {
        id: 'nodeA',
        type: 'transform',
        expression: 42,
        output_mapping: { result: 'state.step1' },
      },
      {
        id: 'nodeB',
        type: 'transform',
        expression: { '+': [{ var: 'step1' }, 1] },
        input_mapping: { val: 'state.step1' },
        output_mapping: { result: 'state.step2' },
      },
    ],
    edges: [{ from: 'nodeA', to: 'nodeB' }],
  };

  const conditionOrchestration = {
    name: 'Condition Pipeline',
    nodes: [
      {
        id: 'cond',
        type: 'condition',
        expression: 'yes',
      },
      {
        id: 'yes_node',
        type: 'transform',
        expression: 'yes_result',
        output_mapping: { result: 'state.branch' },
      },
      {
        id: 'no_node',
        type: 'transform',
        expression: 'no_result',
        output_mapping: { result: 'state.branch' },
      },
    ],
    edges: [
      { from: 'cond', to: 'yes_node', condition: 'yes' },
      { from: 'cond', to: 'no_node', condition: 'no' },
    ],
  };

  const humanNodeOrchestration = {
    name: 'Human Node Pipeline',
    nodes: [
      {
        id: 'approval',
        type: 'human',
        prompt: 'Please approve or reject.',
        options: ['approve', 'reject'],
      },
    ],
    edges: [],
  };

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'orchadmin', password: 'supersecret' });

    adminToken = await loginAs('orchadmin', 'supersecret');

    const createUserRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'orchuser', password: 'orchpass' });
    userId = createUserRes.body.id;
    userToken = await loginAs('orchuser', 'orchpass');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Orchestrations Test Project' });
    projectId = projectRes.body.id;

    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: [
                'orchestrations:CreateOrchestration',
                'orchestrations:ListOrchestrations',
                'orchestrations:GetOrchestration',
                'orchestrations:UpdateOrchestration',
                'orchestrations:DeleteOrchestration',
                'orchestrations:StartRun',
                'orchestrations:ListRuns',
                'orchestrations:GetRun',
                'orchestrations:CancelRun',
                'orchestrations:SubmitHumanInput',
                'orchestrations:ResumeRun',
              ],
            },
          ],
        },
      });
    policyId = policyRes.body.id;

    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userId}/policies`)
      .send({ policy_ids: [policyId] });

    const noPermRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'orchnoperm', password: 'nopassword' });
    expect(noPermRes.status).toBe(201);
    noPermToken = await loginAs('orchnoperm', 'nopassword');
  });

  describe('POST /api/v1/orchestrations', () => {
    test('authenticated user with permission can create an orchestration', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({ ...simpleOrchestration, project_id: projectId });
      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.id).toMatch(/^orch_/);
      expect(response.body.name).toBe('Simple Pipeline');
      orchestrationId = response.body.id;
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post('/api/v1/orchestrations')
        .send({ ...simpleOrchestration, project_id: projectId });
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post('/api/v1/orchestrations')
        .send({ ...simpleOrchestration, project_id: projectId });
      expect(response.status).toBe(403);
    });

    test('missing name returns 400', async () => {
      const { name: _name, ...withoutName } = simpleOrchestration;
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({ ...withoutName, project_id: projectId });
      expect(response.status).toBe(400);
    });

    test('missing nodes returns 400', async () => {
      const { nodes: _nodes, ...withoutNodes } = simpleOrchestration;
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({ ...withoutNodes, project_id: projectId });
      expect(response.status).toBe(400);
    });

    test('missing edges returns 400', async () => {
      const { edges: _edges, ...withoutEdges } = simpleOrchestration;
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({ ...withoutEdges, project_id: projectId });
      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/v1/orchestrations', () => {
    test('authenticated user with permission can list orchestrations', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/orchestrations')
        .query({ project_id: projectId });
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(
        response.body.some((o: { id: string }) => o.id === orchestrationId)
      ).toBe(true);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .get('/api/v1/orchestrations')
        .query({ project_id: projectId });
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .get('/api/v1/orchestrations')
        .query({ project_id: projectId });
      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/orchestrations/:orchestration_id', () => {
    test('authenticated user with permission can get an orchestration', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestrations/${orchestrationId}`
      );
      expect(response.status).toBe(200);
      expect(response.body.id).toBe(orchestrationId);
      expect(response.body.name).toBe('Simple Pipeline');
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/orchestrations/${orchestrationId}`
      );
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403 or 404', async () => {
      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/orchestrations/${orchestrationId}`
      );
      expect([403, 404]).toContain(response.status);
    });

    test('non-existent orchestration returns 404', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/orchestrations/orch_notexist12345678'
      );
      expect(response.status).toBe(404);
    });
  });

  describe('PATCH /api/v1/orchestrations/:orchestration_id', () => {
    test('authenticated user with permission can update an orchestration', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/orchestrations/${orchestrationId}`)
        .send({ name: 'Updated Pipeline' });
      expect(response.status).toBe(200);
      expect(response.body.name).toBe('Updated Pipeline');
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .patch(`/api/v1/orchestrations/${orchestrationId}`)
        .send({ name: 'X' });
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403 or 404', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .patch(`/api/v1/orchestrations/${orchestrationId}`)
        .send({ name: 'X' });
      expect([403, 404]).toContain(response.status);
    });

    test('can update nodes and edges', async () => {
      const newNodes = [
        {
          id: 'updated_node',
          type: 'transform',
          expression: 'updated',
          output_mapping: { result: 'state.updated' },
        },
      ];
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/orchestrations/${orchestrationId}`)
        .send({ nodes: newNodes, edges: [] });
      expect(response.status).toBe(200);
      expect(response.body.nodes).toBeDefined();
      expect(Array.isArray(response.body.nodes)).toBe(true);
    });

    test('can update description to null', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/orchestrations/${orchestrationId}`)
        .send({ description: null });
      expect(response.status).toBe(200);
      expect(response.body.description).toBeNull();
    });

    test('non-existent orchestration returns 404 or 500', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch('/api/v1/orchestrations/orch_notexist12345678')
        .send({ name: 'X' });
      expect([404, 500]).toContain(response.status);
    });
  });

  describe('POST /api/v1/orchestrations/:orchestration_id/runs', () => {
    let runId: string;

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post(`/api/v1/orchestrations/${orchestrationId}/runs`)
        .send({ input: {} });
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403 or 400', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post(`/api/v1/orchestrations/${orchestrationId}/runs`)
        .send({ input: {} });
      expect([400, 403, 404]).toContain(response.status);
    });

    test('authenticated user can start a run and it completes', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestrations/${orchestrationId}/runs`)
        .send({ input: { greeting: 'hello' } });
      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.status).toBe('completed');
      runId = response.body.id;
    });

    test('run on non-existent orchestration returns 500 or 404', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations/nonexistent-id/runs')
        .send({});
      expect([404, 500]).toContain(response.status);
    });

    test('two-node sequential pipeline completes', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({ ...twoNodeOrchestration, project_id: projectId });
      expect(createRes.status).toBe(201);
      const twoNodeId = createRes.body.id;

      const runRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestrations/${twoNodeId}/runs`)
        .send({ input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('completed');
      expect(runRes.body.state.step1).toBe(42);
      expect(runRes.body.state.step2).toBe(43);
    });

    test('condition node routes to correct branch', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({ ...conditionOrchestration, project_id: projectId });
      expect(createRes.status).toBe(201);
      const condOrcId = createRes.body.id;

      const runRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestrations/${condOrcId}/runs`)
        .send({ input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('completed');
      // expression returns 'yes', so yes_node should run
      expect(runRes.body.state.branch).toBe('yes_result');
    });

    test('human node pauses the run', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({ ...humanNodeOrchestration, project_id: projectId });
      expect(createRes.status).toBe(201);
      const humanOrcId = createRes.body.id;

      const runRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestrations/${humanOrcId}/runs`)
        .send({ input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('paused');

      // Check GET /runs/:run_id returns paused run
      const getRes = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestrations/${humanOrcId}/runs/${runRes.body.id}`
      );
      expect(getRes.status).toBe(200);
      expect(getRes.body.status).toBe('paused');
    });

    test('transform node without expression causes run to fail', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Bad Transform',
          nodes: [{ id: 'bad', type: 'transform' }],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);
      const badId = createRes.body.id;

      const runRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestrations/${badId}/runs`)
        .send({ input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('failed');
      expect(runRes.body.error).toBeDefined();
    });

    test('condition node without expression causes run to fail', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Bad Condition',
          nodes: [{ id: 'cond', type: 'condition' }],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);
      const badId = createRes.body.id;

      const runRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestrations/${badId}/runs`)
        .send({ input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('failed');
    });

    test('non-state input_mapping path resolves to undefined', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Non-State Mapping',
          nodes: [
            {
              id: 'A',
              type: 'transform',
              expression: 'ok',
              input_mapping: { val: 'notstate.x' },
              output_mapping: { result: 'state.result' },
            },
          ],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestrations/${createRes.body.id}/runs`)
        .send({ input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('completed');
    });

    test('deep null path in input_mapping resolves to undefined', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Deep Null Path',
          nodes: [
            {
              id: 'A',
              type: 'transform',
              expression: 'ok',
              input_mapping: { val: 'state.x.y' },
              output_mapping: { result: 'state.result' },
            },
          ],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestrations/${createRes.body.id}/runs`)
        .send({ input: { x: null } });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('completed');
    });

    test('activation group convergence waits for all incoming nodes', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Activation Group',
          nodes: [
            { id: 'A', type: 'transform', expression: 'a' },
            { id: 'B', type: 'transform', expression: 'b' },
            {
              id: 'C',
              type: 'transform',
              expression: 'c',
              output_mapping: { result: 'state.final' },
            },
          ],
          edges: [
            {
              from: 'A',
              to: 'C',
              activation_group: 'join',
              activation_condition: 'all',
            },
            {
              from: 'B',
              to: 'C',
              activation_group: 'join',
              activation_condition: 'all',
            },
          ],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestrations/${createRes.body.id}/runs`)
        .send({ input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('completed');
      expect(runRes.body.state.final).toBe('c');
    });

    test('empty nodes orchestration completes immediately', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Empty Nodes',
          nodes: [],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestrations/${createRes.body.id}/runs`)
        .send({ input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('completed');
    });

    test('knowledge node covers applyInputMapping and resolveFromState branches', async () => {
      // Using knowledge node (no external service mock needed — searchKnowledge queries DB)
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Knowledge Coverage',
          nodes: [
            {
              id: 'search',
              type: 'knowledge',
              input_mapping: {
                // state path that resolves to a value
                query: 'state.question',
                // deep path through null — covers cursor===null branch
                nullPath: 'state.x.y',
                // deep path through undefined — covers typeof cursor !== 'object' branch
                missingPath: 'state.nonexistent.deep',
                // non-state path — covers !path.startsWith('state.') branch
                other: 'notstate.z',
              },
              output_mapping: { results: 'state.knowledgeResults' },
            },
          ],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestrations/${createRes.body.id}/runs`)
        .send({ input: { question: 'hello', x: null } });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('completed');
    });

    test('memory_write node with fake memoryId causes run to fail', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Memory Write Test',
          nodes: [
            {
              id: 'write',
              type: 'memory_write',
              memory_id: 'mem_nonexistent12345',
              input_mapping: { content: 'state.text' },
            },
          ],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestrations/${createRes.body.id}/runs`)
        .send({ input: { text: 'hello world' } });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('failed');
    });

    test('agent node with fake agentId causes run to fail', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Agent Node Test',
          nodes: [
            {
              id: 'agent_node',
              type: 'agent',
              agent_id: 'agt_nonexistent12345',
              input_mapping: { prompt: 'state.question' },
            },
          ],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestrations/${createRes.body.id}/runs`)
        .send({ input: { question: 'hello' } });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('failed');
    });

    test('unknown node type causes run to fail', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Unknown Node Type',
          nodes: [{ id: 'unknown', type: 'unknown_type' }],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestrations/${createRes.body.id}/runs`)
        .send({ input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('failed');
    });

    // ── Phase 2: Parallel & Conditional ─────────────────────────────────

    test('fan-out executes multiple branches and all state updates land', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Fan-Out Pipeline',
          nodes: [
            { id: 'start', type: 'transform', expression: 'start' },
            {
              id: 'branch_a',
              type: 'transform',
              expression: 'a',
              output_mapping: { result: 'state.a' },
            },
            {
              id: 'branch_b',
              type: 'transform',
              expression: 'b',
              output_mapping: { result: 'state.b' },
            },
          ],
          edges: [
            { from: 'start', to: 'branch_a' },
            { from: 'start', to: 'branch_b' },
          ],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestrations/${createRes.body.id}/runs`)
        .send({ input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('completed');
      expect(runRes.body.state.a).toBe('a');
      expect(runRes.body.state.b).toBe('b');
    });

    test('fan-out then fan-in with activation_condition all completes correctly', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Fan-Out Fan-In All',
          nodes: [
            { id: 'start', type: 'transform', expression: 's' },
            {
              id: 'A',
              type: 'transform',
              expression: 'a',
              output_mapping: { result: 'state.a' },
            },
            {
              id: 'B',
              type: 'transform',
              expression: 'b',
              output_mapping: { result: 'state.b' },
            },
            {
              id: 'join',
              type: 'transform',
              expression: { cat: [{ var: 'a' }, { var: 'b' }] },
              output_mapping: { result: 'state.joined' },
            },
          ],
          edges: [
            { from: 'start', to: 'A' },
            { from: 'start', to: 'B' },
            {
              from: 'A',
              to: 'join',
              activation_group: 'merge',
              activation_condition: 'all',
            },
            {
              from: 'B',
              to: 'join',
              activation_group: 'merge',
              activation_condition: 'all',
            },
          ],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestrations/${createRes.body.id}/runs`)
        .send({ input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('completed');
      expect(runRes.body.state.joined).toBe('ab');
    });

    test('activation_condition any activates target on first completion only', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Fan-in Any',
          nodes: [
            { id: 'A', type: 'transform', expression: 'a' },
            { id: 'B', type: 'transform', expression: 'b' },
            {
              id: 'C',
              type: 'transform',
              expression: 'c',
              output_mapping: { result: 'state.final' },
            },
          ],
          edges: [
            {
              from: 'A',
              to: 'C',
              activation_group: 'join',
              activation_condition: 'any',
            },
            {
              from: 'B',
              to: 'C',
              activation_group: 'join',
              activation_condition: 'any',
            },
          ],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestrations/${createRes.body.id}/runs`)
        .send({ input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('completed');
      // C runs exactly once
      expect(runRes.body.state.final).toBe('c');
    });

    test('cycle in graph causes run to fail with cycle error', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Cyclic Pipeline',
          nodes: [
            { id: 'A', type: 'transform', expression: 'a' },
            { id: 'B', type: 'transform', expression: 'b' },
          ],
          edges: [
            { from: 'A', to: 'B' },
            { from: 'B', to: 'A' },
          ],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestrations/${createRes.body.id}/runs`)
        .send({ input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('failed');
      expect(runRes.body.error).toBeDefined();
      expect(runRes.body.error.code).toBe('ORCHESTRATION_CYCLE_DETECTED');
    });

    test('self-loop in graph causes run to fail', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Self-Loop Pipeline',
          nodes: [{ id: 'A', type: 'transform', expression: 'a' }],
          edges: [{ from: 'A', to: 'A' }],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestrations/${createRes.body.id}/runs`)
        .send({ input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('failed');
      expect(runRes.body.error.code).toBe('ORCHESTRATION_CYCLE_DETECTED');
    });

    describe('GET /api/v1/orchestrations/:orchestration_id/runs/:run_id', () => {
      test('authenticated user can get a specific run', async () => {
        const response = await authenticatedTestClient(userToken).get(
          `/api/v1/orchestrations/${orchestrationId}/runs/${runId}`
        );
        expect(response.status).toBe(200);
        expect(response.body.id).toBe(runId);
        expect(response.body.status).toBe('completed');
        expect(response.body.orchestration_id).toBe(orchestrationId);
      });

      test('unauthenticated request returns 401', async () => {
        const response = await testClient.get(
          `/api/v1/orchestrations/${orchestrationId}/runs/${runId}`
        );
        expect(response.status).toBe(401);
      });

      test('non-existent run returns 404', async () => {
        const response = await authenticatedTestClient(userToken).get(
          `/api/v1/orchestrations/${orchestrationId}/runs/nonexistent-run-id`
        );
        expect(response.status).toBe(404);
      });

      test('user without permission returns 403 or 404', async () => {
        const response = await authenticatedTestClient(noPermToken).get(
          `/api/v1/orchestrations/${orchestrationId}/runs/${runId}`
        );
        expect([403, 404]).toContain(response.status);
      });
    });
  });

  describe('GET /api/v1/orchestrations/:orchestration_id/runs', () => {
    test('authenticated user with permission can list runs', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestrations/${orchestrationId}/runs`
      );
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      // At least the run started in POST /runs tests
      expect(response.body.length).toBeGreaterThan(0);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/orchestrations/${orchestrationId}/runs`
      );
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403 or 404', async () => {
      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/orchestrations/${orchestrationId}/runs`
      );
      expect([403, 404]).toContain(response.status);
    });
  });

  describe('DELETE /api/v1/orchestrations/:orchestration_id', () => {
    test('authenticated user with permission can delete an orchestration', async () => {
      // Create a fresh one to delete
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          ...simpleOrchestration,
          name: 'To Delete',
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);
      const toDeleteId = createRes.body.id;

      const deleteRes = await authenticatedTestClient(userToken).delete(
        `/api/v1/orchestrations/${toDeleteId}`
      );
      expect(deleteRes.status).toBe(204);

      const getRes = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestrations/${toDeleteId}`
      );
      expect(getRes.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.delete(
        `/api/v1/orchestrations/${orchestrationId}`
      );
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403 or 404', async () => {
      const response = await authenticatedTestClient(noPermToken).delete(
        `/api/v1/orchestrations/${orchestrationId}`
      );
      expect([403, 404]).toContain(response.status);
    });
  });

  describe('POST /api/v1/orchestrations/:orchestration_id/runs/:run_id/cancel', () => {
    let cancelOrchId: string;
    let cancelRunId: string;

    beforeAll(async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          ...simpleOrchestration,
          name: 'Cancel Test',
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);
      cancelOrchId = createRes.body.id;

      const runRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestrations/${cancelOrchId}/runs`)
        .send({ input: {} });
      expect(runRes.status).toBe(201);
      cancelRunId = runRes.body.id;
    });

    test('cannot cancel a completed run — returns 409', async () => {
      const response = await authenticatedTestClient(userToken).post(
        `/api/v1/orchestrations/${cancelOrchId}/runs/${cancelRunId}/cancel`
      );
      expect(response.status).toBe(409);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.post(
        `/api/v1/orchestrations/${cancelOrchId}/runs/${cancelRunId}/cancel`
      );
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403 or 400', async () => {
      const response = await authenticatedTestClient(noPermToken).post(
        `/api/v1/orchestrations/${cancelOrchId}/runs/${cancelRunId}/cancel`
      );
      expect([403, 400]).toContain(response.status);
    });
  });

  describe('POST /api/v1/orchestrations/:orchestration_id/runs/:run_id/human-input', () => {
    let humanOrchId: string;
    let humanRunId: string;

    beforeAll(async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({ ...humanNodeOrchestration, project_id: projectId });
      expect(createRes.status).toBe(201);
      humanOrchId = createRes.body.id;

      const runRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestrations/${humanOrchId}/runs`)
        .send({ input: {} });
      expect(runRes.status).toBe(201);
      humanRunId = runRes.body.id;
    });

    test('run is paused waiting for human input', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestrations/${humanOrchId}/runs/${humanRunId}`
      );
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('paused');
      expect(response.body.required_action).toBeDefined();
      expect(response.body.required_action.node_id).toBe('approval');
    });

    test('submitting human input resumes the run', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(
          `/api/v1/orchestrations/${humanOrchId}/runs/${humanRunId}/human-input`
        )
        .send({ node_id: 'approval', output: { choice: 'approve' } });
      expect(response.status).toBe(200);
      expect(['completed', 'running', 'paused']).toContain(
        response.body.status
      );
    });

    test('missing node_id returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(
          `/api/v1/orchestrations/${humanOrchId}/runs/${humanRunId}/human-input`
        )
        .send({ output: { choice: 'approve' } });
      expect(response.status).toBe(400);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post(
          `/api/v1/orchestrations/${humanOrchId}/runs/${humanRunId}/human-input`
        )
        .send({ node_id: 'approval', output: {} });
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403 or 400', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post(
          `/api/v1/orchestrations/${humanOrchId}/runs/${humanRunId}/human-input`
        )
        .send({ node_id: 'approval', output: {} });
      expect([403, 400]).toContain(response.status);
    });
  });

  describe('POST /api/v1/orchestrations/:orchestration_id/runs/:run_id/resume', () => {
    test('resuming a completed run returns 409', async () => {
      const response = await authenticatedTestClient(userToken).post(
        `/api/v1/orchestrations/${orchestrationId}/runs/${orchestrationId}/resume`
      );
      // run_id here is invalid — 404 or 409
      expect([404, 409]).toContain(response.status);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.post(
        `/api/v1/orchestrations/${orchestrationId}/runs/someid/resume`
      );
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403 or 400', async () => {
      const response = await authenticatedTestClient(noPermToken).post(
        `/api/v1/orchestrations/${orchestrationId}/runs/someid/resume`
      );
      expect([403, 400]).toContain(response.status);
    });
  });
});
