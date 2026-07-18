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

    test('rejects a structurally-invalid update', async () => {
      const created = (await createWorkflow(userToken)).body;
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/workflows/${created.id}`)
        .send({ states: [{ name: 'solo' }] }); // no initial
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('WORKFLOW_VALIDATION_FAILED');
    });
  });

  describe('DELETE /api/v1/workflows/:id', () => {
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
  });
});
