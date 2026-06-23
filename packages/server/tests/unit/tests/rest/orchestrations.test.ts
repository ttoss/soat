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
        input_mapping: { val: { var: 'step1' } },
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

    test('invalid graph (dangling edge) returns 400 with validation error', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          project_id: projectId,
          name: 'Dangling Edge Pipeline',
          nodes: [{ id: 'a', type: 'transform', expression: 1 }],
          edges: [{ from: 'a', to: 'ghost' }],
        });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('ORCHESTRATION_VALIDATION_FAILED');
      expect(response.body.error.meta.errors).toContainEqual(
        expect.objectContaining({ path: 'edges[0].to' })
      );
    });

    test('agent node missing agent_id returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          project_id: projectId,
          name: 'Bad Agent Pipeline',
          nodes: [{ id: 'a', type: 'agent' }],
          edges: [],
        });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('ORCHESTRATION_VALIDATION_FAILED');
    });
  });

  describe('POST /api/v1/orchestrations/validate', () => {
    test('returns valid=true for a sound graph', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations/validate')
        .send({
          nodes: [
            {
              id: 'a',
              type: 'transform',
              expression: 1,
              output_mapping: { result: 'state.step1' },
            },
            {
              id: 'b',
              type: 'transform',
              expression: 1,
              input_mapping: { val: { var: 'step1' } },
            },
          ],
          edges: [{ from: 'a', to: 'b' }],
        });
      expect(response.status).toBe(200);
      expect(response.body.valid).toBe(true);
      expect(response.body.errors).toEqual([]);
    });

    test('reports errors for an invalid graph without persisting', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations/validate')
        .send({
          nodes: [{ id: 'a', type: 'agent' }],
          edges: [{ from: 'a', to: 'ghost' }],
        });
      expect(response.status).toBe(200);
      expect(response.body.valid).toBe(false);
      expect(response.body.errors.length).toBeGreaterThan(0);
    });

    test('reports a warning for a conditional-branch reference', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations/validate')
        .send({
          nodes: [
            { id: 'cond', type: 'condition', expression: 'yes' },
            {
              id: 'yes_node',
              type: 'transform',
              expression: 1,
              output_mapping: { result: 'state.branch' },
            },
            { id: 'no_node', type: 'transform', expression: 2 },
            {
              id: 'join',
              type: 'transform',
              expression: 1,
              input_mapping: { val: { var: 'branch' } },
            },
          ],
          edges: [
            { from: 'cond', to: 'yes_node', condition: 'yes' },
            { from: 'cond', to: 'no_node', condition: 'no' },
            { from: 'yes_node', to: 'join' },
            { from: 'no_node', to: 'join' },
          ],
        });
      expect(response.status).toBe(200);
      expect(response.body.valid).toBe(true);
      expect(response.body.warnings.length).toBeGreaterThan(0);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post('/api/v1/orchestrations/validate')
        .send({ nodes: [], edges: [] });
      expect(response.status).toBe(401);
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
        response.body.some((o: { id: string }) => {
          return o.id === orchestrationId;
        })
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

  describe('POST /api/v1/orchestration-runs', () => {
    let runId: string;

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: orchestrationId, input: {} });
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403 or 400', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: orchestrationId, input: {} });
      expect([400, 403, 404]).toContain(response.status);
    });

    test('authenticated user can start a run and it completes', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({
          orchestration_id: orchestrationId,
          input: { greeting: 'hello' },
        });
      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.status).toBe('completed');
      runId = response.body.id;
    });

    test('admin can start a run without explicit project context', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/orchestration-runs')
        .send({
          orchestration_id: orchestrationId,
          input: { greeting: 'hello from admin' },
        });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.status).toBe('completed');
    });

    test('run on non-existent orchestration returns 500 or 404', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: 'nonexistent-id' });
      expect([404, 500]).toContain(response.status);
    });

    test('two-node sequential pipeline completes', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({ ...twoNodeOrchestration, project_id: projectId });
      expect(createRes.status).toBe(201);
      const twoNodeId = createRes.body.id;

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: twoNodeId, input: {} });
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
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: condOrcId, input: {} });
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
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: humanOrcId, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('paused');

      // Check GET /runs/:run_id returns paused run
      const getRes = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestration-runs/${runRes.body.id}`
      );
      expect(getRes.status).toBe(200);
      expect(getRes.body.status).toBe('paused');
    });

    test('transform node without expression is rejected at create', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Bad Transform',
          nodes: [{ id: 'bad', type: 'transform' }],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(400);
      expect(createRes.body.error.code).toBe('ORCHESTRATION_VALIDATION_FAILED');
    });

    test('condition node without expression is rejected at create', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Bad Condition',
          nodes: [{ id: 'cond', type: 'condition' }],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(400);
      expect(createRes.body.error.code).toBe('ORCHESTRATION_VALIDATION_FAILED');
    });

    test('input_mapping resolves literals, run-input {var} refs, and expressions', async () => {
      // End-to-end proof of JSON Logic input_mapping: a human node surfaces its
      // resolved inputs as required_action.context. The {var} ref reads a value
      // passed at run time (the original start-orchestration-run bug scenario).
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'JSON Logic Mapping',
          nodes: [
            {
              id: 'review',
              type: 'human',
              prompt: 'Review?',
              input_mapping: {
                language: 'pt-BR',
                threshold: 0.8,
                documentId: { var: 'temaDocumentId' },
                label: { cat: ['Tema: ', { var: 'titulo' }] },
                isLong: { '>': [{ var: 'wordCount' }, 500] },
              },
            },
          ],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({
          orchestration_id: createRes.body.id,
          input: { temaDocumentId: 'ood_123', titulo: 'Verão', wordCount: 750 },
        });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('paused');
      // Response keys are snake_cased by the outbound caseTransform middleware.
      expect(runRes.body.required_action.context).toEqual({
        language: 'pt-BR',
        threshold: 0.8,
        document_id: 'ood_123',
        label: 'Tema: Verão',
        is_long: true,
      });
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
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: createRes.body.id, input: {} });
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
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: createRes.body.id, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('completed');
    });

    test('knowledge node covers applyInputMapping branches', async () => {
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
                // {var} ref that resolves to a value
                query: { var: 'question' },
                // {var} ref into a null value
                nullVar: { var: 'x.y' },
                // {var} ref to a missing key resolves to null
                missingVar: { var: 'nonexistent.deep' },
                // a literal string is passed through as-is
                other: 'literal-value',
              },
              output_mapping: { results: 'state.knowledgeResults' },
            },
          ],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({
          orchestration_id: createRes.body.id,
          input: { question: 'hello', x: null },
        });
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
              input_mapping: { content: { var: 'text' } },
            },
          ],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({
          orchestration_id: createRes.body.id,
          input: { text: 'hello world' },
        });
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
              input_mapping: { prompt: { var: 'question' } },
            },
          ],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({
          orchestration_id: createRes.body.id,
          input: { question: 'hello' },
        });
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
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: createRes.body.id, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('failed');
    });

    test('records per-node executions for a completed run', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({ ...twoNodeOrchestration, project_id: projectId });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: createRes.body.id, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('completed');

      const execs = runRes.body.node_executions;
      expect(Array.isArray(execs)).toBe(true);
      expect(execs).toHaveLength(2);

      const nodeA = execs.find((e: { node_id: string }) => {
        return e.node_id === 'nodeA';
      });
      const nodeB = execs.find((e: { node_id: string }) => {
        return e.node_id === 'nodeB';
      });
      expect(nodeA.status).toBe('completed');
      expect(nodeA.node_type).toBe('transform');
      expect(nodeA.output).toEqual({ result: 42 });
      expect(nodeA.error).toBeNull();
      expect(nodeA.started_at).toBeDefined();
      expect(nodeA.completed_at).toBeDefined();

      // nodeB's input_mapping { val: { var: 'step1' } } resolves against state
      // written by nodeA's output_mapping (state.step1 = 42).
      expect(nodeB.status).toBe('completed');
      expect(nodeB.input).toEqual({ val: 42 });
      expect(nodeB.output).toEqual({ result: 43 });
    });

    test('records the failing node with its input and error', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Failing Node Trace',
          nodes: [
            {
              id: 'boom',
              type: 'tool',
              // structurally valid (passes create-time validation) but the
              // tool does not exist, so callTool throws at run time.
              tool_id: 'tool_doesnotexist',
              input_mapping: { name: 'widget' },
            },
          ],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: createRes.body.id, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('failed');

      // get-orchestration-run exposes the per-node trace
      const getRes = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestration-runs/${runRes.body.id}`
      );
      expect(getRes.status).toBe(200);
      const execs = getRes.body.node_executions;
      expect(execs).toHaveLength(1);
      expect(execs[0].node_id).toBe('boom');
      expect(execs[0].status).toBe('failed');
      expect(execs[0].input).toEqual({ name: 'widget' });
      expect(execs[0].output).toBeNull();
      expect(execs[0].error).toBeDefined();
      expect(execs[0].error.message).toBeDefined();
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
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: createRes.body.id, input: {} });
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
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: createRes.body.id, input: {} });
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
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: createRes.body.id, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('completed');
      // C runs exactly once
      expect(runRes.body.state.final).toBe('c');
    });

    test('cycle in graph is rejected at create', async () => {
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
      expect(createRes.status).toBe(400);
      expect(createRes.body.error.code).toBe('ORCHESTRATION_VALIDATION_FAILED');
      expect(createRes.body.error.meta.errors).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining('Cycle detected'),
        })
      );
    });

    test('self-loop in graph is rejected at create', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Self-Loop Pipeline',
          nodes: [{ id: 'A', type: 'transform', expression: 'a' }],
          edges: [{ from: 'A', to: 'A' }],
          project_id: projectId,
        });
      expect(createRes.status).toBe(400);
      expect(createRes.body.error.code).toBe('ORCHESTRATION_VALIDATION_FAILED');
    });

    describe('GET /api/v1/orchestration-runs/:run_id', () => {
      test('authenticated user can get a specific run', async () => {
        const response = await authenticatedTestClient(userToken).get(
          `/api/v1/orchestration-runs/${runId}`
        );
        expect(response.status).toBe(200);
        expect(response.body.id).toBe(runId);
        expect(response.body.status).toBe('completed');
        expect(response.body.orchestration_id).toBe(orchestrationId);
      });

      test('unauthenticated request returns 401', async () => {
        const response = await testClient.get(
          `/api/v1/orchestration-runs/${runId}`
        );
        expect(response.status).toBe(401);
      });

      test('non-existent run returns 404', async () => {
        const response = await authenticatedTestClient(userToken).get(
          `/api/v1/orchestration-runs/nonexistent-run-id`
        );
        expect(response.status).toBe(404);
      });

      test('user without permission returns 403 or 404', async () => {
        const response = await authenticatedTestClient(noPermToken).get(
          `/api/v1/orchestration-runs/${runId}`
        );
        expect([403, 404]).toContain(response.status);
      });
    });
  });

  describe('GET /api/v1/orchestration-runs', () => {
    test('authenticated user with permission can list runs', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestration-runs?orchestration_id=${orchestrationId}`
      );
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      // At least the run started in POST /runs tests
      expect(response.body.length).toBeGreaterThan(0);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/orchestration-runs?orchestration_id=${orchestrationId}`
      );
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403 or 404', async () => {
      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/orchestration-runs?orchestration_id=${orchestrationId}`
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

    test('authenticated user can delete an orchestration after a paused run created checkpoints', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Delete With Checkpoints',
          nodes: [
            {
              id: 'approval',
              type: 'human',
              prompt: 'Approve or reject',
              options: ['approve', 'reject'],
              output_mapping: { choice: 'state.choice' },
            },
            {
              id: 'finish',
              type: 'transform',
              expression: { var: 'choice' },
              output_mapping: { result: 'state.result' },
            },
          ],
          edges: [{ from: 'approval', to: 'finish' }],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);
      const toDeleteId = createRes.body.id;

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: toDeleteId, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('paused');

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

  describe('POST /api/v1/orchestration-runs/:run_id/cancel', () => {
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
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: cancelOrchId, input: {} });
      expect(runRes.status).toBe(201);
      cancelRunId = runRes.body.id;
    });

    test('cannot cancel a completed run — returns 409', async () => {
      const response = await authenticatedTestClient(userToken).post(
        `/api/v1/orchestration-runs/${cancelRunId}/cancel`
      );
      expect(response.status).toBe(409);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.post(
        `/api/v1/orchestration-runs/${cancelRunId}/cancel`
      );
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403 or 400', async () => {
      const response = await authenticatedTestClient(noPermToken).post(
        `/api/v1/orchestration-runs/${cancelRunId}/cancel`
      );
      expect([403, 400]).toContain(response.status);
    });
  });

  describe('POST /api/v1/orchestration-runs/:run_id/human-input', () => {
    let humanOrchId: string;
    let humanRunId: string;

    beforeAll(async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({ ...humanNodeOrchestration, project_id: projectId });
      expect(createRes.status).toBe(201);
      humanOrchId = createRes.body.id;

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: humanOrchId, input: {} });
      expect(runRes.status).toBe(201);
      humanRunId = runRes.body.id;
    });

    test('run is paused waiting for human input', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestration-runs/${humanRunId}`
      );
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('paused');
      expect(response.body.required_action).toBeDefined();
      expect(response.body.required_action.node_id).toBe('approval');
    });

    test('submitting human input resumes the run', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestration-runs/${humanRunId}/human-input`)
        .send({ node_id: 'approval', output: { choice: 'approve' } });
      expect(response.status).toBe(200);
      expect(['completed', 'running', 'paused']).toContain(
        response.body.status
      );
    });

    test('missing node_id returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestration-runs/${humanRunId}/human-input`)
        .send({ output: { choice: 'approve' } });
      expect(response.status).toBe(400);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post(`/api/v1/orchestration-runs/${humanRunId}/human-input`)
        .send({ node_id: 'approval', output: {} });
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403 or 400', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post(`/api/v1/orchestration-runs/${humanRunId}/human-input`)
        .send({ node_id: 'approval', output: {} });
      expect([403, 400]).toContain(response.status);
    });
  });

  describe('POST /api/v1/orchestration-runs/:run_id/resume', () => {
    test('resuming a completed run returns 409', async () => {
      const response = await authenticatedTestClient(userToken).post(
        `/api/v1/orchestration-runs/${orchestrationId}/resume`
      );
      // run_id here is invalid — 404 or 409
      expect([404, 409]).toContain(response.status);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.post(
        `/api/v1/orchestration-runs/someid/resume`
      );
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403 or 400', async () => {
      const response = await authenticatedTestClient(noPermToken).post(
        `/api/v1/orchestration-runs/someid/resume`
      );
      expect([403, 400]).toContain(response.status);
    });

    test('resuming a non-paused (completed) run returns 409', async () => {
      // Create a simple orchestration that completes immediately
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Resume Non-Paused',
          nodes: [
            {
              id: 'A',
              type: 'transform',
              expression: 'done',
              output_mapping: { result: 'state.done' },
            },
          ],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: createRes.body.id, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('completed');

      const resumeRes = await authenticatedTestClient(userToken).post(
        `/api/v1/orchestration-runs/${runRes.body.id}/resume`
      );
      expect(resumeRes.status).toBe(409);
    });
  });

  // ── Additional node-type coverage ─────────────────────────────────────────

  describe('Node type coverage – additional executor paths', () => {
    let subOrchId: string;

    beforeAll(async () => {
      // Create a simple sub-orchestration used by loop and sub_orchestration tests
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Sub-Orch for Coverage',
          nodes: [
            {
              id: 'pass',
              type: 'transform',
              expression: { var: 'item' },
              output_mapping: { result: 'state.result' },
            },
          ],
          edges: [],
          project_id: projectId,
        });
      expect(res.status).toBe(201);
      subOrchId = res.body.id;
    });

    test('tool node without tool_id is rejected at create', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Tool No ID',
          nodes: [{ id: 'tool', type: 'tool' }],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(400);
      expect(createRes.body.error.code).toBe('ORCHESTRATION_VALIDATION_FAILED');
    });

    test('delay node without duration is rejected at create', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Delay No Duration',
          nodes: [{ id: 'delay', type: 'delay' }],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(400);
      expect(createRes.body.error.code).toBe('ORCHESTRATION_VALIDATION_FAILED');
    });

    test('delay node with PT0S completes successfully', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Delay Zero',
          nodes: [
            {
              id: 'delay',
              type: 'delay',
              duration: 'PT0S',
              output_mapping: { waited: 'state.waited' },
            },
          ],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: createRes.body.id, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('completed');
      expect(runRes.body.state.waited).toBe('PT0S');
    });

    test('webhook emit mode completes', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Webhook Emit',
          nodes: [
            {
              id: 'wh',
              type: 'webhook',
              mode: 'emit',
              output_mapping: { emitted: 'state.emitted' },
            },
          ],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: createRes.body.id, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('completed');
      expect(runRes.body.state.emitted).toBe(true);
    });

    test('webhook receive mode pauses the run', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Webhook Receive',
          nodes: [{ id: 'wh', type: 'webhook', mode: 'receive' }],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: createRes.body.id, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('paused');
    });

    test('loop node without sub_graph is rejected at create', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Loop No SubGraph',
          nodes: [{ id: 'loop', type: 'loop' }],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(400);
      expect(createRes.body.error.code).toBe('ORCHESTRATION_VALIDATION_FAILED');
    });

    test('loop node with empty collection completes', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Loop Empty Collection',
          nodes: [
            {
              id: 'loop',
              type: 'loop',
              sub_graph: subOrchId,
              collection: 'state.items',
              item_variable: 'item',
              output_mapping: { results: 'state.results' },
            },
          ],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: createRes.body.id, input: { items: [] } });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('completed');
      expect(runRes.body.state.results).toEqual([]);
    });

    test('loop node iterates over collection items (runLoopBatches coverage)', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Loop With Items',
          nodes: [
            {
              id: 'loop',
              type: 'loop',
              sub_graph: subOrchId,
              collection: 'state.items',
              item_variable: 'item',
              output_mapping: { results: 'state.results' },
            },
          ],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({
          orchestration_id: createRes.body.id,
          input: { items: ['hello'] },
        });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('completed');
      expect(Array.isArray(runRes.body.state.results)).toBe(true);
    });

    test('loop node with non-state collection path', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Loop Non-State Collection',
          nodes: [
            {
              id: 'loop',
              type: 'loop',
              sub_graph: subOrchId,
              collection: 'items', // no 'state.' prefix — resolveLoopCollection normalises it
              item_variable: 'item',
              output_mapping: { results: 'state.results' },
            },
          ],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: createRes.body.id, input: { items: [] } });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('completed');
    });

    test('sub_orchestration node without orchestration_id is rejected at create', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'SubOrch No ID',
          nodes: [{ id: 'sub', type: 'sub_orchestration' }],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(400);
      expect(createRes.body.error.code).toBe('ORCHESTRATION_VALIDATION_FAILED');
    });

    test('sub_orchestration node with valid orchestration completes', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'SubOrch Main',
          nodes: [
            {
              id: 'sub',
              type: 'sub_orchestration',
              orchestration_id: subOrchId,
              input_mapping: { item: { var: 'value' } },
              output_mapping: { result: 'state.subResult' },
            },
          ],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({
          orchestration_id: createRes.body.id,
          input: { value: 'test' },
        });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('completed');
    });
  });

  // ── Cancel run status edge cases ──────────────────────────────────────────

  describe('Cancel run terminal-status edge cases', () => {
    test('cancelling a failed run returns 409', async () => {
      // Create an orchestration that immediately fails at run time. The graph
      // is structurally valid (so it passes create-time validation) but the
      // referenced tool does not exist, so the node throws during the run.
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Fail For Cancel Test',
          nodes: [{ id: 'bad', type: 'tool', tool_id: 'tool_doesnotexist' }],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);
      const failOrchId = createRes.body.id;

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: failOrchId, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('failed');
      const failedRunId = runRes.body.id;

      const cancelRes = await authenticatedTestClient(userToken).post(
        `/api/v1/orchestration-runs/${failedRunId}/cancel`
      );
      expect(cancelRes.status).toBe(409);
    });

    test('cancelling an already-cancelled run returns 409', async () => {
      // Create a human-node orchestration so the run pauses
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Paused For Double-Cancel',
          nodes: [
            {
              id: 'wait',
              type: 'human',
              prompt: 'Waiting.',
            },
          ],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);
      const pauseOrchId = createRes.body.id;

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: pauseOrchId, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('paused');
      const pausedRunId = runRes.body.id;

      // First cancel succeeds
      const firstCancel = await authenticatedTestClient(userToken).post(
        `/api/v1/orchestration-runs/${pausedRunId}/cancel`
      );
      expect(firstCancel.status).toBe(200);

      // Second cancel hits the 'cancelled' terminal-state branch
      const secondCancel = await authenticatedTestClient(userToken).post(
        `/api/v1/orchestration-runs/${pausedRunId}/cancel`
      );
      expect(secondCancel.status).toBe(409);
    });
  });

  // ── Submit human input edge cases ─────────────────────────────────────────

  describe('Submit human input edge cases', () => {
    let edgeOrchId: string;
    let edgeRunId: string;

    beforeAll(async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Human Edge Cases Orch',
          nodes: [
            {
              id: 'step',
              type: 'human',
              prompt: 'Choose.',
              options: ['a', 'b'],
            },
          ],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);
      edgeOrchId = createRes.body.id;

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: edgeOrchId, input: {} });
      expect(runRes.status).toBe(201);
      edgeRunId = runRes.body.id;
    });

    test('submitting human input with wrong nodeId returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestration-runs/${edgeRunId}/human-input`)
        .send({ node_id: 'wrong_node_id', output: { choice: 'a' } });
      expect(response.status).toBe(400);
    });

    test('submitting human input to a completed run returns 409', async () => {
      // Create and complete a fresh orchestration (no human node)
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Completed For Human Submit',
          nodes: [{ id: 'A', type: 'transform', expression: 'done' }],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: createRes.body.id, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('completed');

      const submitRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestration-runs/${runRes.body.id}/human-input`)
        .send({ node_id: 'A', output: { val: 1 } });
      expect(submitRes.status).toBe(409);
    });
  });
});
