import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import {
  type ChatCompletionsStub,
  startChatCompletionsStub,
  textCompletion,
  toolCallCompletion,
} from '../../fixtures/chatCompletionsStub';
import { asWire, captureEvents } from '../../fixtures/eventCapture';
import { authenticatedTestClient } from '../../testClient';

/**
 * A conversation turn paused on a client tool, completed through
 * `POST /api/v1/agents/{agent_id}/generate/{generation_id}/tool-outputs`.
 */
describe('Conversation turn completed through agent tool-outputs', () => {
  let token: string;
  let projectId: string;
  let agentId: string;
  let stub: ChatCompletionsStub;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'convtools',
      policyActions: [
        'conversations:CreateConversation',
        'conversations:GetConversation',
        'conversations:UpdateConversation',
        'conversations:GenerateConversationMessage',
        'agents:CreateAgentGeneration',
      ],
      createNoPermUser: false,
    });
    token = setup.userToken;
    projectId = setup.projectId;

    stub = await startChatCompletionsStub();
    const asAdmin = authenticatedTestClient(setup.adminToken);
    const provider = await asAdmin.post('/api/v1/ai-providers').send({
      project_id: projectId,
      name: 'Conversation Tool Outputs Provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: stub.baseUrl,
    });
    expect(provider.status).toBe(201);
    const tool = await asAdmin.post('/api/v1/tools').send({
      project_id: projectId,
      name: 'read_barometer',
      type: 'client',
      parameters: { type: 'object', properties: {} },
    });
    expect(tool.status).toBe(201);
    const agent = await asAdmin.post('/api/v1/agents').send({
      project_id: projectId,
      ai_provider_id: provider.body.id,
      name: 'Conversation Tool Outputs Agent',
      tool_bindings: [{ tool_id: tool.body.id }],
    });
    expect(agent.status).toBe(201);
    agentId = agent.body.id;
  });

  afterAll(async () => {
    await stub.close();
  });

  const storedMessages = async (conversationId: string) => {
    const res = await authenticatedTestClient(token).get(
      `/api/v1/conversations/${conversationId}/messages`
    );
    return res.body.data as Array<Record<string, unknown>>;
  };

  const postMessage = async (args: {
    conversationId: string;
    message: string;
  }) => {
    const res = await authenticatedTestClient(token)
      .post(`/api/v1/conversations/${args.conversationId}/messages`)
      .send({ message: args.message, role: 'user' });
    expect(res.status).toBe(201);
  };

  /** A conversation whose first turn is paused on the client tool. */
  const pausedConversationTurn = async () => {
    const conversation = await authenticatedTestClient(token)
      .post('/api/v1/conversations')
      .send({ project_id: projectId });
    expect(conversation.status).toBe(201);
    const conversationId = conversation.body.id as string;
    await postMessage({ conversationId, message: 'Will it rain?' });
    stub.reply(
      toolCallCompletion([{ id: 'call_baro', name: 'read_barometer' }]),
      textCompletion('Pressure is falling: expect rain.')
    );
    const paused = await authenticatedTestClient(token)
      .post(`/api/v1/conversations/${conversationId}/generate?wait=true`)
      .send({ agent_id: agentId });
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe('requires_action');
    return {
      conversationId,
      generationId: paused.body.generation_id as string,
    };
  };

  const complete = (args: { generationId: string; toolCallId?: string }) => {
    return authenticatedTestClient(token)
      .post(
        `/api/v1/agents/${agentId}/generate/${args.generationId}/tool-outputs`
      )
      .send({
        tool_outputs: [
          { tool_call_id: args.toolCallId ?? 'call_baro', output: '990 hPa' },
        ],
      });
  };

  describe('POST /api/v1/agents/{agent_id}/generate/{generation_id}/tool-outputs', () => {
    test('stores the reply right after the messages it read, ahead of one sent during the pause', async () => {
      const turn = await pausedConversationTurn();
      await postMessage({
        conversationId: turn.conversationId,
        message: 'Still there?',
      });

      const res = await complete({ generationId: turn.generationId });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      const stored = await storedMessages(turn.conversationId);
      expect(
        stored.map((message) => {
          return [message.position, message.role, message.content];
        })
      ).toEqual([
        [0, 'user', 'Will it rain?'],
        [1, 'assistant', 'Pressure is falling: expect rain.'],
        [2, 'user', 'Still there?'],
      ]);
      expect(stored[1].agent_id).toBe(agentId);
    });

    test('announces the stored reply as conversation_messages.generated', async () => {
      const turn = await pausedConversationTurn();
      let res: Awaited<ReturnType<typeof complete>> | undefined;

      const [event] = await captureEvents({
        type: 'conversation_messages.generated',
        where: (candidate) => {
          return candidate.data.conversation_id === turn.conversationId;
        },
        action: async () => {
          res = await complete({ generationId: turn.generationId });
        },
      });

      expect(res?.status).toBe(200);
      expect(event).toBeDefined();
      const [, reply] = await storedMessages(turn.conversationId);
      expect(event.resourceId).toBe(reply.document_id);
      expect(asWire(event.data)).toEqual({
        ...reply,
        conversation_id: turn.conversationId,
        generation_id: turn.generationId,
        trace_id: res?.body.trace_id,
      });
    });

    test('a further pause stores nothing', async () => {
      const turn = await pausedConversationTurn();
      stub.reply(
        toolCallCompletion([{ id: 'call_baro_2', name: 'read_barometer' }])
      );

      const res = await complete({ generationId: turn.generationId });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('requires_action');
      expect(await storedMessages(turn.conversationId)).toHaveLength(1);
    });

    test('a generation that answers no conversation stores nothing', async () => {
      stub.reply(
        toolCallCompletion([{ id: 'call_bare', name: 'read_barometer' }]),
        textCompletion('Bare reply.')
      );
      const paused = await authenticatedTestClient(token)
        .post(`/api/v1/agents/${agentId}/generate?wait=true`)
        .send({ messages: [{ role: 'user', content: 'Will it rain?' }] });
      expect(paused.status).toBe(200);
      expect(paused.body.status).toBe('requires_action');
      let res: Awaited<ReturnType<typeof complete>> | undefined;

      const events = await captureEvents({
        type: 'conversation_messages.generated',
        where: (candidate) => {
          return candidate.data.generation_id === paused.body.id;
        },
        action: async () => {
          res = await complete({
            generationId: paused.body.id,
            toolCallId: 'call_bare',
          });
        },
      });

      expect(res?.status).toBe(200);
      expect(res?.body.status).toBe('completed');
      expect(res?.body.output.content).toBe('Bare reply.');
      expect(events).toEqual([]);
    });
  });
});
