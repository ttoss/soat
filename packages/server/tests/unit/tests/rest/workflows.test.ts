import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

const SIMPLE_STATES = [
  { name: 'triage', initial: true },
  { name: 'draft' },
  { name: 'review', kind: 'human' },
  { name: 'published', terminal: true },
];

const SIMPLE_TRANSITIONS = [
  { name: 'to_draft', from: ['triage', 'review'], to: 'draft' },
  { name: 'to_review', from: ['triage', 'draft'], to: 'review' },
  {
    name: 'publish',
    from: ['review'],
    to: 'published',
    guard: { '==': [{ var: 'task.payload.approved' }, true] },
  },
];

describe('Workflows', () => {
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let projectId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'workflows',
      policyActions: [
        'workflows:CreateWorkflow',
        'workflows:ListWorkflows',
        'workflows:GetWorkflow',
        'workflows:UpdateWorkflow',
        'workflows:DeleteWorkflow',
        'tasks:CreateTask',
        'tasks:DeleteTask',
        'tasks:TransitionTask',
        'tasks:GetTask',
      ],
      createNoPermUser: true,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;
  });

  const createWorkflow = (token: string, overrides: object = {}) => {
    return authenticatedTestClient(token)
      .post('/api/v1/workflows')
      .send({
        project_id: projectId,
        name: `wf-${Math.random().toString(36).slice(2)}`,
        states: SIMPLE_STATES,
        transitions: SIMPLE_TRANSITIONS,
        ...overrides,
      });
  };

  describe('POST /api/v1/workflows', () => {
    test('creates a workflow and exposes id as publicId', async () => {
      const res = await createWorkflow(userToken, { name: 'content-pipeline' });
      expect(res.status).toBe(201);
      expect(res.body.id).toMatch(/^wfl_/);
      expect(res.body.project_id).toBe(projectId);
      expect(res.body.name).toBe('content-pipeline');
      expect(res.body.states).toHaveLength(4);
      // The guard round-trips verbatim (JSON Logic body is not case-transformed).
      const publish = res.body.transitions.find((t: { name: string }) => {
        return t.name === 'publish';
      });
      expect(publish.guard).toEqual({
        '==': [{ var: 'task.payload.approved' }, true],
      });
    });

    test('rejects a definition with no initial state', async () => {
      const res = await createWorkflow(userToken, {
        states: [{ name: 'a' }, { name: 'b' }],
        transitions: [{ name: 'go', from: ['a'], to: 'b' }],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('WORKFLOW_VALIDATION_FAILED');
    });

    test('rejects a transition referencing an unknown state', async () => {
      const res = await createWorkflow(userToken, {
        states: [{ name: 'a', initial: true }],
        transitions: [{ name: 'go', from: ['a'], to: 'ghost' }],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('WORKFLOW_VALIDATION_FAILED');
    });

    test('rejects a duplicate name in the same project', async () => {
      await createWorkflow(adminToken, { name: 'dup-wf' });
      const res = await createWorkflow(adminToken, { name: 'dup-wf' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('NAME_CONFLICT');
    });

    test('401 for unauthenticated requests', async () => {
      const res = await testClient.post('/api/v1/workflows').send({
        project_id: projectId,
        name: 'nope',
        states: SIMPLE_STATES,
        transitions: SIMPLE_TRANSITIONS,
      });
      expect(res.status).toBe(401);
    });

    test('403 for a user without permission', async () => {
      const res = await createWorkflow(noPermToken);
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/v1/workflows', () => {
    test('lists workflows in the project', async () => {
      await createWorkflow(userToken);
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/workflows?project_id=${projectId}`
      );
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
    });

    test('404 for an unknown workflow', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/workflows/wfl_missing'
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('WORKFLOW_NOT_FOUND');
    });

    test('401 for unauthenticated list requests', async () => {
      const res = await testClient.get(
        `/api/v1/workflows?project_id=${projectId}`
      );
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/workflows/:id', () => {
    test('401 for unauthenticated requests', async () => {
      const created = (await createWorkflow(userToken)).body;
      const res = await testClient.get(`/api/v1/workflows/${created.id}`);
      expect(res.status).toBe(401);
    });

    test('returns a single workflow to a permitted user', async () => {
      const created = (await createWorkflow(userToken, { name: 'get-one' }))
        .body;
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/workflows/${created.id}`
      );
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(created.id);
      expect(res.body.name).toBe('get-one');
    });

    test('403 for a user without permission', async () => {
      const created = (await createWorkflow(userToken)).body;
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/workflows/${created.id}`
      );
      expect(res.status).toBe(403);
    });
  });

  describe('PATCH /api/v1/workflows/:id', () => {
    test('updates name and re-validates structural changes', async () => {
      const created = (await createWorkflow(userToken)).body;
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/workflows/${created.id}`)
        .send({ description: 'now documented' });
      expect(res.status).toBe(200);
      expect(res.body.description).toBe('now documented');
    });

    test('renames a workflow to a new unique name', async () => {
      const created = (await createWorkflow(userToken)).body;
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/workflows/${created.id}`)
        .send({ name: `renamed-${Math.random().toString(36).slice(2)}` });
      expect(res.status).toBe(200);
      expect(res.body.name).toMatch(/^renamed-/);
    });

    test('rejects a rename that collides with an existing name', async () => {
      await createWorkflow(adminToken, { name: 'taken-name' });
      const created = (await createWorkflow(adminToken)).body;
      const res = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/workflows/${created.id}`)
        .send({ name: 'taken-name' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('NAME_CONFLICT');
    });

    test('replaces the payload_schema', async () => {
      const created = (await createWorkflow(userToken)).body;
      const schema = { properties: { topic: { type: 'string' } } };
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/workflows/${created.id}`)
        .send({ payload_schema: schema });
      expect(res.status).toBe(200);
      expect(res.body.payload_schema).toEqual(schema);
    });

    test('re-validates a structural change and persists new states', async () => {
      const created = (await createWorkflow(userToken)).body;
      const nextStates = [
        { name: 'open', initial: true },
        { name: 'closed', terminal: true },
      ];
      const nextTransitions = [
        { name: 'finish', from: ['open'], to: 'closed' },
      ];
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/workflows/${created.id}`)
        .send({ states: nextStates, transitions: nextTransitions });
      expect(res.status).toBe(200);
      expect(res.body.states).toHaveLength(2);
      expect(res.body.transitions).toHaveLength(1);
    });

    test('rejects a structurally-invalid update', async () => {
      const created = (await createWorkflow(userToken)).body;
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/workflows/${created.id}`)
        .send({ states: [{ name: 'solo' }] }); // no initial
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('WORKFLOW_VALIDATION_FAILED');
    });

    test('404 for an unknown workflow', async () => {
      const res = await authenticatedTestClient(userToken)
        .patch('/api/v1/workflows/wfl_missing')
        .send({ description: 'x' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('WORKFLOW_NOT_FOUND');
    });

    test('403 for a user without permission', async () => {
      const created = (await createWorkflow(userToken)).body;
      const res = await authenticatedTestClient(noPermToken)
        .patch(`/api/v1/workflows/${created.id}`)
        .send({ description: 'x' });
      expect(res.status).toBe(403);
    });

    test('401 for unauthenticated requests', async () => {
      const created = (await createWorkflow(userToken)).body;
      const res = await testClient
        .patch(`/api/v1/workflows/${created.id}`)
        .send({ description: 'x' });
      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /api/v1/workflows/:id', () => {
    test('404 for an unknown workflow', async () => {
      const res = await authenticatedTestClient(userToken).delete(
        '/api/v1/workflows/wfl_missing'
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('WORKFLOW_NOT_FOUND');
    });

    test('403 for a user without permission', async () => {
      const created = (await createWorkflow(userToken)).body;
      const res = await authenticatedTestClient(noPermToken).delete(
        `/api/v1/workflows/${created.id}`
      );
      expect(res.status).toBe(403);
    });

    test('401 for unauthenticated requests', async () => {
      const created = (await createWorkflow(userToken)).body;
      const res = await testClient.delete(`/api/v1/workflows/${created.id}`);
      expect(res.status).toBe(401);
    });

    test('deletes a workflow with no tasks', async () => {
      const created = (await createWorkflow(userToken)).body;
      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/workflows/${created.id}`
      );
      expect(res.status).toBe(204);
    });

    test('rejects deletion while an open task exists', async () => {
      const created = (await createWorkflow(userToken)).body;
      const task = await authenticatedTestClient(userToken)
        .post('/api/v1/tasks')
        .send({ project_id: projectId, workflow_id: created.id, title: 't' });
      expect(task.status).toBe(201);

      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/workflows/${created.id}`
      );
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('WORKFLOW_HAS_OPEN_TASKS');
    });

    test('deletes a workflow once its only task is closed (no bare 500) (#604)', async () => {
      // Minimal workflow with a direct terminal transition so the task can be
      // closed without satisfying the SIMPLE_TRANSITIONS publish guard.
      const created = (
        await createWorkflow(userToken, {
          states: [
            { name: 'a', initial: true },
            { name: 'z', terminal: true },
          ],
          transitions: [{ name: 'finish', from: ['a'], to: 'z' }],
        })
      ).body;

      const task = await authenticatedTestClient(userToken)
        .post('/api/v1/tasks')
        .send({ project_id: projectId, workflow_id: created.id, title: 't' });
      expect(task.status).toBe(201);

      // Close the task by transitioning it into the terminal state.
      const transition = await authenticatedTestClient(userToken)
        .post(`/api/v1/tasks/${task.body.id}/transitions`)
        .send({ transition: 'finish' });
      expect(transition.status).toBe(200);
      expect(transition.body.status).toBe('closed');

      // Deleting now must succeed (not a bare 500 from the FK constraint).
      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/workflows/${created.id}`
      );
      expect(res.status).toBe(204);

      // Workflow is gone, and its closed task cascaded away with it.
      const getWf = await authenticatedTestClient(userToken).get(
        `/api/v1/workflows/${created.id}`
      );
      expect(getWf.status).toBe(404);

      const getTask = await authenticatedTestClient(userToken).get(
        `/api/v1/tasks/${task.body.id}`
      );
      expect(getTask.status).toBe(404);
    });
  });
});
