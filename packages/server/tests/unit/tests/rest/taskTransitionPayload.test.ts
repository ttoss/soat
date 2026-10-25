import { flushTaskAutomations } from 'src/lib/tasks';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

const APPROVED = { '==': [{ var: 'task.payload.approved' }, true] };

const STATES = [
  { name: 'draft', initial: true },
  { name: 'review' },
  { name: 'done', terminal: true },
];

const TRANSITIONS = [
  { name: 'submit', from: ['draft'], to: 'review' },
  { name: 'publish', from: ['review'], to: 'done', guard: APPROVED },
  {
    name: 'escalate',
    from: ['review'],
    to: 'done',
    requires_approval: true,
    guard: APPROVED,
  },
];

describe('Task transition payload', () => {
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let workflowId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'tasktransitionpayload',
      policyActions: [
        'workflows:CreateWorkflow',
        'tasks:CreateTask',
        'tasks:GetTask',
        'tasks:TransitionTask',
        'approvals:ListApprovals',
        'approvals:ResolveApproval',
      ],
      createNoPermUser: true,
    });
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;

    workflowId = (
      await authenticatedTestClient(userToken)
        .post('/api/v1/workflows')
        .send({
          project_id: projectId,
          name: 'transition-payload',
          states: STATES,
          transitions: TRANSITIONS,
          payload_schema: {
            properties: {
              approved: { type: 'boolean' },
              topic: { type: 'string' },
            },
          },
        })
    ).body.id;
  });

  afterEach(async () => {
    await flushTaskAutomations();
  });

  const createInReview = async (): Promise<string> => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/tasks')
      .send({
        project_id: projectId,
        workflow_id: workflowId,
        title: 't',
        payload: { topic: 'keep' },
      });
    expect(res.status).toBe(201);
    const moved = await authenticatedTestClient(userToken)
      .post(`/api/v1/tasks/${res.body.id}/transitions`)
      .send({ transition: 'submit' });
    expect(moved.status).toBe(200);
    return res.body.id as string;
  };

  const fire = (taskId: string, body: object, token = userToken) => {
    return authenticatedTestClient(token)
      .post(`/api/v1/tasks/${taskId}/transitions`)
      .send(body);
  };

  const resolveGate = async (taskId: string, verb: 'approve' | 'reject') => {
    const list = await authenticatedTestClient(userToken)
      .get('/api/v1/approvals')
      .query({ project_id: projectId, status: 'pending' });
    const item = list.body.data.find((a: { task_id: string | null }) => {
      return a.task_id === taskId;
    });
    return authenticatedTestClient(userToken)
      .post(`/api/v1/approvals/${item.id}/${verb}`)
      .send(verb === 'reject' ? { reason: 'not yet' } : {});
  };

  const getTask = async (taskId: string) => {
    return (
      await authenticatedTestClient(userToken).get(`/api/v1/tasks/${taskId}`)
    ).body;
  };

  describe('POST /api/v1/tasks/:task_id/transitions with payload', () => {
    test('the guard reads the payload the move carries', async () => {
      const taskId = await createInReview();
      const res = await fire(taskId, {
        transition: 'publish',
        payload: { approved: true },
      });
      expect(res.status).toBe(200);
      expect(res.body.state).toBe('done');
      // Shallow-merged like PATCH: keys the move did not name survive.
      expect(res.body.payload).toEqual({ topic: 'keep', approved: true });
    });

    test('a refused move writes no payload', async () => {
      const taskId = await createInReview();
      const res = await fire(taskId, {
        transition: 'publish',
        payload: { approved: false, topic: 'changed' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TASK_GUARD_REJECTED');
      expect((await getTask(taskId)).payload).toEqual({ topic: 'keep' });
    });

    test('a conflicting move writes no payload', async () => {
      const taskId = await createInReview();
      const res = await fire(taskId, {
        transition: 'submit',
        payload: { topic: 'changed' },
      });
      expect(res.status).toBe(409);
      expect((await getTask(taskId)).payload).toEqual({ topic: 'keep' });
    });

    test('a payload outside the pinned schema is TASK_PAYLOAD_INVALID', async () => {
      const taskId = await createInReview();
      const res = await fire(taskId, {
        transition: 'publish',
        payload: { approved: 'yes' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TASK_PAYLOAD_INVALID');
      expect((await getTask(taskId)).state).toBe('review');
    });

    test('a parked move keeps its payload with the gate', async () => {
      const taskId = await createInReview();
      const parked = await fire(taskId, {
        transition: 'escalate',
        payload: { approved: true },
      });
      expect(parked.status).toBe(200);
      expect(parked.body.pending_transition).toBe('escalate');
      expect(parked.body.payload).toEqual({ topic: 'keep' });
    });

    test('approving a parked move applies its payload before the guard', async () => {
      const taskId = await createInReview();
      await fire(taskId, {
        transition: 'escalate',
        payload: { approved: true },
      });

      const resolved = await resolveGate(taskId, 'approve');
      expect(resolved.status).toBe(200);

      const after = await getTask(taskId);
      expect(after.state).toBe('done');
      expect(after.payload).toEqual({ topic: 'keep', approved: true });
    });

    test('rejecting a parked move writes no payload', async () => {
      const taskId = await createInReview();
      await fire(taskId, {
        transition: 'escalate',
        payload: { approved: true },
      });
      expect((await resolveGate(taskId, 'reject')).status).toBe(200);

      const after = await getTask(taskId);
      expect(after.state).toBe('review');
      expect(after.payload).toEqual({ topic: 'keep' });
    });

    test('a parked payload outside the schema is refused before parking', async () => {
      const taskId = await createInReview();
      const res = await fire(taskId, {
        transition: 'escalate',
        payload: { approved: 'yes' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TASK_PAYLOAD_INVALID');
      expect((await getTask(taskId)).pending_transition).toBeNull();
    });

    test('a non-object payload is 400', async () => {
      const taskId = await createInReview();
      const res = await fire(taskId, { transition: 'publish', payload: [1] });
      expect(res.status).toBe(400);
    });

    test('the idempotency key compares the payload', async () => {
      const taskId = await createInReview();
      await authenticatedTestClient(userToken)
        .post(`/api/v1/tasks/${taskId}/transitions`)
        .set('Idempotency-Key', 'k-payload')
        .send({ transition: 'publish', payload: { approved: true } });
      const reused = await authenticatedTestClient(userToken)
        .post(`/api/v1/tasks/${taskId}/transitions`)
        .set('Idempotency-Key', 'k-payload')
        .send({
          transition: 'publish',
          payload: { approved: true, topic: 'x' },
        });
      expect(reused.status).toBe(409);
      expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    test('returns 401 without a token', async () => {
      const taskId = await createInReview();
      const res = await testClient
        .post(`/api/v1/tasks/${taskId}/transitions`)
        .send({ transition: 'publish', payload: { approved: true } });
      expect(res.status).toBe(401);
    });

    test('returns 404 without tasks:TransitionTask and writes nothing', async () => {
      const taskId = await createInReview();
      const res = await fire(
        taskId,
        { transition: 'publish', payload: { approved: true } },
        noPermToken
      );
      expect(res.status).toBe(404);
      expect((await getTask(taskId)).payload).toEqual({ topic: 'keep' });
    });
  });
});
