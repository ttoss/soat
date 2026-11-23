import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

let adminToken: string;
let userToken: string;
let noPermToken: string;
let projectId: string;
let otherProjectId: string;

/** Every task a test created, by id, so a graph's ids read as titles. */
const titleOf = new Map<string, string>();

type Edge = { task_id: string; depends_on_task_id: string };

const createWorkflow = async (
  name: string,
  project = projectId,
  token = userToken
) => {
  const res = await authenticatedTestClient(token)
    .post('/api/v1/workflows')
    .send({
      project_id: project,
      name,
      states: [
        { name: 'todo', initial: true },
        { name: 'done', terminal: true },
      ],
      transitions: [{ name: 'finish', from: ['todo'], to: 'done' }],
    });
  expect(res.status).toBe(201);
  return res.body.id as string;
};

const createTask = async (args: {
  workflowId: string;
  title: string;
  metadata?: Record<string, string>;
  project?: string;
  token?: string;
}) => {
  const res = await authenticatedTestClient(args.token ?? userToken)
    .post('/api/v1/tasks')
    .send({
      project_id: args.project ?? projectId,
      workflow_id: args.workflowId,
      title: args.title,
      metadata: args.metadata,
    });
  expect(res.status).toBe(201);
  titleOf.set(res.body.id, args.title);
  return res.body.id as string;
};

/** `taskId` waits on `dependsOnTaskId`. */
const dependOn = async (taskId: string, dependsOnTaskId: string) => {
  const res = await authenticatedTestClient(userToken)
    .post(`/api/v1/tasks/${taskId}/dependencies`)
    .send({ depends_on_task_id: dependsOnTaskId });
  expect(res.status).toBe(201);
};

const finish = async (taskId: string) => {
  const res = await authenticatedTestClient(userToken)
    .post(`/api/v1/tasks/${taskId}/transitions`)
    .send({ transition: 'finish' });
  expect(res.status).toBe(200);
};

const nodeTitles = (ids: string[]) => {
  return ids
    .map((id) => {
      return titleOf.get(id) ?? id;
    })
    .sort();
};

const titles = (items: { title: string }[]) => {
  return items
    .map((item) => {
      return item.title;
    })
    .sort();
};

/**
 * A milestone over a diamond: `milestone` waits on `a` and `b`, both wait on
 * `base`; `unrelated` sits beside it.
 */
const diamond = async (name: string) => {
  const wf = await createWorkflow(name);
  const milestone = await createTask({
    workflowId: wf,
    title: 'milestone',
    metadata: { kind: 'milestone' },
  });
  const a = await createTask({ workflowId: wf, title: 'a' });
  const b = await createTask({ workflowId: wf, title: 'b' });
  const base = await createTask({ workflowId: wf, title: 'base' });
  await createTask({ workflowId: wf, title: 'unrelated' });
  await dependOn(milestone, a);
  await dependOn(milestone, b);
  await dependOn(a, base);
  await dependOn(b, base);
  return { wf, milestone, a, b, base };
};

beforeAll(async () => {
  const setup = await setupProjectWithUsers({
    prefix: 'taskgraph',
    policyActions: [
      'workflows:CreateWorkflow',
      'tasks:CreateTask',
      'tasks:GetTask',
      'tasks:ListTasks',
      'tasks:TransitionTask',
      'tasks:UpdateTaskDependencies',
    ],
    createOtherProject: true,
    createNoPermUser: true,
  });
  adminToken = setup.adminToken;
  userToken = setup.userToken;
  noPermToken = setup.noPermToken as string;
  projectId = setup.projectId;
  otherProjectId = setup.otherProjectId as string;
});

describe('GET /api/v1/tasks?upstream_of=', () => {
  test('lists the transitive dependencies, without the task itself', async () => {
    const { wf, milestone } = await diamond('upstream list');

    const res = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks?workflow_id=${wf}&upstream_of=${milestone}`
    );
    expect(res.status).toBe(200);
    expect(titles(res.body.data)).toEqual(['a', 'b', 'base']);
  });

  test('composes with blocked=false and order=next to pull within a milestone', async () => {
    const { wf, milestone } = await diamond('upstream pull');

    const res = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks?workflow_id=${wf}&upstream_of=${milestone}&blocked=false&order=next`
    );
    expect(res.status).toBe(200);
    expect(titles(res.body.data)).toEqual(['base']);
  });

  test('walks through closed tasks to what they depended on', async () => {
    const { wf, milestone, a, base } = await diamond('upstream closed');
    await finish(base);
    await finish(a);

    const open = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks?workflow_id=${wf}&upstream_of=${milestone}&status=open`
    );
    expect(titles(open.body.data)).toEqual(['b']);

    const all = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks?workflow_id=${wf}&upstream_of=${milestone}`
    );
    expect(titles(all.body.data)).toEqual(['a', 'b', 'base']);
  });

  test('an unknown task lists nothing', async () => {
    const res = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks?project_id=${projectId}&upstream_of=task_unknown0000000`
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  test('pages by cursor with the filter kept', async () => {
    const { wf, milestone } = await diamond('upstream pages');

    const first = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks?workflow_id=${wf}&upstream_of=${milestone}&limit=2`
    );
    expect(first.body.data).toHaveLength(2);
    const second = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks?workflow_id=${wf}&upstream_of=${milestone}&limit=2&cursor=${first.body.next_cursor}`
    );
    expect(titles([...first.body.data, ...second.body.data])).toEqual([
      'a',
      'b',
      'base',
    ]);
  });
});

describe('GET /api/v1/tasks/graph', () => {
  test('answers the ids of the filtered tasks and the edges between them', async () => {
    const { wf, milestone, a, b, base } = await diamond('graph all');

    const res = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks/graph?workflow_id=${wf}`
    );
    expect(res.status).toBe(200);
    const nodes = res.body.data.nodes as string[];
    expect(nodeTitles(nodes)).toEqual([
      'a',
      'b',
      'base',
      'milestone',
      'unrelated',
    ]);
    expect(nodes[0]).toMatch(/^task_/);
    const edges = (res.body.data.edges as Edge[])
      .map((edge) => {
        return `${edge.task_id}>${edge.depends_on_task_id}`;
      })
      .sort();
    expect(edges).toEqual(
      [
        `${milestone}>${a}`,
        `${milestone}>${b}`,
        `${a}>${base}`,
        `${b}>${base}`,
      ].sort()
    );
  });

  test('upstream_of answers a milestone subgraph', async () => {
    const { wf, milestone } = await diamond('graph upstream');

    const res = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks/graph?workflow_id=${wf}&upstream_of=${milestone}`
    );
    expect(res.status).toBe(200);
    expect(nodeTitles(res.body.data.nodes)).toEqual(['a', 'b', 'base']);
    expect(res.body.data.edges).toHaveLength(2);
  });

  test('an edge to a task the filters leave out is not answered', async () => {
    const { wf, base } = await diamond('graph filtered');
    await finish(base);

    const res = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks/graph?workflow_id=${wf}&status=open`
    );
    expect(nodeTitles(res.body.data.nodes)).toEqual([
      'a',
      'b',
      'milestone',
      'unrelated',
    ]);
    expect(res.body.data.edges).toHaveLength(2);
  });

  test('filters by metadata, as the list does', async () => {
    const { wf } = await diamond('graph metadata');
    const metadata = encodeURIComponent(JSON.stringify({ kind: 'milestone' }));

    const res = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks/graph?workflow_id=${wf}&metadata=${metadata}`
    );
    expect(nodeTitles(res.body.data.nodes)).toEqual(['milestone']);
    expect(res.body.data.edges).toEqual([]);
  });

  test('is not read as a task id', async () => {
    const res = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks/graph?project_id=${projectId}`
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      nodes: expect.any(Array),
      edges: expect.any(Array),
    });
  });

  test('refuses above the ceiling instead of truncating', async () => {
    const previous = process.env.TASK_GRAPH_LIMIT;
    process.env.TASK_GRAPH_LIMIT = '2';
    try {
      const { wf } = await diamond('graph ceiling');
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/tasks/graph?workflow_id=${wf}`
      );
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('TASK_GRAPH_TOO_LARGE');
      expect(res.body.error.meta).toEqual({ count: 5, limit: 2 });
    } finally {
      if (previous === undefined) delete process.env.TASK_GRAPH_LIMIT;
      else process.env.TASK_GRAPH_LIMIT = previous;
    }
  });

  test('answers only the projects the caller reads', async () => {
    const wf = await createWorkflow('graph other', otherProjectId, adminToken);
    await createTask({
      workflowId: wf,
      title: 'elsewhere',
      project: otherProjectId,
      token: adminToken,
    });

    await diamond('graph scoped');
    const scopedToken = await createScopedPrincipal({
      adminToken,
      projectId,
      username: 'taskgraphscoped',
      actions: ['tasks:ListTasks'],
    });

    const res = await authenticatedTestClient(scopedToken).get(
      '/api/v1/tasks/graph'
    );
    expect(res.status).toBe(200);
    const seen = nodeTitles(res.body.data.nodes);
    expect(seen).toContain('milestone');
    expect(seen).not.toContain('elsewhere');
  });

  test('refuses order, limit and cursor', async () => {
    const res = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks/graph?project_id=${projectId}&order=next`
    );
    expect(res.status).toBe(400);
  });

  test('401 without a credential', async () => {
    const res = await testClient.get('/api/v1/tasks/graph');
    expect(res.status).toBe(401);
  });

  test('an empty graph without tasks:ListTasks', async () => {
    await diamond('graph no permission');
    const res = await authenticatedTestClient(noPermToken).get(
      '/api/v1/tasks/graph'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { nodes: [], edges: [] } });
  });
});
