import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { captureEvents } from '../../fixtures/eventCapture';
import { authenticatedTestClient } from '../../testClient';

/**
 * A state's `max_tasks` caps the open tasks it holds: every entry into a full
 * state (create, transition, migration) answers `409 TASK_STATE_FULL` and
 * leaves the task where it was.
 */

let userToken: string;
let projectId: string;
let workflowSeq = 0;

const STATES = [
  { name: 'todo', initial: true },
  { name: 'doing', max_tasks: 1 },
  { name: 'done', terminal: true },
];

const TRANSITIONS = [
  { name: 'start', from: ['todo'], to: 'doing' },
  { name: 'retouch', from: ['doing'], to: 'doing' },
  { name: 'finish', from: ['doing'], to: 'done' },
  { name: 'start_gated', from: ['todo'], to: 'doing', requires_approval: true },
];

const client = () => {
  return authenticatedTestClient(userToken);
};

const postWorkflow = (body: object) => {
  workflowSeq += 1;
  return client()
    .post('/api/v1/workflows')
    .send({
      project_id: projectId,
      name: `capacity-${workflowSeq}`,
      states: STATES,
      transitions: TRANSITIONS,
      ...body,
    });
};

const createWorkflow = async (body: object = {}) => {
  const res = await postWorkflow(body);
  expect(res.status).toBe(201);
  return res.body as { id: string; version: number };
};

const postTask = (workflowId: string, body: object = {}) => {
  return client()
    .post('/api/v1/tasks')
    .send({
      project_id: projectId,
      workflow_id: workflowId,
      title: 'capacity task',
      ...body,
    });
};

const createTask = async (workflowId: string, body: object = {}) => {
  const res = await postTask(workflowId, body);
  expect(res.status).toBe(201);
  return res.body.id as string;
};

const transition = (taskId: string, name: string) => {
  return client()
    .post(`/api/v1/tasks/${taskId}/transitions`)
    .send({ transition: name });
};

const stateOf = async (taskId: string) => {
  const res = await client().get(`/api/v1/tasks/${taskId}`);
  expect(res.status).toBe(200);
  return res.body.state as string;
};

/** A workflow whose `doing` holds one task, and that task. */
const fullDoing = async () => {
  const workflow = await createWorkflow();
  const holder = await createTask(workflow.id);
  expect((await transition(holder, 'start')).status).toBe(200);
  return { workflow, holder };
};

beforeAll(async () => {
  const setup = await setupProjectWithUsers({
    prefix: 'taskcap',
    policyActions: [
      'workflows:CreateWorkflow',
      'workflows:GetWorkflow',
      'workflows:UpdateWorkflow',
      'tasks:CreateTask',
      'tasks:GetTask',
      'tasks:TransitionTask',
      'tasks:MigrateTask',
      'approvals:ListApprovals',
      'approvals:GetApproval',
      'approvals:ResolveApproval',
    ],
  });
  userToken = setup.userToken;
  projectId = setup.projectId;
});

describe('POST /api/v1/workflows — max_tasks', () => {
  test('reads back on the workflow and its version; absent means no limit', async () => {
    const workflow = await createWorkflow();

    const read = await client().get(`/api/v1/workflows/${workflow.id}`);
    expect(read.status).toBe(200);
    expect(read.body.states[1]).toEqual({ name: 'doing', max_tasks: 1 });
    expect(read.body.states[0]).not.toHaveProperty('max_tasks');

    const version = await client().get(
      `/api/v1/workflows/${workflow.id}/versions/${workflow.version}`
    );
    expect(version.status).toBe(200);
    expect(version.body.config.states[1].max_tasks).toBe(1);
  });

  test.each([0, -1, 1.5])('refuses max_tasks %p', async (maxTasks) => {
    const res = await postWorkflow({
      states: [
        { name: 'todo', initial: true, max_tasks: maxTasks },
        { name: 'done', terminal: true },
      ],
      transitions: [{ name: 'finish', from: ['todo'], to: 'done' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WORKFLOW_VALIDATION_FAILED');
    expect(res.body.error.meta.problems).toEqual([
      expect.objectContaining({
        code: 'INVALID_VALUE',
        path: 'states[0].max_tasks',
      }),
    ]);
  });

  test('refuses max_tasks on a terminal state', async () => {
    const res = await postWorkflow({
      states: [
        { name: 'todo', initial: true },
        { name: 'done', terminal: true, max_tasks: 3 },
      ],
      transitions: [{ name: 'finish', from: ['todo'], to: 'done' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.meta.problems).toEqual([
      expect.objectContaining({
        code: 'FIELD_NOT_ALLOWED',
        path: 'states[1].max_tasks',
      }),
    ]);
  });
});

describe('POST /api/v1/tasks/:task_id/transitions — into a full state', () => {
  test('answers 409 TASK_STATE_FULL naming the state and its limit; the task stays', async () => {
    const { workflow } = await fullDoing();
    const second = await createTask(workflow.id);

    const res = await transition(second, 'start');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TASK_STATE_FULL');
    expect(res.body.error.meta).toEqual({ state: 'doing', max_tasks: 1 });
    expect(await stateOf(second)).toBe('todo');
  });

  test('a task leaving the state frees its slot', async () => {
    const { workflow, holder } = await fullDoing();
    const second = await createTask(workflow.id);
    expect((await transition(holder, 'finish')).status).toBe(200);

    const res = await transition(second, 'start');
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('doing');
  });

  test('a move from the full state back to itself takes no slot', async () => {
    const { holder } = await fullDoing();

    const res = await transition(holder, 'retouch');
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('doing');
  });

  test('two entries racing for the last slot: one is accepted', async () => {
    const workflow = await createWorkflow();
    const first = await createTask(workflow.id);
    const second = await createTask(workflow.id);

    const statuses = (
      await Promise.all([
        transition(first, 'start'),
        transition(second, 'start'),
      ])
    )
      .map((res) => {
        return res.status;
      })
      .sort();
    expect(statuses).toEqual([200, 409]);
  });

  test('the limit counts tasks of every version of the workflow', async () => {
    const workflow = await createWorkflow({
      states: [
        { name: 'todo', initial: true },
        { name: 'doing' },
        { name: 'done', terminal: true },
      ],
    });
    const onV1 = await createTask(workflow.id);
    expect((await transition(onV1, 'start')).status).toBe(200);
    const patched = await client()
      .patch(`/api/v1/workflows/${workflow.id}`)
      .send({ states: STATES, transitions: TRANSITIONS });
    expect(patched.status).toBe(200);
    const onV2 = await createTask(workflow.id);

    const res = await transition(onV2, 'start');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TASK_STATE_FULL');
  });

  test('the transition list answers TASK_STATE_FULL for a move into the full state', async () => {
    const { workflow } = await fullDoing();
    const second = await createTask(workflow.id);

    const res = await client().get(`/api/v1/tasks/${second}/transitions`);
    expect(res.status).toBe(200);
    const start = res.body.data.find((t: { name: string }) => {
      return t.name === 'start';
    });
    expect(start).toMatchObject({
      allowed: false,
      error_code: 'TASK_STATE_FULL',
    });
  });

  test('an approved gate into a full state clears and emits tasks.approval_failed', async () => {
    const workflow = await createWorkflow();
    const gated = await createTask(workflow.id);
    const parked = await transition(gated, 'start_gated');
    expect(parked.status).toBe(200);
    expect(parked.body.pending_transition).toBe('start_gated');
    const holder = await createTask(workflow.id);
    expect((await transition(holder, 'start')).status).toBe(200);

    const approvals = await client().get(
      `/api/v1/approvals?project_id=${projectId}&status=pending`
    );
    const approval = approvals.body.data.find((a: { task_id: string }) => {
      return a.task_id === gated;
    });
    const [failed] = await captureEvents({
      type: 'tasks.approval_failed',
      where: (event) => {
        return event.resourceId === gated;
      },
      action: async () => {
        const approved = await client()
          .post(`/api/v1/approvals/${approval.id}/approve`)
          .send({});
        expect(approved.status).toBe(200);
      },
    });
    expect(failed.data.error_code).toBe('TASK_STATE_FULL');

    const after = await client().get(`/api/v1/tasks/${gated}`);
    expect(after.body.state).toBe('todo');
    expect(after.body.pending_transition).toBeNull();
  });
});

describe('POST /api/v1/tasks — into a full state', () => {
  test('a create into a full state is refused and makes no task', async () => {
    const workflow = await createWorkflow({
      states: [
        { name: 'todo', initial: true, max_tasks: 1 },
        { name: 'done', terminal: true },
      ],
      transitions: [{ name: 'finish', from: ['todo'], to: 'done' }],
    });
    await createTask(workflow.id);

    const res = await postTask(workflow.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TASK_STATE_FULL');
    expect(res.body.error.meta).toEqual({ state: 'todo', max_tasks: 1 });

    const list = await client().get(
      `/api/v1/tasks?project_id=${projectId}&workflow_id=${workflow.id}`
    );
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
  });

  test('a create into a full alternate state is refused', async () => {
    const { workflow } = await fullDoing();

    const res = await postTask(workflow.id, { state: 'doing' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TASK_STATE_FULL');
  });
});

describe('POST /api/v1/tasks/:task_id/migrate — into a full state', () => {
  const V1 = {
    states: [
      { name: 'todo', initial: true },
      { name: 'queued' },
      { name: 'doing' },
      { name: 'done', terminal: true },
    ],
    transitions: [
      { name: 'queue', from: ['todo'], to: 'queued' },
      { name: 'start', from: ['todo'], to: 'doing' },
    ],
  };

  test('mapping a task into a full state is refused; it stays on its version', async () => {
    const workflow = await createWorkflow(V1);
    const holder = await createTask(workflow.id);
    expect((await transition(holder, 'start')).status).toBe(200);
    const queued = await createTask(workflow.id);
    expect((await transition(queued, 'queue')).status).toBe(200);
    const patched = await client()
      .patch(`/api/v1/workflows/${workflow.id}`)
      .send({ states: STATES, transitions: TRANSITIONS });
    expect(patched.status).toBe(200);

    const res = await client()
      .post(`/api/v1/tasks/${queued}/migrate`)
      .send({ to_version: 2, state_map: { queued: 'doing' } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TASK_STATE_FULL');
    const after = await client().get(`/api/v1/tasks/${queued}`);
    expect(after.body).toMatchObject({ state: 'queued', workflow_version: 1 });
  });

  test('a task kept in a state over a lowered limit keeps its slot', async () => {
    const workflow = await createWorkflow(V1);
    const first = await createTask(workflow.id);
    const second = await createTask(workflow.id);
    expect((await transition(first, 'start')).status).toBe(200);
    expect((await transition(second, 'start')).status).toBe(200);
    const patched = await client()
      .patch(`/api/v1/workflows/${workflow.id}`)
      .send({ states: STATES, transitions: TRANSITIONS });
    expect(patched.status).toBe(200);

    for (const taskId of [first, second]) {
      const res = await client()
        .post(`/api/v1/tasks/${taskId}/migrate`)
        .send({ to_version: 2 });
      expect(res.status).toBe(200);
      expect(res.body.state).toBe('doing');
    }
  });
});
