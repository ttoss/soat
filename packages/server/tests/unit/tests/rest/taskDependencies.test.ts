import { db } from 'src/db';
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
  blocked_by: {
    kind: 'task';
    task_id: string;
    title: string;
    state: string;
  }[];
  blocked_by_count: number;
  unblocks: number;
};

const createWorkflow = async (project: string, name = 'dependency board') => {
  const res = await authenticatedTestClient(userToken)
    .post('/api/v1/workflows')
    .send({
      project_id: project,
      name,
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
const unblockedEventsDuring = async (action: () => Promise<unknown>) => {
  const seen: SoatEvent[] = [];
  const handler = (event: SoatEvent) => {
    if (event.type === 'tasks.unblocked') seen.push(event);
  };
  eventBus.on('soat:event', handler);
  try {
    await action();
  } finally {
    eventBus.off('soat:event', handler);
  }
  return seen;
};

const unblockedDuring = async (action: () => Promise<unknown>) => {
  return (await unblockedEventsDuring(action)).map((event) => {
    return event.resourceId;
  });
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
    expect(res.body.id).toBeUndefined();
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
      blocked_by: [
        { kind: 'task', task_id: blocker.id, title: 'blocker', state: 'todo' },
      ],
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

  test('the same pair again answers 200 with the existing edge', async () => {
    const blocker = await createTask();
    const task = await createTask();
    const first = await addDependency(task.id, blocker.id);
    expect(first.status).toBe(201);

    const res = await authenticatedTestClient(userToken)
      .post(`/api/v1/tasks/${task.id}/dependencies`)
      .send({ depends_on_task_id: blocker.id, note: 'another note' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(first.body);
    expect((await readTask(task.id)).readiness.blocked_by_count).toBe(1);
  });

  test('a closed task cannot gain a dependency', async () => {
    const blocker = await createTask();
    const task = await createTask();
    expect((await fire(task.id, 'finish')).status).toBe(200);

    const res = await addDependency(task.id, blocker.id);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TASK_DEPENDENCY_CLOSED');
  });

  test('a closed task may be depended on, and the edge is inert', async () => {
    const blocker = await createTask();
    const task = await createTask();
    expect((await fire(blocker.id, 'finish')).status).toBe(200);

    expect((await addDependency(task.id, blocker.id)).status).toBe(201);

    expect((await readTask(task.id)).readiness.blocked).toBe(false);
  });

  test('edges cross workflows within a project', async () => {
    const elsewhere = await createWorkflow(projectId, 'another board');
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/tasks')
      .send({ project_id: projectId, workflow_id: elsewhere, title: 'x' });
    expect(res.status).toBe(201);
    const task = await createTask();

    expect((await addDependency(task.id, res.body.id)).status).toBe(201);
    expect((await readTask(task.id)).readiness.blocked).toBe(true);
  });

  test('refuses the task itself', async () => {
    const task = await createTask();
    const res = await addDependency(task.id, task.id);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TASK_DEPENDENCY_SELF');
  });

  test("the body's task in another project is a bad request", async () => {
    const task = await createTask();
    const other = await createTask('elsewhere', { project: otherProjectId });
    const res = await addDependency(task.id, other.id);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TASK_DEPENDENCY_TARGET_NOT_FOUND');
  });

  test("a missing body's task is a bad request", async () => {
    const task = await createTask();
    const res = await addDependency(task.id, 'task_doesnotexist');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TASK_DEPENDENCY_TARGET_NOT_FOUND');
  });

  test("a missing path's task is not found", async () => {
    const task = await createTask();
    const res = await addDependency('task_doesnotexist', task.id);
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
    expect((await addDependency(task.id, blocker.id)).status).toBe(201);

    const add = await addDependency(task.id, blocker.id, readerToken);
    expect(add.status).toBe(403);
    expect(add.body.error.code).toBe('FORBIDDEN');

    const remove = await authenticatedTestClient(readerToken).delete(
      `/api/v1/tasks/${task.id}/dependencies/${blocker.id}`
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

describe('DELETE /api/v1/tasks/:task_id/dependencies/:depends_on_task_id', () => {
  test('removes it, frees the task and emits tasks.unblocked', async () => {
    const blocker = await createTask();
    const task = await createTask();
    expect((await addDependency(task.id, blocker.id)).status).toBe(201);

    const events = await unblockedEventsDuring(async () => {
      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/tasks/${task.id}/dependencies/${blocker.id}`
      );
      expect(res.status).toBe(204);
    });

    expect(events).toHaveLength(1);
    expect(events[0].resourceId).toBe(task.id);
    expect(events[0].data.unblocked_by).toEqual({
      task_id: blocker.id,
      state: 'todo',
    });
    expect((await readTask(task.id)).readiness.blocked).toBe(false);
  });

  test('removing it again answers 204', async () => {
    const blocker = await createTask();
    const task = await createTask();
    expect((await addDependency(task.id, blocker.id)).status).toBe(201);
    const path = `/api/v1/tasks/${task.id}/dependencies/${blocker.id}`;
    expect((await authenticatedTestClient(userToken).delete(path)).status).toBe(
      204
    );

    const seen = await unblockedDuring(async () => {
      const res = await authenticatedTestClient(userToken).delete(path);
      expect(res.status).toBe(204);
    });

    expect(seen).toEqual([]);
  });

  test('a caller without tasks:UpdateTaskDependencies is answered 404', async () => {
    const blocker = await createTask();
    const task = await createTask();
    expect((await addDependency(task.id, blocker.id)).status).toBe(201);
    const res = await authenticatedTestClient(noPermToken).delete(
      `/api/v1/tasks/${task.id}/dependencies/${blocker.id}`
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('TASK_NOT_FOUND');
  });

  test('401 without credentials', async () => {
    const res = await testClient.delete(
      '/api/v1/tasks/task_x/dependencies/task_y'
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

    const afterSecond = await unblockedEventsDuring(() => {
      return fire(second.id, 'cancel');
    });
    expect(
      afterSecond.map((event) => {
        return event.resourceId;
      })
    ).toEqual([task.id]);
    expect(afterSecond[0].data.unblocked_by).toEqual({
      task_id: second.id,
      state: 'cancelled',
    });
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
});

describe('deleting a closed task', () => {
  test('frees nothing', async () => {
    const blocker = await createTask();
    const task = await createTask();
    expect((await addDependency(task.id, blocker.id)).status).toBe(201);
    expect((await fire(blocker.id, 'finish')).status).toBe(200);

    const seen = await unblockedDuring(async () => {
      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/tasks/${blocker.id}`
      );
      expect(res.status).toBe(204);
    });

    expect(seen).toEqual([]);
    expect((await readTask(task.id)).readiness.blocked).toBe(false);
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

  test('a page of 100 reads readiness in as many queries as a page of 1', async () => {
    const board = await createWorkflow(projectId, 'page board');
    const create = async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/tasks')
        .send({ project_id: projectId, workflow_id: board, title: 'row' });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    const blocker = await create();
    const ids: string[] = [];
    for (let batch = 0; batch < 10; batch += 1) {
      ids.push(
        ...(await Promise.all(
          Array.from({ length: 10 }, () => {
            return create();
          })
        ))
      );
    }
    await Promise.all(
      ids.map(async (id) => {
        expect((await addDependency(id, blocker)).status).toBe(201);
      })
    );

    // Counts only reads of the task graph: event fan-out from the setup's
    // writes may still be querying other tables while the list runs.
    const queriesFor = async (limit: number) => {
      let count = 0;
      const hook = (_options: unknown, query: object) => {
        const sql =
          'sql' in query && typeof query.sql === 'string' ? query.sql : '';
        if (/\b(tasks|task_dependencies)\b/.test(sql)) count += 1;
      };
      db.sequelize.addHook('afterQuery', 'countListQueries', hook);
      try {
        const res = await authenticatedTestClient(userToken).get(
          `/api/v1/tasks?project_id=${projectId}&workflow_id=${board}&limit=${limit}`
        );
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(limit);
        expect(res.body.data[0].readiness.blocked).toBe(true);
      } finally {
        db.sequelize.removeHook('afterQuery', 'countListQueries');
      }
      return count;
    };

    expect(await queriesFor(100)).toBe(await queriesFor(1));
  });
});
