import { db } from 'src/db';
import { flushTaskAutomations } from 'src/lib/tasks';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { asWire, captureEvents } from '../../fixtures/eventCapture';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * A task is pinned to the workflow version it entered on; `migrate` is the one
 * explicit move onto a newer version. Every test builds v1, edits the workflow
 * to v2, and asserts which machine the task runs on afterwards.
 */

let adminToken: string;
let userToken: string;
let noPermToken: string;
let projectId: string;
let agentId: string;
let workflowSeq = 0;

const V1_STATES = [
  { name: 'triage', initial: true },
  { name: 'review', kind: 'human' },
  { name: 'published', terminal: true },
];

const V1_TRANSITIONS = [
  { name: 'to_review', from: ['triage'], to: 'review' },
  {
    name: 'publish',
    from: ['review'],
    to: 'published',
    requires_approval: true,
  },
];

const createWorkflow = async (overrides: object = {}) => {
  workflowSeq += 1;
  const res = await authenticatedTestClient(userToken)
    .post('/api/v1/workflows')
    .send({
      project_id: projectId,
      name: `migration-${workflowSeq}`,
      states: V1_STATES,
      transitions: V1_TRANSITIONS,
      ...overrides,
    });
  expect(res.status).toBe(201);
  return res.body as { id: string; version: number };
};

const updateWorkflow = async (workflowId: string, body: object) => {
  const res = await authenticatedTestClient(userToken)
    .patch(`/api/v1/workflows/${workflowId}`)
    .send(body);
  expect(res.status).toBe(200);
  return res.body as { version: number };
};

const createTask = async (workflowId: string, body: object = {}) => {
  const res = await authenticatedTestClient(userToken)
    .post('/api/v1/tasks')
    .send({
      project_id: projectId,
      workflow_id: workflowId,
      title: 'migrating task',
      ...body,
    });
  expect(res.status).toBe(201);
  return res.body as { id: string; workflow_version: number | null };
};

const transition = (taskId: string, name: string) => {
  return authenticatedTestClient(userToken)
    .post(`/api/v1/tasks/${taskId}/transitions`)
    .send({ transition: name });
};

const migrate = (taskId: string, body: object, token = userToken) => {
  return authenticatedTestClient(token)
    .post(`/api/v1/tasks/${taskId}/migrate`)
    .send(body);
};

/** A task in `review` on v1, with v2 adding a `reject` move out of `review`. */
const reviewTaskWithV2 = async () => {
  const workflow = await createWorkflow();
  const task = await createTask(workflow.id);
  expect((await transition(task.id, 'to_review')).status).toBe(200);
  await updateWorkflow(workflow.id, {
    states: [...V1_STATES, { name: 'rejected', terminal: true }],
    transitions: [
      ...V1_TRANSITIONS,
      { name: 'reject', from: ['review'], to: 'rejected' },
    ],
  });
  return { workflow, task };
};

const pollTask = async (args: {
  taskId: string;
  predicate: (task: Record<string, unknown>) => boolean;
}): Promise<Record<string, unknown>> => {
  for (let i = 0; i < 100; i += 1) {
    const res = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks/${args.taskId}`
    );
    if (res.status === 200 && args.predicate(res.body)) return res.body;
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error(`pollTask: predicate never held for ${args.taskId}`);
};

beforeAll(async () => {
  const setup = await setupProjectWithUsers({
    prefix: 'taskmig',
    policyActions: [
      'workflows:CreateWorkflow',
      'workflows:UpdateWorkflow',
      'tasks:CreateTask',
      'tasks:GetTask',
      'tasks:TransitionTask',
      'tasks:MigrateTask',
    ],
    createNoPermUser: true,
  });
  adminToken = setup.adminToken;
  userToken = setup.userToken;
  noPermToken = setup.noPermToken as string;
  projectId = setup.projectId;

  const aiProvider = await authenticatedTestClient(adminToken)
    .post('/api/v1/ai-providers')
    .send({
      project_id: projectId,
      name: 'Migration Provider',
      provider: 'ollama',
      default_model: 'llama3.2',
    });
  agentId = (
    await authenticatedTestClient(adminToken).post('/api/v1/agents').send({
      project_id: projectId,
      name: 'Migration Agent',
      ai_provider_id: aiProvider.body.id,
    })
  ).body.id;
});

afterEach(async () => {
  await flushTaskAutomations();
  jest.clearAllMocks();
});

describe('POST /api/v1/tasks/:task_id/migrate', () => {
  test('moves the task onto the target version, keeping a state both versions declare', async () => {
    const { task } = await reviewTaskWithV2();

    const res = await migrate(task.id, { to_version: 2 });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(task.id);
    expect(res.body.workflow_version).toBe(2);
    expect(res.body.state).toBe('review');
    expect(res.body.status).toBe('open');

    // The move v2 added is now available; on v1 it did not exist.
    const rejected = await transition(task.id, 'reject');
    expect(rejected.status).toBe(200);
    expect(rejected.body.state).toBe('rejected');
  });

  test('records the migration in history as a move with no transition, naming both versions', async () => {
    const { task } = await reviewTaskWithV2();
    expect((await migrate(task.id, { to_version: 2 })).status).toBe(200);

    const history = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks/${task.id}/history`
    );
    expect(history.status).toBe(200);
    const rows = history.body.data as Record<string, unknown>[];
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({
      transition: 'to_review',
      from_workflow_version: null,
      to_workflow_version: null,
    });
    expect(rows[2]).toMatchObject({
      from_state: 'review',
      to_state: 'review',
      transition: null,
      from_workflow_version: 1,
      to_workflow_version: 2,
      principal_type: 'user',
    });
    expect(rows[2].principal_id).toEqual(expect.any(String));
  });

  test('emits tasks.migrated with the task as GET answers it and the versions beside it', async () => {
    const { task } = await reviewTaskWithV2();

    const [event] = await captureEvents({
      type: 'tasks.migrated',
      where: (event) => {
        return event.resourceId === task.id;
      },
      action: () => {
        return migrate(task.id, { to_version: 2 });
      },
    });

    const read = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks/${task.id}`
    );
    expect(asWire(event.data)).toEqual({
      ...read.body,
      from_state: 'review',
      from_workflow_version: 1,
    });
  });

  test('a state the target lacks is moved through state_map', async () => {
    const workflow = await createWorkflow();
    const task = await createTask(workflow.id);
    expect((await transition(task.id, 'to_review')).status).toBe(200);
    await updateWorkflow(workflow.id, {
      states: [
        { name: 'triage', initial: true },
        { name: 'checking', kind: 'human' },
        { name: 'published', terminal: true },
      ],
      transitions: [
        { name: 'to_checking', from: ['triage'], to: 'checking' },
        { name: 'publish', from: ['checking'], to: 'published' },
      ],
    });

    const res = await migrate(task.id, {
      to_version: 2,
      state_map: { review: 'checking' },
    });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('checking');

    const published = await transition(task.id, 'publish');
    expect(published.status).toBe(200);
    expect(published.body.state).toBe('published');
  });

  test('a state the target lacks and state_map omits is refused, naming it', async () => {
    const workflow = await createWorkflow();
    const task = await createTask(workflow.id);
    expect((await transition(task.id, 'to_review')).status).toBe(200);
    await updateWorkflow(workflow.id, {
      states: [
        { name: 'triage', initial: true },
        { name: 'published', terminal: true },
      ],
      transitions: [{ name: 'publish', from: ['triage'], to: 'published' }],
    });

    const res = await migrate(task.id, { to_version: 2 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TASK_MIGRATION_STATE_UNMAPPED');
    expect(res.body.error.meta).toEqual({ state: 'review' });

    const read = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks/${task.id}`
    );
    expect(read.body.workflow_version).toBe(1);
    expect(read.body.state).toBe('review');
  });

  test('a state_map target the version does not declare is refused', async () => {
    const { task } = await reviewTaskWithV2();

    const res = await migrate(task.id, {
      to_version: 2,
      state_map: { review: 'nowhere' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TASK_STATE_NOT_FOUND');
    expect(res.body.error.meta).toEqual({ state: 'nowhere' });
  });

  test('a mapped terminal state is refused: a migration never closes a task', async () => {
    const { task } = await reviewTaskWithV2();

    const res = await migrate(task.id, {
      to_version: 2,
      state_map: { review: 'rejected' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');

    const read = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks/${task.id}`
    );
    expect(read.body.status).toBe('open');
    expect(read.body.workflow_version).toBe(1);
  });

  test('a payload the target payload_schema rejects is refused and the task stays put', async () => {
    const workflow = await createWorkflow();
    const task = await createTask(workflow.id, { payload: { note: 'hi' } });
    await updateWorkflow(workflow.id, {
      payload_schema: { type: 'object', required: ['ticket'] },
    });

    const res = await migrate(task.id, { to_version: 2 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TASK_PAYLOAD_INVALID');

    const read = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks/${task.id}`
    );
    expect(read.body.workflow_version).toBe(1);
  });

  test('the mapped state is entered without firing its on_enter', async () => {
    const workflow = await createWorkflow();
    const task = await createTask(workflow.id);
    expect((await transition(task.id, 'to_review')).status).toBe(200);
    await updateWorkflow(workflow.id, {
      states: [
        { name: 'triage', initial: true },
        {
          name: 'review',
          on_enter: {
            dispatch: {
              kind: 'agent',
              agent_id: agentId,
              input_mapping: { prompt: 'review it' },
            },
          },
        },
        { name: 'published', terminal: true },
      ],
    });

    const res = await migrate(task.id, { to_version: 2 });
    expect(res.status).toBe(200);
    await flushTaskAutomations();

    expect(mockCreateGeneration).not.toHaveBeenCalled();
    const read = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks/${task.id}`
    );
    expect(read.body.active_dispatch).toBeNull();
    expect(read.body.automation_status).toBeNull();
  });

  test('a task with a dispatch in flight is refused', async () => {
    type Generation = Awaited<
      Parameters<typeof mockCreateGeneration.mockResolvedValue>[0]
    >;
    let release: (value: Generation) => void = () => {};
    mockCreateGeneration.mockImplementationOnce(() => {
      return new Promise<Generation>((resolve) => {
        release = resolve;
      });
    });
    const workflow = await createWorkflow({
      states: [
        {
          name: 'writing',
          initial: true,
          on_enter: {
            dispatch: {
              kind: 'agent',
              agent_id: agentId,
              input_mapping: { prompt: 'write it' },
            },
          },
        },
        { name: 'done', terminal: true },
      ],
      transitions: [{ name: 'finish', from: ['writing'], to: 'done' }],
    });
    const task = await createTask(workflow.id);
    await pollTask({
      taskId: task.id,
      predicate: (t) => {
        return t.automation_status === 'running';
      },
    });
    await updateWorkflow(workflow.id, {
      transitions: [
        { name: 'finish', from: ['writing'], to: 'done' },
        { name: 'restart', from: ['writing'], to: 'writing' },
      ],
    });

    const res = await migrate(task.id, { to_version: 2 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TASK_MIGRATION_CONFLICT');

    release({
      id: 'gen_migration_in_flight',
      traceId: 'trc_migration_in_flight',
      status: 'completed',
      output: { model: 'm', content: 'done', finishReason: 'stop' },
    });
  });

  test('a task with a transition pending approval is refused', async () => {
    const { task } = await reviewTaskWithV2();
    const parked = await transition(task.id, 'publish');
    expect(parked.body.pending_transition).toBe('publish');

    const res = await migrate(task.id, { to_version: 2 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TASK_MIGRATION_CONFLICT');
    expect(res.body.error.meta).toEqual({ pending_transition: 'publish' });
  });

  test('a closed task is refused', async () => {
    const workflow = await createWorkflow({
      transitions: [{ name: 'publish', from: ['triage'], to: 'published' }],
    });
    const task = await createTask(workflow.id);
    expect((await transition(task.id, 'publish')).body.status).toBe('closed');
    await updateWorkflow(workflow.id, {
      states: [...V1_STATES, { name: 'archived', terminal: true }],
    });

    const res = await migrate(task.id, { to_version: 2 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TASK_MIGRATION_CONFLICT');
  });

  test('a version the workflow never had is refused', async () => {
    const { task } = await reviewTaskWithV2();

    const res = await migrate(task.id, { to_version: 9 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WORKFLOW_VERSION_NOT_FOUND');
    expect(res.body.error.meta).toEqual({ version: 9 });
  });

  test('a version no newer than the pinned one is refused', async () => {
    const { task } = await reviewTaskWithV2();
    expect((await migrate(task.id, { to_version: 2 })).status).toBe(200);

    const same = await migrate(task.id, { to_version: 2 });
    expect(same.status).toBe(400);
    expect(same.body.error.code).toBe('VALIDATION_FAILED');

    const older = await migrate(task.id, { to_version: 1 });
    expect(older.status).toBe(400);
    expect(older.body.error.code).toBe('VALIDATION_FAILED');
  });

  test('a task with no pinned version is pinned by the migration', async () => {
    const { task } = await reviewTaskWithV2();
    await db.Task.update(
      { workflowVersion: null },
      { where: { publicId: task.id } }
    );

    const res = await migrate(task.id, { to_version: 1 });
    expect(res.status).toBe(200);
    expect(res.body.workflow_version).toBe(1);

    const history = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks/${task.id}/history`
    );
    const rows = history.body.data as Record<string, unknown>[];
    expect(rows[rows.length - 1]).toMatchObject({
      from_workflow_version: null,
      to_workflow_version: 1,
    });
  });

  test('an unknown task is 404', async () => {
    const res = await migrate('task_doesnotexist0', { to_version: 2 });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('TASK_NOT_FOUND');
  });

  test('a missing to_version is 400', async () => {
    const { task } = await reviewTaskWithV2();
    const res = await migrate(task.id, {});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  test('401 without credentials', async () => {
    const { task } = await reviewTaskWithV2();
    const res = await testClient
      .post(`/api/v1/tasks/${task.id}/migrate`)
      .send({ to_version: 2 });
    expect(res.status).toBe(401);
  });

  test('403 without tasks:MigrateTask', async () => {
    const { task } = await reviewTaskWithV2();
    const res = await migrate(task.id, { to_version: 2 }, noPermToken);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');

    const read = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks/${task.id}`
    );
    expect(read.body.workflow_version).toBe(1);
  });
});
