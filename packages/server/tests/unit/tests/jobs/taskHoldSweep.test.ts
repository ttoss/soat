import { db } from 'src/db';
import { type SoatEvent } from 'src/lib/eventBus';
import { flushTaskAutomations } from 'src/lib/tasks';
import { sweepClearedHolds } from 'src/lib/tasksScheduler';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { captureEvents } from '../../fixtures/eventCapture';
import { authenticatedTestClient } from '../../testClient';

let userToken: string;
let projectId: string;
let workflowId: string;

beforeAll(async () => {
  const setup = await setupProjectWithUsers({
    prefix: 'holdsweep',
    policyActions: [
      'workflows:CreateWorkflow',
      'tasks:CreateTask',
      'tasks:GetTask',
      'tasks:SetTaskHold',
    ],
  });
  userToken = setup.userToken;
  projectId = setup.projectId;
  workflowId = (
    await authenticatedTestClient(userToken)
      .post('/api/v1/workflows')
      .send({
        project_id: projectId,
        name: 'hold-sweep',
        states: [{ name: 'todo', initial: true }],
        transitions: [],
      })
  ).body.id;
});

afterEach(async () => {
  await flushTaskAutomations();
});

const heldTask = async (reason: string) => {
  const task = (
    await authenticatedTestClient(userToken)
      .post('/api/v1/tasks')
      .send({ project_id: projectId, workflow_id: workflowId, title: reason })
  ).body;
  const until = new Date(Date.now() + 60_000).toISOString();
  const held = await authenticatedTestClient(userToken)
    .put(`/api/v1/tasks/${task.id}/hold`)
    .send({ hold_until: until, hold_reason: reason });
  expect(held.status).toBe(200);
  return { id: task.id as string, until };
};

const holdClearedDuring = (args: {
  taskId: string;
  action: () => Promise<unknown>;
  count?: number;
}): Promise<SoatEvent[]> => {
  return captureEvents({
    type: 'tasks.hold_cleared',
    where: (event) => {
      return event.resourceId === args.taskId;
    },
    action: args.action,
    count: args.count,
  });
};

describe('sweepClearedHolds', () => {
  test('emits tasks.hold_cleared once when the date passes, and clears the hold', async () => {
    const task = await heldTask('rerun on Dec 1st');
    const later = new Date(Date.now() + 120_000);

    const events = await holdClearedDuring({
      taskId: task.id,
      action: async () => {
        await sweepClearedHolds({ now: later });
        await sweepClearedHolds({ now: later });
      },
      count: 2,
    });
    expect(events).toHaveLength(1);
    expect(events[0].data.cleared_hold).toEqual({
      until: new Date(task.until),
      reason: 'rerun on Dec 1st',
    });
    expect(events[0].data.hold_until).toBeNull();

    const read = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks/${task.id}`
    );
    expect(read.body.hold_until).toBeNull();
    expect(read.body.hold_reason).toBeNull();
    expect(read.body.readiness.blocked).toBe(false);
  });

  test('leaves a hold whose date is ahead', async () => {
    const task = await heldTask('not yet');
    const events = await holdClearedDuring({
      taskId: task.id,
      action: () => {
        return sweepClearedHolds();
      },
    });
    expect(events).toHaveLength(0);
    const row = await db.Task.findOne({ where: { publicId: task.id } });
    expect(row!.holdUntil).toEqual(new Date(task.until));
  });
});
