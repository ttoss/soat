import { flushTaskAutomations } from 'src/lib/tasks';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

const STATES = [
  { name: 'open', initial: true },
  { name: 'review' },
  { name: 'done', terminal: true },
];

const TRANSITIONS = [{ name: 'to_review', from: ['open'], to: 'review' }];

describe('Task create idempotency', () => {
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let otherProjectId: string;
  let workflowId: string;
  let otherWorkflowId: string;

  const createWorkflow = async (args: { token: string; projectId: string }) => {
    const res = await authenticatedTestClient(args.token)
      .post('/api/v1/workflows')
      .send({
        project_id: args.projectId,
        name: 'create-idempotency',
        states: STATES,
        transitions: TRANSITIONS,
      });
    return res.body.id as string;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'taskcreateidem',
      policyActions: [
        'workflows:CreateWorkflow',
        'tasks:CreateTask',
        'tasks:GetTask',
        'tasks:ListTasks',
        'tasks:TransitionTask',
        'tasks:DeleteTask',
      ],
      createOtherProject: true,
      createNoPermUser: true,
    });
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId as string;
    workflowId = await createWorkflow({ token: userToken, projectId });
    otherWorkflowId = await createWorkflow({
      token: userToken,
      projectId: otherProjectId,
    });
  });

  afterEach(async () => {
    await flushTaskAutomations();
  });

  const create = (args: {
    key?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    body?: Record<string, unknown>;
    token?: string;
    project?: string;
    workflow?: string;
  }) => {
    const req = authenticatedTestClient(args.token ?? userToken).post(
      '/api/v1/tasks'
    );
    if (args.key) req.set('Idempotency-Key', args.key);
    return req.send({
      project_id: args.project ?? projectId,
      workflow_id: args.workflow ?? workflowId,
      title: args.title ?? 't',
      ...(args.metadata ? { metadata: args.metadata } : {}),
      ...args.body,
    });
  };

  const countTitled = async (title: string): Promise<number> => {
    const res = await authenticatedTestClient(userToken)
      .get('/api/v1/tasks')
      .query({ project_id: projectId, limit: 100 });
    return res.body.data.filter((t: { title: string }) => {
      return t.title === title;
    }).length;
  };

  describe('POST /api/v1/tasks with a key', () => {
    test('the same key and body twice creates one task and replays it', async () => {
      const first = await create({
        key: 'k-once',
        title: 'once',
        metadata: { customer_id: '42' },
      });
      const second = await create({
        key: 'k-once',
        title: 'once',
        metadata: { customer_id: '42' },
      });

      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.body.id).toBe(first.body.id);
      expect(await countTitled('once')).toBe(1);
    });

    test('a replay answers the task as it is now', async () => {
      const first = await create({ key: 'k-now', title: 'now' });
      await authenticatedTestClient(userToken)
        .post(`/api/v1/tasks/${first.body.id}/transitions`)
        .send({ transition: 'to_review' });

      const replay = await create({ key: 'k-now', title: 'now' });
      expect(replay.status).toBe(200);
      expect(replay.body.id).toBe(first.body.id);
      expect(replay.body.state).toBe('review');
    });

    test('the body field and the header are one key', async () => {
      const first = await create({ key: 'k-both', title: 'both' });
      const replay = await create({
        title: 'both',
        body: { idempotency_key: 'k-both' },
      });
      expect(replay.status).toBe(200);
      expect(replay.body.id).toBe(first.body.id);
      expect(await countTitled('both')).toBe(1);
    });

    test('the body field alone claims the key', async () => {
      const first = await create({
        title: 'field',
        body: { idempotency_key: 'k-field' },
      });
      expect(first.status).toBe(201);
      const replay = await create({ key: 'k-field', title: 'field' });
      expect(replay.status).toBe(200);
      expect(replay.body.id).toBe(first.body.id);
    });

    test('header and body field naming different keys is 400', async () => {
      const res = await create({
        key: 'k-a',
        title: 'mismatch',
        body: { idempotency_key: 'k-b' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(await countTitled('mismatch')).toBe(0);
    });

    test('the same key with a different body is IDEMPOTENCY_KEY_REUSED', async () => {
      await create({
        key: 'k-reuse',
        title: 'reuse',
        metadata: { customer_id: '1' },
      });
      const reused = await create({
        key: 'k-reuse',
        title: 'reuse',
        metadata: { customer_id: '2' },
      });
      expect(reused.status).toBe(409);
      expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await countTitled('reuse')).toBe(1);
    });

    test('a key is scoped to its project', async () => {
      const a = await create({ key: 'k-scope', title: 'scope' });
      const b = await create({
        key: 'k-scope',
        title: 'scope',
        project: otherProjectId,
        workflow: otherWorkflowId,
      });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(b.body.id).not.toBe(a.body.id);
    });

    test('without a key every create makes a task', async () => {
      await create({ title: 'keyless' });
      await create({ title: 'keyless' });
      expect(await countTitled('keyless')).toBe(2);
    });

    test('a failed create claims no key', async () => {
      const failed = await create({
        key: 'k-failed',
        title: 'failed',
        body: { state: 'missing' },
      });
      expect(failed.status).toBe(400);
      const ok = await create({ key: 'k-failed', title: 'failed' });
      expect(ok.status).toBe(201);
    });

    test('a deleted task releases its key', async () => {
      const first = await create({ key: 'k-deleted', title: 'deleted' });
      await authenticatedTestClient(userToken).delete(
        `/api/v1/tasks/${first.body.id}`
      );
      const again = await create({ key: 'k-deleted', title: 'deleted' });
      expect(again.status).toBe(201);
      expect(again.body.id).not.toBe(first.body.id);
    });

    test('concurrent creates under one key make one task', async () => {
      const [a, b] = await Promise.all([
        create({ key: 'k-race', title: 'race' }),
        create({ key: 'k-race', title: 'race' }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 201]);
      expect(a.body.id).toBe(b.body.id);
      expect(await countTitled('race')).toBe(1);
    });

    test('an empty key is 400', async () => {
      const res = await create({
        title: 'empty',
        body: { idempotency_key: '' },
      });
      expect(res.status).toBe(400);
    });

    test('returns 401 without a token', async () => {
      const res = await testClient
        .post('/api/v1/tasks')
        .set('Idempotency-Key', 'k-401')
        .send({ project_id: projectId, workflow_id: workflowId, title: 't' });
      expect(res.status).toBe(401);
    });

    test('returns 403 without tasks:CreateTask, claiming nothing', async () => {
      const denied = await create({
        key: 'k-403',
        title: 'denied',
        token: noPermToken,
      });
      expect(denied.status).toBe(403);
      const owner = await create({ key: 'k-403', title: 'denied' });
      expect(owner.status).toBe(201);
    });
  });
});
