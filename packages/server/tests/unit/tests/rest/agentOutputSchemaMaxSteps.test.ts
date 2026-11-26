import {
  type ChatCompletionsStub,
  type RecordedRequest,
  startChatCompletionsStub,
  type StubReply,
  textCompletion,
  toolCallCompletion,
} from '../../fixtures/chatCompletionsStub';
import { pollUntil } from '../../fixtures/poll';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * An `output_schema` agent that spends its whole `max_steps` budget still
 * answers: its last allowed step runs without tools and returns the object.
 */
describe('output_schema at max_steps', () => {
  let stub: ChatCompletionsStub;
  let adminToken: string;
  let projectId: string;
  let aiProviderId: string;
  let lookupToolId: string;
  let doneToolId: string;
  let askToolId: string;

  const ANSWER = { summary: 'what the agent found' };
  const SCHEMA = {
    type: 'object',
    required: ['summary'],
    properties: { summary: { type: 'string' } },
  };

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  let callCount = 0;
  const lookupCall = (): StubReply => {
    callCount += 1;
    return toolCallCompletion([{ id: `call_${callCount}`, name: 'lookup' }]);
  };

  /** A model that calls `lookup` whenever a tool is offered. */
  const toolHappyModel = (request: RecordedRequest): StubReply => {
    const tools = request.body.tools;
    return Array.isArray(tools) && tools.length > 0
      ? lookupCall()
      : textCompletion(JSON.stringify(ANSWER));
  };

  /**
   * A model that ignores `tool_choice: "none"`: it calls `lookup` whenever the
   * request offers a tool or its history holds a tool call.
   */
  const toolChoiceDeafModel = (request: RecordedRequest): StubReply => {
    const tools = request.body.tools;
    const messages = request.body.messages;
    const offersTool = Array.isArray(tools) && tools.length > 0;
    const historyHoldsToolCall =
      Array.isArray(messages) &&
      messages.some((message: { role?: unknown; tool_calls?: unknown }) => {
        return message.role === 'tool' || message.tool_calls !== undefined;
      });
    return offersTool || historyHoldsToolCall
      ? lookupCall()
      : textCompletion(JSON.stringify(ANSWER));
  };

  const offeredToolCounts = () => {
    return stub.completions.map((request) => {
      const tools = request.body.tools;
      return Array.isArray(tools) ? tools.length : 0;
    });
  };

  const createTool = async (body: Record<string, unknown>): Promise<string> => {
    const res = await asAdmin()
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        parameters: { type: 'object', properties: {} },
        ...body,
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createAgent = async (
    body: Record<string, unknown>
  ): Promise<string> => {
    const res = await asAdmin()
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: aiProviderId,
        output_schema: SCHEMA,
        ...body,
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const generate = (agentId: string) => {
    stub.completions.length = 0;
    return asAdmin()
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'investigate' }] });
  };

  const readStopReason = async (generationId: string) => {
    const res = await asAdmin().get(`/api/v1/generations/${generationId}`);
    expect(res.status).toBe(200);
    return res.body.stop_reason;
  };

  beforeAll(async () => {
    stub = await startChatCompletionsStub({
      routes: {
        '/lookup': () => {
          return { body: { found: 'something' } };
        },
      },
    });

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'maxstepsschema', password: 'supersecret' });
    adminToken = await loginAs('maxstepsschema', 'supersecret');

    const project = await asAdmin()
      .post('/api/v1/projects')
      .send({ name: 'Max Steps Schema Project' });
    projectId = project.body.id;

    const provider = await asAdmin().post('/api/v1/ai-providers').send({
      project_id: projectId,
      name: 'Max Steps Schema Provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: stub.baseUrl,
    });
    aiProviderId = provider.body.id;

    lookupToolId = await createTool({
      name: 'lookup',
      type: 'http',
      description: 'Looks something up.',
      execute: { url: `${stub.baseUrl}/lookup`, method: 'POST' },
    });
    doneToolId = await createTool({
      name: 'done',
      type: 'client',
      description: 'Ends the turn.',
    });
    askToolId = await createTool({
      name: 'ask_user',
      type: 'client',
      description: 'Asks the user.',
    });
  });

  afterAll(async () => {
    await stub.close();
  });

  test('the last allowed step answers without tools and stops on max_steps', async () => {
    const agentId = await createAgent({
      name: 'Schema Budget Agent',
      max_steps: 3,
      tool_bindings: [{ tool_id: lookupToolId }],
    });
    stub.reply(toolHappyModel);

    const res = await generate(agentId);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.output.object).toEqual(ANSWER);
    expect(offeredToolCounts()).toEqual([1, 1, 0]);
    expect(await readStopReason(res.body.id)).toBe('max_steps');
  });

  test('the last allowed step offers no tool and no tool call in its history', async () => {
    const agentId = await createAgent({
      name: 'Schema Budget Deaf Agent',
      max_steps: 2,
      tool_bindings: [{ tool_id: lookupToolId }],
    });
    stub.reply(toolChoiceDeafModel);

    const res = await generate(agentId);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.output.object).toEqual(ANSWER);
    expect(offeredToolCounts()).toEqual([1, 0]);
    expect(JSON.stringify(stub.completions[1].body.messages)).toContain(
      'something'
    );
    expect(await readStopReason(res.body.id)).toBe('max_steps');
  });

  test('a resumed last step offers no tool and no tool call in its history', async () => {
    const agentId = await createAgent({
      name: 'Schema Budget Deaf Resumed Agent',
      max_steps: 2,
      step_rules: [
        { step: 1, tool_choice: { type: 'tool', tool_name: 'ask_user' } },
      ],
      tool_bindings: [{ tool_id: lookupToolId }, { tool_id: askToolId }],
    });
    stub.reply(
      toolCallCompletion([{ id: 'call_ask_deaf', name: 'ask_user' }]),
      toolChoiceDeafModel
    );

    const paused = await generate(agentId);
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe('requires_action');

    stub.completions.length = 0;
    const resumed = await asAdmin()
      .post(`/api/v1/agents/${agentId}/generate/${paused.body.id}/tool-outputs`)
      .send({
        tool_outputs: [
          { tool_call_id: 'call_ask_deaf', output: { answer: 'yes' } },
        ],
      });

    expect(resumed.status).toBe(200);
    expect(resumed.body.status).toBe('completed');
    expect(resumed.body.output.object).toEqual(ANSWER);
    expect(offeredToolCounts()).toEqual([0]);
    const stopReason = await pollUntil({
      read: () => {
        return readStopReason(paused.body.id);
      },
      done: (value) => {
        return value !== null;
      },
    });
    expect(stopReason).toBe('max_steps');
  });

  test('a last step that still yields no object fails with MAX_STEPS_REACHED', async () => {
    const agentId = await createAgent({
      name: 'Schema Budget Silent Agent',
      max_steps: 2,
      tool_bindings: [{ tool_id: lookupToolId }],
    });
    stub.reply(lookupCall);

    const res = await generate(agentId);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MAX_STEPS_REACHED');
    expect(res.body.error.message).toContain('2');
    expect(res.body.error.meta.max_steps).toBe(2);
  });

  test('an agent whose tool_choice forces a tool fails with MAX_STEPS_REACHED', async () => {
    const agentId = await createAgent({
      name: 'Schema Budget Forcing Agent',
      max_steps: 2,
      tool_choice: 'required',
      stop_conditions: [{ type: 'has_tool_call', tool_name: 'done' }],
      tool_bindings: [{ tool_id: lookupToolId }, { tool_id: doneToolId }],
    });
    stub.reply(toolHappyModel);

    const res = await generate(agentId);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MAX_STEPS_REACHED');
    expect(res.body.error.meta.max_steps).toBe(2);
    expect(
      stub.completions.map((request) => {
        return request.body.tool_choice;
      })
    ).toEqual(['required', 'required']);
  });

  test('a forcing agent whose last step answers without a tool call fails with MAX_STEPS_REACHED', async () => {
    const agentId = await createAgent({
      name: 'Schema Budget Forcing Answering Agent',
      max_steps: 2,
      tool_choice: 'required',
      stop_conditions: [{ type: 'has_tool_call', tool_name: 'done' }],
      tool_bindings: [{ tool_id: lookupToolId }, { tool_id: doneToolId }],
    });
    stub.reply(() => {
      return stub.completions.length < 2
        ? lookupCall()
        : textCompletion(JSON.stringify(ANSWER));
    });

    const res = await generate(agentId);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MAX_STEPS_REACHED');
    expect(res.body.error.meta.max_steps).toBe(2);
    expect(stub.completions).toHaveLength(2);
  });

  test('a forcing agent that answers before its last step fails with AI_PROVIDER_ERROR, untried without tools', async () => {
    const agentId = await createAgent({
      name: 'Schema Budget Forcing Early Agent',
      max_steps: 3,
      tool_choice: 'required',
      stop_conditions: [{ type: 'has_tool_call', tool_name: 'done' }],
      tool_bindings: [{ tool_id: lookupToolId }, { tool_id: doneToolId }],
    });
    stub.reply(() => {
      return textCompletion(JSON.stringify(ANSWER));
    });

    const res = await generate(agentId);

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('AI_PROVIDER_ERROR');
    expect(stub.completions).toHaveLength(1);
  });

  test('a resumed turn counts the steps it spent before the pause', async () => {
    const agentId = await createAgent({
      name: 'Schema Budget Resumed Agent',
      max_steps: 3,
      tool_bindings: [{ tool_id: lookupToolId }, { tool_id: askToolId }],
    });
    stub.reply(
      toolCallCompletion([{ id: 'call_ask', name: 'ask_user' }]),
      toolHappyModel
    );

    const paused = await generate(agentId);
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe('requires_action');

    stub.completions.length = 0;
    const resumed = await asAdmin()
      .post(`/api/v1/agents/${agentId}/generate/${paused.body.id}/tool-outputs`)
      .send({
        tool_outputs: [{ tool_call_id: 'call_ask', output: { answer: 'yes' } }],
      });

    expect(resumed.status).toBe(200);
    expect(resumed.body.status).toBe('completed');
    expect(resumed.body.output.object).toEqual(ANSWER);
    expect(offeredToolCounts()).toEqual([2, 0]);
    // A resumed turn settles its generation after it responds.
    const stopReason = await pollUntil({
      read: () => {
        return readStopReason(paused.body.id);
      },
      done: (value) => {
        return value !== null;
      },
    });
    expect(stopReason).toBe('max_steps');
  });
});
