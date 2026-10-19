import { flushTaskAutomations } from 'src/lib/tasks';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

const STATES = [
  { name: 'open', initial: true },
  { name: 'review' },
  { name: 'done', terminal: true },
];

const TRANSITIONS = [
  { name: 'touch', from: ['open', 'review'], to: 'open' },
  { name: 'to_review', from: ['open'], to: 'review' },
  { name: 'ship', from: ['review'], to: 'done', requires_approval: true },
];

describe('Task transition idempotency', () => {
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let workflowId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'tasktransitionidem',
      policyActions: [
        'workflows:CreateWorkflow',
        'tasks:CreateTask',
        'tasks:GetTask',
        'tasks:TransitionTask',
        'approvals:ListApprovals',
      ],
      createNoPermUser: true,
    });
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;

    workflowId = (
      await authenticatedTestClient(userToken).post('/api/v1/workflows').send({
        project_id: projectId,
        name: 'transition-idempotency',
        states: STATES,
        transitions: TRANSITIONS,
      })
    ).body.id;
  });

  afterEach(async () => {
    await flushTaskAutomations();
  });

  const createTask = async (): Promise<string> => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/tasks')
      .send({ project_id: projectId, workflow_id: workflowId, title: 't' });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const historyTotal = async (taskId: string): Promise<number> => {
    const res = await authenticatedTestClient(userToken).get(
      `/api/v1/tasks/${taskId}/history`
    );
    return res.body.total as number;
  };

  const fire = (args: {
    taskId: string;
    transition: string;
    key?: string;
    note?: string;
    token?: string;
  }) => {
    const req = authenticatedTestClient(args.token ?? userToken).post(
      `/api/v1/tasks/${args.taskId}/transitions`
    );
    if (args.key) req.set('Idempotency-Key', args.key);
    return req.send({ transition: args.transition, note: args.note });
  };

  describe('POST /api/v1/tasks/:task_id/transitions with a key', () => {
    test('the same key twice on a self-loop leaves one history entry', async () => {
      const taskId = await createTask();
      const first = await fire({ taskId, transition: 'touch', key: 'k-loop' });
      const second = await fire({ taskId, transition: 'touch', key: 'k-loop' });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body.id).toBe(taskId);
      expect(second.body.state).toBe('open');
      // The initial placement plus one move.
      expect(await historyTotal(taskId)).toBe(2);
    });

    test('a replay answers the task as it is now, not a 409', async () => {
      const taskId = await createTask();
      expect(
        (await fire({ taskId, transition: 'to_review', key: 'k-move' })).status
      ).toBe(200);
      const replay = await fire({
        taskId,
        transition: 'to_review',
        key: 'k-move',
      });
      expect(replay.status).toBe(200);
      expect(replay.body.state).toBe('review');
      expect(await historyTotal(taskId)).toBe(2);
    });

    test('the body field and the header are one key', async () => {
      const taskId = await createTask();
      await fire({ taskId, transition: 'touch', key: 'k-both' });
      const replay = await authenticatedTestClient(userToken)
        .post(`/api/v1/tasks/${taskId}/transitions`)
        .send({ transition: 'touch', idempotency_key: 'k-both' });
      expect(replay.status).toBe(200);
      expect(await historyTotal(taskId)).toBe(2);
    });

    test('the same key with a different body is IDEMPOTENCY_KEY_REUSED', async () => {
      const taskId = await createTask();
      await fire({ taskId, transition: 'touch', key: 'k-reuse' });
      const reused = await fire({
        taskId,
        transition: 'touch',
        key: 'k-reuse',
        note: 'different',
      });
      expect(reused.status).toBe(409);
      expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await historyTotal(taskId)).toBe(2);
    });

    test('a key is scoped to its task', async () => {
      const a = await createTask();
      const b = await createTask();
      await fire({ taskId: a, transition: 'touch', key: 'k-scope' });
      await fire({ taskId: b, transition: 'touch', key: 'k-scope' });
      expect(await historyTotal(b)).toBe(2);
    });

    test('without a key every fire moves the task', async () => {
      const taskId = await createTask();
      await fire({ taskId, transition: 'touch' });
      await fire({ taskId, transition: 'touch' });
      expect(await historyTotal(taskId)).toBe(3);
    });

    test('a parked approval is claimed by its approval item', async () => {
      const taskId = await createTask();
      await fire({ taskId, transition: 'to_review' });
      const parked = await fire({ taskId, transition: 'ship', key: 'k-park' });
      expect(parked.status).toBe(200);
      expect(parked.body.pending_transition).toBe('ship');

      const replay = await fire({ taskId, transition: 'ship', key: 'k-park' });
      expect(replay.status).toBe(200);
      expect(replay.body.pending_transition).toBe('ship');

      const approvals = await authenticatedTestClient(userToken)
        .get('/api/v1/approvals')
        .query({ project_id: projectId, status: 'pending' });
      expect(
        approvals.body.data.filter((a: { task_id: string | null }) => {
          return a.task_id === taskId;
        })
      ).toHaveLength(1);
    });

    test('a parked key reused with a different body is IDEMPOTENCY_KEY_REUSED', async () => {
      const taskId = await createTask();
      await fire({ taskId, transition: 'to_review' });
      await fire({ taskId, transition: 'ship', key: 'k-park-reuse' });
      const reused = await fire({
        taskId,
        transition: 'touch',
        key: 'k-park-reuse',
      });
      expect(reused.status).toBe(409);
      expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    test('an empty key is 400', async () => {
      const taskId = await createTask();
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/tasks/${taskId}/transitions`)
        .send({ transition: 'touch', idempotency_key: '' });
      expect(res.status).toBe(400);
    });

    test('returns 401 without a token', async () => {
      const taskId = await createTask();
      const res = await testClient
        .post(`/api/v1/tasks/${taskId}/transitions`)
        .set('Idempotency-Key', 'k-401')
        .send({ transition: 'touch' });
      expect(res.status).toBe(401);
    });

    test('returns 403 without tasks:TransitionTask, claiming nothing', async () => {
      const taskId = await createTask();
      const res = await fire({
        taskId,
        transition: 'touch',
        key: 'k-403',
        token: noPermToken,
      });
      expect(res.status).toBe(403);
      const owner = await fire({ taskId, transition: 'touch', key: 'k-403' });
      expect(owner.status).toBe(200);
      expect(await historyTotal(taskId)).toBe(2);
    });
  });
});
