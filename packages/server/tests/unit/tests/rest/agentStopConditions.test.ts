import {
  type ChatCompletionsStub,
  startChatCompletionsStub,
  type StubReply,
  toolCallCompletion,
} from '../../fixtures/chatCompletionsStub';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * `stop_conditions` ends the loop early, on top of `max_steps`; the condition a
 * turn evaluates is `{ type: "has_tool_call", tool_name }`, the terminator of the
 * "done tool" idiom. The stub answers every step with another tool call, so how
 * many times the provider is called is what each condition is judged by.
 */
describe('POST /api/v1/agents/:agent_id/generate with stop_conditions', () => {
  let stub: ChatCompletionsStub;
  let adminToken: string;
  let projectId: string;
  let aiProviderId: string;
  let doneToolId: string;
  let confirmToolId: string;

  const MAX_STEPS = 4;

  const callDone = (step: number): StubReply => {
    return toolCallCompletion([{ id: `call_done_${step}`, name: 'done' }]);
  };
  const callConfirm = toolCallCompletion([
    { id: 'call_confirm', name: 'confirm' },
  ]);

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const createAgent = async (args: {
    name: string;
    stopConditions?: object[];
    maxSteps?: number;
  }): Promise<string> => {
    const res = await asAdmin()
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: aiProviderId,
        name: args.name,
        tool_bindings: [{ tool_id: doneToolId }, { tool_id: confirmToolId }],
        max_steps: args.maxSteps ?? MAX_STEPS,
        ...(args.stopConditions
          ? { stop_conditions: args.stopConditions }
          : {}),
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  /** Runs one turn and returns how many times the provider was called. */
  const providerCallsFor = async (agentId: string): Promise<number> => {
    stub.completions.length = 0;
    stub.reply(callDone(1));
    const res = await asAdmin()
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'do the thing' }] });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    return stub.completions.length;
  };

  /**
   * Pauses a turn on the client tool after `stepsBeforePause` server steps,
   * then submits its output; returns the resumed response and how many
   * provider calls the resumption made.
   */
  const resumeAfterPause = async (args: {
    agentId: string;
    stepsBeforePause: number;
  }) => {
    stub.reply(
      ...Array.from({ length: args.stepsBeforePause }, (_, index) => {
        return callDone(index + 1);
      }),
      callConfirm,
      callDone(99)
    );
    const paused = await asAdmin()
      .post(`/api/v1/agents/${args.agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'do the thing' }] });
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe('requires_action');

    stub.completions.length = 0;
    const resumed = await asAdmin()
      .post(
        `/api/v1/agents/${args.agentId}/generate/${paused.body.id}/tool-outputs`
      )
      .send({
        tool_outputs: [{ tool_call_id: 'call_confirm', output: 'confirmed' }],
      });
    expect(resumed.status).toBe(200);
    return { resumed: resumed.body, providerCalls: stub.completions.length };
  };

  beforeAll(async () => {
    stub = await startChatCompletionsStub({
      routes: {
        '/done': () => {
          return { body: { acknowledged: true } };
        },
      },
    });

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'stopcondadmin', password: 'supersecret' });
    adminToken = await loginAs('stopcondadmin', 'supersecret');

    const project = await asAdmin()
      .post('/api/v1/projects')
      .send({ name: 'Stop Conditions Project' });
    projectId = project.body.id;

    const provider = await asAdmin().post('/api/v1/ai-providers').send({
      project_id: projectId,
      name: 'Stop Conditions Provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: stub.baseUrl,
    });
    aiProviderId = provider.body.id;

    const doneTool = await asAdmin()
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'done',
        type: 'http',
        description: 'Signals the task is finished.',
        parameters: { type: 'object', properties: {} },
        execute: { url: `${stub.baseUrl}/done`, method: 'POST' },
      });
    expect(doneTool.status).toBe(201);
    doneToolId = doneTool.body.id;

    const confirmTool = await asAdmin()
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'confirm',
        type: 'client',
        description: 'Asks the caller to confirm.',
        parameters: { type: 'object', properties: {} },
      });
    expect(confirmTool.status).toBe(201);
    confirmToolId = confirmTool.body.id;
  });

  afterAll(async () => {
    await stub.close();
  });

  test('without conditions the loop runs until the step budget is spent', async () => {
    const agentId = await createAgent({ name: 'Stop Baseline Agent' });

    expect(await providerCallsFor(agentId)).toBe(MAX_STEPS);
  });

  test('has_tool_call ends the loop at the step that calls the tool', async () => {
    const agentId = await createAgent({
      name: 'Stop On Done Agent',
      stopConditions: [{ type: 'has_tool_call', tool_name: 'done' }],
    });

    expect(await providerCallsFor(agentId)).toBe(1);
  });

  test('a condition naming another tool does not end the loop', async () => {
    const agentId = await createAgent({
      name: 'Stop On Other Tool Agent',
      stopConditions: [{ type: 'has_tool_call', tool_name: 'not_called' }],
    });

    expect(await providerCallsFor(agentId)).toBe(MAX_STEPS);
  });

  // `max_chain_generations` bounds the chain, evaluated where a continuation is
  // spawned; as a per-turn predicate it would cap every turn's step count at
  // the chain's number instead.
  test('a chain-scoped condition does not bound the per-turn loop', async () => {
    const agentId = await createAgent({
      name: 'Stop Chain Scoped Agent',
      stopConditions: [{ type: 'max_chain_generations', max_generations: 1 }],
    });

    expect(await providerCallsFor(agentId)).toBe(MAX_STEPS);
  });

  describe('POST /api/v1/agents/:agent_id/generate/:generation_id/tool-outputs', () => {
    test('the resumed loop honors has_tool_call too', async () => {
      const agentId = await createAgent({
        name: 'Stop On Done Resume Agent',
        stopConditions: [{ type: 'has_tool_call', tool_name: 'done' }],
      });

      const { resumed, providerCalls } = await resumeAfterPause({
        agentId,
        stepsBeforePause: 0,
      });

      expect(resumed.status).toBe('completed');
      expect(providerCalls).toBe(1);
    });

    // `max_steps` bounds a turn, and a resumption continues the same turn: a
    // fresh budget per submit would let a turn run forever.
    test('the step budget spans the pause instead of restarting', async () => {
      const agentId = await createAgent({ name: 'Stop Budget Resume Agent' });

      const { providerCalls } = await resumeAfterPause({
        agentId,
        stepsBeforePause: MAX_STEPS - 2,
      });

      expect(providerCalls).toBe(1);
    });

    test('a resumption with the budget already spent calls no model', async () => {
      const agentId = await createAgent({ name: 'Stop Spent Resume Agent' });

      const { providerCalls } = await resumeAfterPause({
        agentId,
        stepsBeforePause: MAX_STEPS - 1,
      });

      expect(providerCalls).toBe(0);
    });
  });
});
