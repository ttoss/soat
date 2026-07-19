import { db } from 'src/db';
import { DomainError } from 'src/errors';
import * as agentGenerationModule from 'src/lib/agentGeneration';
import { expireDueApprovals } from 'src/lib/approvalScheduler';
import { eventBus, type SoatEvent } from 'src/lib/eventBus';
import { flushTaskAutomations } from 'src/lib/tasks';
import * as tasksAutomationModule from 'src/lib/tasksAutomation';
import { sweepStalledTasks } from 'src/lib/tasksScheduler';

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
  actor_kind: string;
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
      ],
      createNoPermUser: true,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;

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
      expect(history.body[0].actor_kind).toBe('user');
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

    test('history actor_id is the API key id (not the owner user id) for api_key auth (#608)', async () => {
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
      expect(history[0].actor_kind).toBe('api_key');
      // The forensic value: the specific key, distinguishable from the owner.
      expect(history[0].actor_id).toBe(keyPublicId);
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
        res.body.every((t: { state: string }) => {
          return t.state === 'review';
        })
      ).toBe(true);
      expect(
        res.body.some((t: { id: string }) => {
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
      // The generation output is written to payload.last_result verbatim.
      expect(
        (settled.payload as { last_result?: unknown }).last_result
      ).toEqual({ model: 'm', content: 'a sonnet', finishReason: 'stop' });

      // The prompt was resolved from the task payload via input_mapping.
      expect(mockCreateGeneration).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId,
          messages: [{ role: 'user', content: 'Write about spring' }],
        })
      );

      // The routed move was recorded as the `automation` actor with provenance.
      const history = (
        await authenticatedTestClient(userToken).get(
          `/api/v1/tasks/${created.body.id}/history`
        )
      ).body;
      const routed = history.find((h: { transition: string }) => {
        return h.transition === 'to_done';
      });
      expect(routed.actor_kind).toBe('automation');
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
            guard: { '==': [{ var: 'actor.kind' }, 'user'] },
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
      mockCreateGeneration.mockRejectedValue(new Error('model exploded'));
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
      expect(routed.actor_kind).toBe('automation');
      // The causing (failed) generation is linked so a reader can jump to its trace.
      expect(routed.generation_id).toBe('gen_failed607');
      expect(routed.actor_id).toBe('gen_failed607');
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
      expect(routed.actor_kind).toBe('automation');
      expect(typeof routed.run_id).toBe('string');
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
      // Orchestration agent nodes call createGeneration from `agentGeneration`
      // directly (not via the `agents` re-export the shared mock spies), so gate
      // that module's export to hold the run genuinely in flight.
      const genSpy = jest
        .spyOn(agentGenerationModule, 'createGeneration')
        .mockImplementation(async () => {
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
        const runId = (running.active_dispatch as { id: string }).id;

        // Fire a manual transition out of the state before the run finishes.
        const moved = await transition(taskId, 'manual_exit');
        expect(moved.body.state).toBe('done');

        // The still-running orchestration run must have been cancelled.
        const runRow = await db.OrchestrationRun.findOne({
          where: { publicId: runId },
        });
        expect(runRow!.status).toBe('cancelled');
      } finally {
        releaseGen!();
      }
      await flushTaskAutomations();
      genSpy.mockRestore();
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
      // The stale result never landed in payload.
      expect(after.body.payload.last_result).toBeUndefined();
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
      return res.body.find((a: { task_id: string }) => {
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
      expect(move.actor_kind).toBe('approval');
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
      expect(note.actor_kind).toBe('approval');
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
            return r.actor_kind === 'approval' && /expired/i.test(r.note ?? '');
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
});
