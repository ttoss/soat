import { db } from 'src/db';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

let userToken: string;
let noPermToken: string;
let projectId: string;

type ListedTask = { id: string; title: string };

const createWorkflow = async (name: string) => {
  const res = await authenticatedTestClient(userToken)
    .post('/api/v1/workflows')
    .send({
      project_id: projectId,
      name,
      states: [
        { name: 'todo', initial: true },
        { name: 'doing' },
        { name: 'done', terminal: true },
      ],
      transitions: [
        { name: 'start', from: ['todo'], to: 'doing' },
        { name: 'finish', from: ['todo', 'doing'], to: 'done' },
      ],
    });
  expect(res.status).toBe(201);
  return res.body.id as string;
};

const createTask = async (args: {
  workflowId: string;
  title: string;
  priority?: string;
}) => {
  const res = await authenticatedTestClient(userToken)
    .post('/api/v1/tasks')
    .send({
      project_id: projectId,
      workflow_id: args.workflowId,
      title: args.title,
    });
  expect(res.status).toBe(201);
  if (args.priority) {
    const set = await authenticatedTestClient(userToken)
      .put(`/api/v1/tasks/${res.body.id}/priority`)
      .send({ priority: args.priority });
    expect(set.status).toBe(200);
  }
  return res.body.id as string;
};

/** `taskId` waits on `dependsOnTaskId`: the latter blocks the former. */
const dependOn = async (taskId: string, dependsOnTaskId: string) => {
  const res = await authenticatedTestClient(userToken)
    .post(`/api/v1/tasks/${taskId}/dependencies`)
    .send({ depends_on_task_id: dependsOnTaskId });
  expect(res.status).toBe(201);
};

const listNext = (query: string, token = userToken) => {
  return authenticatedTestClient(token).get(
    `/api/v1/tasks?project_id=${projectId}&order=next&${query}`
  );
};

const titlesOf = (body: { data: ListedTask[] }) => {
  return body.data.map((task) => {
    return task.title;
  });
};

beforeAll(async () => {
  const setup = await setupProjectWithUsers({
    prefix: 'taskpull',
    policyActions: [
      'workflows:CreateWorkflow',
      'tasks:CreateTask',
      'tasks:GetTask',
      'tasks:ListTasks',
      'tasks:TransitionTask',
      'tasks:SetTaskPriority',
      'tasks:UpdateTaskDependencies',
    ],
    createNoPermUser: true,
  });
  userToken = setup.userToken;
  noPermToken = setup.noPermToken as string;
  projectId = setup.projectId;
});

describe('GET /api/v1/tasks?order=next', () => {
  test('a task inherits the priority of the open chain it blocks', async () => {
    const wf = await createWorkflow('pull chain');
    const root = await createTask({ workflowId: wf, title: 'root' });
    const middle = await createTask({ workflowId: wf, title: 'middle' });
    const leaf = await createTask({
      workflowId: wf,
      title: 'leaf',
      priority: 'high',
    });
    await createTask({ workflowId: wf, title: 'medium', priority: 'medium' });
    await dependOn(middle, root);
    await dependOn(leaf, middle);

    const res = await listNext(`workflow_id=${wf}`);
    expect(res.status).toBe(200);
    expect(titlesOf(res.body)).toEqual(['root', 'middle', 'leaf', 'medium']);
    expect(res.body.data[0].id).toBe(root);
    expect(res.body.data[0]).not.toHaveProperty('effective_priority');
  });

  test('a closed dependent lends no priority', async () => {
    const wf = await createWorkflow('pull closed dependent');
    const root = await createTask({ workflowId: wf, title: 'root' });
    const done = await createTask({
      workflowId: wf,
      title: 'done',
      priority: 'very_high',
    });
    await createTask({ workflowId: wf, title: 'low', priority: 'low' });
    await dependOn(done, root);
    const finish = await authenticatedTestClient(userToken)
      .post(`/api/v1/tasks/${done}/transitions`)
      .send({ transition: 'finish' });
    expect(finish.status).toBe(200);

    const res = await listNext(`workflow_id=${wf}&status=open`);
    expect(titlesOf(res.body)).toEqual(['low', 'root']);
  });

  test('a task nobody prioritised sorts below very_low', async () => {
    const wf = await createWorkflow('pull null last');
    await createTask({ workflowId: wf, title: 'none' });
    await createTask({
      workflowId: wf,
      title: 'very_low',
      priority: 'very_low',
    });

    const res = await listNext(`workflow_id=${wf}`);
    expect(titlesOf(res.body)).toEqual(['very_low', 'none']);
  });

  test('ties break on unblocks, then on the oldest entered_state_at', async () => {
    const wf = await createWorkflow('pull ties');
    const older = await createTask({ workflowId: wf, title: 'older' });
    const newer = await createTask({ workflowId: wf, title: 'newer' });
    const holder = await createTask({ workflowId: wf, title: 'holder' });
    await dependOn(older, holder);
    await dependOn(newer, holder);
    const held = await createTask({ workflowId: wf, title: 'held-twice' });
    await dependOn(held, older);
    await dependOn(held, newer);

    const res = await listNext(`workflow_id=${wf}&blocked=false`);
    expect(titlesOf(res.body)).toEqual(['holder']);

    const all = await listNext(`workflow_id=${wf}`);
    expect(titlesOf(all.body)).toEqual([
      'holder',
      'older',
      'newer',
      'held-twice',
    ]);
  });

  test('composes with state, blocked and priority filters', async () => {
    const wf = await createWorkflow('pull filters');
    const blocker = await createTask({
      workflowId: wf,
      title: 'blocker',
      priority: 'low',
    });
    const blocked = await createTask({
      workflowId: wf,
      title: 'blocked',
      priority: 'very_high',
    });
    await createTask({ workflowId: wf, title: 'free', priority: 'medium' });
    const started = await createTask({
      workflowId: wf,
      title: 'started',
      priority: 'very_high',
    });
    await dependOn(blocked, blocker);
    const start = await authenticatedTestClient(userToken)
      .post(`/api/v1/tasks/${started}/transitions`)
      .send({ transition: 'start' });
    expect(start.status).toBe(200);

    const res = await listNext(`workflow_id=${wf}&state=todo&blocked=false`);
    expect(titlesOf(res.body)).toEqual(['blocker', 'free']);

    const low = await listNext(`workflow_id=${wf}&priority=low`);
    expect(titlesOf(low.body)).toEqual(['blocker']);
  });

  test('answers one page: limit applies and there is no next cursor', async () => {
    const wf = await createWorkflow('pull page');
    await createTask({ workflowId: wf, title: 'a', priority: 'high' });
    await createTask({ workflowId: wf, title: 'b', priority: 'low' });
    await createTask({ workflowId: wf, title: 'c' });

    const res = await listNext(`workflow_id=${wf}&limit=2`);
    expect(res.status).toBe(200);
    expect(titlesOf(res.body)).toEqual(['a', 'b']);
    expect(res.body.next_cursor).toBeNull();
  });

  test('refuses a cursor', async () => {
    const wf = await createWorkflow('pull cursor');
    await createTask({ workflowId: wf, title: 'a' });
    await createTask({ workflowId: wf, title: 'b' });
    const page = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks?project_id=${projectId}&workflow_id=${wf}&limit=1`
    );
    expect(page.body.next_cursor).toEqual(expect.any(String));

    const res = await listNext(
      `workflow_id=${wf}&cursor=${page.body.next_cursor}`
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  test('refuses an order outside the set', async () => {
    const res = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks?project_id=${projectId}&order=oldest`
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  test('omitted, the list stays newest first', async () => {
    const wf = await createWorkflow('pull default');
    await createTask({ workflowId: wf, title: 'first', priority: 'very_high' });
    await createTask({ workflowId: wf, title: 'second' });

    const res = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks?project_id=${projectId}&workflow_id=${wf}`
    );
    expect(titlesOf(res.body)).toEqual(['second', 'first']);
  });

  test('a page of 20 is ordered in as many queries as a page of 1', async () => {
    const wf = await createWorkflow('pull queries');
    const ids: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      ids.push(await createTask({ workflowId: wf, title: `row-${index}` }));
    }
    for (let index = 1; index < ids.length; index += 1) {
      await dependOn(ids[index], ids[index - 1]);
    }

    const queriesFor = async (limit: number) => {
      let count = 0;
      const hook = (_options: unknown, query: object) => {
        const sql =
          'sql' in query && typeof query.sql === 'string' ? query.sql : '';
        if (/\b(tasks|task_dependencies)\b/.test(sql)) count += 1;
      };
      db.sequelize.addHook('afterQuery', 'countPullQueries', hook);
      try {
        const res = await listNext(`workflow_id=${wf}&limit=${limit}`);
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(limit);
      } finally {
        db.sequelize.removeHook('afterQuery', 'countPullQueries');
      }
      return count;
    };

    expect(await queriesFor(20)).toBe(await queriesFor(1));
  });

  test('401 without credentials', async () => {
    const res = await testClient.get(
      `/api/v1/tasks?project_id=${projectId}&order=next`
    );
    expect(res.status).toBe(401);
  });

  test('403 for a caller without tasks:ListTasks', async () => {
    const res = await listNext('', noPermToken);
    expect(res.status).toBe(403);
  });
});
