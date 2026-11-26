import { db } from 'src/db';
import { flushTaskAutomations } from 'src/lib/tasks';

import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

describe('Task hold', () => {
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let updaterToken: string;
  let projectId: string;
  let workflowId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'taskhold',
      policyActions: [
        'workflows:CreateWorkflow',
        'tasks:CreateTask',
        'tasks:ListTasks',
        'tasks:GetTask',
        'tasks:UpdateTask',
        'tasks:TransitionTask',
        'tasks:SetTaskHold',
        'tasks:UpdateTaskDependencies',
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
      username: 'taskholdupdater',
      actions: ['tasks:GetTask', 'tasks:UpdateTask'],
    });

    workflowId = (
      await authenticatedTestClient(userToken)
        .post('/api/v1/workflows')
        .send({
          project_id: projectId,
          name: 'hold-board',
          states: [{ name: 'todo', initial: true }, { name: 'doing' }],
          transitions: [
            {
              name: 'start',
              from: ['todo'],
              to: 'doing',
              guard: { '!': { var: 'task.readiness.blocked' } },
            },
          ],
        })
    ).body.id;
  });

  afterEach(async () => {
    await flushTaskAutomations();
  });

  const inMinutes = (minutes: number) => {
    return new Date(Date.now() + minutes * 60_000).toISOString();
  };

  const createTask = async (fields: object = {}) => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/tasks')
      .send({
        project_id: projectId,
        workflow_id: workflowId,
        title: 'A card',
        ...fields,
      });
    return res;
  };

  const setHold = (args: { taskId: string; body: object; token?: string }) => {
    return authenticatedTestClient(args.token ?? userToken)
      .put(`/api/v1/tasks/${args.taskId}/hold`)
      .send(args.body);
  };

  const getTask = async (taskId: string) => {
    return (
      await authenticatedTestClient(userToken).get(`/api/v1/tasks/${taskId}`)
    ).body;
  };

  /** The clock passing the hold, with no write through the API. */
  const letHoldPass = async (taskId: string) => {
    await db.Task.update(
      { holdUntil: new Date(Date.now() - 1000) },
      { where: { publicId: taskId } }
    );
  };

  describe('POST /api/v1/tasks', () => {
    test('a new task holds nothing', async () => {
      const res = await createTask();
      expect(res.status).toBe(201);
      expect(res.body.hold_until).toBeNull();
      expect(res.body.hold_reason).toBeNull();
      expect(res.body.readiness.blocked).toBe(false);
    });

    test('refuses hold_until as an unknown field', async () => {
      const res = await createTask({ hold_until: inMinutes(5) });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.meta.unknown_fields).toContain('hold_until');
    });
  });

  describe('PUT /api/v1/tasks/:task_id/hold', () => {
    test('holds a task until a future date: blocked, by a scheduled entry', async () => {
      const task = (await createTask()).body;
      const until = inMinutes(60);
      const res = await setHold({
        taskId: task.id,
        body: { hold_until: until, hold_reason: 'rerun on Dec 1st' },
      });
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(task.id);
      expect(res.body.hold_until).toBe(until);
      expect(res.body.hold_reason).toBe('rerun on Dec 1st');
      expect(res.body.readiness).toEqual({
        blocked: true,
        blocked_by: [{ kind: 'scheduled', until, reason: 'rerun on Dec 1st' }],
        blocked_by_count: 1,
        unblocks: 0,
      });
    });

    test('a reason is optional', async () => {
      const task = (await createTask()).body;
      const until = inMinutes(60);
      const res = await setHold({
        taskId: task.id,
        body: { hold_until: until },
      });
      expect(res.status).toBe(200);
      expect(res.body.hold_reason).toBeNull();
      expect(res.body.readiness.blocked_by).toEqual([
        { kind: 'scheduled', until, reason: null },
      ]);
    });

    test('the hold is listed beside open dependencies', async () => {
      const blocker = (await createTask({ title: 'blocker' })).body;
      const task = (await createTask()).body;
      const edge = await authenticatedTestClient(userToken)
        .post(`/api/v1/tasks/${task.id}/dependencies`)
        .send({ depends_on_task_id: blocker.id });
      expect(edge.status).toBe(201);
      const until = inMinutes(60);
      const res = await setHold({
        taskId: task.id,
        body: { hold_until: until },
      });
      expect(res.body.readiness.blocked_by).toEqual([
        { kind: 'scheduled', until, reason: null },
        {
          kind: 'task',
          task_id: blocker.id,
          title: 'blocker',
          state: 'todo',
        },
      ]);
      expect(res.body.readiness.blocked_by_count).toBe(2);
    });

    test('null clears it', async () => {
      const task = (await createTask()).body;
      await setHold({
        taskId: task.id,
        body: { hold_until: inMinutes(60), hold_reason: 'later' },
      });
      const res = await setHold({
        taskId: task.id,
        body: { hold_until: null },
      });
      expect(res.status).toBe(200);
      expect(res.body.hold_until).toBeNull();
      expect(res.body.hold_reason).toBeNull();
      expect(res.body.readiness.blocked).toBe(false);
    });

    test('refuses a date that is not in the future', async () => {
      const task = (await createTask()).body;
      const res = await setHold({
        taskId: task.id,
        body: { hold_until: inMinutes(-1) },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.meta.invalid_fields).toEqual(['hold_until']);
    });

    test('refuses a value that is not a date-time', async () => {
      const task = (await createTask()).body;
      const res = await setHold({
        taskId: task.id,
        body: { hold_until: 'next tuesday' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('refuses a reason without a date', async () => {
      const task = (await createTask()).body;
      const res = await setHold({
        taskId: task.id,
        body: { hold_until: null, hold_reason: 'why' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.meta.invalid_fields).toEqual(['hold_reason']);
    });

    test('refuses a body without hold_until', async () => {
      const task = (await createTask()).body;
      const res = await setHold({ taskId: task.id, body: {} });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.meta.missing_fields).toEqual(['hold_until']);
    });

    test('401 without credentials', async () => {
      const task = (await createTask()).body;
      const res = await testClient
        .put(`/api/v1/tasks/${task.id}/hold`)
        .send({ hold_until: inMinutes(5) });
      expect(res.status).toBe(401);
    });

    test('403 for a member who may update the task but not hold it', async () => {
      const task = (await createTask()).body;
      const res = await setHold({
        taskId: task.id,
        body: { hold_until: inMinutes(5) },
        token: updaterToken,
      });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    test('404 for a caller outside the project', async () => {
      const task = (await createTask()).body;
      const res = await setHold({
        taskId: task.id,
        body: { hold_until: inMinutes(5) },
        token: noPermToken,
      });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('TASK_NOT_FOUND');
    });

    test('404 for an unknown task', async () => {
      const res = await setHold({
        taskId: 'task_missing',
        body: { hold_until: inMinutes(5) },
      });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('TASK_NOT_FOUND');
    });
  });

  describe('a held task', () => {
    test('is absent from the pull order until the date passes, then ready with no write', async () => {
      const held = (await createTask({ title: 'held' })).body;
      await setHold({ taskId: held.id, body: { hold_until: inMinutes(60) } });

      const pull = async () => {
        const res = await authenticatedTestClient(userToken).get(
          `/api/v1/tasks?workflow_id=${workflowId}&blocked=false&order=next&limit=100`
        );
        expect(res.status).toBe(200);
        return res.body.data.map((task: { id: string }) => {
          return task.id;
        });
      };
      expect(await pull()).not.toContain(held.id);

      const blocked = await authenticatedTestClient(userToken).get(
        `/api/v1/tasks?workflow_id=${workflowId}&blocked=true&limit=100`
      );
      expect(
        blocked.body.data.map((task: { id: string }) => {
          return task.id;
        })
      ).toContain(held.id);

      await letHoldPass(held.id);
      expect(await pull()).toContain(held.id);
      const read = await getTask(held.id);
      expect(read.readiness.blocked).toBe(false);
      expect(read.readiness.blocked_by).toEqual([]);
    });

    test('a guard on task.readiness.blocked refuses to start it until the date passes', async () => {
      const task = (await createTask()).body;
      await setHold({ taskId: task.id, body: { hold_until: inMinutes(60) } });

      const start = () => {
        return authenticatedTestClient(userToken)
          .post(`/api/v1/tasks/${task.id}/transitions`)
          .send({ transition: 'start' });
      };
      const refused = await start();
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('TASK_GUARD_REJECTED');

      await letHoldPass(task.id);
      const started = await start();
      expect(started.status).toBe(200);
      expect(started.body.state).toBe('doing');
    });

    test('the graph reads it blocked', async () => {
      const task = (await createTask({ title: 'graph-held' })).body;
      await setHold({ taskId: task.id, body: { hold_until: inMinutes(60) } });
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/tasks/graph?workflow_id=${workflowId}`
      );
      expect(res.status).toBe(200);
      const node = res.body.data.nodes.find((n: { id: string }) => {
        return n.id === task.id;
      });
      expect(node.blocked).toBe(true);
    });
  });
});
