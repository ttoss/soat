import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';
import { DomainError } from 'src/errors';
import { expireDueApprovals } from 'src/lib/approvalScheduler';
import { eventBus, type SoatEvent } from 'src/lib/eventBus';
import { buildRunAuthHeader } from 'src/lib/orchestrationRunToken';
import { wakeDueRuns } from 'src/lib/orchestrationScheduler';
import { flushTaskAutomations } from 'src/lib/tasks';
import * as tasksAutomationModule from 'src/lib/tasksAutomation';
import {
  reconcileOrphanedDispatches,
  sweepStalledTasks,
} from 'src/lib/tasksScheduler';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient, testClient } from '../../testClient';

const STATES = [
  { name: 'triage', initial: true },
  { name: 'draft' },
  { name: 'review', kind: 'human' },
  { name: 'published', terminal: true },
];

const TRANSITIONS = [
  { name: 'to_draft', from: ['triage', 'review'], to: 'draft' },
  { name: 'to_review', from: ['triage', 'draft'], to: 'review' },
  {
    name: 'publish',
    from: ['review'],
    to: 'published',
    guard: { '==': [{ var: 'task.payload.approved' }, true] },
  },
];

/** Polls a task until `predicate` holds or the bounded budget is exhausted. */
const pollTask = async (args: {
  token: string;
  taskId: string;
  predicate: (task: Record<string, unknown>) => boolean;
}): Promise<Record<string, unknown>> => {
  for (let i = 0; i < 100; i += 1) {
    const res = await authenticatedTestClient(args.token).get(
      `/api/v1/tasks/${args.taskId}`
    );
    if (res.status === 200 && args.predicate(res.body)) return res.body;
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error(`pollTask: predicate never held for ${args.taskId}`);
};

type HistoryRow = {
  principal_kind: string;
  transition: string | null;
  note: string | null;
};

/** Polls a task's history until `predicate` holds or the budget is exhausted. */
const pollHistory = async (args: {
  token: string;
  taskId: string;
  predicate: (rows: HistoryRow[]) => boolean;
}): Promise<HistoryRow[]> => {
  for (let i = 0; i < 100; i += 1) {
    const res = await authenticatedTestClient(args.token).get(
      `/api/v1/tasks/${args.taskId}/history`
    );
    if (res.status === 200 && args.predicate(res.body)) return res.body;
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error(`pollHistory: predicate never held for ${args.taskId}`);
};

describe('Tasks', () => {
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let workflowId: string;
  let agentId: string;
  let userId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'tasks',
      policyActions: [
        'workflows:CreateWorkflow',
        'tasks:CreateTask',
        'tasks:ListTasks',
        'tasks:GetTask',
        'tasks:UpdateTask',
        'tasks:TransitionTask',
        'tasks:DeleteTask',
        'approvals:ListApprovals',
        'approvals:GetApproval',
        'approvals:ResolveApproval',
        'ai-providers:CreateAiProvider',
        'agents:CreateAgent',
        'orchestrations:CreateOrchestration',
        'orchestrations:GetRun',
        'orchestrations:StartRun',
        'tools:CreateTool',
        'guardrails:CreateGuardrail',
      ],
      createNoPermUser: true,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;
    userId = setup.userId;

    const aiProv = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Tasks Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    agentId = (
      await authenticatedTestClient(adminToken).post('/api/v1/agents').send({
        project_id: projectId,
        name: 'Tasks Agent',
        ai_provider_id: aiProv.body.id,
      })
    ).body.id;

    workflowId = (
      await authenticatedTestClient(userToken)
        .post('/api/v1/workflows')
        .send({
          project_id: projectId,
          name: 'tasks-pipeline',
          states: STATES,
          transitions: TRANSITIONS,
          payload_schema: { properties: { topic: { type: 'string' } } },
        })
    ).body.id;
  });

  // Drain any detached on_enter automation before teardown so trailing DB
  // writes never outlive the worker (jest force-exits on leaked handles).
  afterEach(async () => {
    await flushTaskAutomations();
  });

  const createTask = (payload: object = {}) => {
    return authenticatedTestClient(userToken).post('/api/v1/tasks').send({
      project_id: projectId,
      workflow_id: workflowId,
      title: 'A card',
      payload,
    });
  };

  const transition = (taskId: string, name: string, token = userToken) => {
    return authenticatedTestClient(token)
      .post(`/api/v1/tasks/${taskId}/transitions`)
      .send({ transition: name });
  };

  describe('POST /api/v1/tasks', () => {
    test('creates a task in the initial state with a history entry', async () => {
      const res = await createTask({ topic: 'spring' });
      expect(res.status).toBe(201);
      expect(res.body.id).toMatch(/^task_/);
      expect(res.body.state).toBe('triage');
      expect(res.body.status).toBe('open');
      expect(res.body.payload).toEqual({ topic: 'spring' });

      const history = await authenticatedTestClient(userToken).get(
        `/api/v1/tasks/${res.body.id}/history`
      );
      expect(history.status).toBe(200);
      expect(history.body).toHaveLength(1);
      expect(history.body[0].from_state).toBeNull();
      expect(history.body[0].to_state).toBe('triage');
      expect(history.body[0].principal_kind).toBe('user');
      expect(history.body[0].principal_id).toBe(userId);
      // The pre-#786 names are gone from the wire, not aliased.
      expect(history.body[0].actor_kind).toBeUndefined();
      expect(history.body[0].actor_id).toBeUndefined();
    });

    // #342 (same gap, third module): a task is long-lived, durable and moves
    // through states for days. Its only caller-settable bag was `payload` —
    // read by every guard and writable by the workflow's own `payload_writes`,
    // so an infrastructural label put there is neither inert nor safe from the
    // engine. `metadata` is caller-owned and untouched by both.
    describe('metadata', () => {
      test('round-trips verbatim on create, single read and list', async () => {
        const metadata = { tenant_account_id: '42', source: 'zendesk' };

        const res = await authenticatedTestClient(userToken)
          .post('/api/v1/tasks')
          .send({
            project_id: projectId,
            workflow_id: workflowId,
            title: 'A labelled card',
            payload: { topic: 'spring' },
            metadata,
          });
        expect(res.status).toBe(201);
        expect(res.body.metadata).toEqual(metadata);
        // The label stays out of the guard-visible payload.
        expect(res.body.payload).toEqual({ topic: 'spring' });

        const getRes = await authenticatedTestClient(userToken).get(
          `/api/v1/tasks/${res.body.id}`
        );
        expect(getRes.status).toBe(200);
        expect(getRes.body.metadata).toEqual(metadata);

        const listRes = await authenticatedTestClient(userToken).get(
          `/api/v1/tasks?workflow_id=${workflowId}`
        );
        expect(listRes.status).toBe(200);
        const listed = listRes.body.data.find((task: { id: string }) => {
          return task.id === res.body.id;
        });
        expect(listed.metadata).toEqual(metadata);
      });

      test('survives a transition, which supplies no metadata of its own', async () => {
        const res = await authenticatedTestClient(userToken)
          .post('/api/v1/tasks')
          .send({
            project_id: projectId,
            workflow_id: workflowId,
            title: 'A card that moves',
            metadata: { tenant_account_id: '42' },
          });
        expect(res.status).toBe(201);

        const moved = await transition(res.body.id, 'to_draft');
        expect(moved.status).toBe(200);
        expect(moved.body.metadata).toEqual({ tenant_account_id: '42' });
      });

      test('a task created without metadata reports null', async () => {
        const res = await createTask({ topic: 'spring' });
        expect(res.status).toBe(201);
        expect(res.body.metadata).toBeNull();
      });

      test('a non-object metadata is rejected with 400 and creates no task', async () => {
        const res = await authenticatedTestClient(userToken)
          .post('/api/v1/tasks')
          .send({
            project_id: projectId,
            workflow_id: workflowId,
            title: 'A rejected card',
            metadata: ['not', 'an', 'object'],
          });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
      });
    });

    test('rejects a payload that violates payload_schema', async () => {
      const res = await createTask({ topic: 123 });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TASK_PAYLOAD_INVALID');
    });

    test('404 for an unknown workflow', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/tasks')
        .send({ project_id: projectId, workflow_id: 'wfl_x', title: 't' });
      expect(res.status).toBe(404);
    });

    test('401 unauthenticated', async () => {
      const res = await testClient
        .post('/api/v1/tasks')
        .send({ project_id: projectId, workflow_id: workflowId, title: 't' });
      expect(res.status).toBe(401);
    });

    test('403 without permission', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .post('/api/v1/tasks')
        .send({ project_id: projectId, workflow_id: workflowId, title: 't' });
      expect(res.status).toBe(403);
    });

    test('history principal_id is the API key id (not the owner user id) for api_key auth (#608)', async () => {
      // The user creates an unscoped API key it owns; the key inherits the
      // owner's permissions.
      const keyRes = await authenticatedTestClient(userToken)
        .post('/api/v1/api-keys')
        .send({ name: 'task-actor-key' });
      expect(keyRes.status).toBe(201);
      const keyPublicId = keyRes.body.id as string;
      const rawKey = keyRes.body.key as string;
      expect(keyPublicId).toMatch(/^key_/);

      // Create a task authenticated as the API key.
      const created = await authenticatedTestClient(rawKey)
        .post('/api/v1/tasks')
        .send({
          project_id: projectId,
          workflow_id: workflowId,
          title: 'via key',
        });
      expect(created.status).toBe(201);

      const history = (
        await authenticatedTestClient(userToken).get(
          `/api/v1/tasks/${created.body.id}/history`
        )
      ).body;
      expect(history[0].principal_kind).toBe('api_key');
      // The forensic value: the specific key, distinguishable from the owner.
      expect(history[0].principal_id).toBe(keyPublicId);
    });
  });

  describe('POST /api/v1/tasks — alternate entry point via `state` (#821)', () => {
    test('creates the task directly in a named non-initial state', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/tasks')
        .send({
          project_id: projectId,
          workflow_id: workflowId,
          title: 'mid-flow card',
          state: 'draft',
          payload: { topic: 'spring' },
        });
      expect(res.status).toBe(201);
      expect(res.body.state).toBe('draft');
      expect(res.body.status).toBe('open');

      const history = (
        await authenticatedTestClient(userToken).get(
          `/api/v1/tasks/${res.body.id}/history`
        )
      ).body;
      // Mid-flow entry is a different first state, not a second lifecycle: a
      // single synthetic placement entry, same shape as the initial-state one.
      expect(history).toHaveLength(1);
      expect(history[0].from_state).toBeNull();
      expect(history[0].to_state).toBe('draft');
      expect(history[0].transition).toBeNull();
      expect(history[0].principal_kind).toBe('user');
    });

    test('creating directly in a terminal state closes the task', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/tasks')
        .send({
          project_id: projectId,
          workflow_id: workflowId,
          title: 'already published',
          state: 'published',
        });
      expect(res.status).toBe(201);
      expect(res.body.state).toBe('published');
      expect(res.body.status).toBe('closed');
    });

    test('400 TASK_STATE_NOT_FOUND for a state the workflow does not declare', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/tasks')
        .send({
          project_id: projectId,
          workflow_id: workflowId,
          title: 'bad state',
          state: 'not-a-real-state',
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TASK_STATE_NOT_FOUND');
    });

    test('on_enter automation fires for the named entry state, not the initial one', async () => {
      const dispatchWorkflowId = (
        await authenticatedTestClient(userToken)
          .post('/api/v1/workflows')
          .send({
            project_id: projectId,
            name: `alt-entry-${Math.random().toString(36).slice(2)}`,
            states: [
              { name: 'idea', initial: true },
              {
                name: 'writing',
                on_enter: {
                  dispatch: {
                    kind: 'agent',
                    agent_id: agentId,
                    input_mapping: {
                      prompt: {
                        cat: ['Write about ', { var: 'task.payload.topic' }],
                      },
                    },
                  },
                  on_complete: [{ when: true, transition: 'to_done' }],
                },
              },
              { name: 'done', terminal: true },
            ],
            transitions: [
              { name: 'to_writing', from: ['idea'], to: 'writing' },
              { name: 'to_done', from: ['writing'], to: 'done' },
            ],
          })
      ).body.id;

      mockCreateGeneration.mockResolvedValue({
        id: 'gen_alt_entry',
        traceId: 'trc_alt_entry',
        status: 'completed',
        output: { model: 'm', content: 'a post', finishReason: 'stop' },
      });

      const created = await authenticatedTestClient(userToken)
        .post('/api/v1/tasks')
        .send({
          project_id: projectId,
          workflow_id: dispatchWorkflowId,
          title: 'skip idea, start writing',
          state: 'writing',
          payload: { topic: 'autumn' },
        });
      expect(created.status).toBe(201);
      expect(created.body.state).toBe('writing');

      const settled = await pollTask({
        token: userToken,
        taskId: created.body.id,
        predicate: (t) => {
          return t.state === 'done';
        },
      });
      expect(settled.status).toBe('closed');

      // The `idea` state's on_enter (none declared) never fired — only
      // `writing`'s did, proving entry landed on the named state directly.
      expect(mockCreateGeneration).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId,
          messages: [{ role: 'user', content: 'Write about autumn' }],
        })
      );

      jest.clearAllMocks();
    });
  });

  describe('POST /api/v1/tasks/:id/transitions', () => {
    test('a backward move (review → draft → review) works and is fully audited', async () => {
      const task = (await createTask()).body;
      expect((await transition(task.id, 'to_review')).body.state).toBe(
        'review'
      );
      // review → draft is a backward move a DAG would reject by design.
      expect((await transition(task.id, 'to_draft')).body.state).toBe('draft');
      expect((await transition(task.id, 'to_review')).body.state).toBe(
        'review'
      );

      const history = (
        await authenticatedTestClient(userToken).get(
          `/api/v1/tasks/${task.id}/history`
        )
      ).body;
      // initial + 3 transitions.
      expect(history).toHaveLength(4);
      expect(
        history.map((h: { to_state: string }) => {
          return h.to_state;
        })
      ).toEqual(['triage', 'review', 'draft', 'review']);
    });

    test('a false guard rejects the move before any state change', async () => {
      const task = (await createTask()).body;
      await transition(task.id, 'to_review');
      const res = await transition(task.id, 'publish'); // approved not set
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TASK_GUARD_REJECTED');
      // State unchanged.
      const after = await authenticatedTestClient(userToken).get(
        `/api/v1/tasks/${task.id}`
      );
      expect(after.body.state).toBe('review');
    });

    test('a passing guard closes the task on a terminal state; then 409', async () => {
      const task = (await createTask()).body;
      await transition(task.id, 'to_review');
      await authenticatedTestClient(userToken)
        .patch(`/api/v1/tasks/${task.id}`)
        .send({ payload: { approved: true } });

      const published = await transition(task.id, 'publish');
      expect(published.status).toBe(200);
      expect(published.body.state).toBe('published');
      expect(published.body.status).toBe('closed');

      // A closed task can no longer transition.
      const again = await transition(task.id, 'to_draft');
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('TASK_TRANSITION_CONFLICT');
    });

    test('a guard reads the firing principal as `principal` (#786)', async () => {
      // A guard that only a `user` principal satisfies. If the guard context
      // did not bind `principal`, `var` would resolve to null and this move
      // would be rejected — so a 200 here proves the binding.
      const wf = (
        await authenticatedTestClient(userToken)
          .post('/api/v1/workflows')
          .send({
            project_id: projectId,
            name: 'principal-guard',
            states: [{ name: 'start', initial: true }, { name: 'done' }],
            transitions: [
              {
                name: 'advance',
                from: ['start'],
                to: 'done',
                guard: { '==': [{ var: 'principal.kind' }, 'user'] },
              },
            ],
          })
      ).body.id;

      const task = (
        await authenticatedTestClient(userToken).post('/api/v1/tasks').send({
          project_id: projectId,
          workflow_id: wf,
          title: 'principal guard',
        })
      ).body;

      const moved = await transition(task.id, 'advance');
      expect(moved.status).toBe(200);
      expect(moved.body.state).toBe('done');
    });

    test('a guard on the removed `actor` name no longer resolves (#786)', async () => {
      // `actor` was renamed to `principal`; the old name is not aliased, so a
      // guard still reading `actor.kind` resolves to null and rejects the move.
      // This pins the rename as a real break rather than a silent dual-binding.
      const wf = (
        await authenticatedTestClient(userToken)
          .post('/api/v1/workflows')
          .send({
            project_id: projectId,
            name: 'legacy-actor-guard',
            states: [{ name: 'start', initial: true }, { name: 'done' }],
            transitions: [
              {
                name: 'advance',
                from: ['start'],
                to: 'done',
                guard: { '==': [{ var: 'actor.kind' }, 'user'] },
              },
            ],
          })
      ).body.id;

      const task = (
        await authenticatedTestClient(userToken).post('/api/v1/tasks').send({
          project_id: projectId,
          workflow_id: wf,
          title: 'legacy actor guard',
        })
      ).body;

      const res = await transition(task.id, 'advance');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TASK_GUARD_REJECTED');
    });

    test('an unknown transition name is 400 TASK_TRANSITION_NOT_FOUND', async () => {
      const task = (await createTask()).body;
      const res = await transition(task.id, 'nope');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TASK_TRANSITION_NOT_FOUND');
    });

    test('a transition invalid from the current state is 409', async () => {
      const task = (await createTask()).body; // in triage
      const res = await transition(task.id, 'publish'); // only valid from review
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('TASK_TRANSITION_CONFLICT');
    });

    test('403 without permission', async () => {
      const task = (await createTask()).body;
      const res = await transition(task.id, 'to_review', noPermToken);
      expect(res.status).toBe(403);
    });

    test('401 for unauthenticated requests', async () => {
      const task = (await createTask()).body;
      const res = await testClient
        .post(`/api/v1/tasks/${task.id}/transitions`)
        .send({ transition: 'to_review' });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/tasks (board query)', () => {
    test('filters by state and status', async () => {
      const task = (await createTask()).body;
      await transition(task.id, 'to_review');

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/tasks?workflow_id=${workflowId}&state=review&status=open`
      );
      expect(res.status).toBe(200);
      expect(
        res.body.data.every((t: { state: string }) => {
          return t.state === 'review';
        })
      ).toBe(true);
      expect(
        res.body.data.some((t: { id: string }) => {
          return t.id === task.id;
        })
      ).toBe(true);
    });
  });

  describe('GET /api/v1/tasks/:id', () => {
    test('returns a single task to a permitted user', async () => {
      const task = (await createTask({ topic: 'x' })).body;
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/tasks/${task.id}`
      );
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(task.id);
      expect(res.body.workflow_id).toBe(workflowId);
    });

    test('404 for an unknown task', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/tasks/task_missing'
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('TASK_NOT_FOUND');
    });

    test('403 without permission', async () => {
      const task = (await createTask()).body;
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/tasks/${task.id}`
      );
      expect(res.status).toBe(403);
    });

    test('403 without permission on history', async () => {
      const task = (await createTask()).body;
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/tasks/${task.id}/history`
      );
      expect(res.status).toBe(403);
    });

    test('404 on history for an unknown task', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/tasks/task_missing/history'
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('TASK_NOT_FOUND');
    });

    test('401 for unauthenticated list requests', async () => {
      const res = await testClient.get(
        `/api/v1/tasks?workflow_id=${workflowId}`
      );
      expect(res.status).toBe(401);
    });

    test('401 for unauthenticated single-task requests', async () => {
      const task = (await createTask()).body;
      const res = await testClient.get(`/api/v1/tasks/${task.id}`);
      expect(res.status).toBe(401);
    });
  });

  describe('PATCH /api/v1/tasks/:id', () => {
    test('updates the title and assignee', async () => {
      const task = (await createTask()).body;
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/tasks/${task.id}`)
        .send({ title: 'Renamed', assignee: 'usr_someone' });
      expect(res.status).toBe(200);
      expect(res.body.title).toBe('Renamed');
      expect(res.body.assignee).toBe('usr_someone');
    });

    test('merges the payload rather than replacing it, preserving keys the patch omits', async () => {
      const task = (await createTask({ topic: 'spring' })).body;
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/tasks/${task.id}`)
        .send({ payload: { approved: true } });
      expect(res.status).toBe(200);
      // `topic` (set at creation, and what an on_enter automation would write
      // to `last_result`) survives a partial patch that only sets `approved`.
      expect(res.body.payload).toEqual({ topic: 'spring', approved: true });
    });

    test('a payload key can be overwritten by the patch', async () => {
      const task = (await createTask({ topic: 'spring' })).body;
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/tasks/${task.id}`)
        .send({ payload: { topic: 'summer' } });
      expect(res.status).toBe(200);
      expect(res.body.payload).toEqual({ topic: 'summer' });
    });

    test('404 for an unknown task', async () => {
      const res = await authenticatedTestClient(userToken)
        .patch('/api/v1/tasks/task_missing')
        .send({ title: 'x' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('TASK_NOT_FOUND');
    });

    test('rejects a `state` field as an unknown field, leaving state unchanged (#605)', async () => {
      const task = (await createTask()).body;
      const stateBefore = task.state;

      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/tasks/${task.id}`)
        .send({ state: 'published' });

      // `state` is never directly writable — it is rejected by the strict-field
      // request validation as an unknown property of UpdateTaskRequest.
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.meta.unknownFields).toContain('state');

      // The task's state must be untouched by the rejected write.
      const after = await authenticatedTestClient(userToken).get(
        `/api/v1/tasks/${task.id}`
      );
      expect(after.body.state).toBe(stateBefore);
    });

    test('403 without permission', async () => {
      const task = (await createTask()).body;
      const res = await authenticatedTestClient(noPermToken)
        .patch(`/api/v1/tasks/${task.id}`)
        .send({ title: 'x' });
      expect(res.status).toBe(403);
    });

    test('401 for unauthenticated requests', async () => {
      const task = (await createTask()).body;
      const res = await testClient
        .patch(`/api/v1/tasks/${task.id}`)
        .send({ title: 'x' });
      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /api/v1/tasks/:id', () => {
    test('deletes a task', async () => {
      const task = (await createTask()).body;
      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/tasks/${task.id}`
      );
      expect(res.status).toBe(204);

      const after = await authenticatedTestClient(userToken).get(
        `/api/v1/tasks/${task.id}`
      );
      expect(after.status).toBe(404);
    });

    test('404 for an unknown task', async () => {
      const res = await authenticatedTestClient(userToken).delete(
        '/api/v1/tasks/task_missing'
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('TASK_NOT_FOUND');
    });

    test('403 without permission', async () => {
      const task = (await createTask()).body;
      const res = await authenticatedTestClient(noPermToken).delete(
        `/api/v1/tasks/${task.id}`
      );
      expect(res.status).toBe(403);
    });
  });

  describe('a task whose initial state is terminal', () => {
    test('is created already closed', async () => {
      const wf = (
        await authenticatedTestClient(userToken)
          .post('/api/v1/workflows')
          .send({
            project_id: projectId,
            name: `instant-${Math.random().toString(36).slice(2)}`,
            states: [{ name: 'done', initial: true, terminal: true }],
            transitions: [],
          })
      ).body;

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/tasks')
        .send({ project_id: projectId, workflow_id: wf.id, title: 'instant' });
      expect(res.status).toBe(201);
      expect(res.body.state).toBe('done');
      expect(res.body.status).toBe('closed');
    });
  });

  // #846 — `last_result` is the record of what an automation actually did, so
  // it lives in its own server-owned column, exposed to guards as
  // `task.last_result`. `payload` is 100% caller-owned: a caller can write a
  // `last_result` key into it, but nothing server-side reads it back.
  describe('last_result is server-owned (#846)', () => {
    let lrWorkflowId: string;

    beforeAll(async () => {
      lrWorkflowId = (
        await authenticatedTestClient(userToken)
          .post('/api/v1/workflows')
          .send({
            project_id: projectId,
            name: 'last-result-pipeline',
            states: [
              {
                name: 'writing',
                initial: true,
                on_enter: {
                  dispatch: {
                    kind: 'agent',
                    agent_id: agentId,
                    input_mapping: { prompt: 'Write.' },
                  },
                  on_complete: [{ when: true, transition: 'to_review' }],
                },
              },
              { name: 'review', kind: 'human' },
              { name: 'done', terminal: true },
            ],
            transitions: [
              { name: 'to_review', from: ['writing'], to: 'review' },
              {
                name: 'approve',
                from: ['review'],
                to: 'done',
                // The guard asks "did the automation succeed?" — it must only
                // ever be satisfiable by an automation-written value.
                guard: {
                  '==': [{ var: 'task.last_result.finishReason' }, 'stop'],
                },
              },
            ],
          })
      ).body.id;
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    test('a dispatch result lands in the last_result field, not in the caller payload', async () => {
      mockCreateGeneration.mockResolvedValue({
        id: 'gen_lr_1',
        traceId: 'trc_lr_1',
        status: 'completed',
        output: { model: 'm', content: 'a sonnet', finishReason: 'stop' },
      });

      const created = await authenticatedTestClient(userToken)
        .post('/api/v1/tasks')
        .send({
          project_id: projectId,
          workflow_id: lrWorkflowId,
          title: 'lr card',
          payload: { topic: 'spring' },
        });
      expect(created.status).toBe(201);

      const settled = await pollTask({
        token: userToken,
        taskId: created.body.id,
        predicate: (t) => {
          return t.state === 'review';
        },
      });

      expect(settled.last_result).toEqual({
        model: 'm',
        content: 'a sonnet',
        finishReason: 'stop',
      });
      // The caller bag carries no server key anymore.
      expect(settled.payload).toEqual({ topic: 'spring' });
    });

    test('a caller-written payload.last_result cannot satisfy a guard on task.last_result', async () => {
      // A workflow whose task never dispatched: last_result is unset, and the
      // caller tries to forge it through the one write path they own.
      const wf = (
        await authenticatedTestClient(userToken)
          .post('/api/v1/workflows')
          .send({
            project_id: projectId,
            name: 'lr-guard-forge',
            states: [
              { name: 'review', initial: true, kind: 'human' },
              { name: 'done', terminal: true },
            ],
            transitions: [
              {
                name: 'approve',
                from: ['review'],
                to: 'done',
                guard: {
                  '==': [{ var: 'task.last_result.finishReason' }, 'stop'],
                },
              },
            ],
          })
      ).body;

      const task = (
        await authenticatedTestClient(userToken).post('/api/v1/tasks').send({
          project_id: projectId,
          workflow_id: wf.id,
          title: 'forge card',
        })
      ).body;

      const patched = await authenticatedTestClient(userToken)
        .patch(`/api/v1/tasks/${task.id}`)
        .send({ payload: { last_result: { finishReason: 'stop' } } });
      expect(patched.status).toBe(200);
      // The patch lands in the caller-owned payload...
      expect(patched.body.payload).toEqual({
        last_result: { finishReason: 'stop' },
      });
      // ...but never in the server-owned field the guard reads.
      expect(patched.body.last_result).toBeNull();

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/tasks/${task.id}/transitions`)
        .send({ transition: 'approve' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TASK_GUARD_REJECTED');
    });

    test('an automation-written last_result satisfies the same guard', async () => {
      mockCreateGeneration.mockResolvedValue({
        id: 'gen_lr_2',
        traceId: 'trc_lr_2',
        status: 'completed',
        output: { model: 'm', content: 'ok', finishReason: 'stop' },
      });

      const created = await authenticatedTestClient(userToken)
        .post('/api/v1/tasks')
        .send({
          project_id: projectId,
          workflow_id: lrWorkflowId,
          title: 'lr guard card',
        });

      const settled = await pollTask({
        token: userToken,
        taskId: created.body.id,
        predicate: (t) => {
          return t.state === 'review';
        },
      });
      expect(settled.last_result).toBeDefined();

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/tasks/${created.body.id}/transitions`)
        .send({ transition: 'approve' });
      expect(res.status).toBe(200);
      expect(res.body.state).toBe('done');
    });
  });

  describe('on_enter agent dispatch (Phase 2)', () => {
    let dispatchWorkflowId: string;

    beforeAll(async () => {
      dispatchWorkflowId = (
        await authenticatedTestClient(userToken)
          .post('/api/v1/workflows')
          .send({
            project_id: projectId,
            name: 'sonnet-pipeline',
            states: [
              {
                name: 'writing',
                initial: true,
                on_enter: {
                  dispatch: {
                    kind: 'agent',
                    agent_id: agentId,
                    input_mapping: {
                      prompt: {
                        cat: ['Write about ', { var: 'task.payload.topic' }],
                      },
                    },
                  },
                  on_complete: [{ when: true, transition: 'to_done' }],
                },
              },
              { name: 'done', terminal: true },
            ],
            transitions: [{ name: 'to_done', from: ['writing'], to: 'done' }],
          })
      ).body.id;
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    test('entering the initial state dispatches an agent and routes on_complete', async () => {
      mockCreateGeneration.mockResolvedValue({
        id: 'gen_test1',
        traceId: 'trc_test1',
        status: 'completed',
        output: { model: 'm', content: 'a sonnet', finishReason: 'stop' },
      });

      const created = await authenticatedTestClient(userToken)
        .post('/api/v1/tasks')
        .send({
          project_id: projectId,
          workflow_id: dispatchWorkflowId,
          title: 'sonnet card',
          payload: { topic: 'spring' },
        });
      expect(created.status).toBe(201);

      const settled = await pollTask({
        token: userToken,
        taskId: created.body.id,
        predicate: (t) => {
          return t.state === 'done';
        },
      });
      expect(settled.status).toBe('closed');
      // The generation output is written to the last_result field verbatim.
      expect(settled.last_result).toEqual({
        model: 'm',
        content: 'a sonnet',
        finishReason: 'stop',
      });

      // The prompt was resolved from the task payload via input_mapping.
      expect(mockCreateGeneration).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId,
          messages: [{ role: 'user', content: 'Write about spring' }],
        })
      );

      // The routed move was recorded as the `automation` principal with
      // provenance. There is no principal behind an automated move, so
      // `principal_id` is null and the cause lives only in `generation_id`.
      const history = (
        await authenticatedTestClient(userToken).get(
          `/api/v1/tasks/${created.body.id}/history`
        )
      ).body;
      const routed = history.find((h: { transition: string }) => {
        return h.transition === 'to_done';
      });
      expect(routed.principal_kind).toBe('automation');
      expect(routed.principal_id).toBeNull();
      expect(routed.generation_id).toBe('gen_test1');
    });
  });

  describe('on_enter dispatch variants (Phase 2)', () => {
    afterEach(() => {
      jest.clearAllMocks();
    });

    const dispatchWorkflow = async (args: {
      name: string;
      onEnter: object;
      extraStates?: object[];
      extraTransitions?: object[];
    }) => {
      return (
        await authenticatedTestClient(userToken)
          .post('/api/v1/workflows')
          .send({
            project_id: projectId,
            name: `${args.name}-${Math.random().toString(36).slice(2)}`,
            states: [
              { name: 'writing', initial: true, on_enter: args.onEnter },
              { name: 'done', terminal: true },
              ...(args.extraStates ?? []),
            ],
            transitions: [
              { name: 'to_done', from: ['writing'], to: 'done' },
              ...(args.extraTransitions ?? []),
            ],
          })
      ).body.id;
    };

    const startTask = async (workflow: string, payload: object) => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/tasks')
        .send({
          project_id: projectId,
          workflow_id: workflow,
          title: 'card',
          payload,
        });
      expect(res.status).toBe(201);
      return res.body.id;
    };

    test('an input_mapping producing a messages array is passed through', async () => {
      mockCreateGeneration.mockResolvedValue({
        id: 'gen_m',
        traceId: 'trc_m',
        status: 'completed',
        output: { model: 'm', content: 'ok', finishReason: 'stop' },
      });
      const wf = await dispatchWorkflow({
        name: 'msgs',
        onEnter: {
          dispatch: {
            kind: 'agent',
            agent_id: agentId,
            input_mapping: {
              messages: [{ role: 'user', content: 'literal message' }],
            },
          },
          on_complete: [{ when: true, transition: 'to_done' }],
        },
      });
      const taskId = await startTask(wf, {});
      await pollTask({
        token: userToken,
        taskId,
        predicate: (t) => {
          return t.state === 'done';
        },
      });
      expect(mockCreateGeneration).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [{ role: 'user', content: 'literal message' }],
        })
      );
    });

    test('payload_writes survives a second dispatch that overwrites last_result', async () => {
      mockCreateGeneration
        .mockResolvedValueOnce({
          id: 'gen_write',
          traceId: 'trc_write',
          status: 'completed',
          output: { model: 'm', content: 'DOC123', finishReason: 'stop' },
        })
        .mockResolvedValueOnce({
          id: 'gen_read',
          traceId: 'trc_read',
          status: 'completed',
          output: {
            model: 'm',
            content: 'second hop done',
            finishReason: 'stop',
          },
        });

      const wf = await dispatchWorkflow({
        name: 'writes',
        onEnter: {
          dispatch: {
            kind: 'agent',
            agent_id: agentId,
            payload_writes: { doc_id: { var: 'result.content' } },
          },
          on_complete: [{ when: true, transition: 'to_middle' }],
        },
        extraStates: [
          {
            name: 'middle',
            on_enter: {
              dispatch: {
                kind: 'agent',
                agent_id: agentId,
                input_mapping: {
                  prompt: {
                    cat: ['use doc ', { var: 'task.payload.doc_id' }],
                  },
                },
              },
              on_complete: [{ when: true, transition: 'finish' }],
            },
          },
        ],
        extraTransitions: [
          { name: 'to_middle', from: ['writing'], to: 'middle' },
          { name: 'finish', from: ['middle'], to: 'done' },
        ],
      });

      const taskId = await startTask(wf, {});
      const settled = await pollTask({
        token: userToken,
        taskId,
        predicate: (t) => {
          return t.state === 'done';
        },
      });

      // The write from the first dispatch survives the second dispatch's
      // last_result overwrite — it lives in a distinct payload key, not the
      // one-hop `last_result` channel.
      expect((settled.payload as { doc_id?: unknown }).doc_id).toBe('DOC123');
      expect(settled.last_result).toEqual({
        model: 'm',
        content: 'second hop done',
        finishReason: 'stop',
      });

      // The second dispatch's input_mapping read the write back deterministically.
      expect(mockCreateGeneration).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          messages: [{ role: 'user', content: 'use doc DOC123' }],
        })
      );
    });

    test('a mapping without prompt/messages is JSON-encoded as one message', async () => {
      mockCreateGeneration.mockResolvedValue({
        id: 'gen_j',
        traceId: 'trc_j',
        status: 'completed',
        output: { model: 'm', content: 'ok', finishReason: 'stop' },
      });
      const wf = await dispatchWorkflow({
        name: 'json',
        onEnter: {
          dispatch: {
            kind: 'agent',
            agent_id: agentId,
            input_mapping: { topic: { var: 'task.payload.topic' } },
          },
          on_complete: [{ when: true, transition: 'to_done' }],
        },
      });
      const taskId = await startTask(wf, { topic: 'autumn' });
      await pollTask({
        token: userToken,
        taskId,
        predicate: (t) => {
          return t.state === 'done';
        },
      });
      const call = mockCreateGeneration.mock.calls[0][0] as {
        messages: { role: string; content: string }[];
      };
      expect(call.messages).toHaveLength(1);
      expect(JSON.parse(call.messages[0].content)).toEqual({ topic: 'autumn' });
    });

    test('an on_complete with no matching rule parks the task as completed', async () => {
      mockCreateGeneration.mockResolvedValue({
        id: 'gen_u',
        traceId: 'trc_u',
        status: 'completed',
        output: { model: 'm', content: 'ok', finishReason: 'stop' },
      });
      const wf = await dispatchWorkflow({
        name: 'unrouted',
        onEnter: {
          dispatch: { kind: 'agent', agent_id: agentId },
          on_complete: [{ when: false, transition: 'to_done' }],
        },
      });
      const taskId = await startTask(wf, {});
      const settled = await pollTask({
        token: userToken,
        taskId,
        predicate: (t) => {
          return t.automation_status === 'completed';
        },
      });
      // No rule matched: the task stays in the automated state, not `done`.
      expect(settled.state).toBe('writing');
      expect(settled.status).toBe('open');
    });

    test('a matched on_complete transition rejected by its guard surfaces automation_status=unrouted', async () => {
      mockCreateGeneration.mockResolvedValue({
        id: 'gen_gr',
        traceId: 'trc_gr',
        status: 'completed',
        output: { model: 'm', content: 'ok', finishReason: 'stop' },
      });
      // The dispatch completes and the rule matches, but `advance` is guarded to
      // accept only a `user` actor — the `automation` actor is rejected. The task
      // must not be left parked as `completed` (the "silently stuck" state).
      const wf = await dispatchWorkflow({
        name: 'guard-reject',
        onEnter: {
          dispatch: { kind: 'agent', agent_id: agentId },
          on_complete: [{ when: true, transition: 'advance' }],
        },
        extraStates: [{ name: 'approved', terminal: true }],
        extraTransitions: [
          {
            name: 'advance',
            from: ['writing'],
            to: 'approved',
            guard: { '==': [{ var: 'principal.kind' }, 'user'] },
          },
        ],
      });
      const taskId = await startTask(wf, {});
      const settled = await pollTask({
        token: userToken,
        taskId,
        predicate: (t) => {
          return t.automation_status === 'unrouted';
        },
      });
      // Guard rejected the automation actor: the task stays put, but is flagged
      // `unrouted` so board queries can find it — not silently `completed`.
      expect(settled.state).toBe('writing');
      expect(settled.status).toBe('open');

      // The rejected transition never lands in history.
      const history = (
        await authenticatedTestClient(userToken).get(
          `/api/v1/tasks/${taskId}/history`
        )
      ).body;
      expect(
        history.some((h: { transition: string }) => {
          return h.transition === 'advance';
        })
      ).toBe(false);
    });

    test('a failed dispatch sets automation_status and follows on_failure', async () => {
      // Production createGeneration always wraps a terminal failure in a
      // DomainError carrying the generation_id (see recordGenerationFailure) — a
      // real dispatch failure never comes back with zero provenance.
      mockCreateGeneration.mockRejectedValue(
        new DomainError('AI_PROVIDER_ERROR', 'model exploded', {
          generation_id: 'gen_exploded890',
        })
      );
      const wf = await dispatchWorkflow({
        name: 'failing',
        onEnter: {
          dispatch: { kind: 'agent', agent_id: agentId },
          on_complete: [{ when: true, transition: 'to_done' }],
          on_failure: 'to_failed',
        },
        extraStates: [{ name: 'failed', terminal: true }],
        extraTransitions: [
          { name: 'to_failed', from: ['writing'], to: 'failed' },
        ],
      });
      const taskId = await startTask(wf, {});
      const settled = await pollTask({
        token: userToken,
        taskId,
        predicate: (t) => {
          return t.state === 'failed';
        },
      });
      expect(settled.status).toBe('closed');
      // No `retry` declared: exactly one attempt (#822).
      expect(mockCreateGeneration).toHaveBeenCalledTimes(1);
    });

    test('an on_enter retry policy round-trips snake_case (#822)', async () => {
      const created = await authenticatedTestClient(userToken)
        .post('/api/v1/workflows')
        .send({
          project_id: projectId,
          name: `retry-shape-${Math.random().toString(36).slice(2)}`,
          states: [
            {
              name: 'writing',
              initial: true,
              on_enter: {
                dispatch: { kind: 'agent', agent_id: agentId },
                retry: {
                  max_attempts: 2,
                  backoff_seconds: 1,
                  backoff_multiplier: 2,
                },
                on_complete: [{ when: true, transition: 'to_done' }],
              },
            },
            { name: 'done', terminal: true },
          ],
          transitions: [{ name: 'to_done', from: ['writing'], to: 'done' }],
        });
      expect(created.status).toBe(201);
      expect(created.body.states[0].on_enter.retry).toEqual({
        max_attempts: 2,
        backoff_seconds: 1,
        backoff_multiplier: 2,
      });
    });

    test('a retry policy re-dispatches after a transient failure and completes (#822)', async () => {
      mockCreateGeneration
        .mockRejectedValueOnce(
          new DomainError('AI_PROVIDER_ERROR', 'transient 502', {
            generation_id: 'gen_flake1',
          })
        )
        .mockResolvedValueOnce({
          id: 'gen_ok2',
          traceId: 'trc_ok2',
          status: 'completed',
          output: { model: 'm', content: 'second try', finishReason: 'stop' },
        });

      const wf = await dispatchWorkflow({
        name: 'retrying',
        onEnter: {
          dispatch: { kind: 'agent', agent_id: agentId },
          retry: { max_attempts: 3, backoff_seconds: 0 },
          on_complete: [{ when: true, transition: 'to_done' }],
          on_failure: 'to_failed',
        },
        extraStates: [{ name: 'failed', terminal: true }],
        extraTransitions: [
          { name: 'to_failed', from: ['writing'], to: 'failed' },
        ],
      });
      const taskId = await startTask(wf, {});
      const settled = await pollTask({
        token: userToken,
        taskId,
        predicate: (t) => {
          return t.state === 'done';
        },
      });

      // The flake cost an attempt, not the card: two dispatches, the second one
      // routed through on_complete, and on_failure never fired.
      expect(mockCreateGeneration).toHaveBeenCalledTimes(2);
      expect(settled.last_result).toEqual({
        model: 'm',
        content: 'second try',
        finishReason: 'stop',
      });

      const history = (
        await authenticatedTestClient(userToken).get(
          `/api/v1/tasks/${taskId}/history`
        )
      ).body;
      expect(
        history.some((h: { transition: string | null }) => {
          return h.transition === 'to_failed';
        })
      ).toBe(false);
      const routed = history.find((h: { transition: string | null }) => {
        return h.transition === 'to_done';
      });
      expect(routed.generation_id).toBe('gen_ok2');
    });

    test('on_failure fires only after the last retry attempt (#822)', async () => {
      mockCreateGeneration.mockRejectedValue(
        new DomainError('AI_PROVIDER_ERROR', 'always down', {
          generation_id: 'gen_down822',
        })
      );

      const wf = await dispatchWorkflow({
        name: 'retry-exhausted',
        onEnter: {
          dispatch: { kind: 'agent', agent_id: agentId },
          retry: { max_attempts: 3, backoff_seconds: 0 },
          on_complete: [{ when: true, transition: 'to_done' }],
          on_failure: 'to_failed',
        },
        extraStates: [{ name: 'failed', terminal: true }],
        extraTransitions: [
          { name: 'to_failed', from: ['writing'], to: 'failed' },
        ],
      });
      const taskId = await startTask(wf, {});
      const settled = await pollTask({
        token: userToken,
        taskId,
        predicate: (t) => {
          return t.state === 'failed';
        },
      });

      expect(mockCreateGeneration).toHaveBeenCalledTimes(3);
      expect(settled.status).toBe('closed');
      const history = (
        await authenticatedTestClient(userToken).get(
          `/api/v1/tasks/${taskId}/history`
        )
      ).body;
      // on_failure routed exactly once — after the last attempt, not per attempt.
      expect(
        history.filter((h: { transition: string | null }) => {
          return h.transition === 'to_failed';
        })
      ).toHaveLength(1);
    });

    test('an exhausted retry policy parks the task with the burned attempt count (#822)', async () => {
      mockCreateGeneration.mockRejectedValue(
        new DomainError('AI_PROVIDER_ERROR', 'always down', {
          generation_id: 'gen_parked822',
        })
      );

      const wf = await dispatchWorkflow({
        name: 'retry-parked',
        onEnter: {
          dispatch: { kind: 'agent', agent_id: agentId },
          retry: { max_attempts: 2, backoff_seconds: 0 },
          on_complete: [{ when: true, transition: 'to_done' }],
        },
      });
      const taskId = await startTask(wf, {});
      const parked = await pollTask({
        token: userToken,
        taskId,
        predicate: (t) => {
          return t.automation_status === 'failed';
        },
      });

      expect(mockCreateGeneration).toHaveBeenCalledTimes(2);
      // With no `on_failure` the card parks in place, and the attempt count
      // sits next to the failed dispatch's provenance so the audit trail shows
      // how many attempts the flake burned.
      expect(parked.state).toBe('writing');
      expect(parked.active_dispatch).toEqual({
        kind: 'generation',
        id: 'gen_parked822',
        status: 'failed',
        attempt: 2,
      });
    });

    test('a dispatch with no retry policy records no attempt counter (#822)', async () => {
      mockCreateGeneration.mockRejectedValue(
        new DomainError('AI_PROVIDER_ERROR', 'down', {
          generation_id: 'gen_noretry822',
        })
      );

      const wf = await dispatchWorkflow({
        name: 'no-retry',
        onEnter: {
          dispatch: { kind: 'agent', agent_id: agentId },
          on_complete: [{ when: true, transition: 'to_done' }],
        },
      });
      const taskId = await startTask(wf, {});
      const parked = await pollTask({
        token: userToken,
        taskId,
        predicate: (t) => {
          return t.automation_status === 'failed';
        },
      });

      // Strictly additive: without `retry`, `active_dispatch` keeps exactly the
      // shape it had before retries existed.
      expect(mockCreateGeneration).toHaveBeenCalledTimes(1);
      expect(parked.active_dispatch).toEqual({
        kind: 'generation',
        id: 'gen_noretry822',
        status: 'failed',
      });
    });

    test('a task that leaves the state between attempts abandons its remaining retries (#822)', async () => {
      mockCreateGeneration.mockRejectedValue(
        new DomainError('AI_PROVIDER_ERROR', 'transient', {
          generation_id: 'gen_stale822',
        })
      );

      const wf = await dispatchWorkflow({
        name: 'retry-stale',
        onEnter: {
          dispatch: { kind: 'agent', agent_id: agentId },
          // A backoff long enough to move the task out of the state while the
          // automation is sleeping between attempts.
          retry: { max_attempts: 3, backoff_seconds: 3 },
          on_complete: [{ when: true, transition: 'to_done' }],
          on_failure: 'to_failed',
        },
        extraStates: [{ name: 'failed', terminal: true }],
        extraTransitions: [
          { name: 'to_failed', from: ['writing'], to: 'failed' },
        ],
      });
      const taskId = await startTask(wf, {});

      // Wait for the first attempt to fail, then move the card by hand.
      for (
        let i = 0;
        i < 100 && mockCreateGeneration.mock.calls.length < 1;
        i += 1
      ) {
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
      }
      expect((await transition(taskId, 'to_done')).body.state).toBe('done');

      await flushTaskAutomations();

      // The remaining attempts were abandoned rather than re-dispatched against
      // a task that had already moved on (same staleness rule as a single
      // attempt), and on_failure never fired.
      expect(mockCreateGeneration).toHaveBeenCalledTimes(1);
      const task = (
        await authenticatedTestClient(userToken).get(`/api/v1/tasks/${taskId}`)
      ).body;
      expect(task.state).toBe('done');
      const history = (
        await authenticatedTestClient(userToken).get(
          `/api/v1/tasks/${taskId}/history`
        )
      ).body;
      expect(
        history.some((h: { transition: string | null }) => {
          return h.transition === 'to_failed';
        })
      ).toBe(false);
    });

    test('a failed dispatch with no recoverable cause id never persists a provenance-less automation transition (#792)', async () => {
      // Simulates a dispatch failure that surfaces before any generation or
      // orchestration run id exists (e.g. a bug upstream of recordGenerationFailure).
      // Without a defensive check this would silently write a `to_failed` history
      // row with principal_id, generation_id, and orchestration_run_id all null —
      // a transition with no recorded cause at all.
      mockCreateGeneration.mockRejectedValue(new Error('no meta at all'));
      const wf = await dispatchWorkflow({
        name: 'failing-no-provenance',
        onEnter: {
          dispatch: { kind: 'agent', agent_id: agentId },
          on_complete: [{ when: true, transition: 'to_done' }],
          on_failure: 'to_failed',
        },
        extraStates: [{ name: 'failed', terminal: true }],
        extraTransitions: [
          { name: 'to_failed', from: ['writing'], to: 'failed' },
        ],
      });
      const taskId = await startTask(wf, {});
      await flushTaskAutomations();

      const task = (
        await authenticatedTestClient(userToken).get(`/api/v1/tasks/${taskId}`)
      ).body;
      // The rejected transition never applied: the task stays in `writing`,
      // flagged `failed` by automation_status, rather than moving to a `failed`
      // state whose history row would carry no cause.
      expect(task.state).toBe('writing');
      expect(task.status).toBe('open');
      expect(task.automation_status).toBe('failed');

      const history = (
        await authenticatedTestClient(userToken).get(
          `/api/v1/tasks/${taskId}/history`
        )
      ).body;
      expect(
        history.some((h: { transition: string | null }) => {
          return h.transition === 'to_failed';
        })
      ).toBe(false);
    });

    test('on_failure history links the failed generation (#607)', async () => {
      // Production createGeneration wraps terminal failures in a DomainError
      // whose meta carries the generation_id (see recordGenerationFailure).
      mockCreateGeneration.mockRejectedValue(
        new DomainError('AI_PROVIDER_ERROR', 'invalid credentials', {
          generation_id: 'gen_failed607',
          trace_id: 'trc_failed607',
        })
      );
      const wf = await dispatchWorkflow({
        name: 'failing-link',
        onEnter: {
          dispatch: { kind: 'agent', agent_id: agentId },
          on_complete: [{ when: true, transition: 'to_done' }],
          on_failure: 'to_failed',
        },
        extraStates: [{ name: 'failed', terminal: true }],
        extraTransitions: [
          { name: 'to_failed', from: ['writing'], to: 'failed' },
        ],
      });
      const taskId = await startTask(wf, {});
      await pollTask({
        token: userToken,
        taskId,
        predicate: (t) => {
          return t.state === 'failed';
        },
      });

      const history = (
        await authenticatedTestClient(userToken).get(
          `/api/v1/tasks/${taskId}/history`
        )
      ).body;
      const routed = history.find((h: { transition: string }) => {
        return h.transition === 'to_failed';
      });
      expect(routed.principal_kind).toBe('automation');
      // The causing (failed) generation is linked so a reader can jump to its trace.
      expect(routed.generation_id).toBe('gen_failed607');
      // The cause is not a principal: it is carried by `generation_id` alone,
      // never duplicated into the principal field (#786).
      expect(routed.principal_id).toBeNull();
    });

    test('an orchestration dispatch runs the pipeline and routes on_complete', async () => {
      const orchestrationId = (
        await authenticatedTestClient(userToken)
          .post('/api/v1/orchestrations')
          .send({
            project_id: projectId,
            name: `pipeline-${Math.random().toString(36).slice(2)}`,
            nodes: [
              {
                id: 'start',
                type: 'transform',
                expression: { var: '' },
                state_mapping: { 'state.result': { var: 'output.output' } },
              },
            ],
            edges: [],
          })
      ).body.id;

      const wf = await dispatchWorkflow({
        name: 'orch',
        onEnter: {
          dispatch: {
            kind: 'orchestration',
            orchestration_id: orchestrationId,
            input_mapping: { topic: { var: 'task.payload.topic' } },
          },
          on_complete: [{ when: true, transition: 'to_done' }],
        },
      });
      const taskId = await startTask(wf, { topic: 'winter' });
      const settled = await pollTask({
        token: userToken,
        taskId,
        predicate: (t) => {
          return t.state === 'done';
        },
      });
      expect(settled.status).toBe('closed');
      // The routed move carries the orchestration run id as provenance.
      const history = (
        await authenticatedTestClient(userToken).get(
          `/api/v1/tasks/${taskId}/history`
        )
      ).body;
      const routed = history.find((h: { transition: string }) => {
        return h.transition === 'to_done';
      });
      expect(routed.principal_kind).toBe('automation');
      expect(typeof routed.orchestration_run_id).toBe('string');
      // An orchestration run is a cause, not a principal — it is never copied
      // into `principal_id` (#786).
      expect(routed.principal_id).toBeNull();
    });

    test('a failed orchestration dispatch sets automation_status and follows on_failure, not on_complete', async () => {
      // memory_write against a nonexistent memory_id deterministically fails the
      // run without any external HTTP dependency (see orchestrations.test.ts).
      const orchestrationId = (
        await authenticatedTestClient(userToken)
          .post('/api/v1/orchestrations')
          .send({
            project_id: projectId,
            name: `failing-pipeline-${Math.random().toString(36).slice(2)}`,
            nodes: [
              {
                id: 'write',
                type: 'memory_write',
                memory_id: 'mem_nonexistent12345',
                input_mapping: { content: { var: 'topic' } },
              },
            ],
            edges: [],
          })
      ).body.id;

      const wf = await dispatchWorkflow({
        name: 'orch-failure',
        onEnter: {
          dispatch: {
            kind: 'orchestration',
            orchestration_id: orchestrationId,
            input_mapping: { topic: { var: 'task.payload.topic' } },
          },
          // A catch-all on_complete rule must never fire for a failed run.
          on_complete: [{ when: true, transition: 'to_done' }],
          on_failure: 'to_failed',
        },
        extraStates: [{ name: 'failed', terminal: true }],
        extraTransitions: [
          { name: 'to_failed', from: ['writing'], to: 'failed' },
        ],
      });
      const taskId = await startTask(wf, { topic: 'winter' });
      const settled = await pollTask({
        token: userToken,
        taskId,
        predicate: (t) => {
          return t.state === 'failed';
        },
      });
      expect(settled.status).toBe('closed');
      // The failed run's partial state must never be presented as a result.
      expect(settled.last_result).toBeNull();

      const history = (
        await authenticatedTestClient(userToken).get(
          `/api/v1/tasks/${taskId}/history`
        )
      ).body;
      expect(
        history.some((h: { transition: string }) => {
          return h.transition === 'to_done';
        })
      ).toBe(false);
      const routed = history.find((h: { transition: string }) => {
        return h.transition === 'to_failed';
      });
      expect(routed.principal_kind).toBe('automation');
      expect(typeof routed.orchestration_run_id).toBe('string');
      expect(routed.principal_id).toBeNull();
    });

    test('a failed orchestration dispatch with no on_failure leaves the task parked, not routed by on_complete', async () => {
      const orchestrationId = (
        await authenticatedTestClient(userToken)
          .post('/api/v1/orchestrations')
          .send({
            project_id: projectId,
            name: `failing-pipeline-unrouted-${Math.random().toString(36).slice(2)}`,
            nodes: [
              {
                id: 'write',
                type: 'memory_write',
                memory_id: 'mem_nonexistent12345',
                input_mapping: { content: { var: 'topic' } },
              },
            ],
            edges: [],
          })
      ).body.id;

      const wf = await dispatchWorkflow({
        name: 'orch-failure-unrouted',
        onEnter: {
          dispatch: {
            kind: 'orchestration',
            orchestration_id: orchestrationId,
            input_mapping: { topic: { var: 'task.payload.topic' } },
          },
          on_complete: [{ when: true, transition: 'to_done' }],
        },
      });
      const taskId = await startTask(wf, { topic: 'winter' });
      const settled = await pollTask({
        token: userToken,
        taskId,
        predicate: (t) => {
          return t.automation_status === 'failed';
        },
      });
      expect(settled.state).toBe('writing');
      expect(settled.status).toBe('open');
      expect((settled.active_dispatch as { status?: string }).status).toBe(
        'failed'
      );
      expect(settled.last_result).toBeNull();
    });

    test('cancellation-on-exit cancels a genuinely in-flight orchestration run (#606)', async () => {
      // Gate the orchestration's agent-node generation so the run is genuinely
      // in flight (not merely parked on human input) when we transition out.
      let releaseGen: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseGen = resolve;
      });
      let signalStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      // Gate the generation so the orchestration run is genuinely in flight
      // when the manual transition fires. This used to install a second spy on
      // `agentGeneration` directly, because the shared one named the `agents`
      // re-export and orchestration agent nodes bypassed it — and restoring
      // that second spy unwired the shared one for every test after it. The
      // barrel is gone (#911) and the shared spy names the defining module, so
      // there is one spy again and nothing to restore.
      mockCreateGeneration.mockImplementationOnce(async () => {
        signalStarted!();
        await gate;
        return {
          id: 'gen_cancel606',
          traceId: 'trc_cancel606',
          status: 'completed',
          output: { model: 'm', content: 'x', finishReason: 'stop' },
        };
      });

      const orchestrationId = (
        await authenticatedTestClient(userToken)
          .post('/api/v1/orchestrations')
          .send({
            project_id: projectId,
            name: `cancel-pipeline-${Math.random().toString(36).slice(2)}`,
            nodes: [
              {
                id: 'ask',
                type: 'agent',
                agent_id: agentId,
                input_mapping: { prompt: { var: 'input.topic' } },
              },
            ],
            edges: [],
          })
      ).body.id;

      const wf = await dispatchWorkflow({
        name: 'orch-cancel',
        onEnter: {
          dispatch: {
            kind: 'orchestration',
            orchestration_id: orchestrationId,
          },
          on_complete: [{ when: true, transition: 'to_done' }],
        },
        extraTransitions: [
          { name: 'manual_exit', from: ['writing'], to: 'done' },
        ],
      });
      const taskId = await startTask(wf, {});

      // Wait until the run is inside the agent node (genuinely running).
      await started;

      try {
        // The task must expose the real run id while the dispatch is running —
        // the fix. Previously active_dispatch.id stayed null through the wait,
        // so cancellation-on-exit could never reach the in-flight run.
        const running = await pollTask({
          token: userToken,
          taskId,
          predicate: (t) => {
            const ad = t.active_dispatch as {
              id?: unknown;
              status?: unknown;
            } | null;
            return (
              !!ad &&
              ad.status === 'running' &&
              typeof ad.id === 'string' &&
              ad.id.startsWith('orch_run_')
            );
          },
        });
        const orchestrationRunId = (running.active_dispatch as { id: string })
          .id;

        // Fire a manual transition out of the state before the run finishes.
        const moved = await transition(taskId, 'manual_exit');
        expect(moved.body.state).toBe('done');

        // The still-running orchestration run must have been cancelled.
        const runRow = await db.OrchestrationRun.findOne({
          where: { publicId: orchestrationRunId },
        });
        expect(runRow!.status).toBe('cancelled');
      } finally {
        releaseGen!();
      }
      await flushTaskAutomations();
    });

    test('a task-dispatched orchestration with a delay node parks durably as `sleeping` and resumes via the scheduler, without an in-process sleep (#855)', async () => {
      const orchestrationId = (
        await authenticatedTestClient(userToken)
          .post('/api/v1/orchestrations')
          .send({
            project_id: projectId,
            name: `delay-pipeline-${Math.random().toString(36).slice(2)}`,
            nodes: [
              {
                id: 'wait',
                type: 'delay',
                duration: '1s',
                state_mapping: { 'state.waited': { var: 'output.waited' } },
              },
            ],
            edges: [],
          })
      ).body.id;

      const wf = await dispatchWorkflow({
        name: 'orch-delay-855',
        onEnter: {
          dispatch: {
            kind: 'orchestration',
            orchestration_id: orchestrationId,
          },
          on_complete: [{ when: true, transition: 'to_done' }],
        },
      });
      const taskId = await startTask(wf, {});

      const running = await pollTask({
        token: userToken,
        taskId,
        predicate: (t) => {
          const ad = t.active_dispatch as {
            id?: unknown;
            status?: unknown;
          } | null;
          return (
            !!ad && typeof ad.id === 'string' && ad.id.startsWith('orch_run_')
          );
        },
      });
      const orchestrationRunId = (running.active_dispatch as { id: string }).id;

      // The run must durably park as `sleeping` — its wake persisted, not held
      // open by an in-process timer — before the scheduler ever ticks. This is
      // exactly what #855 reports missing: `wait: true` used to `sleep()`
      // through the whole delay in-process and never reach this state, so the
      // scheduler-driven wake sweep never even saw the run.
      let parked: InstanceType<typeof db.OrchestrationRun> | null = null;
      for (let i = 0; i < 100; i += 1) {
        parked = await db.OrchestrationRun.findOne({
          where: { publicId: orchestrationRunId },
        });
        if (parked?.status === 'sleeping') break;
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
      }
      expect(parked?.status).toBe('sleeping');

      // Nothing wakes it until the scheduler's sweep picks up the due run.
      const claimed = await wakeDueRuns({ now: new Date(Date.now() + 5000) });
      expect(claimed).toBeGreaterThanOrEqual(1);

      const settled = await pollTask({
        token: userToken,
        taskId,
        predicate: (t) => {
          return t.state === 'done';
        },
      });
      expect(settled.status).toBe('closed');
    });

    test('a dispatched run that settled while no in-process awaiter existed is reconciled and routed (restart recovery)', async () => {
      // #855 proved the *run* survives a restart: the scheduler owns its wake.
      // The task awaiting it does not. `runDispatch` resolves through
      // `waitForOrchestrationRunSettlement`, an in-process poll loop reached
      // from `dispatchOnEnter`'s detached promise (tracked only in the
      // in-memory `pendingAutomations` set). A restart while the run is
      // `sleeping` — the durable state a `delay`/`poll` node parks in, and the
      // one that can last hours — loses that loop. The run then completes with
      // nobody listening: `on_complete` never fires and the task is stranded at
      // `automation_status: 'running'` forever.
      const orchestrationId = (
        await authenticatedTestClient(userToken)
          .post('/api/v1/orchestrations')
          .send({
            project_id: projectId,
            name: `orphan-pipeline-${Math.random().toString(36).slice(2)}`,
            nodes: [
              {
                id: 'start',
                type: 'transform',
                expression: { var: '' },
                state_mapping: { 'state.result': { var: 'output.output' } },
              },
            ],
            edges: [],
          })
      ).body.id;

      // `working` is deliberately not the initial state, so creating the task
      // parks it in `idle` and dispatches nothing. No awaiter is ever created
      // for this task in this process — which is exactly the condition a
      // restart leaves behind, reproduced without needing to kill the process.
      const workflowId = (
        await authenticatedTestClient(userToken)
          .post('/api/v1/workflows')
          .send({
            project_id: projectId,
            name: `orphan-recovery-${Math.random().toString(36).slice(2)}`,
            states: [
              { name: 'idle', initial: true, kind: 'human' },
              {
                name: 'working',
                on_enter: {
                  dispatch: {
                    kind: 'orchestration',
                    orchestration_id: orchestrationId,
                    // A recovered completion must apply `payload_writes` too,
                    // or the task moves on missing the deterministic channel a
                    // healthy dispatch would have written.
                    payload_writes: { recovered: true },
                  },
                  on_complete: [{ when: true, transition: 'to_done' }],
                },
              },
              { name: 'done', terminal: true },
            ],
            transitions: [
              { name: 'to_working', from: ['idle'], to: 'working' },
              { name: 'to_done', from: ['working'], to: 'done' },
            ],
          })
      ).body.id;

      const taskId = (
        await authenticatedTestClient(userToken).post('/api/v1/tasks').send({
          project_id: projectId,
          workflow_id: workflowId,
          title: 'stranded by a restart',
          payload: {},
        })
      ).body.id;

      // A real run that has already reached a terminal status — the run the
      // scheduler finished after the process that dispatched it went away.
      const run = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: orchestrationId, input: {}, wait: true });
      expect(run.status).toBe(201);
      expect(run.body.status).toBe('succeeded');

      // The post-restart row, written directly because no API call can produce
      // it: a task parked in an automated state with a `running` dispatch
      // pointing at a run that has since settled. `entered_state_at` is aged
      // past the reconciler's grace window so a genuinely in-flight dispatch in
      // a live process is never mistaken for an orphan.
      await db.Task.update(
        {
          state: 'working',
          enteredStateAt: new Date(Date.now() - 60_000),
          automationStatus: 'running',
          activeDispatch: {
            kind: 'orchestration_run',
            id: run.body.id,
            status: 'running',
          },
        },
        { where: { publicId: taskId } }
      );

      const claimed = await reconcileOrphanedDispatches();
      expect(claimed).toBe(1);

      const recovered = await pollTask({
        token: userToken,
        taskId,
        predicate: (t) => {
          return t.state === 'done';
        },
      });
      expect(recovered.status).toBe('closed');
      expect(recovered.payload).toEqual({ recovered: true });
      expect(recovered.last_result).toBeDefined();
      // Entering `done` cleared the dispatch provenance, exactly as it does on
      // the in-process path — the recovery is indistinguishable from a healthy
      // completion once the task has moved.
      expect(recovered.automation_status).toBeNull();
      expect(recovered.active_dispatch).toBeNull();

      // The recovered move carries the run as its cause, exactly as the
      // in-process completion path records it.
      const history = (
        await authenticatedTestClient(userToken).get(
          `/api/v1/tasks/${taskId}/history`
        )
      ).body;
      const routed = history.find((h: { transition: string | null }) => {
        return h.transition === 'to_done';
      });
      expect(routed.principal_kind).toBe('automation');
      expect(routed.orchestration_run_id).toBe(run.body.id);
    });

    test('a reconciled dispatch whose run failed follows on_failure, not on_complete', async () => {
      // A recovered outcome must pick the same branch a live one would. The
      // classification is shared with the dispatcher (NON_SUCCESS_TERMINAL_
      // STATUSES), so a failed run can never be recovered as a success.
      const orchestrationId = (
        await authenticatedTestClient(userToken)
          .post('/api/v1/orchestrations')
          .send({
            project_id: projectId,
            name: `orphan-failing-${Math.random().toString(36).slice(2)}`,
            nodes: [
              {
                id: 'write',
                type: 'memory_write',
                memory_id: 'mem_nonexistent12345',
                input_mapping: { content: { var: 'topic' } },
              },
            ],
            edges: [],
          })
      ).body.id;

      const workflowId = (
        await authenticatedTestClient(userToken)
          .post('/api/v1/workflows')
          .send({
            project_id: projectId,
            name: `orphan-failure-${Math.random().toString(36).slice(2)}`,
            states: [
              { name: 'idle', initial: true, kind: 'human' },
              {
                name: 'working',
                on_enter: {
                  dispatch: {
                    kind: 'orchestration',
                    orchestration_id: orchestrationId,
                  },
                  on_complete: [{ when: true, transition: 'to_done' }],
                  on_failure: 'to_failed',
                },
              },
              { name: 'done', terminal: true },
              { name: 'failed', terminal: true },
            ],
            transitions: [
              { name: 'to_working', from: ['idle'], to: 'working' },
              { name: 'to_done', from: ['working'], to: 'done' },
              { name: 'to_failed', from: ['working'], to: 'failed' },
            ],
          })
      ).body.id;

      const taskId = (
        await authenticatedTestClient(userToken).post('/api/v1/tasks').send({
          project_id: projectId,
          workflow_id: workflowId,
          title: 'stranded by a restart, and doomed',
          payload: {},
        })
      ).body.id;

      const run = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: orchestrationId, input: {}, wait: true });
      expect(run.body.status).toBe('failed');

      await db.Task.update(
        {
          state: 'working',
          enteredStateAt: new Date(Date.now() - 60_000),
          automationStatus: 'running',
          activeDispatch: {
            kind: 'orchestration_run',
            id: run.body.id,
            status: 'running',
          },
        },
        { where: { publicId: taskId } }
      );

      expect(await reconcileOrphanedDispatches()).toBe(1);

      const recovered = await pollTask({
        token: userToken,
        taskId,
        predicate: (t) => {
          return t.state === 'failed';
        },
      });
      expect(recovered.status).toBe('closed');
      // The catch-all `on_complete` rule must not have fired.
      expect(recovered.state).not.toBe('done');
    });

    test('a dispatch whose run is still in flight is never reconciled, however long it has sat', async () => {
      // The grace window is not the whole guard: a `sleeping` run may legitimately
      // outlast it by hours. Settlement is judged by the run's own status, using
      // the same in-flight set the live awaiter uses, so a long `delay` is waited
      // out rather than routed early with a half-finished state.
      const orchestrationId = (
        await authenticatedTestClient(userToken)
          .post('/api/v1/orchestrations')
          .send({
            project_id: projectId,
            name: `long-delay-${Math.random().toString(36).slice(2)}`,
            nodes: [{ id: 'wait', type: 'delay', duration: '1h' }],
            edges: [],
          })
      ).body.id;

      const workflowId = (
        await authenticatedTestClient(userToken)
          .post('/api/v1/workflows')
          .send({
            project_id: projectId,
            name: `sleeping-dispatch-${Math.random().toString(36).slice(2)}`,
            states: [
              { name: 'idle', initial: true, kind: 'human' },
              {
                name: 'working',
                on_enter: {
                  dispatch: {
                    kind: 'orchestration',
                    orchestration_id: orchestrationId,
                  },
                  on_complete: [{ when: true, transition: 'to_done' }],
                },
              },
              { name: 'done', terminal: true },
            ],
            transitions: [
              { name: 'to_working', from: ['idle'], to: 'working' },
              { name: 'to_done', from: ['working'], to: 'done' },
            ],
          })
      ).body.id;

      const taskId = (
        await authenticatedTestClient(userToken).post('/api/v1/tasks').send({
          project_id: projectId,
          workflow_id: workflowId,
          title: 'waiting an hour',
          payload: {},
        })
      ).body.id;

      const run = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: orchestrationId, input: {} });
      // Background mode: a run is created and returns its handle immediately.
      expect(run.status).toBe(201);

      let parked: InstanceType<typeof db.OrchestrationRun> | null = null;
      for (let i = 0; i < 100; i += 1) {
        parked = await db.OrchestrationRun.findOne({
          where: { publicId: run.body.id },
        });
        if (parked?.status === 'sleeping') break;
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
      }
      expect(parked?.status).toBe('sleeping');

      // Aged well past the grace window — the only thing keeping this task from
      // being reconciled is that its run has not settled.
      await db.Task.update(
        {
          state: 'working',
          enteredStateAt: new Date(Date.now() - 3_600_000),
          automationStatus: 'running',
          activeDispatch: {
            kind: 'orchestration_run',
            id: run.body.id,
            status: 'running',
          },
        },
        { where: { publicId: taskId } }
      );

      expect(await reconcileOrphanedDispatches()).toBe(0);

      const untouched = await authenticatedTestClient(userToken).get(
        `/api/v1/tasks/${taskId}`
      );
      expect(untouched.body.state).toBe('working');
      expect(untouched.body.automation_status).toBe('running');
    });

    test('an agent dispatch, and a dispatch with no id yet, are both left to the live path', async () => {
      // Two shapes the reconciler must decline. An `agent` dispatch can park in
      // `requires_action` waiting for client tool outputs — legitimately
      // outstanding, and indistinguishable from an orphan from here. A dispatch
      // with `id: null` is one `setDispatchState` has written but whose record
      // does not exist yet; there is nothing to look up.
      const workflowId = (
        await authenticatedTestClient(userToken)
          .post('/api/v1/workflows')
          .send({
            project_id: projectId,
            name: `undeclinable-${Math.random().toString(36).slice(2)}`,
            states: [
              { name: 'idle', initial: true, kind: 'human' },
              {
                name: 'working',
                on_enter: {
                  dispatch: { kind: 'agent', agent_id: agentId },
                  on_complete: [{ when: true, transition: 'to_done' }],
                },
              },
              { name: 'done', terminal: true },
            ],
            transitions: [
              { name: 'to_working', from: ['idle'], to: 'working' },
              { name: 'to_done', from: ['working'], to: 'done' },
            ],
          })
      ).body.id;

      const makeTask = async (activeDispatch: object) => {
        const id = (
          await authenticatedTestClient(userToken).post('/api/v1/tasks').send({
            project_id: projectId,
            workflow_id: workflowId,
            title: 'not the reconciler’s business',
            payload: {},
          })
        ).body.id;
        await db.Task.update(
          {
            state: 'working',
            enteredStateAt: new Date(Date.now() - 60_000),
            automationStatus: 'running',
            activeDispatch,
          },
          { where: { publicId: id } }
        );
        return id;
      };

      const agentTaskId = await makeTask({
        kind: 'generation',
        id: 'gen_orphan',
        status: 'running',
      });
      const noIdTaskId = await makeTask({
        kind: 'orchestration_run',
        id: null,
        status: 'running',
      });

      expect(await reconcileOrphanedDispatches()).toBe(0);

      for (const id of [agentTaskId, noIdTaskId]) {
        const untouched = await authenticatedTestClient(userToken).get(
          `/api/v1/tasks/${id}`
        );
        expect(untouched.body.state).toBe('working');
        expect(untouched.body.automation_status).toBe('running');
      }
    });

    test('a live dispatch inside its grace window is left alone by the reconciler', async () => {
      // The mirror of the test above: reconciliation must never race a healthy
      // in-process awaiter. A task that entered its state moments ago is still
      // plausibly being awaited here, so the sweep must not claim it even
      // though its dispatch record reads `running`.
      const orchestrationId = (
        await authenticatedTestClient(userToken)
          .post('/api/v1/orchestrations')
          .send({
            project_id: projectId,
            name: `fresh-pipeline-${Math.random().toString(36).slice(2)}`,
            nodes: [
              {
                id: 'start',
                type: 'transform',
                expression: { var: '' },
                state_mapping: { 'state.result': { var: 'output.output' } },
              },
            ],
            edges: [],
          })
      ).body.id;

      const workflowId = (
        await authenticatedTestClient(userToken)
          .post('/api/v1/workflows')
          .send({
            project_id: projectId,
            name: `fresh-dispatch-${Math.random().toString(36).slice(2)}`,
            states: [
              { name: 'idle', initial: true, kind: 'human' },
              {
                name: 'working',
                on_enter: {
                  dispatch: {
                    kind: 'orchestration',
                    orchestration_id: orchestrationId,
                  },
                  on_complete: [{ when: true, transition: 'to_done' }],
                },
              },
              { name: 'done', terminal: true },
            ],
            transitions: [
              { name: 'to_working', from: ['idle'], to: 'working' },
              { name: 'to_done', from: ['working'], to: 'done' },
            ],
          })
      ).body.id;

      const taskId = (
        await authenticatedTestClient(userToken).post('/api/v1/tasks').send({
          project_id: projectId,
          workflow_id: workflowId,
          title: 'still in flight',
          payload: {},
        })
      ).body.id;

      const run = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ orchestration_id: orchestrationId, input: {}, wait: true });
      expect(run.body.status).toBe('succeeded');

      // Same shape as the orphan above, but entered *now* — inside the grace
      // window, so the awaiter that would route it may still be alive.
      await db.Task.update(
        {
          state: 'working',
          enteredStateAt: new Date(),
          automationStatus: 'running',
          activeDispatch: {
            kind: 'orchestration_run',
            id: run.body.id,
            status: 'running',
          },
        },
        { where: { publicId: taskId } }
      );

      expect(await reconcileOrphanedDispatches()).toBe(0);

      const untouched = await authenticatedTestClient(userToken).get(
        `/api/v1/tasks/${taskId}`
      );
      expect(untouched.body.state).toBe('working');
      expect(untouched.body.automation_status).toBe('running');

      // The window is a knob, not a constant: shrinking it to zero makes the
      // very same task eligible, which is what an operator recovering a fleet
      // after a restart would reach for.
      const previous = process.env.TASKS_DISPATCH_RECONCILE_GRACE_MS;
      process.env.TASKS_DISPATCH_RECONCILE_GRACE_MS = '0';
      try {
        expect(await reconcileOrphanedDispatches()).toBe(1);
      } finally {
        if (previous === undefined) {
          delete process.env.TASKS_DISPATCH_RECONCILE_GRACE_MS;
        } else {
          process.env.TASKS_DISPATCH_RECONCILE_GRACE_MS = previous;
        }
      }

      const recovered = await pollTask({
        token: userToken,
        taskId,
        predicate: (t) => {
          return t.state === 'done';
        },
      });
      expect(recovered.status).toBe('closed');
    });

    test('a result that arrives after the task left the state is discarded', async () => {
      // Gate the generation so we can move the task out of `writing` while the
      // dispatch is still in flight, exercising cancellation-on-exit.
      let releaseGen: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseGen = resolve;
      });
      let signalStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      mockCreateGeneration.mockImplementationOnce(async () => {
        signalStarted!();
        await gate;
        return {
          id: 'gen_stale',
          traceId: 'trc_stale',
          status: 'completed',
          output: { model: 'm', content: 'late', finishReason: 'stop' },
        };
      });

      const wf = await dispatchWorkflow({
        name: 'stale',
        onEnter: {
          dispatch: { kind: 'agent', agent_id: agentId },
          on_complete: [{ when: true, transition: 'to_done' }],
        },
        extraStates: [{ name: 'parked' }],
        extraTransitions: [{ name: 'bail', from: ['writing'], to: 'parked' }],
      });
      const taskId = await startTask(wf, {});

      // Wait until the dispatch is inside createGeneration, then move away.
      await started;
      const moved = await transition(taskId, 'bail');
      expect(moved.body.state).toBe('parked');

      // Let the (now-stale) generation resolve; its result must be discarded.
      releaseGen!();
      await flushTaskAutomations();

      const after = await authenticatedTestClient(userToken).get(
        `/api/v1/tasks/${taskId}`
      );
      expect(after.body.state).toBe('parked');
      // The stale result never landed on the task.
      expect(after.body.last_result).toBeNull();
    });

    test('a concurrent transition committing between the automation completion read and write is not clobbered (#590)', async () => {
      // Reproduces the exact TOCTOU #590 describes: a concurrent transitionTask
      // commits *after* the automation's post-dispatch read but *before* its
      // write commits. A plain read-check-write can't be raced into that gap
      // deterministically (there's no natural yield point between them), so we
      // widen it with a force-failure-style spy (tests.md exception #2, same
      // spirit as the dedup-race spy in approvals.test.ts) on the one `.save()`
      // call the completion write makes. `on_complete` deliberately never
      // matches: an auto-fired `to_done` runs in-process (no REST/auth
      // overhead) and would always beat the externally-fired `abort` request
      // to the row, confounding the race this test is actually after.
      let releaseGen: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseGen = resolve;
      });
      let signalStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      mockCreateGeneration.mockImplementationOnce(async () => {
        signalStarted!();
        await gate;
        return {
          id: 'gen_race',
          traceId: 'trc_race',
          status: 'completed',
          output: { model: 'm', content: 'ok', finishReason: 'stop' },
        };
      });

      const wf = await dispatchWorkflow({
        name: 'race',
        onEnter: {
          dispatch: { kind: 'agent', agent_id: agentId },
          on_complete: [{ when: false, transition: 'to_done' }],
        },
        extraStates: [{ name: 'aborted', terminal: true }],
        extraTransitions: [{ name: 'abort', from: ['writing'], to: 'aborted' }],
      });
      const taskId = await startTask(wf, {});
      await started;

      const originalSave = db.Task.prototype.save;
      let releaseSave: (() => void) | undefined;
      const saveGate = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      let signalSaveReached: (() => void) | undefined;
      const saveReached = new Promise<void>((resolve) => {
        signalSaveReached = resolve;
      });
      const saveSpy = jest
        .spyOn(db.Task.prototype, 'save')
        .mockImplementationOnce(async function (
          this: InstanceType<typeof db.Task>,
          options?: Parameters<typeof originalSave>[0]
        ) {
          signalSaveReached!();
          await saveGate;
          return originalSave.call(this, options);
        });

      try {
        releaseGen!();
        // The automation's post-dispatch reload has now happened (it must, to
        // reach the save it's about to make) — its in-memory snapshot still
        // shows `writing`. Fire the concurrent transition now, then release
        // the held write so it commits its stale snapshot afterward.
        await saveReached;
        const abortPromise = transition(taskId, 'abort');
        // Give the concurrent transition, which goes through the full
        // REST/auth stack, time to reach the DB before releasing the stale
        // write — reproducing the ordering #590 describes: concurrent commit
        // first, stale write fires anyway afterward.
        await new Promise((resolve) => {
          setTimeout(resolve, 150);
        });
        releaseSave!();
        await Promise.all([abortPromise, flushTaskAutomations()]);
      } finally {
        saveSpy.mockRestore();
      }

      const after = await authenticatedTestClient(userToken).get(
        `/api/v1/tasks/${taskId}`
      );
      expect(after.body.state).toBe('aborted');
      expect(after.body.status).toBe('closed');
      // The concurrent transition closed the task and cleared automation
      // provenance; the stale `writing`-state completion write must not
      // resurrect either field.
      expect(after.body.automation_status).toBeNull();
      expect(after.body.active_dispatch).toBeNull();
    });

    test('a rejected on_enter automation is swallowed (fire-and-forget)', async () => {
      // Sanctioned .catch()-resilience stub: dispatchOnEnter runs the automation
      // detached behind a `.catch`, so the swallow branch only executes when the
      // automation itself rejects. Force one rejection and assert the task is
      // still created — the error is caught, never surfaced to the caller.
      const spy = jest
        .spyOn(tasksAutomationModule, 'runStateAutomation')
        .mockRejectedValueOnce(new Error('dispatch boom'));
      try {
        const wf = await dispatchWorkflow({
          name: 'reject',
          onEnter: {
            dispatch: { kind: 'agent', agent_id: agentId },
            on_complete: [{ when: true, transition: 'to_done' }],
          },
        });
        const taskId = await startTask(wf, {});
        await flushTaskAutomations();

        const res = await authenticatedTestClient(userToken).get(
          `/api/v1/tasks/${taskId}`
        );
        expect(res.status).toBe(200);
        // The rejection was swallowed; the card stays in its initial state.
        expect(res.body.state).toBe('writing');
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('on_enter tool dispatch (#1039)', () => {
    // A local HTTP server standing in for the tool's target: the only thing
    // mocked is the network hop SOAT does not own. Every layer under test —
    // validation, the wire mapping, the guardrail gate, the tool executor —
    // runs for real.
    let toolServer: http.Server;
    let toolServerUrl: string;
    let calls: Array<{ body: unknown; path: string }>;
    let failNext: boolean;

    const createHttpTool = async (
      name: string,
      presetParameters?: object
    ): Promise<string> => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: `${name}-${Math.random().toString(36).slice(2)}`,
          type: 'http',
          execute: { url: `${toolServerUrl}/do`, method: 'POST' },
          ...(presetParameters ? { preset_parameters: presetParameters } : {}),
        });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };

    const toolWorkflow = async (args: {
      name: string;
      dispatch: object;
      onComplete?: object[];
      onFailure?: string;
    }) => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/workflows')
        .send({
          project_id: projectId,
          name: `${args.name}-${Math.random().toString(36).slice(2)}`,
          states: [
            {
              name: 'calling',
              initial: true,
              on_enter: {
                dispatch: args.dispatch,
                on_complete: args.onComplete ?? [],
                ...(args.onFailure ? { on_failure: args.onFailure } : {}),
              },
            },
            { name: 'done', terminal: true },
            { name: 'failed', terminal: true },
          ],
          transitions: [
            { name: 'to_done', from: ['calling'], to: 'done' },
            { name: 'to_failed', from: ['calling'], to: 'failed' },
          ],
        });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };

    const startToolTask = async (
      workflowId: string,
      payload: object,
      toolContext?: Record<string, string>
    ) => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/tasks')
        .send({
          project_id: projectId,
          workflow_id: workflowId,
          title: 'tool card',
          payload,
          ...(toolContext ? { tool_context: toolContext } : {}),
        });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };

    beforeAll(async () => {
      calls = [];
      failNext = false;
      toolServer = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => {
          raw += chunk;
        });
        req.on('end', () => {
          calls.push({
            body: raw ? JSON.parse(raw) : null,
            path: req.url ?? '',
          });
          if (failNext) {
            res.statusCode = 500;
            res.end('boom');
            return;
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({ ok: true, echoed: raw ? JSON.parse(raw) : null })
          );
        });
      });
      await new Promise<void>((resolve) => {
        toolServer.listen(0, '127.0.0.1', resolve);
      });
      const { port } = toolServer.address() as AddressInfo;
      toolServerUrl = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => {
        toolServer.close(() => {
          resolve();
        });
      });
    });

    beforeEach(() => {
      calls = [];
      failNext = false;
    });

    test('calls the tool with input_mapping-resolved arguments and routes on_complete', async () => {
      const toolId = await createHttpTool('echo');
      const wf = await toolWorkflow({
        name: 'tool-happy',
        dispatch: {
          kind: 'tool',
          tool_id: toolId,
          input_mapping: { topic: { var: 'task.payload.topic' } },
        },
        onComplete: [{ when: true, transition: 'to_done' }],
      });

      const taskId = await startToolTask(wf, { topic: 'winter' });

      const settled = await pollTask({
        token: userToken,
        taskId,
        predicate: (t) => {
          return t.state === 'done';
        },
      });
      expect(settled.status).toBe('closed');

      // The mapping was resolved against the task context exactly once — the
      // arguments reaching the tool are the mapped ones, not the raw payload
      // and not a double-resolved copy.
      expect(calls).toHaveLength(1);
      expect(calls[0].body).toEqual({ topic: 'winter' });

      // The tool's own return value is what `on_complete` and `last_result` see.
      expect(settled.last_result).toMatchObject({ ok: true });

      // Every automation move must record a machine-readable cause (#792). A
      // tool call produces no generation and no run, so the tool is the cause —
      // without this the move would be rejected outright, not merely untraced.
      const history = (
        await authenticatedTestClient(userToken).get(
          `/api/v1/tasks/${taskId}/history`
        )
      ).body;
      const routed = history.find((h: { transition: string | null }) => {
        return h.transition === 'to_done';
      });
      expect(routed.principal_kind).toBe('automation');
      expect(routed.tool_id).toBe(toolId);
      expect(routed.generation_id).toBeNull();
      expect(routed.orchestration_run_id).toBeNull();
    });

    // #345: a task's stored `tool_context` reaches its `agent` and
    // `orchestration` dispatches; the `tool` kind dropped it, so a tool pinning
    // a `{{context:}}` parameter (or naming one in a header) could not be
    // dispatched from a workflow at all.
    test("forwards the task's tool_context, resolving the tool's {{context:}} preset", async () => {
      const toolId = await createHttpTool('ctx-preset', {
        adAccountId: '{{context:ocaAdAccountId}}',
      });
      const wf = await toolWorkflow({
        name: 'tool-context',
        dispatch: {
          kind: 'tool',
          tool_id: toolId,
          input_mapping: { topic: { var: 'task.payload.topic' } },
        },
        onComplete: [{ when: true, transition: 'to_done' }],
      });

      const taskId = await startToolTask(
        wf,
        { topic: 'winter' },
        { ocaAdAccountId: 'act_1330065197707199' }
      );

      const settled = await pollTask({
        token: userToken,
        taskId,
        predicate: (t) => {
          return t.state === 'done';
        },
      });
      expect(settled.status).toBe('closed');

      expect(calls).toHaveLength(1);
      expect(calls[0].body).toEqual({
        topic: 'winter',
        adAccountId: 'act_1330065197707199',
      });
    });

    test('exposes the tool result to on_complete rules, and records a tool_call dispatch with no id', async () => {
      const toolId = await createHttpTool('echo');
      const wf = await toolWorkflow({
        name: 'tool-result',
        dispatch: { kind: 'tool', tool_id: toolId, input_mapping: {} },
        // Deliberately unsatisfiable: the task stays put with its dispatch
        // provenance intact, which is the only way to observe `active_dispatch`
        // after a dispatch settles (a routed move clears it).
        onComplete: [
          {
            when: { '==': [{ var: 'result.ok' }, false] },
            transition: 'to_done',
          },
        ],
      });

      const taskId = await startToolTask(wf, {});

      const parked = await pollTask({
        token: userToken,
        taskId,
        predicate: (t) => {
          return t.automation_status === 'completed';
        },
      });
      expect(parked.state).toBe('calling');
      // A tool call leaves no addressable record, so the id is null — unlike a
      // generation or a run, there is nothing to point at.
      expect(parked.active_dispatch).toEqual({
        kind: 'tool_call',
        id: null,
        status: 'completed',
      });
      expect(parked.last_result).toMatchObject({ ok: true });
    });

    test('a rule reading the tool result routes on it', async () => {
      const toolId = await createHttpTool('echo');
      const wf = await toolWorkflow({
        name: 'tool-routed',
        dispatch: { kind: 'tool', tool_id: toolId, input_mapping: {} },
        onComplete: [
          {
            when: { '==': [{ var: 'result.ok' }, true] },
            transition: 'to_done',
          },
        ],
      });

      const taskId = await startToolTask(wf, {});
      const settled = await pollTask({
        token: userToken,
        taskId,
        predicate: (t) => {
          return t.state === 'done';
        },
      });
      expect(settled.status).toBe('closed');
    });

    test('a failing tool call fails the dispatch and follows on_failure', async () => {
      failNext = true;
      const toolId = await createHttpTool('boom');
      const wf = await toolWorkflow({
        name: 'tool-failure',
        dispatch: { kind: 'tool', tool_id: toolId, input_mapping: {} },
        // A catch-all on_complete must not fire for a failed tool call.
        onComplete: [{ when: true, transition: 'to_done' }],
        onFailure: 'to_failed',
      });

      const taskId = await startToolTask(wf, {});
      const settled = await pollTask({
        token: userToken,
        taskId,
        predicate: (t) => {
          return t.state === 'failed';
        },
      });
      expect(settled.status).toBe('closed');
      expect(settled.state).not.toBe('done');
    });

    test('a guardrail-blocked call fails the dispatch instead of routing on_complete', async () => {
      // The guardrail gate is the same one an orchestration `tool` node passes
      // through — a workflow dispatch is not a way around it. In a graph a
      // blocked call is a routable outcome an edge can branch on; a task
      // dispatch has nowhere to put that, so it is a dispatch failure, which
      // `on_failure` can route and a catch-all `on_complete` must not swallow.
      const guardrailId = (
        await authenticatedTestClient(userToken)
          .post('/api/v1/guardrails')
          .send({
            project_id: projectId,
            name: `block-all-${Math.random().toString(36).slice(2)}`,
            document: { class: 'D' },
          })
      ).body.id;

      const toolId = (
        await authenticatedTestClient(adminToken)
          .post('/api/v1/tools')
          .send({
            project_id: projectId,
            name: `guarded-${Math.random().toString(36).slice(2)}`,
            type: 'http',
            execute: { url: `${toolServerUrl}/do`, method: 'POST' },
            guardrail_ids: [guardrailId],
          })
      ).body.id;

      const wf = await toolWorkflow({
        name: 'tool-blocked',
        dispatch: { kind: 'tool', tool_id: toolId, input_mapping: {} },
        onComplete: [{ when: true, transition: 'to_done' }],
        onFailure: 'to_failed',
      });

      const taskId = await startToolTask(wf, {});
      const settled = await pollTask({
        token: userToken,
        taskId,
        predicate: (t) => {
          return t.state === 'failed';
        },
      });
      expect(settled.status).toBe('closed');
      // The tool's target was never reached — the call was stopped before it ran.
      expect(calls).toHaveLength(0);
    });

    test('payload_writes and retry apply to a tool dispatch like any other kind', async () => {
      let attempts = 0;
      const flaky = http.createServer((req, res) => {
        attempts += 1;
        req.resume();
        req.on('end', () => {
          if (attempts === 1) {
            res.statusCode = 500;
            res.end('transient');
            return;
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true }));
        });
      });
      await new Promise<void>((resolve) => {
        flaky.listen(0, '127.0.0.1', resolve);
      });
      const { port } = flaky.address() as AddressInfo;

      try {
        const toolId = (
          await authenticatedTestClient(adminToken)
            .post('/api/v1/tools')
            .send({
              project_id: projectId,
              name: `flaky-${Math.random().toString(36).slice(2)}`,
              type: 'http',
              execute: { url: `http://127.0.0.1:${port}/do`, method: 'POST' },
            })
        ).body.id as string;

        const res = await authenticatedTestClient(userToken)
          .post('/api/v1/workflows')
          .send({
            project_id: projectId,
            name: `tool-retry-${Math.random().toString(36).slice(2)}`,
            states: [
              {
                name: 'calling',
                initial: true,
                on_enter: {
                  dispatch: {
                    kind: 'tool',
                    tool_id: toolId,
                    input_mapping: {},
                    payload_writes: { called: true },
                  },
                  retry: { max_attempts: 2 },
                  on_complete: [{ when: true, transition: 'to_done' }],
                },
              },
              { name: 'done', terminal: true },
            ],
            transitions: [{ name: 'to_done', from: ['calling'], to: 'done' }],
          });
        expect(res.status).toBe(201);

        const taskId = await startToolTask(res.body.id as string, {});
        const settled = await pollTask({
          token: userToken,
          taskId,
          predicate: (t) => {
            return t.state === 'done';
          },
        });
        // The first attempt failed and the second succeeded — retry wraps a
        // tool dispatch with no per-kind plumbing.
        expect(attempts).toBe(2);
        expect(settled.payload).toEqual({ called: true });
      } finally {
        await new Promise<void>((resolve) => {
          flaky.close(() => {
            resolve();
          });
        });
      }
    });
  });

  describe('human state parks with no automation', () => {
    test('a kind:human state does not dispatch', async () => {
      const task = (await createTask()).body;
      const review = (await transition(task.id, 'to_review')).body;
      expect(review.state).toBe('review');
      expect(review.automation_status).toBeNull();
      expect(review.active_dispatch).toBeNull();
    });
  });

  // ── Approval-gated transitions (Phase 3) ────────────────────────────────────
  describe('approval-gated transitions', () => {
    let gatedWorkflowId: string;

    beforeAll(async () => {
      gatedWorkflowId = (
        await authenticatedTestClient(userToken)
          .post('/api/v1/workflows')
          .send({
            project_id: projectId,
            name: `gated-${Math.random().toString(36).slice(2)}`,
            states: [
              { name: 'review', initial: true, kind: 'human' },
              { name: 'draft', kind: 'human' },
              { name: 'published', terminal: true },
            ],
            transitions: [
              // A non-gated escape from review so a task can reach a state where
              // the gated transitions are invalid (exercises the from-state check).
              { name: 'to_draft', from: ['review'], to: 'draft' },
              {
                name: 'publish',
                from: ['review'],
                to: 'published',
                requires_approval: true,
              },
              {
                name: 'publish_guarded',
                from: ['review'],
                to: 'published',
                requires_approval: true,
                guard: { '==': [{ var: 'task.payload.approved' }, true] },
              },
            ],
          })
      ).body.id;
    });

    const startGatedTask = async (): Promise<string> => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/tasks')
        .send({
          project_id: projectId,
          workflow_id: gatedWorkflowId,
          title: 'gated card',
        });
      expect(res.status).toBe(201);
      expect(res.body.state).toBe('review');
      return res.body.id;
    };

    const pendingApprovalFor = async (taskId: string) => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/approvals?project_id=${projectId}&status=pending`
      );
      expect(res.status).toBe(200);
      return res.body.data.find((a: { task_id: string }) => {
        return a.task_id === taskId;
      });
    };

    test('firing a requires_approval transition parks instead of moving', async () => {
      const taskId = await startGatedTask();

      // Include a note — it is carried into the approval's reasoning.
      const parked = await authenticatedTestClient(userToken)
        .post(`/api/v1/tasks/${taskId}/transitions`)
        .send({ transition: 'publish', note: 'please review the copy' });
      expect(parked.status).toBe(200);
      // The task did not move; it exposes the pending transition.
      expect(parked.body.state).toBe('review');
      expect(parked.body.status).toBe('open');
      expect(parked.body.pending_transition).toBe('publish');

      // The approval item is filed with task-transition provenance.
      const approval = await pendingApprovalFor(taskId);
      expect(approval).toBeDefined();
      expect(approval.origin).toBe('task_transition');
      expect(approval.task_id).toBe(taskId);
      expect(approval.task_transition).toBe('publish');
      expect(approval.proposed_action).toBeNull();

      // No other transition may fire while the gate is open.
      const blocked = await transition(taskId, 'publish');
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('TASK_TRANSITION_CONFLICT');
    });

    test('approving fires the gated transition as the approval actor', async () => {
      const taskId = await startGatedTask();
      await transition(taskId, 'publish');
      const approval = await pendingApprovalFor(taskId);

      const approved = await authenticatedTestClient(userToken)
        .post(`/api/v1/approvals/${approval.id}/approve`)
        .send({});
      expect(approved.status).toBe(200);
      expect(approved.body.status).toBe('approved');

      // The task moved to the terminal state and the gate cleared.
      const after = (
        await authenticatedTestClient(userToken).get(`/api/v1/tasks/${taskId}`)
      ).body;
      expect(after.state).toBe('published');
      expect(after.status).toBe('closed');
      expect(after.pending_transition).toBeNull();

      // The move is audited as the `approval` actor.
      const history = (
        await authenticatedTestClient(userToken).get(
          `/api/v1/tasks/${taskId}/history`
        )
      ).body;
      const move = history.find((h: { transition: string }) => {
        return h.transition === 'publish';
      });
      expect(move.principal_kind).toBe('approval');
      expect(move.to_state).toBe('published');
    });

    test('rejecting clears the gate and appends a history note', async () => {
      const taskId = await startGatedTask();
      await transition(taskId, 'publish');
      const approval = await pendingApprovalFor(taskId);

      const rejected = await authenticatedTestClient(userToken)
        .post(`/api/v1/approvals/${approval.id}/reject`)
        .send({ reason: 'not ready' });
      expect(rejected.status).toBe(200);
      expect(rejected.body.status).toBe('rejected');

      const after = (
        await authenticatedTestClient(userToken).get(`/api/v1/tasks/${taskId}`)
      ).body;
      // The task never moved and the gate is cleared, so it can transition again.
      expect(after.state).toBe('review');
      expect(after.pending_transition).toBeNull();

      const history = (
        await authenticatedTestClient(userToken).get(
          `/api/v1/tasks/${taskId}/history`
        )
      ).body;
      const note = history[history.length - 1];
      expect(note.principal_kind).toBe('approval');
      expect(note.transition).toBeNull();
      expect(note.note).toMatch(/rejected/i);
    });

    test('expiry clears the gate and records an expiry note', async () => {
      const taskId = await startGatedTask();
      await transition(taskId, 'publish');
      const approval = await pendingApprovalFor(taskId);

      // Force the item due, then run the approvals expiry sweeper (server-side
      // enforcement) — the task-transition resume handler clears the gate. The
      // sweeper dispatches its handler detached, so poll for the side effect.
      await db.ApprovalItem.update(
        { expiresAt: new Date(Date.now() - 1000) },
        { where: { publicId: approval.id } }
      );
      const claimed = await expireDueApprovals();
      expect(claimed).toBeGreaterThanOrEqual(1);

      const after = await pollTask({
        token: userToken,
        taskId,
        predicate: (t) => {
          return t.pending_transition === null;
        },
      });
      expect(after.state).toBe('review');

      const rows = await pollHistory({
        token: userToken,
        taskId,
        predicate: (h) => {
          return h.some((r) => {
            return (
              r.principal_kind === 'approval' && /expired/i.test(r.note ?? '')
            );
          });
        },
      });
      expect(rows.length).toBeGreaterThan(0);
    });

    test('a guard invalid at resolution time is surfaced, not silently dropped', async () => {
      const events: SoatEvent[] = [];
      const handler = (e: SoatEvent) => {
        events.push(e);
      };
      eventBus.on('soat:event', handler);
      try {
        const taskId = await startGatedTask();
        // Park the guarded transition without satisfying its guard.
        await transition(taskId, 'publish_guarded');
        const approval = await pendingApprovalFor(taskId);

        const approved = await authenticatedTestClient(userToken)
          .post(`/api/v1/approvals/${approval.id}/approve`)
          .send({});
        expect(approved.status).toBe(200);

        const after = (
          await authenticatedTestClient(userToken).get(
            `/api/v1/tasks/${taskId}`
          )
        ).body;
        // The transition did not apply (guard false), but the gate is cleared so
        // the task is not stuck against a resolved approval.
        expect(after.state).toBe('review');
        expect(after.pending_transition).toBeNull();

        // The failure surfaced as an event carrying the transition and code.
        const failed = events.find((e) => {
          return e.type === 'tasks.approval_failed' && e.resourceId === taskId;
        });
        expect(failed).toBeDefined();
        expect(failed!.data.transition).toBe('publish_guarded');
        expect(failed!.data.errorCode).toBe('TASK_GUARD_REJECTED');
      } finally {
        eventBus.off('soat:event', handler);
      }
    });

    test('a gated guard satisfied before approval applies the move', async () => {
      const taskId = await startGatedTask();
      await authenticatedTestClient(userToken)
        .patch(`/api/v1/tasks/${taskId}`)
        .send({ payload: { approved: true } });
      await transition(taskId, 'publish_guarded');
      const approval = await pendingApprovalFor(taskId);

      await authenticatedTestClient(userToken)
        .post(`/api/v1/approvals/${approval.id}/approve`)
        .send({});

      const after = (
        await authenticatedTestClient(userToken).get(`/api/v1/tasks/${taskId}`)
      ).body;
      expect(after.state).toBe('published');
      expect(after.status).toBe('closed');
    });

    test('parking a gated transition invalid from the current state is 409', async () => {
      const taskId = await startGatedTask();
      // Leave review via a non-gated move; `publish` is no longer valid from here.
      await transition(taskId, 'to_draft');
      const res = await transition(taskId, 'publish');
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('TASK_TRANSITION_CONFLICT');

      // No approval was filed, and the task carries no pending gate.
      const after = (
        await authenticatedTestClient(userToken).get(`/api/v1/tasks/${taskId}`)
      ).body;
      expect(after.pending_transition).toBeNull();
    });

    test('parking a gated transition on a closed task is 409', async () => {
      const taskId = await startGatedTask();
      await transition(taskId, 'publish');
      const approval = await pendingApprovalFor(taskId);
      await authenticatedTestClient(userToken)
        .post(`/api/v1/approvals/${approval.id}/approve`)
        .send({});
      // The task is now closed (published). A gated transition is rejected.
      const res = await transition(taskId, 'publish');
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('TASK_TRANSITION_CONFLICT');
    });

    test('403 firing a gated transition without permission', async () => {
      const taskId = await startGatedTask();
      const res = await transition(taskId, 'publish', noPermToken);
      expect(res.status).toBe(403);
    });
  });

  // ── Stall/SLA sweeper (Phase 3) ─────────────────────────────────────────────
  describe('stall sweeper', () => {
    let stallWorkflowId: string;

    beforeAll(async () => {
      stallWorkflowId = (
        await authenticatedTestClient(userToken)
          .post('/api/v1/workflows')
          .send({
            project_id: projectId,
            name: `stall-${Math.random().toString(36).slice(2)}`,
            states: [
              {
                name: 'waiting',
                initial: true,
                kind: 'human',
                stalled_after: 60,
              },
              { name: 'moving', kind: 'human', stalled_after: 60 },
              { name: 'closed_state', terminal: true },
            ],
            transitions: [
              { name: 'advance', from: ['waiting'], to: 'moving' },
              { name: 'finish', from: ['moving'], to: 'closed_state' },
            ],
          })
      ).body.id;
    });

    const startStallTask = async (): Promise<string> => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/tasks')
        .send({
          project_id: projectId,
          workflow_id: stallWorkflowId,
          title: 'stall card',
        });
      expect(res.status).toBe(201);
      return res.body.id;
    };

    const stallDeadline = async (taskId: string): Promise<Date | null> => {
      const row = await db.Task.findOne({ where: { publicId: taskId } });
      return (row!.stallDeadlineAt as Date | null) ?? null;
    };

    // The sweeper dispatches `handle` (which emits the event) detached, so
    // collect stall events for a task and poll until the expected count lands.
    const waitForStallEvents = async (args: {
      events: SoatEvent[];
      taskId: string;
      count: number;
    }): Promise<SoatEvent[]> => {
      for (let i = 0; i < 100; i += 1) {
        const mine = args.events.filter((e) => {
          return e.resourceId === args.taskId;
        });
        if (mine.length >= args.count) return mine;
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
      }
      throw new Error(`waitForStallEvents: never reached ${args.count}`);
    };

    test('emits tasks.stalled once per episode and re-arms on the next transition', async () => {
      const events: SoatEvent[] = [];
      const handler = (e: SoatEvent) => {
        if (e.type === 'tasks.stalled') events.push(e);
      };
      eventBus.on('soat:event', handler);
      try {
        const taskId = await startStallTask();
        // The deadline is armed on state entry.
        expect(await stallDeadline(taskId)).not.toBeNull();

        // Sweep with a clock past the threshold: the task stalls.
        await sweepStalledTasks({ now: new Date(Date.now() + 120_000) });

        const [first] = await waitForStallEvents({ events, taskId, count: 1 });
        expect(first.data.state).toBe('waiting');

        // The episode is spent — the deadline is disarmed, so a second sweep at
        // the same clock cannot re-claim the task (once per episode).
        expect(await stallDeadline(taskId)).toBeNull();
        await sweepStalledTasks({ now: new Date(Date.now() + 120_000) });

        // The next transition re-arms the deadline for the new state.
        await transition(taskId, 'advance');
        expect(await stallDeadline(taskId)).not.toBeNull();

        await sweepStalledTasks({ now: new Date(Date.now() + 120_000) });
        const both = await waitForStallEvents({ events, taskId, count: 2 });
        expect(both).toHaveLength(2);
        expect(both[1].data.state).toBe('moving');
      } finally {
        eventBus.off('soat:event', handler);
      }
    });

    test('a state without stalled_after never arms the sweeper', async () => {
      const wf = (
        await authenticatedTestClient(userToken)
          .post('/api/v1/workflows')
          .send({
            project_id: projectId,
            name: `nostall-${Math.random().toString(36).slice(2)}`,
            states: [{ name: 'idle', initial: true, kind: 'human' }],
            transitions: [],
          })
      ).body.id;
      const taskId = (
        await authenticatedTestClient(userToken).post('/api/v1/tasks').send({
          project_id: projectId,
          workflow_id: wf,
          title: 'no stall',
        })
      ).body.id;
      expect(await stallDeadline(taskId)).toBeNull();
    });
  });

  // The composed cycle #879 made possible: a state dispatches, the dispatch
  // routes the task back into that same state, and it dispatches again. Neither
  // layer's validator sees it — orchestration cycle detection is intra-graph,
  // and revisiting a workflow state is the module's whole point (#885).
  describe('automation chain limit (#885)', () => {
    const LIMIT = 3;
    let previousLimit: string | undefined;

    beforeAll(() => {
      previousLimit = process.env.TASK_AUTOMATION_CHAIN_LIMIT;
      process.env.TASK_AUTOMATION_CHAIN_LIMIT = String(LIMIT);
    });

    afterAll(() => {
      if (previousLimit === undefined) {
        delete process.env.TASK_AUTOMATION_CHAIN_LIMIT;
      } else {
        process.env.TASK_AUTOMATION_CHAIN_LIMIT = previousLimit;
      }
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    /** A workflow whose only automated state routes straight back into itself. */
    const selfLoopWorkflow = async () => {
      return (
        await authenticatedTestClient(userToken)
          .post('/api/v1/workflows')
          .send({
            project_id: projectId,
            name: `spin-${Math.random().toString(36).slice(2)}`,
            states: [
              {
                name: 'spin',
                initial: true,
                on_enter: {
                  dispatch: { kind: 'agent', agent_id: agentId },
                  on_complete: [{ when: true, transition: 'respin' }],
                },
              },
              { name: 'done', terminal: true },
            ],
            transitions: [
              { name: 'respin', from: ['spin'], to: 'spin' },
              { name: 'finish', from: ['spin'], to: 'done' },
            ],
          })
      ).body.id;
    };

    test('a state that routes back into itself stops at the limit instead of looping forever', async () => {
      mockCreateGeneration.mockResolvedValue({
        id: 'gen_spin',
        traceId: 'trc_spin',
        status: 'completed',
        output: { model: 'm', content: 'again', finishReason: 'stop' },
      });

      const events: SoatEvent[] = [];
      const handler = (e: SoatEvent) => {
        events.push(e);
      };
      eventBus.on('soat:event', handler);

      try {
        const wf = await selfLoopWorkflow();
        const taskId = (
          await authenticatedTestClient(userToken).post('/api/v1/tasks').send({
            project_id: projectId,
            workflow_id: wf,
            title: 'spinner',
          })
        ).body.id;

        const settled = await pollTask({
          token: userToken,
          taskId,
          predicate: (t) => {
            return t.automation_status === 'unrouted';
          },
        });

        // The task is parked in the state it was looping through, not advanced
        // and not silently left looking `completed`.
        expect(settled.state).toBe('spin');
        expect(settled.automation_chain_depth).toBe(LIMIT);

        // The bound is surfaced, not a silent stop.
        const rejection = events.find((e) => {
          return (
            e.type === 'tasks.automation_rejected' && e.resourceId === taskId
          );
        });
        expect(rejection).toBeDefined();
        expect(rejection!.data.transition).toBe('respin');
        expect(rejection!.data.errorCode).toBe('TASK_AUTOMATION_CHAIN_LIMIT');

        // Exactly `LIMIT` automated hops ran — the loop was cut, not merely
        // slowed. One entry for creation plus one per accepted `respin`.
        const history = await authenticatedTestClient(userToken).get(
          `/api/v1/tasks/${taskId}/history`
        );
        const automated = (history.body as HistoryRow[]).filter((row) => {
          return row.transition === 'respin';
        });
        expect(automated).toHaveLength(LIMIT);
      } finally {
        eventBus.off('soat:event', handler);
      }
    });

    test('a human transition resets the chain, so a task is never bounded by its whole history', async () => {
      mockCreateGeneration.mockResolvedValue({
        id: 'gen_spin2',
        traceId: 'trc_spin2',
        status: 'completed',
        output: { model: 'm', content: 'again', finishReason: 'stop' },
      });

      const wf = await selfLoopWorkflow();
      const taskId = (
        await authenticatedTestClient(userToken).post('/api/v1/tasks').send({
          project_id: projectId,
          workflow_id: wf,
          title: 'spinner-2',
        })
      ).body.id;

      await pollTask({
        token: userToken,
        taskId,
        predicate: (t) => {
          return t.automation_status === 'unrouted';
        },
      });

      // A person stepping in is exactly the intervention the budget exists to
      // wait for: the chain starts over rather than staying permanently spent.
      const moved = await transition(taskId, 'respin');
      expect(moved.status).toBe(200);
      expect(moved.body.automation_chain_depth).toBe(0);

      // ...and the state's automation runs again on that fresh budget.
      const respun = await pollTask({
        token: userToken,
        taskId,
        predicate: (t) => {
          return t.automation_status === 'unrouted';
        },
      });
      expect(respun.automation_chain_depth).toBe(LIMIT);
    });

    // The other half of the loop, and the one a budget keyed on `principal.kind`
    // would miss entirely: a dispatch's own `soat` tool calls `transition-task`
    // with a run-as token, which authenticates as the *user* who started the
    // chain. On the wire that hop is indistinguishable from a person clicking a
    // button — except for the `orn` claim.
    describe('a transition fired by a run-as token', () => {
      /** Two states that bounce back and forth, with no automation of their own. */
      const pingPongWorkflow = async () => {
        return (
          await authenticatedTestClient(userToken)
            .post('/api/v1/workflows')
            .send({
              project_id: projectId,
              name: `pingpong-${Math.random().toString(36).slice(2)}`,
              states: [{ name: 'ping', initial: true }, { name: 'pong' }],
              transitions: [
                { name: 'to_pong', from: ['ping'], to: 'pong' },
                { name: 'to_ping', from: ['pong'], to: 'ping' },
              ],
            })
        ).body.id;
      };

      const startPingPong = async () => {
        return (
          await authenticatedTestClient(userToken)
            .post('/api/v1/tasks')
            .send({
              project_id: projectId,
              workflow_id: await pingPongWorkflow(),
              title: 'bounce',
            })
        ).body.id;
      };

      const bounce = (args: {
        taskId: string;
        index: number;
        token: string;
      }) => {
        return authenticatedTestClient(args.token)
          .post(`/api/v1/tasks/${args.taskId}/transitions`)
          .send({ transition: args.index % 2 === 0 ? 'to_pong' : 'to_ping' });
      };

      test('counts against the chain budget rather than resetting it', async () => {
        const taskId = await startPingPong();
        const header = await buildRunAuthHeader({
          principalKind: 'user',
          principalId: userId,
          projectId: (await db.Project.findOne({
            where: { publicId: projectId },
          }))!.id as number,
          workPublicId: taskId,
        });
        const runToken = header!.slice('Bearer '.length);

        for (let i = 0; i < LIMIT; i += 1) {
          const res = await bounce({ taskId, index: i, token: runToken });
          expect(res.status).toBe(200);
          expect(res.body.automation_chain_depth).toBe(i + 1);
        }

        const refused = await bounce({
          taskId,
          index: LIMIT,
          token: runToken,
        });
        expect(refused.status).toBe(409);
        expect(refused.body.error.code).toBe('TASK_AUTOMATION_CHAIN_LIMIT');
      });

      test('the same sequence from a person is never bounded', async () => {
        const taskId = await startPingPong();
        for (let i = 0; i < LIMIT + 2; i += 1) {
          const res = await bounce({ taskId, index: i, token: userToken });
          expect(res.status).toBe(200);
          expect(res.body.automation_chain_depth).toBe(0);
        }
      });
    });
  });
  // #950 — a workflow/task automation is a generation entry point like any
  // other, so the caller context its dispatches forward must come from
  // somewhere. It attaches per move (creation counts as the first move) and the
  // move that supplies one replaces the stored bag wholesale, so the credential
  // a dispatch runs with belongs to the same principal `resolveDispatchPrincipal`
  // already makes it run as.
  describe('tool_context (#950)', () => {
    let ctxWorkflowId: string;
    let orchWorkflowId: string;
    let retryWorkflowId: string;

    const GEN_OK = {
      id: 'gen_ctx950',
      traceId: 'trc_ctx950',
      status: 'completed' as const,
      output: { model: 'm', content: 'ok', finishReason: 'stop' },
    };

    beforeAll(async () => {
      const agentDispatch = {
        dispatch: { kind: 'agent', agent_id: agentId },
      };

      ctxWorkflowId = (
        await authenticatedTestClient(userToken)
          .post('/api/v1/workflows')
          .send({
            project_id: projectId,
            name: `ctx-${Math.random().toString(36).slice(2)}`,
            states: [
              // `idle` dispatches nothing, so a task can be parked with a bag
              // before any dispatch reads it.
              { name: 'idle', initial: true },
              // No `on_complete`: the dispatch settles and the task stays put,
              // so a second move can be made with a different bag.
              { name: 'working', on_enter: agentDispatch },
              { name: 'gated', on_enter: agentDispatch },
              { name: 'done', terminal: true },
            ],
            transitions: [
              { name: 'begin', from: ['idle'], to: 'working' },
              { name: 'again', from: ['working'], to: 'working' },
              { name: 'wrap', from: ['working'], to: 'done' },
              {
                name: 'gate',
                from: ['idle'],
                to: 'gated',
                requires_approval: true,
              },
            ],
          })
      ).body.id;

      const orchestrationId = (
        await authenticatedTestClient(userToken)
          .post('/api/v1/orchestrations')
          .send({
            project_id: projectId,
            name: `ctx-pipeline-${Math.random().toString(36).slice(2)}`,
            nodes: [
              {
                id: 'start',
                type: 'transform',
                expression: { var: '' },
                state_mapping: { 'state.result': { var: 'output.output' } },
              },
            ],
            edges: [],
          })
      ).body.id;

      orchWorkflowId = (
        await authenticatedTestClient(userToken)
          .post('/api/v1/workflows')
          .send({
            project_id: projectId,
            name: `ctx-orch-${Math.random().toString(36).slice(2)}`,
            states: [
              {
                name: 'running',
                initial: true,
                on_enter: {
                  dispatch: {
                    kind: 'orchestration',
                    orchestration_id: orchestrationId,
                  },
                  on_complete: [{ when: true, transition: 'to_done' }],
                },
              },
              { name: 'done', terminal: true },
            ],
            transitions: [{ name: 'to_done', from: ['running'], to: 'done' }],
          })
      ).body.id;

      retryWorkflowId = (
        await authenticatedTestClient(userToken)
          .post('/api/v1/workflows')
          .send({
            project_id: projectId,
            name: `ctx-retry-${Math.random().toString(36).slice(2)}`,
            states: [
              {
                name: 'flaky',
                initial: true,
                on_enter: {
                  dispatch: { kind: 'agent', agent_id: agentId },
                  retry: { max_attempts: 2, backoff_seconds: 0 },
                },
              },
              { name: 'done', terminal: true },
            ],
            transitions: [{ name: 'to_done', from: ['flaky'], to: 'done' }],
          })
      ).body.id;
    });

    beforeEach(() => {
      jest.clearAllMocks();
      mockCreateGeneration.mockResolvedValue(GEN_OK);
    });

    /** Creates a task on the `ctx` workflow, optionally with a bag and state. */
    const startCtxTask = async (args: {
      toolContext?: Record<string, string>;
      state?: string;
      workflow?: string;
    }) => {
      return authenticatedTestClient(userToken)
        .post('/api/v1/tasks')
        .send({
          project_id: projectId,
          workflow_id: args.workflow ?? ctxWorkflowId,
          title: 'context card',
          ...(args.state ? { state: args.state } : {}),
          ...(args.toolContext ? { tool_context: args.toolContext } : {}),
        });
    };

    const move = (args: {
      taskId: string;
      transition: string;
      toolContext?: Record<string, string>;
    }) => {
      return authenticatedTestClient(userToken)
        .post(`/api/v1/tasks/${args.taskId}/transitions`)
        .send({
          transition: args.transition,
          ...(args.toolContext ? { tool_context: args.toolContext } : {}),
        });
    };

    /** Waits for the state's dispatch to settle (no on_complete rule routes it). */
    const awaitDispatch = (taskId: string) => {
      return pollTask({
        token: userToken,
        taskId,
        predicate: (t) => {
          return t.automation_status === 'completed';
        },
      });
    };

    /** The bag persisted on the task row — never observable through the API. */
    const storedContext = async (taskId: string) => {
      const row = await db.Task.findOne({ where: { publicId: taskId } });
      return row!.toolContext;
    };

    const forwardedContext = (call: number) => {
      return mockCreateGeneration.mock.calls[call]![0].toolContext;
    };

    test('a create-time bag reaches the entry state dispatch', async () => {
      const created = await startCtxTask({
        state: 'working',
        toolContext: { ocaToken: 'tok_create', tenant: 'acme' },
      });
      expect(created.status).toBe(201);
      await awaitDispatch(created.body.id);

      expect(forwardedContext(0)).toEqual({
        ocaToken: 'tok_create',
        tenant: 'acme',
      });
    });

    test("a transition's bag replaces the stored one (last writer wins)", async () => {
      const created = await startCtxTask({
        toolContext: { ocaToken: 'tok_create' },
      });
      expect(created.status).toBe(201);
      const taskId = created.body.id;

      const moved = await move({
        taskId,
        transition: 'begin',
        toolContext: { ocaToken: 'tok_transition' },
      });
      expect(moved.status).toBe(200);
      await awaitDispatch(taskId);

      // The dispatch runs with the credential of whoever last moved the task.
      expect(forwardedContext(0)).toEqual({ ocaToken: 'tok_transition' });
      expect(await storedContext(taskId)).toEqual({
        ocaToken: 'tok_transition',
      });
    });

    test('a transition without a bag keeps the stored one', async () => {
      const created = await startCtxTask({
        toolContext: { ocaToken: 'tok_kept' },
      });
      const taskId = created.body.id;

      expect((await move({ taskId, transition: 'begin' })).status).toBe(200);
      await awaitDispatch(taskId);
      expect(forwardedContext(0)).toEqual({ ocaToken: 'tok_kept' });

      // Re-entering the state dispatches again, still with the same bag: an
      // omitted `tool_context` is "unchanged", never "cleared".
      expect((await move({ taskId, transition: 'again' })).status).toBe(200);
      await pollTask({
        token: userToken,
        taskId,
        predicate: (t) => {
          return (
            t.automation_status === 'completed' &&
            mockCreateGeneration.mock.calls.length >= 2
          );
        },
      });
      expect(forwardedContext(1)).toEqual({ ocaToken: 'tok_kept' });
    });

    test('reserved identity keys are stripped from the caller bag', async () => {
      const created = await startCtxTask({
        state: 'working',
        toolContext: {
          sessionId: 'ses_forged',
          actorId: 'act_forged',
          actorExternalId: 'ext_forged',
          ocaToken: 'tok_keep',
        },
      });
      expect(created.status).toBe(201);
      await awaitDispatch(created.body.id);

      // Identity is server-derived at the generation chokepoint (#843/#850/#851);
      // a task-dispatched generation cannot smuggle one in through the task row.
      expect(forwardedContext(0)).toEqual({ ocaToken: 'tok_keep' });
      expect(await storedContext(created.body.id)).toEqual({
        ocaToken: 'tok_keep',
      });
    });

    test('a bag of nothing but reserved keys persists nothing', async () => {
      const created = await startCtxTask({
        toolContext: { sessionId: 'ses_forged' },
      });
      expect(created.status).toBe(201);
      expect(await storedContext(created.body.id)).toBeNull();
    });

    test('400 for a key that could not become a header — on create', async () => {
      const res = await startCtxTask({ toolContext: { 'bad key': 'v' } });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_TOOL_CONTEXT_KEY');
    });

    test('400 for two keys that collapse to one header — on transition', async () => {
      const created = await startCtxTask({});
      const res = await move({
        taskId: created.body.id,
        transition: 'begin',
        toolContext: { ocaToken: 'a', ocatoken: 'b' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_TOOL_CONTEXT_KEY');
    });

    test('the bag is never returned by a task read', async () => {
      const created = await startCtxTask({
        toolContext: { ocaToken: 'tok_secret' },
      });
      const taskId = created.body.id;
      expect(created.body.tool_context).toBeUndefined();

      const read = await authenticatedTestClient(userToken).get(
        `/api/v1/tasks/${taskId}`
      );
      expect(read.status).toBe(200);
      expect(read.body.tool_context).toBeUndefined();

      const list = await authenticatedTestClient(userToken).get(
        `/api/v1/tasks?project_id=${projectId}`
      );
      expect(list.status).toBe(200);
      const listed = list.body.data.find((t: { id: string }) => {
        return t.id === taskId;
      });
      expect(listed).toBeDefined();
      expect(listed.tool_context).toBeUndefined();

      // The row really does hold it — the absence above is the mapper, not an
      // unwritten column.
      expect(await storedContext(taskId)).toEqual({ ocaToken: 'tok_secret' });
    });

    test('a terminal transition scrubs the stored bag', async () => {
      const created = await startCtxTask({
        toolContext: { ocaToken: 'tok_closing' },
      });
      const taskId = created.body.id;
      await move({ taskId, transition: 'begin' });
      await awaitDispatch(taskId);

      const closed = await move({ taskId, transition: 'wrap' });
      expect(closed.status).toBe(200);
      expect(closed.body.status).toBe('closed');
      // A closed task holds no credential at rest.
      expect(await storedContext(taskId)).toBeNull();
    });

    test('creating directly in a terminal state stores no bag', async () => {
      const created = await startCtxTask({
        state: 'done',
        toolContext: { ocaToken: 'tok_doa' },
      });
      expect(created.status).toBe(201);
      expect(created.body.status).toBe('closed');
      expect(await storedContext(created.body.id)).toBeNull();
    });

    test('the bag survives an approval gate and reaches the gated dispatch', async () => {
      const created = await startCtxTask({
        toolContext: { ocaToken: 'tok_before_gate' },
      });
      const taskId = created.body.id;

      // The parked move supplies its own bag: the gate is a pause, so the
      // transitioner's context has to outlive it.
      const parked = await move({
        taskId,
        transition: 'gate',
        toolContext: { ocaToken: 'tok_at_gate' },
      });
      expect(parked.status).toBe(200);
      expect(parked.body.pending_transition).toBe('gate');
      expect(mockCreateGeneration).not.toHaveBeenCalled();

      const approvals = await authenticatedTestClient(userToken).get(
        `/api/v1/approvals?project_id=${projectId}&status=pending`
      );
      const approval = approvals.body.data.find((a: { task_id: string }) => {
        return a.task_id === taskId;
      });
      expect(approval).toBeDefined();

      const approved = await authenticatedTestClient(userToken)
        .post(`/api/v1/approvals/${approval.id}/approve`)
        .send({});
      expect(approved.status).toBe(200);

      await awaitDispatch(taskId);
      expect(forwardedContext(0)).toEqual({ ocaToken: 'tok_at_gate' });
    });

    test('every retry attempt carries the same bag', async () => {
      mockCreateGeneration
        .mockRejectedValueOnce(
          new DomainError('AI_PROVIDER_ERROR', 'transient 502', {
            generation_id: 'gen_ctx_flake',
          })
        )
        .mockResolvedValueOnce(GEN_OK);

      const created = await startCtxTask({
        workflow: retryWorkflowId,
        toolContext: { ocaToken: 'tok_retry' },
      });
      expect(created.status).toBe(201);
      await awaitDispatch(created.body.id);

      expect(mockCreateGeneration).toHaveBeenCalledTimes(2);
      expect(forwardedContext(0)).toEqual({ ocaToken: 'tok_retry' });
      expect(forwardedContext(1)).toEqual({ ocaToken: 'tok_retry' });
    });

    test('an orchestration dispatch inherits the task bag (#945 item 1)', async () => {
      const created = await startCtxTask({
        workflow: orchWorkflowId,
        toolContext: { ocaToken: 'tok_orch' },
      });
      expect(created.status).toBe(201);
      const taskId = created.body.id;

      await pollTask({
        token: userToken,
        taskId,
        predicate: (t) => {
          return t.state === 'done';
        },
      });

      const history = (
        await authenticatedTestClient(userToken).get(
          `/api/v1/tasks/${taskId}/history`
        )
      ).body;
      const routed = history.find((h: { transition: string | null }) => {
        return h.transition === 'to_done';
      });
      expect(typeof routed.orchestration_run_id).toBe('string');

      const run = await authenticatedTestClient(userToken).get(
        `/api/v1/orchestration-runs/${routed.orchestration_run_id}`
      );
      expect(run.status).toBe(200);
      expect(run.body.tool_context).toEqual({ ocaToken: 'tok_orch' });
    });
  });
});
