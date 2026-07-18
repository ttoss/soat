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
        'ai-providers:CreateAiProvider',
        'agents:CreateAgent',
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

  describe('human state parks with no automation', () => {
    test('a kind:human state does not dispatch', async () => {
      const task = (await createTask()).body;
      const review = (await transition(task.id, 'to_review')).body;
      expect(review.state).toBe('review');
      expect(review.automation_status).toBeNull();
      expect(review.active_dispatch).toBeNull();
    });
  });
});
