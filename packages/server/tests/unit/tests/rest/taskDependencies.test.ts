import { eventBus, type SoatEvent } from 'src/lib/eventBus';

import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

let userToken: string;
let noPermToken: string;
let readerToken: string;
let projectId: string;
let otherProjectId: string;
let workflowId: string;
let otherWorkflowId: string;

type Readiness = {
  blocked: boolean;
  blocked_by: { task_id: string; title: string; state: string }[];
  blocked_by_count: number;
  unblocks: number;
};

const createWorkflow = async (project: string) => {
  const res = await authenticatedTestClient(userToken)
    .post('/api/v1/workflows')
    .send({
      project_id: project,
      name: 'dependency board',
      states: [
        { name: 'todo', initial: true },
        { name: 'doing' },
        { name: 'done', terminal: true },
        { name: 'cancelled', terminal: true },
      ],
      transitions: [
        {
          name: 'start',
          from: ['todo'],
          to: 'doing',
          guard: { '!': { var: 'task.readiness.blocked' } },
        },
        { name: 'finish', from: ['todo', 'doing'], to: 'done' },
        { name: 'cancel', from: ['todo', 'doing'], to: 'cancelled' },
      ],
    });
  expect(res.status).toBe(201);
  return res.body.id as string;
};

const createTask = async (title = 'task', args: { project?: string } = {}) => {
  const res = await authenticatedTestClient(userToken)
    .post('/api/v1/tasks')
    .send({
      project_id: args.project ?? projectId,
      workflow_id:
        args.project === otherProjectId ? otherWorkflowId : workflowId,
      title,
    });
  expect(res.status).toBe(201);
  return res.body as { id: string; readiness: Readiness };
};

const addDependency = (
  taskId: string,
  dependsOnTaskId: string,
  token = userToken
) => {
  return authenticatedTestClient(token)
    .post(`/api/v1/tasks/${taskId}/dependencies`)
    .send({ depends_on_task_id: dependsOnTaskId, note: 'needs it first' });
};

const readTask = async (taskId: string) => {
  const res = await authenticatedTestClient(userToken).get(
    `/api/v1/tasks/${taskId}`
  );
  expect(res.status).toBe(200);
  return res.body as { id: string; readiness: Readiness };
};

const fire = (taskId: string, transition: string) => {
  return authenticatedTestClient(userToken)
    .post(`/api/v1/tasks/${taskId}/transitions`)
    .send({ transition });
};

/** The `tasks.unblocked` events `action` emits before it answers. */
const unblockedDuring = async (action: () => Promise<unknown>) => {
  const seen: string[] = [];
  const handler = (event: SoatEvent) => {
    if (event.type === 'tasks.unblocked') seen.push(event.resourceId);
  };
  eventBus.on('soat:event', handler);
  try {
    await action();
  } finally {
    eventBus.off('soat:event', handler);
  }
  return seen;
};

beforeAll(async () => {
  const setup = await setupProjectWithUsers({
    prefix: 'taskdeps',
    policyActions: [
      'workflows:CreateWorkflow',
      'tasks:CreateTask',
      'tasks:GetTask',
      'tasks:ListTasks',
      'tasks:TransitionTask',
      'tasks:DeleteTask',
      'tasks:UpdateTaskDependencies',
    ],
    createOtherProject: true,
    createNoPermUser: true,
  });
  userToken = setup.userToken;
  noPermToken = setup.noPermToken as string;
  projectId = setup.projectId;
  otherProjectId = setup.otherProjectId as string;
  workflowId = await createWorkflow(projectId);
  readerToken = await createScopedPrincipal({
    adminToken: setup.adminToken,
    projectId,
    username: 'taskdepsreader',
    actions: ['tasks:GetTask'],
  });
  otherWorkflowId = await createWorkflow(otherProjectId);
});

describe('POST /api/v1/tasks/:task_id/dependencies', () => {
  test('adds the dependency and blocks the task', async () => {
    const blocker = await createTask('blocker');
    const task = await createTask('waits');

    const res = await addDependency(task.id, blocker.id);

    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^tdp_/);
    expect(res.body.task).toEqual({
      id: task.id,
      title: 'waits',
      state: 'todo',
      status: 'open',
    });
    expect(res.body.depends_on_task.id).toBe(blocker.id);
    expect(res.body.note).toBe('needs it first');
    expect(res.body.created_by_principal_type).toBe('user');
    expect(res.body.created_by_principal_id).toMatch(/^user_/);

    expect((await readTask(task.id)).readiness).toEqual({
      blocked: true,
      blocked_by: [{ task_id: blocker.id, title: 'blocker', state: 'todo' }],
      blocked_by_count: 1,
      unblocks: 0,
    });
    expect((await readTask(blocker.id)).readiness).toEqual({
      blocked: false,
      blocked_by: [],
      blocked_by_count: 0,
      unblocks: 1,
    });
  });

  test('a new task reads as ready', async () => {
    const task = await createTask();
    expect(task.readiness).toEqual({
      blocked: false,
      blocked_by: [],
      blocked_by_count: 0,
      unblocks: 0,
    });
  });

  test('records a dependency_added row on both tasks', async () => {
    const blocker = await createTask();
    const task = await createTask();
    expect((await addDependency(task.id, blocker.id)).status).toBe(201);

    for (const [own, related] of [
      [task.id, blocker.id],
      [blocker.id, task.id],
    ]) {
      const history = await authenticatedTestClient(userToken).get(
        `/api/v1/tasks/${own}/history`
      );
      expect(history.status).toBe(200);
      const rows = history.body.data as Record<string, unknown>[];
      expect(rows[0]).toMatchObject({
        kind: 'transition',
        related_task_id: null,
        to_state: 'todo',
      });
      expect(rows[1]).toMatchObject({
        kind: 'dependency_added',
        related_task_id: related,
        from_state: null,
        to_state: null,
        principal_type: 'user',
      });
    }
  });

  test('refuses a cycle with its path', async () => {
    const a = await createTask();
    const b = await createTask();
    const c = await createTask();
    expect((await addDependency(b.id, a.id)).status).toBe(201);
    expect((await addDependency(c.id, b.id)).status).toBe(201);

    const res = await addDependency(a.id, c.id);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TASK_DEPENDENCY_CYCLE');
    expect(res.body.error.meta.path).toEqual([a.id, c.id, b.id, a.id]);
  });

  test('refuses a duplicate', async () => {
    const blocker = await createTask();
    const task = await createTask();
    const first = await addDependency(task.id, blocker.id);
    expect(first.status).toBe(201);

    const res = await addDependency(task.id, blocker.id);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TASK_DEPENDENCY_EXISTS');
    expect(res.body.error.meta.dependency_id).toBe(first.body.id);
  });

  test('refuses the task itself', async () => {
    const task = await createTask();
    const res = await addDependency(task.id, task.id);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TASK_DEPENDENCY_SELF');
  });

  test('a task in another project is not found', async () => {
    const task = await createTask();
    const other = await createTask('elsewhere', { project: otherProjectId });
    const res = await addDependency(task.id, other.id);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('TASK_NOT_FOUND');
  });

  test('a missing task is not found', async () => {
    const task = await createTask();
    const res = await addDependency(task.id, 'task_doesnotexist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('TASK_NOT_FOUND');
  });

  test('401 without credentials', async () => {
    const task = await createTask();
    const res = await testClient
      .post(`/api/v1/tasks/${task.id}/dependencies`)
      .send({ depends_on_task_id: task.id });
    expect(res.status).toBe(401);
  });

  test('a caller without tasks:UpdateTaskDependencies is answered 404', async () => {
    const blocker = await createTask();
    const task = await createTask();
    const res = await addDependency(task.id, blocker.id, noPermToken);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('TASK_NOT_FOUND');
  });
});

describe('a reader of the task without tasks:UpdateTaskDependencies', () => {
  test('is refused 403 on add and remove', async () => {
    const blocker = await createTask();
    const task = await createTask();
    const added = await addDependency(task.id, blocker.id);

    const add = await addDependency(task.id, blocker.id, readerToken);
    expect(add.status).toBe(403);
    expect(add.body.error.code).toBe('FORBIDDEN');

    const remove = await authenticatedTestClient(readerToken).delete(
      `/api/v1/tasks/${task.id}/dependencies/${added.body.id}`
    );
    expect(remove.status).toBe(403);
  });

  test('may list them', async () => {
    const task = await createTask();
    const res = await authenticatedTestClient(readerToken).get(
      `/api/v1/tasks/${task.id}/dependencies`
    );
    expect(res.status).toBe(200);
  });
});

describe('GET /api/v1/tasks/:task_id/dependencies and /dependents', () => {
  test('lists open and closed edges in both directions', async () => {
    const open = await createTask('open blocker');
    const closed = await createTask('closed blocker');
    const task = await createTask();
    expect((await addDependency(task.id, open.id)).status).toBe(201);
    expect((await addDependency(task.id, closed.id)).status).toBe(201);
    expect((await fire(closed.id, 'finish')).status).toBe(200);

    const deps = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks/${task.id}/dependencies`
    );
    expect(deps.status).toBe(200);
    expect(
      deps.body.data.map((row: { depends_on_task: { id: string } }) => {
        return row.depends_on_task.id;
      })
    ).toEqual([open.id, closed.id]);
    expect(deps.body.data[1].depends_on_task.status).toBe('closed');

    const dependents = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks/${open.id}/dependents`
    );
    expect(dependents.status).toBe(200);
    expect(dependents.body.data).toHaveLength(1);
    expect(dependents.body.data[0].task.id).toBe(task.id);
  });

  test('401 without credentials', async () => {
    const task = await createTask();
    const res = await testClient.get(`/api/v1/tasks/${task.id}/dependents`);
    expect(res.status).toBe(401);
  });

  test('a caller without tasks:GetTask is answered 404', async () => {
    const task = await createTask();
    const res = await authenticatedTestClient(noPermToken).get(
      `/api/v1/tasks/${task.id}/dependencies`
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('TASK_NOT_FOUND');
  });
});

describe('DELETE /api/v1/tasks/:task_id/dependencies/:dependency_id', () => {
  test('removes it, frees the task and emits tasks.unblocked', async () => {
    const blocker = await createTask();
    const task = await createTask();
    const added = await addDependency(task.id, blocker.id);

    const seen = await unblockedDuring(async () => {
      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/tasks/${task.id}/dependencies/${added.body.id}`
      );
      expect(res.status).toBe(204);
    });

    expect(seen).toEqual([task.id]);
    expect((await readTask(task.id)).readiness.blocked).toBe(false);
    const history = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks/${blocker.id}/history`
    );
    expect(history.body.data.at(-1)).toMatchObject({
      kind: 'dependency_removed',
      related_task_id: task.id,
    });
  });

  test('an unknown dependency is not found', async () => {
    const task = await createTask();
    const res = await authenticatedTestClient(userToken).delete(
      `/api/v1/tasks/${task.id}/dependencies/tdp_doesnotexist`
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('TASK_DEPENDENCY_NOT_FOUND');
  });

  test('a caller without tasks:UpdateTaskDependencies is answered 404', async () => {
    const blocker = await createTask();
    const task = await createTask();
    const added = await addDependency(task.id, blocker.id);
    const res = await authenticatedTestClient(noPermToken).delete(
      `/api/v1/tasks/${task.id}/dependencies/${added.body.id}`
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('TASK_NOT_FOUND');
  });

  test('401 without credentials', async () => {
    const res = await testClient.delete(
      '/api/v1/tasks/task_x/dependencies/tdp_x'
    );
    expect(res.status).toBe(401);
  });
});

describe('closing and deleting', () => {
  test('tasks.unblocked fires once, when the last open dependency closes', async () => {
    const first = await createTask();
    const second = await createTask();
    const task = await createTask();
    expect((await addDependency(task.id, first.id)).status).toBe(201);
    expect((await addDependency(task.id, second.id)).status).toBe(201);

    const afterFirst = await unblockedDuring(() => {
      return fire(first.id, 'finish');
    });
    expect(afterFirst).toEqual([]);
    expect((await readTask(task.id)).readiness).toMatchObject({
      blocked: true,
      blocked_by_count: 1,
    });

    const afterSecond = await unblockedDuring(() => {
      return fire(second.id, 'cancel');
    });
    expect(afterSecond).toEqual([task.id]);
    expect((await readTask(task.id)).readiness.blocked).toBe(false);
  });

  test('deleting a dependency task frees its dependents', async () => {
    const blocker = await createTask();
    const task = await createTask();
    expect((await addDependency(task.id, blocker.id)).status).toBe(201);

    const seen = await unblockedDuring(async () => {
      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/tasks/${blocker.id}`
      );
      expect(res.status).toBe(204);
    });

    expect(seen).toEqual([task.id]);
    expect((await readTask(task.id)).readiness.blocked).toBe(false);
    const deps = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks/${task.id}/dependencies`
    );
    expect(deps.body.data).toEqual([]);
  });

  test('deleting a closed task frees nothing and records the removal on the other end', async () => {
    const blocker = await createTask();
    const task = await createTask();
    expect((await addDependency(task.id, blocker.id)).status).toBe(201);
    expect((await fire(task.id, 'finish')).status).toBe(200);

    const seen = await unblockedDuring(async () => {
      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/tasks/${task.id}`
      );
      expect(res.status).toBe(204);
    });

    expect(seen).toEqual([]);
    const history = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks/${blocker.id}/history`
    );
    expect(history.body.data.at(-1)).toMatchObject({
      kind: 'dependency_removed',
      related_task_id: task.id,
    });
    expect((await readTask(blocker.id)).readiness.unblocks).toBe(0);
  });
});

describe('guards and lists read readiness', () => {
  test('a guard over task.readiness.blocked holds the task until freed', async () => {
    const blocker = await createTask();
    const task = await createTask();
    expect((await addDependency(task.id, blocker.id)).status).toBe(201);

    const refused = await fire(task.id, 'start');
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('TASK_GUARD_REJECTED');

    expect((await fire(blocker.id, 'finish')).status).toBe(200);
    const started = await fire(task.id, 'start');
    expect(started.status).toBe(200);
    expect(started.body.state).toBe('doing');
  });

  test('GET /tasks?blocked filters on an open dependency', async () => {
    const blocker = await createTask();
    const task = await createTask();
    expect((await addDependency(task.id, blocker.id)).status).toBe(201);

    const blocked = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks?project_id=${projectId}&blocked=true&limit=100`
    );
    expect(blocked.status).toBe(200);
    const blockedIds = blocked.body.data.map((t: { id: string }) => {
      return t.id;
    });
    expect(blockedIds).toContain(task.id);
    expect(blockedIds).not.toContain(blocker.id);
    for (const row of blocked.body.data) {
      expect(row.readiness.blocked).toBe(true);
    }

    const free = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks?project_id=${projectId}&blocked=false&limit=100`
    );
    const freeIds = free.body.data.map((t: { id: string }) => {
      return t.id;
    });
    expect(freeIds).toContain(blocker.id);
    expect(freeIds).not.toContain(task.id);
  });

  test('GET /tasks?blocked refuses another value', async () => {
    const res = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks?project_id=${projectId}&blocked=yes`
    );
    expect(res.status).toBe(400);
  });
});
