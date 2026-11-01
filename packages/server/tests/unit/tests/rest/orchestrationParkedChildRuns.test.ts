import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

describe('A parked loop / sub_orchestration child run', () => {
  let userToken: string;
  let projectId: string;

  const client = () => {
    return authenticatedTestClient(userToken);
  };

  const createOrchestration = async (body: Record<string, unknown>) => {
    const res = await client()
      .post('/api/v1/orchestrations')
      .send({ project_id: projectId, edges: [], ...body });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const startRun = async (args: {
    orchestrationId: string;
    input?: Record<string, unknown>;
  }) => {
    const res = await client()
      .post('/api/v1/orchestration-runs')
      .send({
        wait: true,
        orchestration_id: args.orchestrationId,
        input: args.input ?? {},
      });
    expect(res.status).toBe(201);
    return res.body;
  };

  const getRun = async (runId: string) => {
    const res = await client().get(`/api/v1/orchestration-runs/${runId}`);
    expect(res.status).toBe(200);
    return res.body;
  };

  const submitAsk = (runId: string, output: Record<string, unknown>) => {
    return client()
      .post(`/api/v1/orchestration-runs/${runId}/human-input`)
      .send({ node_id: 'ask', output });
  };

  const askChild = (name: string) => {
    return createOrchestration({
      name,
      nodes: [{ id: 'ask', type: 'human', prompt: 'Answer?' }],
    });
  };

  const subParent = async (name: string) => {
    const childId = await askChild(`${name} Child`);
    return createOrchestration({
      name,
      nodes: [
        { id: 'sub', type: 'sub_orchestration', orchestration_id: childId },
      ],
    });
  };

  const childRunIds = (parent: {
    required_action: { context: { orchestration_run_ids: string[] } };
  }) => {
    return parent.required_action.context.orchestration_run_ids;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'parkedchild',
      policyActions: [
        'orchestrations:CreateOrchestration',
        'orchestrations:StartRun',
        'orchestrations:GetRun',
        'orchestrations:CancelRun',
        'orchestrations:PauseRun',
        'orchestrations:ResumeRun',
        'orchestrations:SubmitHumanInput',
      ],
      createNoPermUser: false,
    });
    userToken = setup.userToken;
    projectId = setup.projectId;
  });

  describe('under a sub_orchestration node', () => {
    test('parks its parent on the child', async () => {
      const parent = await startRun({
        orchestrationId: await subParent('Sub Parks'),
      });

      expect(parent.status).toBe('awaiting_input');
      expect(parent.output).toBeNull();
      expect(parent.required_action).toMatchObject({
        type: 'child_run',
        node_id: 'sub',
        context: { orchestration_run_ids: [expect.any(String)] },
      });
      const child = await getRun(childRunIds(parent)[0]);
      expect(child.status).toBe('awaiting_input');
    });

    test("resolving the child's human node completes the parent with the child's output", async () => {
      const parent = await startRun({
        orchestrationId: await subParent('Sub Resumes'),
      });

      const res = await submitAsk(childRunIds(parent)[0], { answer: 'yes' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');

      const settled = await getRun(parent.id);
      expect(settled.status).toBe('completed');
      expect(settled.required_action).toBeNull();
      expect(settled.output).toEqual({ sub: { ask: { answer: 'yes' } } });
    });

    test("a child that fails after it parked fails the parent with the child's error", async () => {
      const childId = await createOrchestration({
        name: 'Sub Fails Child',
        nodes: [
          { id: 'ask', type: 'human', prompt: 'Answer?' },
          { id: 'boom', type: 'transform', expression: { throw: 'boom' } },
        ],
        edges: [{ from: 'ask', to: 'boom' }],
      });
      const parent = await startRun({
        orchestrationId: await createOrchestration({
          name: 'Sub Fails',
          nodes: [
            { id: 'sub', type: 'sub_orchestration', orchestration_id: childId },
          ],
        }),
      });

      const res = await submitAsk(childRunIds(parent)[0], {});
      expect(res.body.status).toBe('failed');

      const settled = await getRun(parent.id);
      expect(settled.status).toBe('failed');
      expect(settled.error).toMatchObject({ code: res.body.error.code });
    });

    test('cancelling the parked child fails the parent', async () => {
      const parent = await startRun({
        orchestrationId: await subParent('Sub Cancelled'),
      });

      const res = await client().post(
        `/api/v1/orchestration-runs/${childRunIds(parent)[0]}/cancel`
      );
      expect(res.status).toBe(200);

      const settled = await getRun(parent.id);
      expect(settled.status).toBe('failed');
      expect(settled.error).toMatchObject({
        code: 'ORCHESTRATION_NESTED_RUN_FAILED',
      });
    });

    test('the parent refuses human input for the node its child holds', async () => {
      const parent = await startRun({
        orchestrationId: await subParent('Sub Refuses Input'),
      });

      const res = await client()
        .post(`/api/v1/orchestration-runs/${parent.id}/human-input`)
        .send({ node_id: 'sub', output: { forged: true } });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ORCHESTRATION_HUMAN_NODE_MISMATCH');
      expect((await getRun(parent.id)).status).toBe('awaiting_input');
    });

    test('a child settling while its parent is paused resumes the parent on its own resume', async () => {
      const parent = await startRun({
        orchestrationId: await subParent('Sub Paused'),
      });
      const childId = childRunIds(parent)[0];
      const pause = await client().post(
        `/api/v1/orchestration-runs/${parent.id}/pause`
      );
      expect(pause.status).toBe(200);
      const childResume = await client().post(
        `/api/v1/orchestration-runs/${childId}/resume`
      );
      expect(childResume.status).toBe(200);

      const answered = await submitAsk(childId, { answer: 'late' });
      expect(answered.body.status).toBe('completed');
      expect((await getRun(parent.id)).status).toBe('awaiting_input');

      const resumed = await client().post(
        `/api/v1/orchestration-runs/${parent.id}/resume`
      );
      expect(resumed.status).toBe(200);
      expect(resumed.body.status).toBe('completed');
      expect(resumed.body.output).toEqual({
        sub: { ask: { answer: 'late' } },
      });
    });
  });

  describe('under a loop node', () => {
    test('parks the parent until every item settles, then collects them in item order', async () => {
      const childId = await askChild('Loop Child');
      const parent = await startRun({
        orchestrationId: await createOrchestration({
          name: 'Loop Parks',
          nodes: [
            {
              id: 'each',
              type: 'loop',
              orchestration_id: childId,
              collection: 'state.input.items',
            },
          ],
        }),
        input: { items: ['a', 'b'] },
      });

      expect(parent.status).toBe('awaiting_input');
      const [first, second] = childRunIds(parent);
      expect((await getRun(first)).input).toEqual({ item: 'a' });
      expect((await getRun(second)).input).toEqual({ item: 'b' });

      await submitAsk(second, { v: 'B' });
      expect((await getRun(parent.id)).status).toBe('awaiting_input');
      await submitAsk(first, { v: 'A' });

      const settled = await getRun(parent.id);
      expect(settled.status).toBe('completed');
      expect(settled.output).toEqual({
        each: {
          results: [{ ask: { v: 'A' } }, { ask: { v: 'B' } }],
          failed_count: 0,
        },
      });
    });

    test('with on_item_error "collect", a parked item that fails is collected as an item error', async () => {
      const childId = await askChild('Loop Collect Child');
      const parent = await startRun({
        orchestrationId: await createOrchestration({
          name: 'Loop Collect',
          nodes: [
            {
              id: 'each',
              type: 'loop',
              orchestration_id: childId,
              collection: 'state.input.items',
              on_item_error: 'collect',
            },
          ],
        }),
        input: { items: ['a'] },
      });

      const [only] = childRunIds(parent);
      await client().post(`/api/v1/orchestration-runs/${only}/cancel`);

      const settled = await getRun(parent.id);
      expect(settled.status).toBe('completed');
      expect(settled.output.each).toMatchObject({
        failed_count: 1,
        results: [{ orchestration_run_id: only }],
      });
    });
  });
});
