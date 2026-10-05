import {
  type ChatCompletionsStub,
  providerFailure,
  type RecordedRequest,
  startChatCompletionsStub,
  textCompletion,
  toolCallCompletion,
} from '../../fixtures/chatCompletionsStub';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * A non-stream turn as the provider sees it: what a client tool's submitted
 * output becomes on the resumed request, what the guardrail gate does with a
 * client call before handing it over, and the no-tools retry when the provider
 * refuses the tool definitions.
 */
describe('client tools on POST /api/v1/agents/:agent_id/generate', () => {
  let stub: ChatCompletionsStub;
  let adminToken: string;
  let projectId: string;
  let aiProviderId: string;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const createTool = async (body: Record<string, unknown>): Promise<string> => {
    const res = await asAdmin()
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        type: 'client',
        parameters: { type: 'object', properties: {} },
        ...body,
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createAgent = async (args: {
    name: string;
    toolIds: string[];
  }): Promise<string> => {
    const res = await asAdmin()
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: aiProviderId,
        name: args.name,
        tool_bindings: args.toolIds.map((toolId) => {
          return { tool_id: toolId };
        }),
        max_steps: 3,
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const generate = (agentId: string) => {
    return asAdmin()
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'go' }] });
  };

  /** The `role: "tool"` message a request carries for one tool call. */
  const toolResultContent = (
    request: RecordedRequest,
    toolCallId: string
  ): unknown => {
    const messages = request.body.messages;
    if (!Array.isArray(messages)) return undefined;
    const message = messages.find((entry: unknown) => {
      return (
        typeof entry === 'object' &&
        entry !== null &&
        'role' in entry &&
        entry.role === 'tool' &&
        'tool_call_id' in entry &&
        entry.tool_call_id === toolCallId
      );
    });
    return typeof message === 'object' &&
      message !== null &&
      'content' in message
      ? message.content
      : undefined;
  };

  beforeAll(async () => {
    stub = await startChatCompletionsStub();

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'clienthandoffadmin', password: 'supersecret' });
    adminToken = await loginAs('clienthandoffadmin', 'supersecret');

    const project = await asAdmin()
      .post('/api/v1/projects')
      .send({ name: 'Client Handoff Project' });
    projectId = project.body.id;

    const provider = await asAdmin().post('/api/v1/ai-providers').send({
      project_id: projectId,
      name: 'Client Handoff Provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: stub.baseUrl,
    });
    aiProviderId = provider.body.id;
  });

  afterAll(async () => {
    await stub.close();
  });

  describe('POST /api/v1/agents/:agent_id/generate/:generation_id/tool-outputs', () => {
    // Client tools never run on the server, so their output_mapping is applied
    // to the submitted output instead, keyed by the tool's name.
    test('a client tool output_mapping reshapes only its own tool’s output', async () => {
      const agentId = await createAgent({
        name: 'Client Output Mapping Agent',
        toolIds: [
          await createTool({
            name: 'transcribe',
            output_mapping: { var: 'output.text' },
          }),
          await createTool({ name: 'read_note' }),
        ],
      });
      stub.reply(
        toolCallCompletion([
          { id: 'call_transcribe', name: 'transcribe' },
          { id: 'call_note', name: 'read_note' },
        ]),
        textCompletion('Done.')
      );

      const paused = await generate(agentId);
      expect(paused.status).toBe(200);
      expect(paused.body.status).toBe('requires_action');

      stub.completions.length = 0;
      const resumed = await asAdmin()
        .post(
          `/api/v1/agents/${agentId}/generate/${paused.body.id}/tool-outputs`
        )
        .send({
          tool_outputs: [
            {
              tool_call_id: 'call_transcribe',
              output: { text: 'Hi!', language: 'en' },
            },
            { tool_call_id: 'call_note', output: { ok: true } },
          ],
        });

      expect(resumed.status).toBe(200);
      expect(resumed.body.status).toBe('completed');
      expect(stub.completions).toHaveLength(1);
      const [request] = stub.completions;
      expect(toolResultContent(request, 'call_transcribe')).toBe('Hi!');
      expect(toolResultContent(request, 'call_note')).toBe('{"ok":true}');
    });
  });

  describe('a guardrail on a client tool', () => {
    const guardedAgent = async (args: {
      name: string;
      guardrailClass: string;
    }): Promise<string> => {
      const guardrail = await asAdmin()
        .post('/api/v1/guardrails')
        .send({
          project_id: projectId,
          name: `${args.name} Guardrail`,
          document: { class: args.guardrailClass },
        });
      expect(guardrail.status).toBe(201);
      return createAgent({
        name: args.name,
        toolIds: [
          await createTool({
            name: 'wire_funds',
            guardrail_ids: [guardrail.body.id],
            parameters: {
              type: 'object',
              properties: { amount: { type: 'number' } },
            },
          }),
        ],
      });
    };

    test('a blocked call is never handed over: the model reads the refusal and answers', async () => {
      const agentId = await guardedAgent({
        name: 'Blocked Client Agent',
        guardrailClass: 'D',
      });
      stub.reply(
        toolCallCompletion([
          { id: 'call_wire', name: 'wire_funds', args: { amount: 5 } },
        ]),
        textCompletion('I could not do that.')
      );

      const res = await generate(agentId);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      expect(res.body.output.content).toBe('I could not do that.');
    });

    test('a released call suspends at requires_action with its arguments', async () => {
      const agentId = await guardedAgent({
        name: 'Released Client Agent',
        guardrailClass: 'A',
      });
      stub.reply(
        toolCallCompletion([
          { id: 'call_wire', name: 'wire_funds', args: { amount: 5 } },
        ])
      );

      const res = await generate(agentId);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('requires_action');
      expect(res.body.required_action.tool_calls).toEqual([
        { id: 'call_wire', tool_name: 'wire_funds', args: { amount: 5 } },
      ]);
    });
  });

  // The provider refuses the request that carries tool definitions; the turn is
  // retried once without them rather than failed.
  test('a provider refusing the tool definitions falls back to a no-tools turn', async () => {
    const agentId = await createAgent({
      name: 'Tool Fallback Agent',
      toolIds: [await createTool({ name: 'lookup' })],
    });
    stub.completions.length = 0;
    stub.reply((request) => {
      return Array.isArray(request.body.tools)
        ? providerFailure(400)
        : textCompletion('fallback answer');
    });

    const res = await generate(agentId);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.output.content).toBe('fallback answer');
    expect(stub.completions).toHaveLength(2);
    expect(Array.isArray(stub.completions[0].body.tools)).toBe(true);
    expect(stub.completions[1].body.tools).toBeUndefined();
  });
});
