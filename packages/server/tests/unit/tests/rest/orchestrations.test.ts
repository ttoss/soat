import { db } from 'src/db';
import { DomainError } from 'src/errors';
import * as agentGenerationModule from 'src/lib/agentGeneration';
import type { SoatEvent } from 'src/lib/eventBus';
import { eventBus } from 'src/lib/eventBus';
import { reapOrphanedRuns, wakeDueRuns } from 'src/lib/orchestrationScheduler';
import * as toolsModule from 'src/lib/tools';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

describe('Orchestrations', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
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
        state_mapping: { 'state.result': { var: 'output.output' } },
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
        state_mapping: { 'state.step1': { var: 'output.result' } },
      },
      {
        id: 'nodeB',
        type: 'transform',
        expression: { '+': [{ var: 'step1' }, 1] },
        input_mapping: { val: { var: 'step1' } },
        state_mapping: { 'state.step2': { var: 'output.result' } },
      },
    ],
    edges: [{ from: 'nodeA', to: 'nodeB' }],
  };

  const nodesNamespaceOrchestration = {
    name: 'Nodes Namespace Pipeline',
    nodes: [
      // No state_mapping: nodeB reads nodeA's raw artifact via the
      // engine-owned state.nodes.<id> namespace instead.
      { id: 'nodeA', type: 'transform', expression: 42 },
      {
        id: 'nodeB',
        type: 'transform',
        expression: { '+': [{ var: 'nodes.nodeA.result' }, 1] },
        input_mapping: { val: { var: 'nodes.nodeA.result' } },
        state_mapping: { 'state.step2': { var: 'output.result' } },
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
        state_mapping: { 'state.branch': { var: 'output.result' } },
      },
      {
        id: 'no_node',
        type: 'transform',
        expression: 'no_result',
        state_mapping: { 'state.branch': { var: 'output.result' } },
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
    const setup = await setupProjectWithUsers({
      prefix: 'orch',
      policyActions: [
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
    });

    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
    noPermToken = setup.noPermToken as string;
  });

  // Creates a project-scoped API key whose policy excludes `excludedAction`,
  // used to exercise the `projectIds === null` (403) branch on routes that
  // don't take a `project_id` param (unlike `noPermToken`, which resolves to
  // an empty project list and 404s instead).
  const createRestrictedApiKey = async (excludedAction: string) => {
    const allowedActions = [
      'orchestrations:CreateOrchestration',
      'orchestrations:ListOrchestrations',
      'orchestrations:GetOrchestration',
      'orchestrations:UpdateOrchestration',
      'orchestrations:DeleteOrchestration',
      'orchestrations:StartRun',
      'orchestrations:ListRuns',
      'orchestrations:GetRun',
    ].filter((action) => {
      return action !== excludedAction;
    });
    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: { statement: [{ effect: 'Allow', action: allowedActions }] },
      });

    const keyRes = await authenticatedTestClient(userToken)
      .post('/api/v1/api-keys')
      .send({
        name: `No ${excludedAction} Key`,
        project_id: projectId,
        policy_ids: [policyRes.body.id],
      });
    expect(keyRes.status).toBe(201);
    return keyRes.body.key as string;
  };

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

    test('admin without project scoping and no project_id returns 400', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/orchestrations')
        .send({ ...simpleOrchestration, name: 'No Project Admin' });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('project_id is required');
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

    test('non-string name returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({ ...simpleOrchestration, name: 123, project_id: projectId });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('name is required');
    });

    test('non-array nodes returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          ...simpleOrchestration,
          nodes: 'not-an-array',
          project_id: projectId,
        });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('nodes must be an array');
    });

    test('non-array edges returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({ ...simpleOrchestration, edges: {}, project_id: projectId });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('edges must be an array');
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
    test('missing nodes and edges default to empty arrays', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations/validate')
        .send({});
      expect(response.status).toBe(200);
      expect(response.body.valid).toBe(true);
      expect(response.body.errors).toEqual([]);
    });

    test('returns valid=true for a sound graph', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations/validate')
        .send({
          nodes: [
            {
              id: 'a',
              type: 'transform',
              expression: 1,
              state_mapping: { 'state.step1': { var: 'output.result' } },
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
              state_mapping: { 'state.branch': { var: 'output.result' } },
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

    test('accepts a node reading an upstream node via {"var": "nodes.<id>..."}', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations/validate')
        .send({
          nodes: nodesNamespaceOrchestration.nodes,
          edges: nodesNamespaceOrchestration.edges,
        });
      expect(response.status).toBe(200);
      expect(response.body.valid).toBe(true);
      expect(response.body.errors).toEqual([]);
    });

    test('rejects a node referencing nodes.<id> of a non-upstream node', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations/validate')
        .send({
          nodes: [
            { id: 'a', type: 'transform', expression: 1 },
            {
              id: 'b',
              type: 'transform',
              expression: 1,
              input_mapping: { val: { var: 'nodes.ghost.result' } },
            },
          ],
          edges: [{ from: 'a', to: 'b' }],
        });
      expect(response.status).toBe(200);
      expect(response.body.valid).toBe(false);
      expect(response.body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining("'ghost' is not an earlier"),
          }),
        ])
      );
    });

    test('rejects a state_mapping write into the reserved nodes namespace', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations/validate')
        .send({
          nodes: [
            {
              id: 'a',
              type: 'transform',
              expression: 1,
              state_mapping: { 'state.nodes.a': { var: 'output.result' } },
            },
          ],
          edges: [],
        });
      expect(response.status).toBe(200);
      expect(response.body.valid).toBe(false);
      expect(response.body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining(
              "reserved 'nodes' state namespace"
            ),
          }),
        ])
      );
    });

    test('accepts an input_schema property named nodes (input lives under state.input, no collision)', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations/validate')
        .send({
          nodes: [
            {
              id: 'a',
              type: 'transform',
              expression: { var: 'input.nodes' },
            },
          ],
          edges: [],
          input_schema: { properties: { nodes: { type: 'object' } } },
        });
      expect(response.status).toBe(200);
      expect(response.body.valid).toBe(true);
    });
  });

  describe('GET /api/v1/orchestrations', () => {
    test('authenticated user with permission can list orchestrations', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/orchestrations')
        .query({ project_id: projectId });
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(
        response.body.data.some((o: { id: string }) => {
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

    test('admin without project scoping and no project_id returns 400', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        '/api/v1/orchestrations'
      );
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('project_id is required');
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

    // An admin's JWT resolveProjectIds returns `undefined` (not `[]`) when no
    // project scope is given, so the lib call runs unfiltered across projects.
    test('admin can get an orchestration without project scoping', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        `/api/v1/orchestrations/${orchestrationId}`
      );
      expect(response.status).toBe(200);
      expect(response.body.id).toBe(orchestrationId);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/orchestrations/${orchestrationId}`
      );
      expect(response.status).toBe(401);
    });

    // noPermToken has zero policies, so resolveProjectIds returns `[]` (not
    // `null`) — the route's own `projectIds === null` check is skipped, and
    // the empty-array project filter simply matches no orchestration.
    test('user without permission returns 404', async () => {
      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/orchestrations/${orchestrationId}`
      );
      expect(response.status).toBe(404);
    });

    test('non-existent orchestration returns 404', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/orchestrations/orch_notexist12345678'
      );
      expect(response.status).toBe(404);
    });

    test('project-scoped API key without GetOrchestration permission returns 403', async () => {
      const rawKey = await createRestrictedApiKey(
        'orchestrations:GetOrchestration'
      );
      const response = await authenticatedTestClient(rawKey).get(
        `/api/v1/orchestrations/${orchestrationId}`
      );
      expect(response.status).toBe(403);
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

    test('admin can update an orchestration without project scoping', async () => {
      const response = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/orchestrations/${orchestrationId}`)
        .send({ name: 'Updated By Admin' });
      expect(response.status).toBe(200);
      expect(response.body.name).toBe('Updated By Admin');
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .patch(`/api/v1/orchestrations/${orchestrationId}`)
        .send({ name: 'X' });
      expect(response.status).toBe(401);
    });

    // Same empty-policy-array reasoning as the GET test above.
    test('user without permission returns 404', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .patch(`/api/v1/orchestrations/${orchestrationId}`)
        .send({ name: 'X' });
      expect(response.status).toBe(404);
    });

    test('can update nodes and edges', async () => {
      const newNodes = [
        {
          id: 'updated_node',
          type: 'transform',
          expression: 'updated',
          state_mapping: { 'state.updated': { var: 'output.result' } },
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

    test('can update description to a string', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/orchestrations/${orchestrationId}`)
        .send({ description: 'An updated description' });
      expect(response.status).toBe(200);
      expect(response.body.description).toBe('An updated description');
    });

    test('can update state_schema and input_schema', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/orchestrations/${orchestrationId}`)
        .send({
          state_schema: { type: 'object' },
          input_schema: { type: 'object', properties: {} },
        });
      expect(response.status).toBe(200);
      expect(response.body.state_schema).toEqual({ type: 'object' });
      expect(response.body.input_schema).toEqual({
        type: 'object',
        properties: {},
      });
    });

    test('project-scoped API key without UpdateOrchestration permission returns 403', async () => {
      const rawKey = await createRestrictedApiKey(
        'orchestrations:UpdateOrchestration'
      );
      const response = await authenticatedTestClient(rawKey)
        .patch(`/api/v1/orchestrations/${orchestrationId}`)
        .send({ name: 'X' });
      expect(response.status).toBe(403);
    });

    test('non-existent orchestration returns 404', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch('/api/v1/orchestrations/orch_notexist12345678')
        .send({ name: 'X' });
      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/v1/orchestration-runs', () => {
    let runId: string;

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post('/api/v1/orchestration-runs')
        .send({ wait: true, orchestration_id: orchestrationId, input: {} });
      expect(response.status).toBe(401);
    });

    // resolveStartRunScope explicitly 403s on an empty projectIds array
    // (unlike the plain orchestration CRUD routes, which just filter to no
    // results and 404).
    test('user without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post('/api/v1/orchestration-runs')
        .send({ wait: true, orchestration_id: orchestrationId, input: {} });
      expect(response.status).toBe(403);
    });

    test('missing orchestration_id returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ wait: true, orchestration_id: 123, input: {} });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('orchestration_id is required');
    });

    test('project-scoped API key without StartRun permission returns 403', async () => {
      const restrictedPolicyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [{ effect: 'Allow', action: ['orchestrations:GetRun'] }],
          },
        });

      const keyRes = await authenticatedTestClient(userToken)
        .post('/api/v1/api-keys')
        .send({
          name: 'No StartRun Key',
          project_id: projectId,
          policy_ids: [restrictedPolicyRes.body.id],
        });
      expect(keyRes.status).toBe(201);
      const rawKey = keyRes.body.key as string;

      const response = await authenticatedTestClient(rawKey)
        .post('/api/v1/orchestration-runs')
        .send({ wait: true, orchestration_id: orchestrationId, input: {} });
      expect(response.status).toBe(403);
    });

    test('authenticated user can start a run and it completes', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({
          wait: true,
          orchestration_id: orchestrationId,
          input: { greeting: 'hello' },
        });
      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.status).toBe('succeeded');
      runId = response.body.id;
    });

    test('admin can start a run without explicit project context', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/orchestration-runs')
        .send({
          wait: true,
          orchestration_id: orchestrationId,
          input: { greeting: 'hello from admin' },
        });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.status).toBe('succeeded');
    });

    test('run on non-existent orchestration returns 404', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ wait: true, orchestration_id: 'nonexistent-id' });
      expect(response.status).toBe(404);
    });

    test('two-node sequential pipeline completes', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({ ...twoNodeOrchestration, project_id: projectId });
      expect(createRes.status).toBe(201);
      const twoNodeId = createRes.body.id;

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ wait: true, orchestration_id: twoNodeId, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('succeeded');
      expect(runRes.body.state.step1).toBe(42);
      expect(runRes.body.state.step2).toBe(43);
    });

    test("a node reads an upstream node's raw artifact via state.nodes.<id> without a state_mapping", async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({ ...nodesNamespaceOrchestration, project_id: projectId });
      expect(createRes.status).toBe(201);
      const nodesNsId = createRes.body.id;

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ wait: true, orchestration_id: nodesNsId, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('succeeded');
      // node ids are caller-authored identifiers referenced verbatim by
      // {"var": "nodes.<id>..."} — they must round-trip unmangled, not be
      // snake-cased like a schema field name (nodeA, not node_a).
      expect(runRes.body.state.nodes.nodeA.result).toBe(42);
      expect(runRes.body.state.step2).toBe(43);
    });

    test('a node whose expression reflects the whole state does not create a circular state.nodes reference', async () => {
      // { var: '' } resolves to the entire state object, so the recorded
      // artifact (`{ result: <state> }`) aliases `state` itself unless the
      // engine clones before nesting it under state.nodes.<id>.
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Whole State Reflection',
          nodes: [{ id: 'start', type: 'transform', expression: { var: '' } }],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ wait: true, orchestration_id: createRes.body.id, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('succeeded');
      expect(runRes.body.state.nodes.start.result).toEqual({ input: {} });
    });

    test("a transform expression's data-object keys round-trip verbatim (no camelCase conversion)", async () => {
      // F-9: the templating doc promises JSON Logic keys round-trip verbatim.
      // A `preserve`-wrapped literal emitted by a transform must land in
      // state.nodes.<id>.result with its snake_case keys intact — the engine
      // must not camelCase `action_id` into `actionId`.
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Preserve Verbatim Keys',
          nodes: [
            {
              id: 'emit',
              type: 'transform',
              expression: {
                preserve: { action_id: 'x', approval_expired: true },
              },
            },
          ],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);
      // The stored definition must keep the author's snake_case keys.
      expect(createRes.body.nodes[0].expression).toEqual({
        preserve: { action_id: 'x', approval_expired: true },
      });

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ wait: true, orchestration_id: createRes.body.id, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('succeeded');
      expect(runRes.body.state.nodes.emit.result).toEqual({
        action_id: 'x',
        approval_expired: true,
      });
      expect(runRes.body.state.nodes.emit.result.actionId).toBeUndefined();
    });

    test('a state_mapping value that resolves to the whole state does not create a circular reference', async () => {
      // { var: 'state' } over the { output, state } context resolves to the
      // live state object; writing it back uncloned would nest state inside
      // itself and crash JSONB persistence, stranding the run.
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'State Snapshot Mapping',
          nodes: [
            {
              id: 'snap',
              type: 'transform',
              expression: 1,
              state_mapping: { 'state.snapshot': { var: 'state' } },
            },
          ],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ wait: true, orchestration_id: createRes.body.id, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('succeeded');
      expect(runRes.body.state.snapshot.input).toEqual({});
    });

    test("a downstream node reads a condition node's label via state.nodes.<id>", async () => {
      // Condition nodes complete with a label, not an artifact; the nodes
      // namespace still records them as { label } so nodes.<id> refs that
      // validation accepts are actually readable at runtime.
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Condition Label In Nodes Namespace',
          nodes: [
            { id: 'cond', type: 'condition', expression: 'yes' },
            {
              id: 'pick',
              type: 'transform',
              expression: { var: 'nodes.cond.label' },
              state_mapping: { 'state.picked': { var: 'output.result' } },
            },
          ],
          edges: [{ from: 'cond', to: 'pick', condition: 'yes' }],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ wait: true, orchestration_id: createRes.body.id, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('succeeded');
      expect(runRes.body.state.picked).toBe('yes');
    });

    test('condition node routes to correct branch', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({ ...conditionOrchestration, project_id: projectId });
      expect(createRes.status).toBe(201);
      const condOrcId = createRes.body.id;

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ wait: true, orchestration_id: condOrcId, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('succeeded');
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
        .send({ wait: true, orchestration_id: humanOrcId, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('awaiting_input');

      // Check GET /runs/:run_id returns paused run
      const getRes = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestration-runs/${runRes.body.id}`
      );
      expect(getRes.status).toBe(200);
      expect(getRes.body.status).toBe('awaiting_input');
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
                documentId: { var: 'input.temaDocumentId' },
                label: { cat: ['Tema: ', { var: 'input.titulo' }] },
                isLong: { '>': [{ var: 'input.wordCount' }, 500] },
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
          wait: true,
          orchestration_id: createRes.body.id,
          input: { temaDocumentId: 'ood_123', titulo: 'Verão', wordCount: 750 },
        });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('awaiting_input');
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
              state_mapping: { 'state.final': { var: 'output.result' } },
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
        .send({ wait: true, orchestration_id: createRes.body.id, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('succeeded');
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
        .send({ wait: true, orchestration_id: createRes.body.id, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('succeeded');
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
              state_mapping: {
                'state.knowledgeResults': { var: 'output.results' },
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
          wait: true,
          orchestration_id: createRes.body.id,
          input: { question: 'hello', x: null },
        });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('succeeded');
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
          wait: true,
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
          wait: true,
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
        .send({ wait: true, orchestration_id: createRes.body.id, input: {} });
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
        .send({ wait: true, orchestration_id: createRes.body.id, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('succeeded');

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
      // written by nodeA's state_mapping (state.step1 = 42).
      expect(nodeB.status).toBe('completed');
      expect(nodeB.input).toEqual({ val: 42 });
      expect(nodeB.output).toEqual({ result: 43 });
    });

    // Regression: https://github.com/ttoss/soat/issues/378 — an agent node's
    // generation call creates a real trace, but the run's own `trace_id`
    // column was never populated from it.
    test('run with an agent node has a non-null trace_id captured from the generation', async () => {
      const aiProviderRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'Orchestration Trace Provider',
          provider: 'ollama',
          default_model: 'llama3.2',
        });
      expect(aiProviderRes.status).toBe(201);

      const agentRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          name: 'Orchestration Trace Agent',
          ai_provider_id: aiProviderRes.body.id,
        });
      expect(agentRes.status).toBe(201);

      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Agent Trace Pipeline',
          nodes: [
            {
              id: 'ask',
              type: 'agent',
              agent_id: agentRes.body.id,
              input_mapping: { prompt: { var: 'question' } },
            },
          ],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const generationSpy = jest
        .spyOn(agentGenerationModule, 'createGeneration')
        .mockResolvedValue({
          id: 'gen_orchtrace01',
          traceId: 'trc_orchtrace01',
          status: 'completed',
          output: {
            model: 'llama3.2',
            content: 'Hello back.',
            finishReason: 'stop',
          },
        });

      try {
        const runRes = await authenticatedTestClient(userToken)
          .post('/api/v1/orchestration-runs')
          .send({
            wait: true,
            orchestration_id: createRes.body.id,
            input: { question: 'hello' },
          });
        expect(runRes.status).toBe(201);
        expect(runRes.body.error).toBeNull();
        expect(runRes.body.status).toBe('succeeded');
        expect(runRes.body.trace_id).toBe('trc_orchtrace01');

        const getRunRes = await authenticatedTestClient(userToken).get(
          `/api/v1/orchestration-runs/${runRes.body.id}`
        );
        expect(getRunRes.status).toBe(200);
        expect(getRunRes.body.trace_id).toBe('trc_orchtrace01');
      } finally {
        generationSpy.mockRestore();
      }
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
        .send({ wait: true, orchestration_id: createRes.body.id, input: {} });
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

    test('a run that throws a non-Error value records a readable error message', async () => {
      // A JSON-Logic `map` whose per-item mapper is a multi-key object is not
      // valid JSON-Logic: the engine treats the first key as an operator, finds
      // none, and throws a bare object `{ type: 'Unknown Operator' }` — not an
      // Error. buildRunError used to String() that into the useless
      // "[object Object]". The message must instead carry the serialized cause.
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Opaque Error Repro',
          nodes: [
            {
              id: 'bad_map',
              type: 'transform',
              expression: {
                map: [{ var: 'input.items' }, { a: { var: '' }, b: 1 }],
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
          wait: true,
          orchestration_id: createRes.body.id,
          input: { items: ['x', 'y'] },
        });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('failed');

      const getRes = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestration-runs/${runRes.body.id}`
      );
      const nodeError = getRes.body.node_executions[0].error;
      expect(nodeError.message).not.toBe('[object Object]');
      expect(nodeError.message).toContain('Unknown Operator');
    });

    test('run input is visible to node logic through the input namespace', async () => {
      // Regression: run input used to be seeded only as flat top-level state
      // keys, so a graph following the documented `{ "var": "input.<name>" }`
      // convention read null. It must now resolve to the supplied value.
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Input Namespace',
          nodes: [
            {
              id: 'echo',
              type: 'transform',
              expression: { var: 'input.cycle_task' },
              state_mapping: { 'state.echoed': { var: 'output.result' } },
            },
          ],
          edges: [],
          project_id: projectId,
          input_schema: {
            type: 'object',
            properties: { cycle_task: { type: 'string' } },
          },
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({
          wait: true,
          orchestration_id: createRes.body.id,
          input: { cycle_task: 'summarize the funnel' },
        });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('succeeded');
      expect(runRes.body.state.echoed).toBe('summarize the funnel');
    });

    test('a dotted state_mapping target round-trips through a nested var read', async () => {
      // Regression: writing to `state.proposed.action_id` stored a single flat
      // key "proposed.action_id", which `{ "var": "proposed.action_id" }` could
      // not read back (var descends dot-paths). The write must build a nested
      // object so a downstream node reads the value.
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Nested State Path',
          nodes: [
            {
              id: 'write',
              type: 'transform',
              expression: { cat: ['act_', { var: 'input.n' }] },
              state_mapping: {
                'state.proposed.action_id': { var: 'output.result' },
              },
            },
            {
              id: 'read',
              type: 'transform',
              expression: { var: 'proposed.action_id' },
              state_mapping: { 'state.readback': { var: 'output.result' } },
            },
          ],
          edges: [{ from: 'write', to: 'read' }],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({
          wait: true,
          orchestration_id: createRes.body.id,
          input: { n: '42' },
        });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('succeeded');
      expect(runRes.body.state.readback).toBe('act_42');
      expect(runRes.body.state.proposed).toEqual({ action_id: 'act_42' });
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
              state_mapping: { 'state.a': { var: 'output.result' } },
            },
            {
              id: 'branch_b',
              type: 'transform',
              expression: 'b',
              state_mapping: { 'state.b': { var: 'output.result' } },
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
        .send({ wait: true, orchestration_id: createRes.body.id, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('succeeded');
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
              state_mapping: { 'state.a': { var: 'output.result' } },
            },
            {
              id: 'B',
              type: 'transform',
              expression: 'b',
              state_mapping: { 'state.b': { var: 'output.result' } },
            },
            {
              id: 'join',
              type: 'transform',
              expression: { cat: [{ var: 'a' }, { var: 'b' }] },
              state_mapping: { 'state.joined': { var: 'output.result' } },
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
        .send({ wait: true, orchestration_id: createRes.body.id, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('succeeded');
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
              state_mapping: { 'state.final': { var: 'output.result' } },
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
        .send({ wait: true, orchestration_id: createRes.body.id, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('succeeded');
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
        expect(response.body.status).toBe('succeeded');
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

      // Same empty-policy-array reasoning as the orchestration CRUD tests
      // above: the get-run lib function filters by an empty projectIds
      // array, which matches nothing, rather than a route-level 403.
      test('user without permission returns 404', async () => {
        const response = await authenticatedTestClient(noPermToken).get(
          `/api/v1/orchestration-runs/${runId}`
        );
        expect(response.status).toBe(404);
      });

      test('project-scoped API key without GetRun permission returns 403', async () => {
        const rawKey = await createRestrictedApiKey('orchestrations:GetRun');
        const response = await authenticatedTestClient(rawKey).get(
          `/api/v1/orchestration-runs/${runId}`
        );
        expect(response.status).toBe(403);
      });

      test('admin can get a run without project scoping', async () => {
        const response = await authenticatedTestClient(adminToken).get(
          `/api/v1/orchestration-runs/${runId}`
        );
        expect(response.status).toBe(200);
        expect(response.body.id).toBe(runId);
      });
    });
  });

  describe('GET /api/v1/orchestration-runs', () => {
    test('authenticated user with permission can list runs', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestration-runs?orchestration_id=${orchestrationId}`
      );
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
      // At least the run started in POST /runs tests
      expect(response.body.data.length).toBeGreaterThan(0);
    });

    test('admin can list runs without project scoping', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        `/api/v1/orchestration-runs?orchestration_id=${orchestrationId}`
      );
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThan(0);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/orchestration-runs?orchestration_id=${orchestrationId}`
      );
      expect(response.status).toBe(401);
    });

    // Unlike get-by-id, the list route explicitly checks for an empty
    // projectIds array and 403s rather than falling through to an
    // empty-filter query.
    test('user without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/orchestration-runs?orchestration_id=${orchestrationId}`
      );
      expect(response.status).toBe(403);
    });
  });

  describe('DELETE /api/v1/orchestrations/:orchestration_id', () => {
    test('admin can delete an orchestration without project scoping', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          ...simpleOrchestration,
          name: 'To Delete By Admin',
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const deleteRes = await authenticatedTestClient(adminToken).delete(
        `/api/v1/orchestrations/${createRes.body.id}`
      );
      expect(deleteRes.status).toBe(204);
    });

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
              state_mapping: { 'state.choice': { var: 'output.choice' } },
            },
            {
              id: 'finish',
              type: 'transform',
              expression: { var: 'choice' },
              state_mapping: { 'state.result': { var: 'output.result' } },
            },
          ],
          edges: [{ from: 'approval', to: 'finish' }],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);
      const toDeleteId = createRes.body.id;

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ wait: true, orchestration_id: toDeleteId, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('awaiting_input');

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

    // Same empty-policy-array reasoning as the GET/PATCH tests above.
    test('user without permission returns 404', async () => {
      const response = await authenticatedTestClient(noPermToken).delete(
        `/api/v1/orchestrations/${orchestrationId}`
      );
      expect(response.status).toBe(404);
    });

    test('project-scoped API key without DeleteOrchestration permission returns 403', async () => {
      const rawKey = await createRestrictedApiKey(
        'orchestrations:DeleteOrchestration'
      );
      const response = await authenticatedTestClient(rawKey).delete(
        `/api/v1/orchestrations/${orchestrationId}`
      );
      expect(response.status).toBe(403);
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
        .send({ wait: true, orchestration_id: cancelOrchId, input: {} });
      expect(runRes.status).toBe(201);
      cancelRunId = runRes.body.id;
    });

    test('cannot cancel a completed run — returns 409', async () => {
      const response = await authenticatedTestClient(userToken).post(
        `/api/v1/orchestration-runs/${cancelRunId}/cancel`
      );
      expect(response.status).toBe(409);
    });

    test('cancelling a non-existent run returns 404', async () => {
      const response = await authenticatedTestClient(userToken).post(
        `/api/v1/orchestration-runs/run_nonexistent0000000/cancel`
      );
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('ORCHESTRATION_RUN_NOT_FOUND');
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.post(
        `/api/v1/orchestration-runs/${cancelRunId}/cancel`
      );
      expect(response.status).toBe(401);
    });

    // resolveRunAuth explicitly 403s on an empty projectIds array.
    test('user without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken).post(
        `/api/v1/orchestration-runs/${cancelRunId}/cancel`
      );
      expect(response.status).toBe(403);
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
        .send({ wait: true, orchestration_id: humanOrchId, input: {} });
      expect(runRes.status).toBe(201);
      humanRunId = runRes.body.id;
    });

    test('run is paused waiting for human input', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestration-runs/${humanRunId}`
      );
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('awaiting_input');
      expect(response.body.required_action).toBeDefined();
      expect(response.body.required_action.node_id).toBe('approval');
      // Regression: https://github.com/ttoss/soat/issues/376 — the docs
      // document `required_action.type: "human_input"` as a discriminator,
      // but the field was never part of the runtime type or construction site.
      expect(response.body.required_action.type).toBe('human_input');
    });

    test('submitting human input resumes the run', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestration-runs/${humanRunId}/human-input`)
        .send({ node_id: 'approval', output: { choice: 'approve' } });
      expect(response.status).toBe(200);
      expect(['succeeded', 'running', 'awaiting_input']).toContain(
        response.body.status
      );
    });

    test('missing node_id returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestration-runs/${humanRunId}/human-input`)
        .send({ output: { choice: 'approve' } });
      expect(response.status).toBe(400);
    });

    test('non-string node_id returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestration-runs/${humanRunId}/human-input`)
        .send({ node_id: 123, output: { choice: 'approve' } });
      expect(response.status).toBe(400);
    });

    test('non-object output defaults to an empty object', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({ ...humanNodeOrchestration, project_id: projectId });
      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ wait: true, orchestration_id: createRes.body.id, input: {} });

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestration-runs/${runRes.body.id}/human-input`)
        .send({ node_id: 'approval', output: 'not-an-object' });
      expect(response.status).toBe(200);
    });

    test('submitting human input for a non-existent run returns 404', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestration-runs/run_nonexistent0000000/human-input`)
        .send({ node_id: 'approval', output: {} });
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('ORCHESTRATION_RUN_NOT_FOUND');
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post(`/api/v1/orchestration-runs/${humanRunId}/human-input`)
        .send({ node_id: 'approval', output: {} });
      expect(response.status).toBe(401);
    });

    // resolveRunAuth explicitly 403s on an empty projectIds array.
    test('user without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post(`/api/v1/orchestration-runs/${humanRunId}/human-input`)
        .send({ node_id: 'approval', output: {} });
      expect(response.status).toBe(403);
    });

    // Regression: the bootstrap admin authenticates via JWT with no project
    // membership, so resolveProjectIds() legitimately returns `undefined`
    // ("no filter — all projects"). human-input required a resolvable single
    // primaryId and rejected that case with a spurious 400
    // 'project_id is required', even though submitHumanInput only needs the
    // (optional) projectIds array to scope its query.
    test('admin (unrestricted JWT, no explicit project) can submit human input', async () => {
      const createRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/orchestrations')
        .send({ ...humanNodeOrchestration, project_id: projectId });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/orchestration-runs')
        .send({ wait: true, orchestration_id: createRes.body.id, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('awaiting_input');

      const response = await authenticatedTestClient(adminToken)
        .post(`/api/v1/orchestration-runs/${runRes.body.id}/human-input`)
        .send({ node_id: 'approval', output: { choice: 'approve' } });
      expect(response.status).toBe(200);
      expect(['succeeded', 'running', 'awaiting_input']).toContain(
        response.body.status
      );
    });
  });

  describe('POST /api/v1/orchestration-runs/:run_id/resume', () => {
    // `orchestrationId` is an orchestration id, not a run id, so this never
    // matches a run — the genuine "resume a completed run" 409 case is
    // covered below by 'resuming a non-paused (completed) run returns 409'.
    test('resuming with an orchestration id instead of a run id returns 404', async () => {
      const response = await authenticatedTestClient(userToken).post(
        `/api/v1/orchestration-runs/${orchestrationId}/resume`
      );
      expect(response.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.post(
        `/api/v1/orchestration-runs/someid/resume`
      );
      expect(response.status).toBe(401);
    });

    // resolveRunAuth explicitly 403s on an empty projectIds array.
    test('user without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken).post(
        `/api/v1/orchestration-runs/someid/resume`
      );
      expect(response.status).toBe(403);
    });

    test('resuming an awaiting-input run succeeds', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({ ...humanNodeOrchestration, project_id: projectId });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ wait: true, orchestration_id: createRes.body.id, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('awaiting_input');

      const resumeRes = await authenticatedTestClient(userToken).post(
        `/api/v1/orchestration-runs/${runRes.body.id}/resume`
      );
      expect(resumeRes.status).toBe(200);
      expect(resumeRes.body.id).toBe(runRes.body.id);
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
              state_mapping: { 'state.done': { var: 'output.result' } },
            },
          ],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ wait: true, orchestration_id: createRes.body.id, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('succeeded');

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
              // Loop items arrive as the sub-run's input, readable only
              // through the input namespace.
              expression: { var: 'input.item' },
              state_mapping: { 'state.result': { var: 'output.result' } },
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
              state_mapping: { 'state.waited': { var: 'output.waited' } },
            },
          ],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ wait: true, orchestration_id: createRes.body.id, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('succeeded');
      expect(runRes.body.state.waited).toBe('PT0S');
    });

    test('emit_event node emits an event delivered to a subscribed webhook', async () => {
      // A graph gets data out by emitting an internal event; a Webhook
      // subscription (not the graph) delivers it. The node holds no URL/secret.
      const fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response('ok', { status: 200 }));
      const hookUrl = 'https://example.com/emit-event-hook';
      try {
        // Admin has webhooks:CreateWebhook; the orch user does not. The
        // dispatcher matches webhooks by project, regardless of who created them.
        const hookRes = await authenticatedTestClient(adminToken)
          .post('/api/v1/webhooks')
          .send({
            project_id: projectId,
            name: 'emit-event-hook',
            url: hookUrl,
            events: ['guardrail.exception'],
          });
        expect(hookRes.status).toBe(201);

        const createRes = await authenticatedTestClient(userToken)
          .post('/api/v1/orchestrations')
          .send({
            name: 'Emit Event',
            nodes: [
              {
                id: 'alert',
                type: 'emit_event',
                event_type: 'guardrail.exception',
                input_mapping: { reason: 'kill-switch' },
              },
            ],
            edges: [],
            project_id: projectId,
          });
        expect(createRes.status).toBe(201);

        const runRes = await authenticatedTestClient(userToken)
          .post('/api/v1/orchestration-runs')
          .send({ wait: true, orchestration_id: createRes.body.id, input: {} });
        expect(runRes.status).toBe(201);
        expect(runRes.body.status).toBe('succeeded');

        const exec = runRes.body.node_executions.find(
          (n: { node_id: string }) => {
            return n.node_id === 'alert';
          }
        );
        // `output` is a verbatim pass-through on orchestration-run routes, so
        // the artifact keeps its camelCase `eventType`.
        expect(exec.output).toEqual({
          emitted: true,
          eventType: 'guardrail.exception',
        });

        // Delivery is fire-and-forget; poll until the subscription is called.
        const deadline = Date.now() + 5000;
        const callTo = () => {
          return fetchSpy.mock.calls.find(([u]) => {
            return u === hookUrl;
          });
        };
        while (!callTo() && Date.now() < deadline) {
          await new Promise((r) => {
            return setTimeout(r, 25);
          });
        }
        const call = callTo();
        expect(call).toBeDefined();
        const init = call![1] as {
          headers: Record<string, string>;
          body: string;
        };
        expect(init.headers['X-Soat-Event']).toBe('guardrail.exception');
        const body = JSON.parse(init.body);
        expect(body.event).toBe('guardrail.exception');
        expect(body.resource_type ?? body.resourceType).toBe(
          'orchestration_run'
        );
        expect(body.data.reason).toBe('kill-switch');
      } finally {
        fetchSpy.mockRestore();
      }
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
        .send({ wait: true, orchestration_id: createRes.body.id, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('awaiting_input');

      // Regression: https://github.com/ttoss/soat/issues/377 — without a
      // `type` discriminator, a client can't tell this webhook-receive pause
      // apart from a `human` node pause (see also #376).
      expect(runRes.body.required_action.type).toBe('webhook_receive');

      const submitRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestration-runs/${runRes.body.id}/human-input`)
        .send({ node_id: 'wh', output: { delivered: true } });
      expect(submitRes.status).toBe(200);
      expect(['succeeded', 'running', 'awaiting_input']).toContain(
        submitRes.body.status
      );
    });

    test('loop node without orchestration_id is rejected at create', async () => {
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
              orchestration_id: subOrchId,
              collection: 'state.input.items',
              item_variable: 'item',
              state_mapping: { 'state.results': { var: 'output.results' } },
            },
          ],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({
          wait: true,
          orchestration_id: createRes.body.id,
          input: { items: [] },
        });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('succeeded');
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
              orchestration_id: subOrchId,
              collection: 'state.input.items',
              item_variable: 'item',
              state_mapping: { 'state.results': { var: 'output.results' } },
            },
          ],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({
          wait: true,
          orchestration_id: createRes.body.id,
          input: { items: ['hello'] },
        });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('succeeded');
      // Each result is the sub-run's output ({ terminalNodeId: artifact });
      // asserting the item value proves the loop actually fed the item
      // through the sub-run's input namespace, not just that a run happened.
      expect(runRes.body.state.results).toEqual([
        { pass: { result: 'hello' } },
      ]);
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
              orchestration_id: subOrchId,
              collection: 'input.items', // no 'state.' prefix — resolveLoopCollection normalises it
              item_variable: 'item',
              state_mapping: { 'state.results': { var: 'output.results' } },
            },
          ],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({
          wait: true,
          orchestration_id: createRes.body.id,
          input: { items: [] },
        });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('succeeded');
    });

    // Regression: https://github.com/ttoss/soat/issues/379 — a `loop` node
    // anywhere in the graph blanket-exempted cycle detection, so a totally
    // unrelated cycle between non-loop nodes (`a -> b -> a`) slipped through
    // both create-time and runtime validation.
    test('a loop node does not exempt an unrelated cycle among non-loop nodes', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Loop Plus Unrelated Cycle',
          nodes: [
            {
              id: 'loop',
              type: 'loop',
              orchestration_id: subOrchId,
              collection: 'state.items',
              item_variable: 'item',
            },
            { id: 'a', type: 'transform', expression: 1 },
            { id: 'b', type: 'transform', expression: 1 },
          ],
          edges: [
            { from: 'a', to: 'b' },
            { from: 'b', to: 'a' },
          ],
          project_id: projectId,
        });
      expect(createRes.status).toBe(400);
      expect(createRes.body.error.code).toBe('ORCHESTRATION_VALIDATION_FAILED');
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
              input_mapping: { item: { var: 'input.value' } },
              // The node's artifact is the child run's output
              // ({ terminalNodeId: artifact }), so the item surfaces at
              // output.pass.result.
              state_mapping: {
                'state.subResult': { var: 'output.pass.result' },
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
          wait: true,
          orchestration_id: createRes.body.id,
          input: { value: 'test' },
        });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('succeeded');
      expect(runRes.body.state.subResult).toBe('test');
    });

    test('poll node missing required fields is rejected at create', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Poll Incomplete',
          nodes: [{ id: 'poll', type: 'poll' }],
          edges: [],
          project_id: projectId,
        });
      expect(createRes.status).toBe(400);
      expect(createRes.body.error.code).toBe('ORCHESTRATION_VALIDATION_FAILED');
    });

    test('poll node completes when the exit condition is met', async () => {
      const spy = jest
        .spyOn(toolsModule, 'callTool')
        .mockResolvedValue({ status: 'completed' });
      try {
        const createRes = await authenticatedTestClient(userToken)
          .post('/api/v1/orchestrations')
          .send({
            name: 'Poll Until Done',
            nodes: [
              {
                id: 'wait',
                type: 'poll',
                tool_id: 'tool_status',
                interval: '0s',
                exit_condition: {
                  '==': [{ var: 'response.status' }, 'completed'],
                },
                state_mapping: {
                  'state.done': { var: 'output.conditionMet' },
                  'state.final': { var: 'output.result' },
                },
              },
            ],
            edges: [],
            project_id: projectId,
          });
        expect(createRes.status).toBe(201);

        const runRes = await authenticatedTestClient(userToken)
          .post('/api/v1/orchestration-runs')
          .send({ wait: true, orchestration_id: createRes.body.id, input: {} });
        expect(runRes.status).toBe(201);
        expect(runRes.body.status).toBe('succeeded');
        expect(runRes.body.state.done).toBe(true);
        expect(runRes.body.state.final).toEqual({ status: 'completed' });
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });

    test('poll node times out without failing when the condition never holds', async () => {
      const spy = jest
        .spyOn(toolsModule, 'callTool')
        .mockResolvedValue({ status: 'pending' });
      try {
        const createRes = await authenticatedTestClient(userToken)
          .post('/api/v1/orchestrations')
          .send({
            name: 'Poll Times Out',
            nodes: [
              {
                id: 'wait',
                type: 'poll',
                tool_id: 'tool_status',
                interval: '0s',
                max_iterations: 2,
                exit_condition: {
                  '==': [{ var: 'response.status' }, 'completed'],
                },
                state_mapping: { 'state.done': { var: 'output.conditionMet' } },
              },
            ],
            edges: [],
            project_id: projectId,
          });
        expect(createRes.status).toBe(201);

        const runRes = await authenticatedTestClient(userToken)
          .post('/api/v1/orchestration-runs')
          .send({ wait: true, orchestration_id: createRes.body.id, input: {} });
        expect(runRes.status).toBe(201);
        expect(runRes.body.status).toBe('succeeded');
        expect(runRes.body.state.done).toBe(false);
        expect(spy).toHaveBeenCalledTimes(2);
      } finally {
        spy.mockRestore();
      }
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
        .send({ wait: true, orchestration_id: failOrchId, input: {} });
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
        .send({ wait: true, orchestration_id: pauseOrchId, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('awaiting_input');
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
        .send({ wait: true, orchestration_id: edgeOrchId, input: {} });
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
        .send({ wait: true, orchestration_id: createRes.body.id, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('succeeded');

      const submitRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestration-runs/${runRes.body.id}/human-input`)
        .send({ node_id: 'A', output: { val: 1 } });
      expect(submitRes.status).toBe(409);
    });
  });

  describe('Skipped node executions', () => {
    test('records unreached branch nodes with status "skipped"', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          project_id: projectId,
          name: 'cond-skip-test',
          nodes: [
            {
              id: 'check',
              type: 'condition',
              expression: {
                if: [{ '>': [{ var: 'input.score' }, 0.8] }, 'high', 'low'],
              },
            },
            {
              id: 'high_path',
              type: 'transform',
              expression: 'high-ran',
              state_mapping: { 'state.high': { var: 'output.result' } },
            },
            {
              id: 'low_path',
              type: 'transform',
              expression: 'low-ran',
              state_mapping: { 'state.low': { var: 'output.result' } },
            },
          ],
          edges: [
            { from: 'check', to: 'high_path', condition: 'high' },
            { from: 'check', to: 'low_path', condition: 'low' },
          ],
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({
          wait: true,
          orchestration_id: createRes.body.id,
          input: { score: 0.9 },
        });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('succeeded');

      const execs: Array<{
        node_id: string;
        status: string;
        output: unknown;
        started_at: unknown;
      }> = runRes.body.node_executions;

      const highExec = execs.find((e) => {
        return e.node_id === 'high_path';
      });
      expect(highExec?.status).toBe('completed');

      const lowExec = execs.find((e) => {
        return e.node_id === 'low_path';
      });
      expect(lowExec).toBeDefined();
      expect(lowExec?.status).toBe('skipped');
      expect(lowExec?.output).toBeNull();
      expect(lowExec?.started_at).toBeNull();
    });
  });

  // ── Human node execution record is finalized on resume (#384) ─────────────

  describe('Human node execution record after resume', () => {
    test("the human node's own node_executions entry is updated to completed, not left as requires_action", async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          project_id: projectId,
          name: 'human-resume-record-test',
          nodes: [
            {
              id: 'review',
              type: 'human',
              prompt: 'Approve?',
              options: ['approve', 'reject'],
            },
            {
              id: 'after_review',
              type: 'transform',
              expression: { var: 'state.review.decision' },
              state_mapping: { 'state.decision': { var: 'output.result' } },
            },
          ],
          edges: [{ from: 'review', to: 'after_review' }],
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({
          wait: true,
          orchestration_id: createRes.body.id,
          input: {},
        });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('awaiting_input');
      const runId = runRes.body.id;

      const pausedExecs: Array<{ node_id: string; status: string }> =
        runRes.body.node_executions;
      const pausedReviewExec = pausedExecs.find((e) => {
        return e.node_id === 'review';
      });
      expect(pausedReviewExec?.status).toBe('requires_action');

      const submitRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/orchestration-runs/${runId}/human-input`)
        .send({ node_id: 'review', output: { decision: 'approve' } });
      expect(submitRes.status).toBe(200);
      expect(submitRes.body.status).toBe('succeeded');

      const finalRes = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestration-runs/${runId}`
      );
      expect(finalRes.status).toBe(200);
      expect(finalRes.body.status).toBe('succeeded');

      const finalExecs: Array<{
        node_id: string;
        status: string;
        output: unknown;
        completed_at: unknown;
      }> = finalRes.body.node_executions;
      const reviewExecs = finalExecs.filter((e) => {
        return e.node_id === 'review';
      });

      // Exactly one execution record for the node — the original
      // requires_action record was updated in place, not duplicated.
      expect(reviewExecs).toHaveLength(1);
      expect(reviewExecs[0].status).toBe('completed');
      expect(reviewExecs[0].output).toEqual({ decision: 'approve' });
      expect(reviewExecs[0].completed_at).not.toBeNull();
    });
  });

  // ── Durable background execution ──────────────────────────────────────────

  describe('Durable background execution', () => {
    const getRun = (runId: string) => {
      return authenticatedTestClient(userToken).get(
        `/api/v1/orchestration-runs/${runId}`
      );
    };

    const sleep = (ms: number) => {
      return new Promise<void>((resolve) => {
        return setTimeout(resolve, ms);
      });
    };

    // Polls the run until one of `statuses` is observed, or fails after a bound.
    const waitForStatus = async (
      runId: string,
      statuses: string[]
    ): Promise<Record<string, unknown>> => {
      for (let i = 0; i < 100; i += 1) {
        const res = await getRun(runId);
        if (statuses.includes(res.body.status as string)) {
          return res.body as Record<string, unknown>;
        }
        await sleep(20);
      }
      throw new Error(`run ${runId} never reached ${statuses.join('/')}`);
    };

    // Polls the run until it is parked on the given node. A timer wait parks the
    // run as `sleeping`, a human node as `awaiting_input`; `running` covers the
    // brief transient window before it parks.
    const waitForActiveNode = async (
      runId: string,
      nodeId: string
    ): Promise<void> => {
      for (let i = 0; i < 100; i += 1) {
        const res = await getRun(runId);
        const active = (res.body.active_nodes ?? []) as string[];
        if (
          ['running', 'sleeping', 'awaiting_input'].includes(res.body.status) &&
          active.includes(nodeId)
        ) {
          return;
        }
        if (['succeeded', 'failed', 'cancelled'].includes(res.body.status)) {
          throw new Error(
            `run ${runId} settled as ${res.body.status} before waiting on ${nodeId}`
          );
        }
        await sleep(20);
      }
      throw new Error(`run ${runId} never waited on ${nodeId}`);
    };

    const createOrchestration = async (body: Record<string, unknown>) => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({ ...body, project_id: projectId });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };

    test('start-run returns immediately with status queued (async default)', async () => {
      const orchId = await createOrchestration({
        name: 'Async Simple',
        nodes: [
          {
            id: 'start',
            type: 'transform',
            expression: 'hello',
            state_mapping: { 'state.msg': { var: 'output.result' } },
          },
        ],
        edges: [],
      });

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: orchId, input: {} });
      expect(runRes.status).toBe(201);
      // Async default: the run is enqueued, not driven inside the request.
      expect(runRes.body.status).toBe('queued');

      const settled = await waitForStatus(runRes.body.id as string, [
        'succeeded',
      ]);
      expect((settled.state as Record<string, unknown>).msg).toBe('hello');
    });

    test('a delay run survives without an in-process timer and completes via the scheduler', async () => {
      const orchId = await createOrchestration({
        name: 'Async Delay',
        nodes: [
          {
            id: 'delay',
            type: 'delay',
            duration: '1s',
            state_mapping: { 'state.waited': { var: 'output.waited' } },
          },
          {
            id: 'after',
            type: 'transform',
            expression: 'done',
            state_mapping: { 'state.after': { var: 'output.result' } },
          },
        ],
        edges: [{ from: 'delay', to: 'after' }],
      });

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: orchId, input: {} });
      expect(runRes.status).toBe(201);
      expect(runRes.body.status).toBe('queued');
      const runId = runRes.body.id as string;

      // The run parks on the delay node with its wake persisted — no in-process
      // timer is holding it (simulating a fresh process after a restart, since
      // the scheduler interval is disabled under test).
      await waitForActiveNode(runId, 'delay');

      // A timer-parked run is `sleeping` (holds no worker), not `running`.
      const parked = await getRun(runId);
      expect(parked.body.status).toBe('sleeping');

      // Nothing wakes it until the scheduler picks up the due run.
      const claimed = await wakeDueRuns({
        now: new Date(Date.now() + 5000),
      });
      expect(claimed).toBeGreaterThanOrEqual(1);

      const settled = await waitForStatus(runId, ['succeeded']);
      expect((settled.state as Record<string, unknown>).waited).toBe('1s');
      expect((settled.state as Record<string, unknown>).after).toBe('done');
    });

    test('poll does not hold the request open between attempts', async () => {
      const spy = jest
        .spyOn(toolsModule, 'callTool')
        .mockResolvedValueOnce({ status: 'pending' })
        .mockResolvedValue({ status: 'completed' });
      try {
        const orchId = await createOrchestration({
          name: 'Async Poll',
          nodes: [
            {
              id: 'wait',
              type: 'poll',
              tool_id: 'tool_status',
              interval: '1s',
              max_iterations: 5,
              exit_condition: {
                '==': [{ var: 'response.status' }, 'completed'],
              },
              state_mapping: { 'state.done': { var: 'output.conditionMet' } },
            },
          ],
          edges: [],
        });

        const runRes = await authenticatedTestClient(userToken)
          .post('/api/v1/orchestration-runs')
          .send({ orchestration_id: orchId, input: {} });
        expect(runRes.status).toBe(201);
        expect(runRes.body.status).toBe('queued');
        const runId = runRes.body.id as string;

        // First attempt was pending, so the run parks between attempts instead
        // of blocking; only one tool call has happened so far.
        await waitForActiveNode(runId, 'wait');
        expect(spy).toHaveBeenCalledTimes(1);

        // The scheduler drives the next attempt, which meets the condition.
        await wakeDueRuns({ now: new Date(Date.now() + 5000) });

        const settled = await waitForStatus(runId, ['succeeded']);
        expect((settled.state as Record<string, unknown>).done).toBe(true);
        expect(spy).toHaveBeenCalledTimes(2);
      } finally {
        spy.mockRestore();
      }
    });

    test('emits run lifecycle webhook events', async () => {
      const captured: SoatEvent[] = [];
      const listener = (event: SoatEvent) => {
        if (event.type.startsWith('orchestration_runs.')) captured.push(event);
      };
      eventBus.on('soat:event', listener);
      try {
        const orchId = await createOrchestration({
          name: 'Lifecycle Events',
          nodes: [
            {
              id: 'start',
              type: 'transform',
              expression: 'ok',
              state_mapping: { 'state.msg': { var: 'output.result' } },
            },
          ],
          edges: [],
        });

        const runRes = await authenticatedTestClient(userToken)
          .post('/api/v1/orchestration-runs')
          .send({ orchestration_id: orchId, input: {} });
        const runId = runRes.body.id as string;

        await waitForStatus(runId, ['succeeded']);

        // Events resolve the project public ID asynchronously, so give them a
        // moment to flush.
        for (let i = 0; i < 50; i += 1) {
          const types = captured
            .filter((e) => {
              return e.resourceId === runId;
            })
            .map((e) => {
              return e.type;
            });
          if (
            types.includes('orchestration_runs.started') &&
            types.includes('orchestration_runs.succeeded')
          ) {
            break;
          }
          await sleep(20);
        }

        const types = captured
          .filter((e) => {
            return e.resourceId === runId;
          })
          .map((e) => {
            return e.type;
          });
        expect(types).toContain('orchestration_runs.started');
        expect(types).toContain('orchestration_runs.succeeded');
      } finally {
        eventBus.off('soat:event', listener);
      }
    });

    // Simulates a run whose driver crashed mid-execution: a `running` row with an
    // expired lease and no fresh worker. The reaper must reclaim and finish it.
    const createOrphanedRun = async (orchestrationPublicId: string) => {
      const orch = await db.Orchestration.findOne({
        where: { publicId: orchestrationPublicId },
      });
      const project = await db.Project.findOne({
        where: { publicId: projectId },
      });
      return db.OrchestrationRun.create({
        orchestrationId: orch?.id as number,
        projectId: project?.id as number,
        status: 'running',
        state: {},
        activeNodes: [],
        artifacts: {},
        input: {},
        startedAt: new Date(),
        // Lease already expired → the driver stopped refreshing it (crashed).
        leaseExpiresAt: new Date(Date.now() - 60_000),
      });
    };

    test('the reaper reclaims an orphaned running run and drives it to completion', async () => {
      const orchId = await createOrchestration({
        name: 'Orphan Recovery',
        nodes: [
          {
            id: 'start',
            type: 'transform',
            expression: 'hello',
            state_mapping: { 'state.msg': { var: 'output.result' } },
          },
          {
            id: 'after',
            type: 'transform',
            expression: 'done',
            state_mapping: { 'state.after': { var: 'output.result' } },
          },
        ],
        edges: [{ from: 'start', to: 'after' }],
      });
      const orphan = await createOrphanedRun(orchId);

      const claimed = await reapOrphanedRuns({ now: new Date() });
      expect(claimed).toBeGreaterThanOrEqual(1);

      const settled = await waitForStatus(orphan.publicId as string, [
        'succeeded',
      ]);
      expect((settled.state as Record<string, unknown>).msg).toBe('hello');
      expect((settled.state as Record<string, unknown>).after).toBe('done');
    });

    test('the reaper does not reclaim a running run whose lease is still fresh', async () => {
      const orchId = await createOrchestration({
        name: 'Fresh Lease',
        nodes: [
          {
            id: 'start',
            type: 'transform',
            expression: 'hi',
            state_mapping: { 'state.msg': { var: 'output.result' } },
          },
        ],
        edges: [],
      });
      const orch = await db.Orchestration.findOne({
        where: { publicId: orchId },
      });
      const project = await db.Project.findOne({
        where: { publicId: projectId },
      });
      const healthy = await db.OrchestrationRun.create({
        orchestrationId: orch?.id as number,
        projectId: project?.id as number,
        status: 'running',
        state: {},
        activeNodes: [],
        artifacts: {},
        input: {},
        startedAt: new Date(),
        // Lease still valid → a live driver is holding it.
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });

      await reapOrphanedRuns({ now: new Date() });

      const after = await getRun(healthy.publicId as string);
      expect(after.body.status).toBe('running');
    });

    // ── Per-node retry policy ────────────────────────────────────────────────

    const callExecsOf = (run: Record<string, unknown>, nodeId: string) => {
      return (run.node_executions as Array<Record<string, unknown>>).filter(
        (e) => {
          return e.node_id === nodeId;
        }
      );
    };

    const startAsyncRun = async (orchId: string) => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: orchId, input: {} });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };

    test('retries a transient node failure and completes the run', async () => {
      const spy = jest
        .spyOn(toolsModule, 'callTool')
        .mockRejectedValueOnce(new Error('transient upstream error'))
        .mockResolvedValue({ ok: true });
      try {
        const orchId = await createOrchestration({
          name: 'Retry Transient',
          nodes: [
            {
              id: 'call',
              type: 'tool',
              tool_id: 'tool_x',
              retry: { max_attempts: 2, backoff: { delay_ms: 1000 } },
            },
          ],
          edges: [],
        });
        const runId = await startAsyncRun(orchId);

        // First attempt failed → the run parks as `sleeping` on the retry wait.
        await waitForActiveNode(runId, 'call');
        expect((await getRun(runId)).body.status).toBe('sleeping');

        // The scheduler drives the retry, which succeeds.
        await wakeDueRuns({ now: new Date(Date.now() + 5000) });
        const settled = await waitForStatus(runId, ['succeeded']);

        const execs = callExecsOf(settled, 'call');
        expect(execs).toHaveLength(2);
        expect(execs[0]).toMatchObject({ attempt: 1, status: 'failed' });
        expect(execs[1]).toMatchObject({ attempt: 2, status: 'completed' });
        expect(spy).toHaveBeenCalledTimes(2);
      } finally {
        spy.mockRestore();
      }
    });

    test('fails the run after exhausting the attempt budget', async () => {
      const spy = jest
        .spyOn(toolsModule, 'callTool')
        .mockRejectedValue(new Error('always down'));
      try {
        const orchId = await createOrchestration({
          name: 'Retry Exhausted',
          nodes: [
            {
              id: 'call',
              type: 'tool',
              tool_id: 'tool_x',
              retry: { max_attempts: 2, backoff: { delay_ms: 1000 } },
            },
          ],
          edges: [],
        });
        const runId = await startAsyncRun(orchId);

        await waitForActiveNode(runId, 'call');
        await wakeDueRuns({ now: new Date(Date.now() + 5000) });
        const settled = await waitForStatus(runId, ['failed']);

        const execs = callExecsOf(settled, 'call');
        expect(execs).toHaveLength(2);
        expect(
          execs.every((e) => {
            return e.status === 'failed';
          })
        ).toBe(true);
        expect(spy).toHaveBeenCalledTimes(2);
      } finally {
        spy.mockRestore();
      }
    });

    test('a terminal (4xx) error fails immediately without retrying', async () => {
      const spy = jest
        .spyOn(toolsModule, 'callTool')
        .mockRejectedValue(new DomainError('RESOURCE_NOT_FOUND', 'gone'));
      try {
        const orchId = await createOrchestration({
          name: 'Retry Terminal',
          nodes: [
            {
              id: 'call',
              type: 'tool',
              tool_id: 'tool_x',
              retry: { max_attempts: 5, backoff: { delay_ms: 1000 } },
            },
          ],
          edges: [],
        });
        // wait:true is safe here — a terminal error never parks, so nothing sleeps.
        const res = await authenticatedTestClient(userToken)
          .post('/api/v1/orchestration-runs')
          .send({ wait: true, orchestration_id: orchId, input: {} });
        expect(res.status).toBe(201);
        expect(res.body.status).toBe('failed');

        const execs = callExecsOf(res.body, 'call');
        expect(execs).toHaveLength(1);
        expect(execs[0]).toMatchObject({ attempt: 1, status: 'failed' });
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
