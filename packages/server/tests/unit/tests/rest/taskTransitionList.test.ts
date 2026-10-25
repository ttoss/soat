import { flushTaskAutomations } from 'src/lib/tasks';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

const STATES = [
  { name: 'triage', initial: true },
  { name: 'review' },
  { name: 'published', terminal: true },
];

const TRANSITIONS = [
  { name: 'to_review', from: ['triage'], to: 'review' },
  { name: 'back', from: ['review'], to: 'triage' },
  {
    name: 'publish',
    from: ['review'],
    to: 'published',
    guard: { '==': [{ var: 'task.payload.approved' }, true] },
  },
  {
    name: 'escalate',
    from: ['review'],
    to: 'published',
    requires_approval: true,
    guard: { '==': [{ var: 'task.payload.approved' }, true] },
  },
  {
    name: 'by_user',
    from: ['triage'],
    to: 'review',
    guard: { '==': [{ var: 'principal.kind' }, 'user'] },
  },
];

type TransitionOption = {
  name: string;
  to: string;
  requires_approval: boolean;
  allowed: boolean;
  error_code: string | null;
};

describe('Task transition list', () => {
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let workflowId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'tasktransitionlist',
      policyActions: [
        'workflows:CreateWorkflow',
        'tasks:CreateTask',
        'tasks:GetTask',
        'tasks:UpdateTask',
        'tasks:TransitionTask',
      ],
      createNoPermUser: true,
    });
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;

    workflowId = (
      await authenticatedTestClient(userToken).post('/api/v1/workflows').send({
        project_id: projectId,
        name: 'transition-list',
        states: STATES,
        transitions: TRANSITIONS,
      })
    ).body.id;
  });

  afterEach(async () => {
    await flushTaskAutomations();
  });

  const createTask = async (): Promise<string> => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/tasks')
      .send({ project_id: projectId, workflow_id: workflowId, title: 't' });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const fire = (taskId: string, transition: string) => {
    return authenticatedTestClient(userToken)
      .post(`/api/v1/tasks/${taskId}/transitions`)
      .send({ transition });
  };

  const list = async (taskId: string): Promise<TransitionOption[]> => {
    const res = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks/${taskId}/transitions`
    );
    expect(res.status).toBe(200);
    return res.body.data as TransitionOption[];
  };

  const byName = (rows: TransitionOption[], name: string) => {
    return rows.find((r) => {
      return r.name === name;
    })!;
  };

  describe('GET /api/v1/tasks/:task_id/transitions', () => {
    test('lists every transition of the pinned version with its outcome', async () => {
      const taskId = await createTask();
      const rows = await list(taskId);

      expect(
        rows.map((r) => {
          return r.name;
        })
      ).toEqual(['to_review', 'back', 'publish', 'escalate', 'by_user']);
      expect(byName(rows, 'to_review')).toEqual({
        name: 'to_review',
        to: 'review',
        requires_approval: false,
        allowed: true,
        error_code: null,
      });
      expect(byName(rows, 'back')).toMatchObject({
        allowed: false,
        error_code: 'TASK_TRANSITION_CONFLICT',
      });
      expect(byName(rows, 'escalate').requires_approval).toBe(true);
    });

    test('the guard reads the caller as `principal`', async () => {
      const taskId = await createTask();
      expect(byName(await list(taskId), 'by_user')).toMatchObject({
        allowed: true,
        error_code: null,
      });
    });

    test('a guard reading task.payload flips `allowed` after a PATCH', async () => {
      const taskId = await createTask();
      expect((await fire(taskId, 'to_review')).status).toBe(200);
      expect(byName(await list(taskId), 'publish')).toMatchObject({
        allowed: false,
        error_code: 'TASK_GUARD_REJECTED',
      });

      await authenticatedTestClient(userToken)
        .patch(`/api/v1/tasks/${taskId}`)
        .send({ payload: { approved: true } });

      expect(byName(await list(taskId), 'publish')).toMatchObject({
        allowed: true,
        error_code: null,
      });
    });

    test('a requires_approval transition is allowed before its guard passes', async () => {
      // The gate files before the payload that satisfies its guard is set; the
      // guard re-runs when the approval resolves.
      const taskId = await createTask();
      expect((await fire(taskId, 'to_review')).status).toBe(200);
      expect(byName(await list(taskId), 'escalate')).toMatchObject({
        allowed: true,
        error_code: null,
      });
    });

    test('a pending gate refuses every transition', async () => {
      const taskId = await createTask();
      expect((await fire(taskId, 'to_review')).status).toBe(200);
      expect((await fire(taskId, 'escalate')).status).toBe(200);

      const rows = await list(taskId);
      for (const row of rows) {
        expect(row).toMatchObject({
          allowed: false,
          error_code: 'TASK_TRANSITION_CONFLICT',
        });
      }
    });

    test('a closed task refuses every transition', async () => {
      const taskId = await createTask();
      expect((await fire(taskId, 'to_review')).status).toBe(200);
      await authenticatedTestClient(userToken)
        .patch(`/api/v1/tasks/${taskId}`)
        .send({ payload: { approved: true } });
      expect((await fire(taskId, 'publish')).status).toBe(200);

      for (const row of await list(taskId)) {
        expect(row.allowed).toBe(false);
      }
    });

    test('every refused row names the code firing it answers', async () => {
      const taskId = await createTask();
      expect((await fire(taskId, 'to_review')).status).toBe(200);
      const rows = await list(taskId);

      for (const row of rows) {
        // `back` would move the task, so only the refusals are fired.
        if (row.allowed) continue;
        const res = await fire(taskId, row.name);
        expect(res.body.error.code).toBe(row.error_code);
      }
      expect(
        rows.filter((r) => {
          return !r.allowed;
        }).length
      ).toBeGreaterThan(0);
    });

    test('does not move the task', async () => {
      const taskId = await createTask();
      await list(taskId);
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/tasks/${taskId}/history`
      );
      expect(res.body.data).toHaveLength(1);
    });

    test('returns 401 without a token', async () => {
      const taskId = await createTask();
      const res = await testClient.get(`/api/v1/tasks/${taskId}/transitions`);
      expect(res.status).toBe(401);
    });

    test('returns 404 without tasks:GetTask', async () => {
      const taskId = await createTask();
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/tasks/${taskId}/transitions`
      );
      expect(res.status).toBe(404);
    });

    test('pages with limit and cursor', async () => {
      const taskId = await createTask();
      const first = await authenticatedTestClient(userToken)
        .get(`/api/v1/tasks/${taskId}/transitions`)
        .query({ limit: 2 });
      const res = await authenticatedTestClient(userToken)
        .get(`/api/v1/tasks/${taskId}/transitions`)
        .query({ limit: 2, cursor: first.body.next_cursor });
      expect(first.status).toBe(200);
      expect(typeof first.body.next_cursor).toBe('string');
      expect(res.status).toBe(200);
      expect(typeof res.body.next_cursor).toBe('string');
      expect(
        res.body.data.map((r: TransitionOption) => {
          return r.name;
        })
      ).toEqual(['publish', 'escalate']);
    });

    test('returns 404 for an unknown task', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/tasks/task_doesnotexist0/transitions'
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('TASK_NOT_FOUND');
    });
  });
});
