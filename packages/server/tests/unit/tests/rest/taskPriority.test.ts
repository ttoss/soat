import { flushTaskAutomations } from 'src/lib/tasks';

import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

describe('Task priority', () => {
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let updaterToken: string;
  let projectId: string;
  let workflowId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'taskprio',
      policyActions: [
        'workflows:CreateWorkflow',
        'tasks:CreateTask',
        'tasks:ListTasks',
        'tasks:GetTask',
        'tasks:UpdateTask',
        'tasks:TransitionTask',
        'tasks:SetTaskPriority',
      ],
      createNoPermUser: true,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;

    updaterToken = await createScopedPrincipal({
      adminToken,
      projectId,
      username: 'taskprioupdater',
      actions: ['tasks:GetTask', 'tasks:UpdateTask'],
    });

    workflowId = (
      await authenticatedTestClient(userToken)
        .post('/api/v1/workflows')
        .send({
          project_id: projectId,
          name: 'priority-pipeline',
          states: [{ name: 'triage', initial: true }, { name: 'urgent' }],
          transitions: [
            {
              name: 'escalate',
              from: ['triage'],
              to: 'urgent',
              guard: { '==': [{ var: 'task.priority' }, 'very_high'] },
            },
          ],
        })
    ).body.id;
  });

  afterEach(async () => {
    await flushTaskAutomations();
  });

  const createTask = (fields: object = {}) => {
    return authenticatedTestClient(userToken)
      .post('/api/v1/tasks')
      .send({
        project_id: projectId,
        workflow_id: workflowId,
        title: 'A card',
        ...fields,
      });
  };

  const setPriority = (args: {
    taskId: string;
    body: object;
    token?: string;
  }) => {
    return authenticatedTestClient(args.token ?? userToken)
      .put(`/api/v1/tasks/${args.taskId}/priority`)
      .send(args.body);
  };

  describe('POST /api/v1/tasks', () => {
    test('a task nobody prioritised reads priority null', async () => {
      const res = await createTask();
      expect(res.status).toBe(201);
      expect(res.body.priority).toBeNull();
    });

    test('creates a task with a priority', async () => {
      const res = await createTask({ priority: 'high' });
      expect(res.status).toBe(201);
      expect(res.body.priority).toBe('high');

      const read = await authenticatedTestClient(userToken).get(
        `/api/v1/tasks/${res.body.id}`
      );
      expect(read.body.priority).toBe('high');
    });

    test('refuses a priority outside the set', async () => {
      const res = await createTask({ priority: 'urgent' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('PUT /api/v1/tasks/:task_id/priority', () => {
    test('sets a priority', async () => {
      const task = (await createTask()).body;
      const res = await setPriority({
        taskId: task.id,
        body: { priority: 'low' },
      });
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(task.id);
      expect(res.body.priority).toBe('low');
    });

    test('null clears it', async () => {
      const task = (await createTask({ priority: 'medium' })).body;
      const res = await setPriority({
        taskId: task.id,
        body: { priority: null },
      });
      expect(res.status).toBe(200);
      expect(res.body.priority).toBeNull();
    });

    test('refuses a value outside the set', async () => {
      const task = (await createTask({ priority: 'medium' })).body;
      const res = await setPriority({
        taskId: task.id,
        body: { priority: 'urgent' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');

      const read = await authenticatedTestClient(userToken).get(
        `/api/v1/tasks/${task.id}`
      );
      expect(read.body.priority).toBe('medium');
    });

    test('refuses a body without priority', async () => {
      const task = (await createTask()).body;
      const res = await setPriority({ taskId: task.id, body: {} });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.meta.missing_fields).toEqual(['priority']);
    });

    test('401 without credentials', async () => {
      const task = (await createTask()).body;
      const res = await testClient
        .put(`/api/v1/tasks/${task.id}/priority`)
        .send({ priority: 'high' });
      expect(res.status).toBe(401);
    });

    test('403 for a member who may update the task but not reprioritise it', async () => {
      const task = (await createTask()).body;
      const res = await setPriority({
        taskId: task.id,
        body: { priority: 'high' },
        token: updaterToken,
      });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    test('404 for a caller outside the project', async () => {
      const task = (await createTask()).body;
      const res = await setPriority({
        taskId: task.id,
        body: { priority: 'high' },
        token: noPermToken,
      });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('TASK_NOT_FOUND');
    });

    test('404 for an unknown task', async () => {
      const res = await setPriority({
        taskId: 'task_missing',
        body: { priority: 'high' },
      });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('TASK_NOT_FOUND');
    });
  });

  describe('PATCH /api/v1/tasks/:task_id', () => {
    test('refuses priority as an unknown field', async () => {
      const task = (await createTask({ priority: 'low' })).body;
      const res = await authenticatedTestClient(updaterToken)
        .patch(`/api/v1/tasks/${task.id}`)
        .send({ priority: 'very_high' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.meta.unknown_fields).toContain('priority');
    });
  });

  describe('GET /api/v1/tasks?priority=', () => {
    let wf: string;
    const ids: Record<string, string> = {};

    beforeAll(async () => {
      wf = (
        await authenticatedTestClient(userToken)
          .post('/api/v1/workflows')
          .send({
            project_id: projectId,
            name: 'priority-filter',
            states: [{ name: 'open', initial: true }],
            transitions: [],
          })
      ).body.id;
      for (const priority of ['high', 'low', null]) {
        const res = await authenticatedTestClient(userToken)
          .post('/api/v1/tasks')
          .send({
            project_id: projectId,
            workflow_id: wf,
            title: `p-${priority}`,
            priority,
          });
        ids[String(priority)] = res.body.id;
      }
    });

    const list = (query: string) => {
      return authenticatedTestClient(userToken).get(
        `/api/v1/tasks?workflow_id=${wf}&${query}`
      );
    };

    const idsOf = (body: { data: { id: string }[] }) => {
      return body.data
        .map((t) => {
          return t.id;
        })
        .sort();
    };

    test('filters by one priority', async () => {
      const res = await list('priority=high');
      expect(res.status).toBe(200);
      expect(idsOf(res.body)).toEqual([ids.high]);
    });

    test('ORs repeated values', async () => {
      const res = await list('priority=high&priority=low');
      expect(idsOf(res.body)).toEqual([ids.high, ids.low].sort());
    });

    test('`none` selects the tasks with no priority', async () => {
      const res = await list('priority=none');
      expect(idsOf(res.body)).toEqual([ids.null]);
    });

    test('`none` ORs with a value', async () => {
      const res = await list('priority=none&priority=low');
      expect(idsOf(res.body)).toEqual([ids.null, ids.low].sort());
    });

    test('refuses a value outside the set', async () => {
      const res = await list('priority=urgent');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('guards', () => {
    test('a guard reads task.priority', async () => {
      const task = (await createTask({ priority: 'low' })).body;
      const refused = await authenticatedTestClient(userToken)
        .post(`/api/v1/tasks/${task.id}/transitions`)
        .send({ transition: 'escalate' });
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('TASK_GUARD_REJECTED');

      await setPriority({ taskId: task.id, body: { priority: 'very_high' } });
      const moved = await authenticatedTestClient(userToken)
        .post(`/api/v1/tasks/${task.id}/transitions`)
        .send({ transition: 'escalate' });
      expect(moved.status).toBe(200);
      expect(moved.body.state).toBe('urgent');
    });
  });
});
