import { flushTaskAutomations } from 'src/lib/tasks';

import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * A workflow migration moves every open task of a workflow onto a newer
 * version: each task is migrated as `POST /tasks/{id}/migrate` would, and a
 * task that one would refuse is reported as refused on the run instead of
 * failing the batch.
 */

let adminToken: string;
let userToken: string;
let noPermToken: string;
let projectId: string;
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
  { name: 'publish_now', from: ['triage'], to: 'published' },
];

const createWorkflow = async () => {
  workflowSeq += 1;
  const res = await authenticatedTestClient(userToken)
    .post('/api/v1/workflows')
    .send({
      project_id: projectId,
      name: `batch-migration-${workflowSeq}`,
      states: V1_STATES,
      transitions: V1_TRANSITIONS,
    });
  expect(res.status).toBe(201);
  return res.body as { id: string };
};

const updateWorkflow = async (workflowId: string, body: object) => {
  const res = await authenticatedTestClient(userToken)
    .patch(`/api/v1/workflows/${workflowId}`)
    .send(body);
  expect(res.status).toBe(200);
  return res.body as { version: number };
};

const createTask = async (workflowId: string) => {
  const res = await authenticatedTestClient(userToken)
    .post('/api/v1/tasks')
    .send({ project_id: projectId, workflow_id: workflowId, title: 'batch' });
  expect(res.status).toBe(201);
  return res.body as { id: string };
};

const transition = async (taskId: string, name: string) => {
  const res = await authenticatedTestClient(userToken)
    .post(`/api/v1/tasks/${taskId}/transitions`)
    .send({ transition: name });
  expect(res.status).toBe(200);
  return res.body as { pending_transition: string | null };
};

const getTask = async (taskId: string) => {
  const res = await authenticatedTestClient(userToken).get(
    `/api/v1/tasks/${taskId}`
  );
  expect(res.status).toBe(200);
  return res.body as { state: string; workflow_version: number | null };
};

const startMigration = (
  workflowId: string,
  body: object,
  token = userToken
) => {
  return authenticatedTestClient(token)
    .post(`/api/v1/workflows/${workflowId}/migrations`)
    .send(body);
};

type MigrationItem = {
  task_id: string;
  status: string;
  error: { code: string; message: string } | null;
};

const itemOf = (body: { tasks: MigrationItem[] }, taskId: string) => {
  return body.tasks.find((item) => {
    return item.task_id === taskId;
  });
};

/**
 * v1 → v2 adds `rejected`; v2 → v3 drops `triage`. One task in `triage`, one
 * in `review`, one parked for approval, one closed.
 */
const workflowWithTasks = async () => {
  const workflow = await createWorkflow();
  const triage = await createTask(workflow.id);
  const review = await createTask(workflow.id);
  await transition(review.id, 'to_review');
  const parked = await createTask(workflow.id);
  await transition(parked.id, 'to_review');
  expect((await transition(parked.id, 'publish')).pending_transition).toBe(
    'publish'
  );
  const closed = await createTask(workflow.id);
  await transition(closed.id, 'publish_now');
  await updateWorkflow(workflow.id, {
    states: [...V1_STATES, { name: 'rejected', terminal: true }],
    transitions: [
      ...V1_TRANSITIONS,
      { name: 'reject', from: ['review'], to: 'rejected' },
    ],
  });
  return { workflow, triage, review, parked, closed };
};

const pollMigration = async (args: {
  workflowId: string;
  migrationId: string;
}) => {
  for (let i = 0; i < 100; i += 1) {
    const res = await authenticatedTestClient(userToken).get(
      `/api/v1/workflows/${args.workflowId}/migrations/${args.migrationId}`
    );
    expect(res.status).toBe(200);
    if (res.body.status === 'completed') return res.body;
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error(`pollMigration: ${args.migrationId} never completed`);
};

beforeAll(async () => {
  const setup = await setupProjectWithUsers({
    prefix: 'wflmig',
    policyActions: [
      'workflows:CreateWorkflow',
      'workflows:UpdateWorkflow',
      'workflows:MigrateWorkflowTasks',
      'workflows:GetWorkflowMigration',
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
});

afterEach(async () => {
  await flushTaskAutomations();
});

describe('POST /api/v1/workflows/:workflow_id/migrations', () => {
  test('wait: true migrates every open task and reports a refusal per task', async () => {
    const { workflow, triage, review, parked, closed } =
      await workflowWithTasks();

    const res = await startMigration(workflow.id, {
      to_version: 2,
      wait: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^wfl_mig_/);
    expect(res.body.workflow_id).toBe(workflow.id);
    expect(res.body.project_id).toBe(projectId);
    expect(res.body.to_version).toBe(2);
    expect(res.body.state_map).toBeNull();
    expect(res.body.status).toBe('completed');
    expect(res.body.task_count).toBe(3);
    expect(res.body.migrated_count).toBe(2);
    expect(res.body.refused_count).toBe(1);
    expect(res.body.finished_at).toEqual(expect.any(String));
    expect(res.body.lease_expires_at).toBeUndefined();

    expect(itemOf(res.body, triage.id)).toEqual({
      task_id: triage.id,
      status: 'migrated',
      error: null,
    });
    expect(itemOf(res.body, review.id)?.status).toBe('migrated');
    expect(itemOf(res.body, parked.id)).toEqual({
      task_id: parked.id,
      status: 'refused',
      error: expect.objectContaining({ code: 'TASK_MIGRATION_CONFLICT' }),
    });
    // A closed task stays on its version and is not part of the run.
    expect(itemOf(res.body, closed.id)).toBeUndefined();

    expect((await getTask(review.id)).workflow_version).toBe(2);
    expect((await getTask(parked.id)).workflow_version).toBe(1);
    expect((await getTask(closed.id)).workflow_version).toBe(1);
  });

  test('without wait the run is answered queued and settles in the background', async () => {
    const { workflow, triage } = await workflowWithTasks();

    const res = await startMigration(workflow.id, { to_version: 2 });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('queued');
    expect(res.body.task_count).toBe(3);
    expect(itemOf(res.body, triage.id)?.status).toBe('pending');

    const settled = await pollMigration({
      workflowId: workflow.id,
      migrationId: res.body.id,
    });
    expect(settled.migrated_count).toBe(2);
    expect(settled.refused_count).toBe(1);
    expect((await getTask(triage.id)).workflow_version).toBe(2);
  });

  test('state_map moves a state the target lacks; a task it leaves unmapped is refused', async () => {
    const { workflow, triage, review } = await workflowWithTasks();
    await updateWorkflow(workflow.id, {
      states: [
        { name: 'intake', initial: true },
        { name: 'review', kind: 'human' },
        { name: 'published', terminal: true },
      ],
      transitions: [{ name: 'to_review', from: ['intake'], to: 'review' }],
    });

    const unmapped = await startMigration(workflow.id, {
      to_version: 3,
      wait: true,
    });
    expect(unmapped.status).toBe(201);
    expect(itemOf(unmapped.body, triage.id)?.error?.code).toBe(
      'TASK_MIGRATION_STATE_UNMAPPED'
    );
    expect(itemOf(unmapped.body, review.id)?.status).toBe('migrated');

    const mapped = await startMigration(workflow.id, {
      to_version: 3,
      state_map: { triage: 'intake' },
      wait: true,
    });
    expect(mapped.status).toBe(201);
    expect(mapped.body.state_map).toEqual({ triage: 'intake' });
    expect(itemOf(mapped.body, triage.id)?.status).toBe('migrated');
    // Already on v3 after the first run: not selected again.
    expect(itemOf(mapped.body, review.id)).toBeUndefined();
    expect(await getTask(triage.id)).toMatchObject({
      state: 'intake',
      workflow_version: 3,
    });
  });

  test('a task the caller may not migrate is refused FORBIDDEN and left on its version', async () => {
    const { workflow, triage } = await workflowWithTasks();
    const token = await createScopedPrincipal({
      adminToken,
      projectId,
      username: `wflmig_notask_${workflowSeq}`,
      actions: [
        'workflows:MigrateWorkflowTasks',
        'workflows:GetWorkflowMigration',
      ],
    });

    const res = await startMigration(
      workflow.id,
      { to_version: 2, wait: true },
      token
    );
    expect(res.status).toBe(201);
    expect(res.body.migrated_count).toBe(0);
    expect(itemOf(res.body, triage.id)?.error?.code).toBe('FORBIDDEN');
    expect((await getTask(triage.id)).workflow_version).toBe(1);
  });

  test('a workflow with no task to migrate completes with none', async () => {
    const workflow = await createWorkflow();
    await updateWorkflow(workflow.id, {
      states: [...V1_STATES, { name: 'rejected', terminal: true }],
    });

    const res = await startMigration(workflow.id, {
      to_version: 2,
      wait: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('completed');
    expect(res.body.task_count).toBe(0);
    expect(res.body.tasks).toEqual([]);
  });

  test('a state_map target the version does not declare is refused before any run is recorded', async () => {
    const { workflow } = await workflowWithTasks();
    const res = await startMigration(workflow.id, {
      to_version: 2,
      state_map: { triage: 'nowhere' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TASK_STATE_NOT_FOUND');
  });

  test('a terminal state_map target is refused: a migration never closes a task', async () => {
    const { workflow } = await workflowWithTasks();
    const res = await startMigration(workflow.id, {
      to_version: 2,
      state_map: { triage: 'rejected' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  test('a version the workflow never had is refused', async () => {
    const { workflow } = await workflowWithTasks();
    const res = await startMigration(workflow.id, { to_version: 9 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WORKFLOW_VERSION_NOT_FOUND');
  });

  test('a missing to_version is 400', async () => {
    const workflow = await createWorkflow();
    const res = await startMigration(workflow.id, {});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  test('an unknown workflow is 404', async () => {
    const res = await startMigration('wfl_doesnotexist', { to_version: 2 });
    expect(res.status).toBe(404);
  });

  test('401 without credentials', async () => {
    const workflow = await createWorkflow();
    const res = await testClient
      .post(`/api/v1/workflows/${workflow.id}/migrations`)
      .send({ to_version: 2 });
    expect(res.status).toBe(401);
  });

  test('404 without workflows:MigrateWorkflowTasks', async () => {
    const { workflow, triage } = await workflowWithTasks();
    const res = await startMigration(
      workflow.id,
      { to_version: 2, wait: true },
      noPermToken
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WORKFLOW_NOT_FOUND');
    expect((await getTask(triage.id)).workflow_version).toBe(1);
  });
});

describe('GET /api/v1/workflows/:workflow_id/migrations/:migration_id', () => {
  test('returns the run with its per-task results', async () => {
    const { workflow, triage } = await workflowWithTasks();
    const started = await startMigration(workflow.id, {
      to_version: 2,
      wait: true,
    });

    const res = await authenticatedTestClient(userToken).get(
      `/api/v1/workflows/${workflow.id}/migrations/${started.body.id}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual(started.body);
    expect(itemOf(res.body, triage.id)?.status).toBe('migrated');
  });

  test('a run of another workflow is 404', async () => {
    const { workflow } = await workflowWithTasks();
    const other = await createWorkflow();
    const started = await startMigration(workflow.id, {
      to_version: 2,
      wait: true,
    });

    const res = await authenticatedTestClient(userToken).get(
      `/api/v1/workflows/${other.id}/migrations/${started.body.id}`
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WORKFLOW_MIGRATION_NOT_FOUND');
  });

  test('401 without credentials', async () => {
    const workflow = await createWorkflow();
    const res = await testClient.get(
      `/api/v1/workflows/${workflow.id}/migrations/wfl_mig_x`
    );
    expect(res.status).toBe(401);
  });

  test('404 without workflows:GetWorkflowMigration', async () => {
    const { workflow } = await workflowWithTasks();
    const started = await startMigration(workflow.id, {
      to_version: 2,
      wait: true,
    });
    const res = await authenticatedTestClient(noPermToken).get(
      `/api/v1/workflows/${workflow.id}/migrations/${started.body.id}`
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WORKFLOW_NOT_FOUND');
  });
});
