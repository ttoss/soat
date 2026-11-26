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

const createWorkflow = async (project: string) => {
  const res = await authenticatedTestClient(userToken)
    .post('/api/v1/workflows')
    .send({
      project_id: project,
      name: 'link board',
      states: [
        { name: 'todo', initial: true },
        { name: 'done', terminal: true },
      ],
      transitions: [{ name: 'finish', from: ['todo'], to: 'done' }],
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
  return res.body as { id: string };
};

const addLink = (
  taskId: string,
  toTaskId: string,
  kind = 'derived_from',
  token = userToken
) => {
  return authenticatedTestClient(token)
    .post(`/api/v1/tasks/${taskId}/links`)
    .send({ to_task_id: toTaskId, kind, note: 'split off' });
};

const listLinks = (taskId: string, query = '') => {
  return authenticatedTestClient(userToken).get(
    `/api/v1/tasks/${taskId}/links${query}`
  );
};

const readiness = async (taskId: string) => {
  const res = await authenticatedTestClient(userToken).get(
    `/api/v1/tasks/${taskId}`
  );
  expect(res.status).toBe(200);
  return res.body.readiness;
};

const history = async (taskId: string) => {
  const res = await authenticatedTestClient(userToken).get(
    `/api/v1/tasks/${taskId}/history`
  );
  expect(res.status).toBe(200);
  return res.body.data as {
    from_state: string | null;
    to_state: string;
    link: unknown;
  }[];
};

const listedIds = async (query: string) => {
  const res = await authenticatedTestClient(userToken).get(
    `/api/v1/tasks?project_id=${projectId}&${query}`
  );
  expect(res.status).toBe(200);
  return (res.body.data as { id: string }[]).map((task) => {
    return task.id;
  });
};

beforeAll(async () => {
  const setup = await setupProjectWithUsers({
    prefix: 'tasklinks',
    policyActions: [
      'workflows:CreateWorkflow',
      'tasks:CreateTask',
      'tasks:GetTask',
      'tasks:ListTasks',
      'tasks:TransitionTask',
      'tasks:DeleteTask',
      'tasks:UpdateTaskLinks',
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
    username: 'tasklinksreader',
    actions: ['tasks:GetTask'],
  });
  otherWorkflowId = await createWorkflow(otherProjectId);
});

describe('POST /api/v1/tasks/:task_id/links', () => {
  test('links two tasks and leaves both ready', async () => {
    const source = await createTask('source');
    const split = await createTask('split');
    const before = await readiness(source.id);

    const res = await addLink(split.id, source.id);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      kind: 'derived_from',
      from_task: { id: split.id, title: 'split', status: 'open' },
      to_task: { id: source.id, title: 'source', status: 'open' },
      note: 'split off',
      created_by_principal_type: 'user',
    });
    expect(res.body.id).toBeUndefined();
    expect(await readiness(source.id)).toEqual(before);
    expect(await readiness(split.id)).toEqual(before);
  });

  test('the same link again answers 200; another kind is another link', async () => {
    const a = await createTask();
    const b = await createTask();
    expect((await addLink(a.id, b.id)).status).toBe(201);
    expect((await addLink(a.id, b.id)).status).toBe(200);
    expect((await addLink(a.id, b.id, 'supersedes')).status).toBe(201);
    expect((await listLinks(a.id)).body.data).toHaveLength(2);
  });

  test('either end may be closed', async () => {
    const closed = await createTask();
    const task = await createTask();
    const fired = await authenticatedTestClient(userToken)
      .post(`/api/v1/tasks/${closed.id}/transitions`)
      .send({ transition: 'finish' });
    expect(fired.status).toBe(200);
    expect((await addLink(task.id, closed.id, 'supersedes')).status).toBe(201);
    expect((await addLink(closed.id, task.id)).status).toBe(201);
  });

  test('refuses a kind outside ^[a-z_]{1,32}$', async () => {
    const a = await createTask();
    const b = await createTask();
    const res = await addLink(a.id, b.id, 'Derived-From');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  test('refuses the task itself', async () => {
    const task = await createTask();
    const res = await addLink(task.id, task.id);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TASK_LINK_SELF');
  });

  test("the body's task in another project is a bad request", async () => {
    const task = await createTask();
    const other = await createTask('elsewhere', { project: otherProjectId });
    const res = await addLink(task.id, other.id);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TASK_LINK_TARGET_NOT_FOUND');
  });

  test("a missing path's task is not found", async () => {
    const task = await createTask();
    const res = await addLink('task_doesnotexist', task.id);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('TASK_NOT_FOUND');
  });

  test('401 without credentials', async () => {
    const task = await createTask();
    const res = await testClient
      .post(`/api/v1/tasks/${task.id}/links`)
      .send({ to_task_id: task.id, kind: 'derived_from' });
    expect(res.status).toBe(401);
  });

  test('a caller without tasks:UpdateTaskLinks is answered 404', async () => {
    const a = await createTask();
    const b = await createTask();
    const res = await addLink(a.id, b.id, 'derived_from', noPermToken);
    expect(res.status).toBe(404);
  });

  test('a reader of the task is refused 403 on add and remove, and may list', async () => {
    const a = await createTask();
    const b = await createTask();
    expect((await addLink(a.id, b.id)).status).toBe(201);
    const add = await addLink(a.id, b.id, 'derived_from', readerToken);
    expect(add.status).toBe(403);
    const remove = await authenticatedTestClient(readerToken).delete(
      `/api/v1/tasks/${a.id}/links/derived_from/${b.id}`
    );
    expect(remove.status).toBe(403);
    const list = await authenticatedTestClient(readerToken).get(
      `/api/v1/tasks/${a.id}/links`
    );
    expect(list.status).toBe(200);
  });
});

describe('GET /api/v1/tasks/:task_id/links', () => {
  test('reads a link from both ends, by direction and kind', async () => {
    const a = await createTask();
    const b = await createTask();
    const c = await createTask();
    expect((await addLink(a.id, b.id)).status).toBe(201);
    expect((await addLink(c.id, a.id, 'supersedes')).status).toBe(201);

    const ends = (res: {
      body: { data: { from_task: { id: string }; to_task: { id: string } }[] };
    }) => {
      return res.body.data.map((link) => {
        return [link.from_task.id, link.to_task.id];
      });
    };
    expect(ends(await listLinks(a.id))).toEqual([
      [a.id, b.id],
      [c.id, a.id],
    ]);
    expect(ends(await listLinks(b.id))).toEqual([[a.id, b.id]]);
    expect(ends(await listLinks(a.id, '?direction=out'))).toEqual([
      [a.id, b.id],
    ]);
    expect(ends(await listLinks(a.id, '?direction=in'))).toEqual([
      [c.id, a.id],
    ]);
    expect(ends(await listLinks(a.id, '?kind=supersedes'))).toEqual([
      [c.id, a.id],
    ]);
  });

  test('refuses another direction', async () => {
    const task = await createTask();
    expect((await listLinks(task.id, '?direction=both')).status).toBe(400);
  });

  test('401 without credentials', async () => {
    const task = await createTask();
    const res = await testClient.get(`/api/v1/tasks/${task.id}/links`);
    expect(res.status).toBe(401);
  });

  test('a caller without tasks:GetTask is answered 404', async () => {
    const task = await createTask();
    const res = await authenticatedTestClient(noPermToken).get(
      `/api/v1/tasks/${task.id}/links`
    );
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/v1/tasks/:task_id/links/:kind/:to_task_id', () => {
  test('removes only that kind, and again answers 204', async () => {
    const a = await createTask();
    const b = await createTask();
    expect((await addLink(a.id, b.id)).status).toBe(201);
    expect((await addLink(a.id, b.id, 'supersedes')).status).toBe(201);

    const path = `/api/v1/tasks/${a.id}/links/derived_from/${b.id}`;
    expect((await authenticatedTestClient(userToken).delete(path)).status).toBe(
      204
    );
    expect((await authenticatedTestClient(userToken).delete(path)).status).toBe(
      204
    );
    const left = (await listLinks(b.id)).body.data as { kind: string }[];
    expect(
      left.map((link) => {
        return link.kind;
      })
    ).toEqual(['supersedes']);
  });

  test('401 without credentials', async () => {
    const a = await createTask();
    const res = await testClient.delete(
      `/api/v1/tasks/${a.id}/links/derived_from/${a.id}`
    );
    expect(res.status).toBe(401);
  });

  test('deleting a task removes its links', async () => {
    const a = await createTask();
    const b = await createTask();
    expect((await addLink(a.id, b.id)).status).toBe(201);
    const deleted = await authenticatedTestClient(userToken).delete(
      `/api/v1/tasks/${a.id}`
    );
    expect(deleted.status).toBe(204);
    expect((await listLinks(b.id)).body.data).toEqual([]);
  });
});

describe('history', () => {
  test('records an added and a removed link on both ends', async () => {
    const a = await createTask();
    const b = await createTask();
    expect((await addLink(a.id, b.id)).status).toBe(201);
    expect((await addLink(a.id, b.id)).status).toBe(200);
    await authenticatedTestClient(userToken).delete(
      `/api/v1/tasks/${a.id}/links/derived_from/${b.id}`
    );

    for (const id of [a.id, b.id]) {
      const rows = await history(id);
      expect(rows[0].link).toBeNull();
      expect(rows.slice(1)).toEqual([
        expect.objectContaining({
          from_state: 'todo',
          to_state: 'todo',
          link: {
            action: 'added',
            kind: 'derived_from',
            from_task_id: a.id,
            to_task_id: b.id,
          },
        }),
        expect.objectContaining({
          link: {
            action: 'removed',
            kind: 'derived_from',
            from_task_id: a.id,
            to_task_id: b.id,
          },
        }),
      ]);
    }
  });
});

describe('GET /api/v1/tasks link filters', () => {
  test('linked_from, linked_to and link_kind', async () => {
    const old = await createTask('old decision');
    const replacement = await createTask('new decision');
    const split = await createTask('split');
    expect((await addLink(replacement.id, old.id, 'supersedes')).status).toBe(
      201
    );
    expect((await addLink(split.id, replacement.id)).status).toBe(201);

    expect(await listedIds(`linked_from=${replacement.id}`)).toEqual([old.id]);
    expect(await listedIds(`linked_to=${replacement.id}`)).toEqual([split.id]);
    expect(await listedIds(`linked_to=${old.id}&link_kind=supersedes`)).toEqual(
      [replacement.id]
    );
    expect(
      await listedIds(`linked_to=${old.id}&link_kind=derived_from`)
    ).toEqual([]);

    const unsuperseded = await listedIds(
      'linked_from=none&link_kind=supersedes'
    );
    expect(unsuperseded).toEqual(
      expect.arrayContaining([replacement.id, split.id])
    );
    expect(unsuperseded).not.toContain(old.id);

    const superseded = await listedIds('linked_from=any&link_kind=supersedes');
    expect(superseded).toContain(old.id);
    expect(superseded).not.toContain(replacement.id);

    expect(await listedIds('linked_from=task_doesnotexist')).toEqual([]);
  });

  test('link_kind alone is a bad request', async () => {
    const res = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks?project_id=${projectId}&link_kind=supersedes`
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});
