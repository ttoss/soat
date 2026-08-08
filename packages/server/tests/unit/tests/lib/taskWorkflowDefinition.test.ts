import { db } from 'src/db';
import { resolveTaskDefinition } from 'src/lib/taskWorkflowDefinition';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * The live-definition fallbacks in `resolveTaskDefinition` (issue #882).
 *
 * Tested directly rather than through the REST entry point because the *states*
 * they cover cannot be produced through any entry point: `POST /tasks` always
 * stamps a pin, and an archive row is only ever deleted together with its
 * workflow (which deletes the workflow's tasks in the same transaction). Both
 * are nonetheless real:
 *
 * - a **null pin** is every task that was open across the deploy that introduced
 *   pinning — the live row is the only definition it ever had;
 * - a **missing archive row** is an out-of-band deletion, where degrading to the
 *   live definition beats turning a bookkeeping inconsistency into a permanently
 *   stuck task.
 *
 * Everything else about the resolver — that a pinned task resolves its own
 * version — is covered through the entry point in
 * `rest/taskWorkflowPinning.test.ts`.
 *
 * The state is set up through the API and then perturbed with a single targeted
 * DB write against the real database; nothing is mocked.
 */

const STATES = [
  { name: 'triage', initial: true },
  { name: 'done', terminal: true },
];
const TRANSITIONS = [{ name: 'finish', from: ['triage'], to: 'done' }];

let userToken: string;
let projectId: string;
let workflowSeq = 0;

/** A task and its workflow row, as the resolver's callers hold them. */
const createPinnedTask = async () => {
  workflowSeq += 1;
  const workflowRes = await authenticatedTestClient(userToken)
    .post('/api/v1/workflows')
    .send({
      project_id: projectId,
      name: `resolve-${workflowSeq}`,
      states: STATES,
      transitions: TRANSITIONS,
      payload_schema: { type: 'object' },
    });
  expect(workflowRes.status).toBe(201);

  const taskRes = await authenticatedTestClient(userToken)
    .post('/api/v1/tasks')
    .send({
      project_id: projectId,
      workflow_id: workflowRes.body.id,
      title: 'resolvable task',
    });
  expect(taskRes.status).toBe(201);

  const task = await db.Task.findOne({
    where: { publicId: taskRes.body.id },
  });
  const workflow = await db.Workflow.findOne({
    where: { publicId: workflowRes.body.id },
  });
  return { task: task!, workflow: workflow! };
};

beforeAll(async () => {
  const setup = await setupProjectWithUsers({
    prefix: 'resolvedef',
    policyActions: ['workflows:CreateWorkflow', 'tasks:CreateTask'],
    createNoPermUser: false,
  });
  userToken = setup.userToken;
  projectId = setup.projectId;
});

test('a task with no pinned version resolves the live definition', async () => {
  const { task, workflow } = await createPinnedTask();

  // The pre-pinning shape: a task row whose `workflowVersion` is null. No entry
  // point can create one — `createTask` always stamps the workflow's version.
  await task.update({ workflowVersion: null });

  const definition = await resolveTaskDefinition({ task, workflow });

  expect(definition.states).toEqual(STATES);
  expect(definition.transitions).toEqual(TRANSITIONS);
  expect(definition.payloadSchema).toEqual({ type: 'object' });
});

test('a task pinned to a missing archive row resolves the live definition', async () => {
  const { task, workflow } = await createPinnedTask();
  expect(task.workflowVersion).toBe(1);

  // An out-of-band deletion of the archive: the pin still names version 1, but
  // there is no longer a row to resolve it to.
  await db.WorkflowVersion.destroy({
    where: { workflowId: workflow.id as number, version: 1 },
  });

  const definition = await resolveTaskDefinition({ task, workflow });

  // Degraded to the live row rather than refusing the move and stranding the
  // task forever.
  expect(definition.states).toEqual(STATES);
  expect(definition.transitions).toEqual(TRANSITIONS);
});
