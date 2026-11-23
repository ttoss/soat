import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * `workflow_id` pins a task call to one workflow: a task of another workflow
 * is `404` on every by-id route, so a `builtin` tool presetting it confines
 * every task action it binds, not only the listing.
 */

let token: string;
let projectId: string;
let pinnedWorkflowId: string;
let otherWorkflowId: string;
let toolId: string;
let workflowSeq = 0;

const TASK_ACTIONS = [
  'list-tasks',
  'get-task',
  'get-task-history',
  'list-task-transitions',
  'list-task-dependencies',
  'list-task-dependents',
  'update-task',
  'transition-task',
  'set-task-priority',
  'pause-task',
  'resume-task',
  'migrate-task',
  'delete-task',
  'add-task-dependency',
  'remove-task-dependency',
];

const createWorkflow = async (): Promise<string> => {
  workflowSeq += 1;
  const res = await authenticatedTestClient(token)
    .post('/api/v1/workflows')
    .send({
      project_id: projectId,
      name: `workflow-pin-${workflowSeq}`,
      states: [
        { name: 'todo', initial: true },
        { name: 'done', terminal: true },
      ],
      transitions: [{ name: 'finish', from: ['todo'], to: 'done' }],
    });
  expect(res.status).toBe(201);
  return res.body.id as string;
};

const createTask = async (workflowId: string): Promise<string> => {
  const res = await authenticatedTestClient(token)
    .post('/api/v1/tasks')
    .send({ project_id: projectId, workflow_id: workflowId, title: 'task' });
  expect(res.status).toBe(201);
  return res.body.id as string;
};

const callTool = (action: string, input: Record<string, unknown>) => {
  return authenticatedTestClient(token)
    .post(`/api/v1/tools/${toolId}/call`)
    .send({ action, input });
};

beforeAll(async () => {
  const setup = await setupProjectWithUsers({
    prefix: 'taskworkflowpin',
    policyActions: ['tasks:*', 'workflows:*', 'tools:*'],
    createNoPermUser: false,
  });
  token = setup.userToken;
  projectId = setup.projectId;
  pinnedWorkflowId = await createWorkflow();
  otherWorkflowId = await createWorkflow();

  const tool = await authenticatedTestClient(token)
    .post('/api/v1/tools')
    .send({
      project_id: projectId,
      name: 'pinned-tasks',
      type: 'builtin',
      actions: TASK_ACTIONS,
      preset_parameters: { workflow_id: pinnedWorkflowId },
    });
  expect(tool.status).toBe(201);
  toolId = tool.body.id;
});

describe('GET /api/v1/tasks/{task_id}?workflow_id=', () => {
  test('answers a task of the pinned workflow', async () => {
    const taskId = await createTask(pinnedWorkflowId);
    const res = await authenticatedTestClient(token).get(
      `/api/v1/tasks/${taskId}?workflow_id=${pinnedWorkflowId}`
    );
    expect(res.status).toBe(200);
  });

  test('is 404 for a task of another workflow', async () => {
    const taskId = await createTask(otherWorkflowId);
    const res = await authenticatedTestClient(token).get(
      `/api/v1/tasks/${taskId}?workflow_id=${pinnedWorkflowId}`
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('TASK_NOT_FOUND');
  });
});

describe('a builtin tool presetting workflow_id', () => {
  const BY_ID: Array<[string, (taskId: string) => Record<string, unknown>]> = [
    [
      'get-task',
      (id) => {
        return { task_id: id };
      },
    ],
    [
      'get-task-history',
      (id) => {
        return { task_id: id };
      },
    ],
    [
      'list-task-transitions',
      (id) => {
        return { task_id: id };
      },
    ],
    [
      'list-task-dependencies',
      (id) => {
        return { task_id: id };
      },
    ],
    [
      'list-task-dependents',
      (id) => {
        return { task_id: id };
      },
    ],
    [
      'update-task',
      (id) => {
        return { task_id: id, title: 'rewritten' };
      },
    ],
    [
      'transition-task',
      (id) => {
        return { task_id: id, transition: 'finish' };
      },
    ],
    [
      'set-task-priority',
      (id) => {
        return { task_id: id, priority: 'high' };
      },
    ],
    [
      'pause-task',
      (id) => {
        return { task_id: id };
      },
    ],
    [
      'resume-task',
      (id) => {
        return { task_id: id };
      },
    ],
    [
      'migrate-task',
      (id) => {
        return { task_id: id, to_version: 2 };
      },
    ],
    [
      'delete-task',
      (id) => {
        return { task_id: id };
      },
    ],
  ];

  test.each(BY_ID)(
    '%s is 404 for a task of another workflow',
    async (action, input) => {
      const taskId = await createTask(otherWorkflowId);
      const res = await callTool(action, input(taskId));
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).toMatch(/TASK_NOT_FOUND/);

      const unchanged = await authenticatedTestClient(token).get(
        `/api/v1/tasks/${taskId}`
      );
      expect(unchanged.status).toBe(200);
      expect(unchanged.body.title).toBe('task');
      expect(unchanged.body.state).toBe('todo');
    }
  );

  test('get-task answers a task of the pinned workflow', async () => {
    const taskId = await createTask(pinnedWorkflowId);
    const res = await callTool('get-task', { task_id: taskId });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(taskId);
  });

  test('add-task-dependency is 404 when the dependent is outside the pin', async () => {
    const outside = await createTask(otherWorkflowId);
    const inside = await createTask(pinnedWorkflowId);
    const res = await callTool('add-task-dependency', {
      task_id: outside,
      depends_on_task_id: inside,
    });
    expect(res.status).toBe(404);
  });

  test('add-task-dependency is 404 when the dependency is outside the pin', async () => {
    const inside = await createTask(pinnedWorkflowId);
    const outside = await createTask(otherWorkflowId);
    const res = await callTool('add-task-dependency', {
      task_id: inside,
      depends_on_task_id: outside,
    });
    expect(res.status).toBe(404);
  });

  test.each([
    ['the dependent', true],
    ['the dependency', false],
  ])(
    'remove-task-dependency is 404 when %s is outside the pin',
    async (_end, dependentOutside) => {
      const outside = await createTask(otherWorkflowId);
      const inside = await createTask(pinnedWorkflowId);
      const [taskId, dependsOnTaskId] = dependentOutside
        ? [outside, inside]
        : [inside, outside];
      const added = await authenticatedTestClient(token)
        .post(`/api/v1/tasks/${taskId}/dependencies`)
        .send({ depends_on_task_id: dependsOnTaskId });
      expect(added.status).toBe(201);

      const res = await callTool('remove-task-dependency', {
        task_id: taskId,
        depends_on_task_id: dependsOnTaskId,
      });
      expect(res.status).toBe(404);

      const still = await authenticatedTestClient(token).get(
        `/api/v1/tasks/${taskId}/dependencies`
      );
      expect(still.body.data).toHaveLength(1);
    }
  );

  test('add-task-dependency joins two tasks of the pinned workflow', async () => {
    const a = await createTask(pinnedWorkflowId);
    const b = await createTask(pinnedWorkflowId);
    const res = await callTool('add-task-dependency', {
      task_id: a,
      depends_on_task_id: b,
    });
    expect(res.status).toBe(200);
  });
});
