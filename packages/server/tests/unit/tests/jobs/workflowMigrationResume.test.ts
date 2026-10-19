import { db } from 'src/db';
import { resumeWorkflowMigrations } from 'src/lib/workflowMigrations';

import { pollUntil } from '../../fixtures/agentToolTurn';
import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A run whose process stopped before it settled keeps its unsettled items
 * `pending`; the sweep hands it to the next process once its lease expires.
 */

let userToken: string;
let projectId: string;
let workflowSeq = 0;

const STATES = [
  { name: 'triage', initial: true },
  { name: 'published', terminal: true },
];

const workflowWithTwoTasks = async () => {
  workflowSeq += 1;
  const client = authenticatedTestClient(userToken);
  const workflow = await client.post('/api/v1/workflows').send({
    project_id: projectId,
    name: `resume-${workflowSeq}`,
    states: STATES,
    transitions: [{ name: 'publish', from: ['triage'], to: 'published' }],
  });
  expect(workflow.status).toBe(201);
  const tasks = [];
  for (const title of ['moved', 'left']) {
    const task = await authenticatedTestClient(userToken)
      .post('/api/v1/tasks')
      .send({ project_id: projectId, workflow_id: workflow.body.id, title });
    expect(task.status).toBe(201);
    tasks.push(task.body as { id: string });
  }
  const updated = await authenticatedTestClient(userToken)
    .patch(`/api/v1/workflows/${workflow.body.id}`)
    .send({ states: [...STATES, { name: 'archived', terminal: true }] });
  expect(updated.status).toBe(200);
  return { workflowId: workflow.body.id as string, tasks };
};

/** A run as a stopped process leaves it: both items still `pending`. */
const recordStoppedRun = async (args: {
  workflowId: string;
  taskIds: string[];
  leaseExpiresAt: Date;
}) => {
  const workflow = await db.Workflow.findOne({
    where: { publicId: args.workflowId },
  });
  const tasks = await db.Task.findAll({
    where: { publicId: args.taskIds },
    order: [['id', 'ASC']],
  });
  return db.WorkflowMigration.create({
    workflowId: workflow!.id as number,
    toVersion: 2,
    stateMap: null,
    status: 'running',
    items: tasks.map((task) => {
      return {
        taskId: task.id as number,
        taskPublicId: task.publicId,
        status: 'pending',
        error: null,
      };
    }),
    createdByPrincipalType: 'user',
    createdByPrincipalId: null,
    leaseExpiresAt: args.leaseExpiresAt,
    finishedAt: null,
  });
};

const readRun = async (args: { workflowId: string; id: string }) => {
  const res = await authenticatedTestClient(userToken).get(
    `/api/v1/workflows/${args.workflowId}/migrations/${args.id}`
  );
  expect(res.status).toBe(200);
  return res.body as {
    status: string;
    migrated_count: number;
    refused_count: number;
  };
};

beforeAll(async () => {
  const setup = await setupProjectWithUsers({
    prefix: 'wflresume',
    policyActions: [
      'workflows:CreateWorkflow',
      'workflows:UpdateWorkflow',
      'workflows:GetWorkflowMigration',
      'tasks:CreateTask',
      'tasks:GetTask',
      'tasks:MigrateTask',
    ],
  });
  userToken = setup.userToken;
  projectId = setup.projectId;
});

describe('resumeWorkflowMigrations', () => {
  test('settles the pending items of a run whose lease expired, counting a task already moved as migrated', async () => {
    const { workflowId, tasks } = await workflowWithTwoTasks();
    // The stopped process moved the first task but never recorded it.
    const moved = await authenticatedTestClient(userToken)
      .post(`/api/v1/tasks/${tasks[0].id}/migrate`)
      .send({ to_version: 2 });
    expect(moved.status).toBe(200);
    const run = await recordStoppedRun({
      workflowId,
      taskIds: tasks.map((task) => {
        return task.id;
      }),
      leaseExpiresAt: new Date(Date.now() - 1000),
    });

    expect(await resumeWorkflowMigrations()).toBe(1);

    const settled = await pollUntil({
      read: () => {
        return readRun({ workflowId, id: run.publicId });
      },
      done: (body) => {
        return body.status === 'completed';
      },
    });
    expect(settled.migrated_count).toBe(2);
    expect(settled.refused_count).toBe(0);
    const left = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks/${tasks[1].id}`
    );
    expect(left.body.workflow_version).toBe(2);
  });

  test('leaves a run whose lease is still held', async () => {
    const { workflowId, tasks } = await workflowWithTwoTasks();
    const run = await recordStoppedRun({
      workflowId,
      taskIds: [tasks[0].id],
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });

    expect(await resumeWorkflowMigrations()).toBe(0);
    expect((await readRun({ workflowId, id: run.publicId })).status).toBe(
      'running'
    );
  });
});
