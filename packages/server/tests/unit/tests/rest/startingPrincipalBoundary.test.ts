import jwt from 'jsonwebtoken';
import { db } from 'src/db';
import { type ActiveDispatch, flushTaskAutomations } from 'src/lib/tasks';
import { JWT_SECRET } from 'src/middleware/auth';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * Durable work started by an OAuth token records no principal, as
 * `resolveStartingPrincipal` rules: a later drive re-mints its credential from
 * the recorded principal, and a plain run token for the token's user would
 * drop the consented scope and act with the user's whole access.
 *
 * Every case pairs the OAuth caller with the user's own login, which does
 * record the user, so a run that records nothing for every caller cannot pass.
 */

let userToken: string;
let oauthToken: string;
let userId: string;
let projectId: string;
let orchestrationId: string;

const principalOf = async (where: Record<string, unknown>) => {
  const run = await db.OrchestrationRun.findOne({ where });
  expect(run).not.toBeNull();
  return { kind: run!.principalKind ?? null, id: run!.principalId ?? null };
};

beforeAll(async () => {
  const setup = await setupProjectWithUsers({
    prefix: 'startprin',
    policyActions: [
      'orchestrations:CreateOrchestration',
      'orchestrations:GetOrchestration',
      'orchestrations:StartRun',
      'orchestrations:GetRun',
      'workflows:CreateWorkflow',
      'workflows:GetWorkflow',
      'tasks:CreateTask',
      'tasks:GetTask',
      'tasks:TransitionTask',
      'tasks:PauseTask',
      'tasks:ResumeTask',
    ],
    createNoPermUser: false,
  });
  userToken = setup.userToken;
  userId = setup.userId;
  projectId = setup.projectId;
  oauthToken = jwt.sign(
    {
      publicId: userId,
      role: 'user',
      scope: `* mcp:access prj:${projectId}`,
      prj: projectId,
    },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  const orchestrationRes = await authenticatedTestClient(userToken)
    .post('/api/v1/orchestrations')
    .send({
      project_id: projectId,
      name: 'startprin-echo',
      nodes: [{ id: 'start', type: 'transform', expression: { var: '' } }],
      edges: [],
    });
  expect(orchestrationRes.status).toBe(201);
  orchestrationId = orchestrationRes.body.id;
});

afterEach(async () => {
  await flushTaskAutomations();
});

describe('POST /orchestration-runs', () => {
  const start = async (token: string) => {
    const res = await authenticatedTestClient(token)
      .post('/api/v1/orchestration-runs')
      .send({ orchestration_id: orchestrationId });
    expect(res.status).toBe(201);
    return principalOf({ publicId: res.body.id });
  };

  test('a user login records the user', async () => {
    expect(await start(userToken)).toEqual({ kind: 'user', id: userId });
  });

  test('an OAuth token records no principal', async () => {
    expect(await start(oauthToken)).toEqual({ kind: null, id: null });
  });
});

describe('a task dispatch', () => {
  let workflowId: string;

  beforeAll(async () => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/workflows')
      .send({
        project_id: projectId,
        name: 'startprin-flow',
        states: [
          {
            name: 'running',
            initial: true,
            on_enter: {
              dispatch: {
                kind: 'orchestration',
                orchestration_id: orchestrationId,
              },
            },
          },
          { name: 'idle' },
          {
            name: 'rerun',
            on_enter: {
              dispatch: {
                kind: 'orchestration',
                orchestration_id: orchestrationId,
              },
            },
          },
        ],
        transitions: [{ name: 'to_rerun', from: ['idle'], to: 'rerun' }],
      });
    expect(res.status).toBe(201);
    workflowId = res.body.id;
  });

  const createTask = async (args: { token: string; state?: string }) => {
    const res = await authenticatedTestClient(args.token)
      .post('/api/v1/tasks')
      .send({
        project_id: projectId,
        workflow_id: workflowId,
        title: 'startprin',
        ...(args.state ? { state: args.state } : {}),
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  /** The principal of the orchestration run the task's dispatch started. */
  const dispatchPrincipalOf = async (taskId: string) => {
    await flushTaskAutomations();
    const task = await db.Task.findOne({ where: { publicId: taskId } });
    const runId = (task!.activeDispatch as ActiveDispatch | null)?.id;
    expect(typeof runId).toBe('string');
    return principalOf({ publicId: runId });
  };

  describe.each([
    [
      'a user login',
      () => {
        return userToken;
      },
      () => {
        return { kind: 'user', id: userId };
      },
    ],
    [
      'an OAuth token',
      () => {
        return oauthToken;
      },
      () => {
        return { kind: null, id: null };
      },
    ],
  ])('started by %s', (_label, tokenOf, expected) => {
    test('create runs the entry dispatch as the starting principal', async () => {
      const taskId = await createTask({ token: tokenOf() });
      expect(await dispatchPrincipalOf(taskId)).toEqual(expected());
    });

    test('a transition runs the dispatch as the starting principal', async () => {
      const taskId = await createTask({ token: userToken, state: 'idle' });
      const res = await authenticatedTestClient(tokenOf())
        .post(`/api/v1/tasks/${taskId}/transitions`)
        .send({ transition: 'to_rerun' });
      expect(res.status).toBe(200);
      expect(await dispatchPrincipalOf(taskId)).toEqual(expected());
    });

    test('a resume runs the suppressed dispatch as the starting principal', async () => {
      const taskId = await createTask({ token: userToken, state: 'idle' });
      const paused = await authenticatedTestClient(userToken)
        .post(`/api/v1/tasks/${taskId}/pause`)
        .send({});
      expect(paused.status).toBe(200);
      const moved = await authenticatedTestClient(userToken)
        .post(`/api/v1/tasks/${taskId}/transitions`)
        .send({ transition: 'to_rerun' });
      expect(moved.status).toBe(200);
      await flushTaskAutomations();

      const resumed = await authenticatedTestClient(tokenOf())
        .post(`/api/v1/tasks/${taskId}/resume`)
        .send({});
      expect(resumed.status).toBe(200);
      expect(await dispatchPrincipalOf(taskId)).toEqual(expected());
    });
  });
});
