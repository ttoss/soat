import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

describe('Orchestration run depth', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;

  const createOrchestration = async (body: Record<string, unknown>) => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/orchestrations')
      .send({ project_id: projectId, edges: [], ...body });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const replaceGraph = async (args: {
    orchestrationId: string;
    nodes: Record<string, unknown>[];
    edges?: Record<string, unknown>[];
  }) => {
    const res = await authenticatedTestClient(userToken)
      .patch(`/api/v1/orchestrations/${args.orchestrationId}`)
      .send({ nodes: args.nodes, edges: args.edges ?? [] });
    expect(res.status).toBe(200);
  };

  const startRun = async (orchestrationId: string) => {
    return authenticatedTestClient(userToken)
      .post('/api/v1/orchestration-runs')
      .send({ wait: true, orchestration_id: orchestrationId, input: {} });
  };

  const setProjectRunDepth = async (maxRunDepth: number | null) => {
    const res = await authenticatedTestClient(adminToken)
      .patch(`/api/v1/projects/${projectId}`)
      .send({ max_run_depth: maxRunDepth });
    expect(res.status).toBe(200);
  };

  const passThroughNode = {
    id: 'pass',
    type: 'transform',
    expression: { var: 'input.item' },
    state_mapping: { 'state.result': { var: 'output.result' } },
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'rundepth',
      policyActions: [
        'orchestrations:CreateOrchestration',
        'orchestrations:GetOrchestration',
        'orchestrations:UpdateOrchestration',
        'orchestrations:StartRun',
        'orchestrations:ListRuns',
        'orchestrations:GetRun',
      ],
      createNoPermUser: false,
    });

    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
  });

  describe('the bound', () => {
    afterEach(async () => {
      await setProjectRunDepth(null);
    });

    test('a self-referencing sub_orchestration graph fails naming the depth bound', async () => {
      const orchestrationId = await createOrchestration({
        name: 'Self Referencing',
        nodes: [passThroughNode],
      });

      // The self-reference can only be introduced by an update: at create time
      // the graph has no id to name yet.
      await replaceGraph({
        orchestrationId,
        nodes: [
          {
            id: 'recurse',
            type: 'sub_orchestration',
            orchestration_id: orchestrationId,
          },
        ],
      });

      const run = await startRun(orchestrationId);
      expect(run.status).toBe(201);
      expect(run.body.status).toBe('failed');
      expect(run.body.error.code).toBe('ORCHESTRATION_RUN_DEPTH_LIMIT');
      expect(run.body.error.message).toMatch(/nesting depth 11.*limit of 10/);
      expect(run.body.run_depth).toBe(0);
    });

    test('a cycle spanning two graphs fails the same way', async () => {
      const secondId = await createOrchestration({
        name: 'Cycle Second',
        nodes: [passThroughNode],
      });
      const firstId = await createOrchestration({
        name: 'Cycle First',
        nodes: [
          { id: 'down', type: 'sub_orchestration', orchestration_id: secondId },
        ],
      });
      await replaceGraph({
        orchestrationId: secondId,
        nodes: [
          { id: 'back', type: 'sub_orchestration', orchestration_id: firstId },
        ],
      });

      const run = await startRun(firstId);
      expect(run.status).toBe(201);
      expect(run.body.status).toBe('failed');
      expect(run.body.error.code).toBe('ORCHESTRATION_RUN_DEPTH_LIMIT');
    });

    test('a self-referencing loop graph fails the same way', async () => {
      const orchestrationId = await createOrchestration({
        name: 'Self Referencing Loop',
        nodes: [passThroughNode],
      });
      // One item per level: a loop fans out, so a wider collection would make
      // the tree exponential in the bound rather than linear in it.
      await replaceGraph({
        orchestrationId,
        nodes: [
          {
            id: 'fan',
            type: 'transform',
            // `merge` is how JSON Logic spells a literal list; the loop needs a
            // one-item collection regenerated at every level.
            expression: { merge: [[1]] },
            state_mapping: { 'state.items': { var: 'output.result' } },
          },
          {
            id: 'recurse',
            type: 'loop',
            orchestration_id: orchestrationId,
            collection: 'state.items',
          },
        ],
        edges: [{ from: 'fan', to: 'recurse' }],
      });

      const run = await startRun(orchestrationId);
      expect(run.status).toBe(201);
      expect(run.body.status).toBe('failed');
      expect(run.body.error.code).toBe('ORCHESTRATION_RUN_DEPTH_LIMIT');
    });

    test("the project's own bound narrows the deployment one", async () => {
      const childId = await createOrchestration({
        name: 'Narrowed Child',
        nodes: [passThroughNode],
      });
      const parentId = await createOrchestration({
        name: 'Narrowed Parent',
        nodes: [
          { id: 'down', type: 'sub_orchestration', orchestration_id: childId },
        ],
      });
      const grandparentId = await createOrchestration({
        name: 'Narrowed Grandparent',
        nodes: [
          { id: 'down', type: 'sub_orchestration', orchestration_id: parentId },
        ],
      });

      await setProjectRunDepth(1);

      const allowed = await startRun(parentId);
      expect(allowed.status).toBe(201);
      expect(allowed.body.status).toBe('succeeded');

      const refused = await startRun(grandparentId);
      expect(refused.status).toBe(201);
      expect(refused.body.status).toBe('failed');
      expect(refused.body.error.code).toBe('ORCHESTRATION_RUN_DEPTH_LIMIT');
      expect(refused.body.error.message).toMatch(/limit of 1/);
    });

    test('a legitimate deep composition is unaffected', async () => {
      let currentId = await createOrchestration({
        name: 'Deep Leaf',
        nodes: [passThroughNode],
      });

      for (let level = 0; level < 5; level += 1) {
        currentId = await createOrchestration({
          name: `Deep Level ${level}`,
          nodes: [
            {
              id: 'down',
              type: 'sub_orchestration',
              orchestration_id: currentId,
            },
          ],
        });
      }

      const run = await startRun(currentId);
      expect(run.status).toBe(201);
      expect(run.body.status).toBe('succeeded');
    });
  });

  describe('run_depth on the run', () => {
    test('is 0 for a caller-started run and 1 for its child', async () => {
      const childId = await createOrchestration({
        name: 'Depth Field Child',
        nodes: [passThroughNode],
      });
      const parentId = await createOrchestration({
        name: 'Depth Field Parent',
        nodes: [
          { id: 'down', type: 'sub_orchestration', orchestration_id: childId },
        ],
      });

      const run = await startRun(parentId);
      expect(run.status).toBe(201);
      expect(run.body.status).toBe('succeeded');
      expect(run.body.run_depth).toBe(0);

      const children = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestration-runs?parent_orchestration_run_id=${run.body.id}`
      );
      expect(children.status).toBe(200);
      expect(children.body.data).toHaveLength(1);
      expect(children.body.data[0].run_depth).toBe(1);
    });
  });

  describe('PATCH /api/v1/projects/{project_id} max_run_depth', () => {
    test('defaults to null, and an admin can set and clear it', async () => {
      const initial = await authenticatedTestClient(adminToken).get(
        `/api/v1/projects/${projectId}`
      );
      expect(initial.status).toBe(200);
      expect(initial.body.max_run_depth).toBeNull();

      const set = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/projects/${projectId}`)
        .send({ max_run_depth: 3 });
      expect(set.status).toBe(200);
      expect(set.body.max_run_depth).toBe(3);

      const cleared = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/projects/${projectId}`)
        .send({ max_run_depth: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.max_run_depth).toBeNull();
    });

    test.each([0, -1, 2.5])(
      'rejects max_run_depth %p with 400',
      async (value) => {
        const res = await authenticatedTestClient(adminToken)
          .patch(`/api/v1/projects/${projectId}`)
          .send({ max_run_depth: value });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
      }
    );

    test('a non-admin cannot set max_run_depth', async () => {
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/projects/${projectId}`)
        .send({ max_run_depth: 5 });
      expect(res.status).toBe(403);
    });
  });
});
