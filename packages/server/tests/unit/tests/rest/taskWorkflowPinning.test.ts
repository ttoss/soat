import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A task runs on the state machine it entered on, not the one the workflow holds
 * now (issue #882).
 *
 * A task lives in a workflow for weeks, so an edit to the definition used to
 * reach every task already in flight: three read paths — the transition
 * validator, the approval gate, and payload validation — resolved `states` /
 * `transitions` / `payload_schema` from the live `Workflow` row. A task could be
 * stranded in a state that no longer existed, or refused a move that was legal
 * when it was created.
 *
 * Every test here creates a task on v1, edits the workflow to v2, and then drives
 * the task — so the assertion names *which definition ran*, not merely that the
 * call succeeded.
 */

let userToken: string;
let projectId: string;
let workflowSeq = 0;

const V1_STATES = [
  { name: 'triage', initial: true },
  { name: 'review', kind: 'human' },
  { name: 'published', terminal: true },
];

const V1_TRANSITIONS = [
  { name: 'to_review', from: ['triage'], to: 'review' },
  { name: 'publish', from: ['review'], to: 'published' },
];

const createWorkflow = async (overrides: object = {}) => {
  workflowSeq += 1;
  const res = await authenticatedTestClient(userToken)
    .post('/api/v1/workflows')
    .send({
      project_id: projectId,
      name: `pinning-${workflowSeq}`,
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
      title: 'pinned task',
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

beforeAll(async () => {
  const setup = await setupProjectWithUsers({
    prefix: 'taskpin',
    policyActions: [
      'workflows:CreateWorkflow',
      'workflows:UpdateWorkflow',
      'tasks:CreateTask',
      'tasks:GetTask',
      'tasks:UpdateTask',
      'tasks:TransitionTask',
    ],
    createNoPermUser: false,
  });
  userToken = setup.userToken;
  projectId = setup.projectId;
});

test('a task is stamped with the workflow version it entered on', async () => {
  const workflow = await createWorkflow();
  expect(workflow.version).toBe(1);

  const task = await createTask(workflow.id);
  expect(task.workflow_version).toBe(1);

  await updateWorkflow(workflow.id, {
    states: [...V1_STATES, { name: 'archived', terminal: true }],
    transitions: [
      ...V1_TRANSITIONS,
      { name: 'archive', from: ['review'], to: 'archived' },
    ],
  });

  // The task created after the edit enters on v2; the earlier one keeps v1.
  const later = await createTask(workflow.id);
  expect(later.workflow_version).toBe(2);

  const res = await authenticatedTestClient(userToken).get(
    `/api/v1/tasks/${task.id}`
  );
  expect(res.status).toBe(200);
  expect(res.body.workflow_version).toBe(1);
});

test('a transition removed after the task was created still applies', async () => {
  const workflow = await createWorkflow();
  const task = await createTask(workflow.id);
  expect((await transition(task.id, 'to_review')).status).toBe(200);

  // v2 drops `published` entirely — the state the parked task is on its way to.
  await updateWorkflow(workflow.id, {
    states: [
      { name: 'triage', initial: true },
      { name: 'review', kind: 'human' },
    ],
    transitions: [{ name: 'to_review', from: ['triage'], to: 'review' }],
  });

  const res = await transition(task.id, 'publish');
  expect(res.status).toBe(200);
  expect(res.body.state).toBe('published');
  expect(res.body.status).toBe('closed');
});

test('a transition added after the task was created is not available to it', async () => {
  const workflow = await createWorkflow();
  const task = await createTask(workflow.id);

  await updateWorkflow(workflow.id, {
    transitions: [
      ...V1_TRANSITIONS,
      { name: 'fast_track', from: ['triage'], to: 'published' },
    ],
  });

  const res = await transition(task.id, 'fast_track');
  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe('TASK_TRANSITION_NOT_FOUND');

  // A task created on v2 gets the new move.
  const fresh = await createTask(workflow.id);
  const ok = await transition(fresh.id, 'fast_track');
  expect(ok.status).toBe(200);
  expect(ok.body.state).toBe('published');
});

test('a guard added after the task was created does not reject it', async () => {
  const workflow = await createWorkflow();
  const task = await createTask(workflow.id);

  await updateWorkflow(workflow.id, {
    transitions: [
      {
        name: 'to_review',
        from: ['triage'],
        to: 'review',
        guard: { '==': [{ var: 'task.payload.approved' }, true] },
      },
      { name: 'publish', from: ['review'], to: 'published' },
    ],
  });

  const res = await transition(task.id, 'to_review');
  expect(res.status).toBe(200);
  expect(res.body.state).toBe('review');
});

test('an approval gate parks against the definition the task entered on', async () => {
  const workflow = await createWorkflow({
    transitions: [
      { name: 'to_review', from: ['triage'], to: 'review' },
      {
        name: 'publish',
        from: ['review'],
        to: 'published',
        requires_approval: true,
      },
    ],
  });
  const task = await createTask(workflow.id);
  expect((await transition(task.id, 'to_review')).status).toBe(200);

  // v2 rewires `publish` so it is no longer valid from `review`.
  await updateWorkflow(workflow.id, {
    transitions: [
      { name: 'to_review', from: ['triage'], to: 'review' },
      {
        name: 'publish',
        from: ['triage'],
        to: 'published',
        requires_approval: true,
      },
    ],
  });

  const res = await transition(task.id, 'publish');
  expect(res.status).toBe(200);
  expect(res.body.pending_transition).toBe('publish');
});

test('a payload schema tightened after the task was created does not block updates', async () => {
  const workflow = await createWorkflow();
  const task = await createTask(workflow.id, { payload: { note: 'hello' } });

  await updateWorkflow(workflow.id, {
    payload_schema: { type: 'object', required: ['ticket'] },
  });

  const res = await authenticatedTestClient(userToken)
    .patch(`/api/v1/tasks/${task.id}`)
    .send({ payload: { note: 'updated' } });
  expect(res.status).toBe(200);
  expect(res.body.payload).toEqual({ note: 'updated' });

  // A task created on v2 is held to the new schema.
  const rejected = await authenticatedTestClient(userToken)
    .post('/api/v1/tasks')
    .send({
      project_id: projectId,
      workflow_id: workflow.id,
      title: 'needs a ticket',
      payload: { note: 'no ticket' },
    });
  expect(rejected.status).toBe(400);
  expect(rejected.body.error.code).toBe('TASK_PAYLOAD_INVALID');
});
