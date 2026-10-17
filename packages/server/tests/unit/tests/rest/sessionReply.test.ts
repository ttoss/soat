import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { load } from 'js-yaml';

import * as agentGenerationModule from '../../../../src/lib/agentGeneration';
import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient } from '../../testClient';

const SPECS_DIR = join(__dirname, '../../../../src/rest/openapi/v1');
const CONVERSATION_REPLY_REF =
  './conversations.yaml#/components/schemas/GenerateConversationMessageResponse';

const completedGeneration = (args: { id: string; content: string }) => {
  return {
    id: args.id,
    traceId: `trace_${args.id}`,
    status: 'completed' as const,
    output: {
      model: 'test-model',
      content: args.content,
      finishReason: 'stop',
    },
  };
};

const requiresActionGeneration = (id: string) => {
  return {
    id,
    traceId: `trace_${id}`,
    status: 'requires_action' as const,
    requiredAction: {
      type: 'submit_tool_outputs' as const,
      toolCalls: [{ id: 'call_1', toolName: 'get_weather', args: {} }],
    },
  };
};

describe('Session reply', () => {
  let token: string;
  let agentId: string;

  const createSession = async (body: Record<string, unknown> = {}) => {
    const res = await authenticatedTestClient(token)
      .post('/api/v1/sessions')
      .send({ agent_id: agentId, ...body });
    return {
      id: res.body.id as string,
      conversationId: res.body.conversation_id as string,
    };
  };

  const storedMessages = async (conversationId: string) => {
    const res = await authenticatedTestClient(token).get(
      `/api/v1/conversations/${conversationId}/messages`
    );
    return res.body.data as Array<Record<string, unknown>>;
  };

  const storedRecord = async (args: {
    conversationId: string;
    documentId: unknown;
  }) => {
    const messages = await storedMessages(args.conversationId);
    return messages.find((message) => {
      return message.document_id === args.documentId;
    });
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'sessreply',
      policyActions: [
        'agents:CreateAgent',
        'agents:CreateSession',
        'agents:SendSessionMessage',
        'agents:SubmitSessionToolOutputs',
        'conversations:GetConversation',
      ],
      createNoPermUser: false,
    });
    token = setup.userToken;

    const provider = await authenticatedTestClient(setup.adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: setup.projectId,
        name: 'Session Reply Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });

    const agent = await authenticatedTestClient(token)
      .post('/api/v1/agents')
      .send({
        project_id: setup.projectId,
        ai_provider_id: provider.body.id,
        name: 'Session Reply Agent',
      });
    agentId = agent.body.id;
  });

  // `mockCreateGeneration` is shared: clearing keeps it attached, restoring
  // would not.
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/v1/sessions/{session_id}/generate?wait=true', () => {
    test('the reply carries the stored record the conversation lists', async () => {
      const session = await createSession();
      await authenticatedTestClient(token)
        .post(`/api/v1/sessions/${session.id}/messages`)
        .send({ message: 'Hello' });
      mockCreateGeneration.mockResolvedValueOnce(
        completedGeneration({ id: 'gen_reply_sync', content: 'Hi there' })
      );

      const res = await authenticatedTestClient(token).post(
        `/api/v1/sessions/${session.id}/generate?wait=true`
      );

      expect(res.status).toBe(200);
      expect(res.body.message.document_id).toMatch(/^doc_/);
      expect(res.body.message).toEqual(
        await storedRecord({
          conversationId: session.conversationId,
          documentId: res.body.message.document_id,
        })
      );
      expect(res.body).toMatchObject({
        status: 'completed',
        content: 'Hi there',
        model: 'test-model',
        generation_id: 'gen_reply_sync',
        trace_id: 'trace_gen_reply_sync',
      });
      expect(res.body.message).toMatchObject({
        role: 'assistant',
        agent_id: agentId,
        position: 1,
        content: 'Hi there',
      });
    });

    test('a turn awaiting tool outputs answers no message', async () => {
      const session = await createSession();
      await authenticatedTestClient(token)
        .post(`/api/v1/sessions/${session.id}/messages`)
        .send({ message: 'Weather?' });
      mockCreateGeneration.mockResolvedValueOnce(
        requiresActionGeneration('gen_reply_pending')
      );

      const res = await authenticatedTestClient(token).post(
        `/api/v1/sessions/${session.id}/generate?wait=true`
      );

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('requires_action');
      expect(res.body).not.toHaveProperty('message');
      expect(res.body).not.toHaveProperty('content');
      expect(await storedMessages(session.conversationId)).toHaveLength(1);
    });
  });

  describe('POST /api/v1/sessions/{session_id}/messages', () => {
    test('an auto-generated reply carries the stored record', async () => {
      const session = await createSession({ auto_generate: true });
      mockCreateGeneration.mockResolvedValueOnce(
        completedGeneration({ id: 'gen_reply_auto', content: 'Auto reply' })
      );

      const res = await authenticatedTestClient(token)
        .post(`/api/v1/sessions/${session.id}/messages`)
        .send({ message: 'Hello' });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('completed');
      expect(res.body.message).toEqual(
        await storedRecord({
          conversationId: session.conversationId,
          documentId: res.body.message.document_id,
        })
      );
      expect(res.body.message.content).toBe('Auto reply');
    });
  });

  describe('POST /api/v1/sessions/{session_id}/tool-outputs', () => {
    let submitToolOutputs: jest.SpiedFunction<
      typeof agentGenerationModule.submitToolOutputs
    >;

    // The pause a submission resumes lives in the LLM loop, so the boundary
    // stands in for it.
    beforeEach(() => {
      submitToolOutputs = jest.spyOn(
        agentGenerationModule,
        'submitToolOutputs'
      );
    });

    afterEach(() => {
      submitToolOutputs.mockRestore();
    });

    const submit = (args: { sessionId: string; generationId: string }) => {
      return authenticatedTestClient(token)
        .post(`/api/v1/sessions/${args.sessionId}/tool-outputs`)
        .send({
          generation_id: args.generationId,
          tool_outputs: [{ tool_call_id: 'call_1', output: { temp: 18 } }],
        });
    };

    test('the completed reply carries the stored record', async () => {
      const session = await createSession();
      submitToolOutputs.mockResolvedValueOnce(
        completedGeneration({ id: 'gen_reply_tools', content: '18C' })
      );

      const res = await submit({
        sessionId: session.id,
        generationId: 'gen_reply_tools',
      });

      expect(res.status).toBe(200);
      expect(res.body.message).toEqual(
        await storedRecord({
          conversationId: session.conversationId,
          documentId: res.body.message.document_id,
        })
      );
      expect(res.body).toMatchObject({
        status: 'completed',
        content: '18C',
        model: 'test-model',
      });
    });

    test('a completed reply with no text is stored and answered like any other', async () => {
      const session = await createSession();
      submitToolOutputs.mockResolvedValueOnce(
        completedGeneration({ id: 'gen_reply_empty', content: '' })
      );

      const res = await submit({
        sessionId: session.id,
        generationId: 'gen_reply_empty',
      });

      expect(res.status).toBe(200);
      expect(res.body.content).toBe('');
      expect(res.body.message).toEqual(
        await storedRecord({
          conversationId: session.conversationId,
          documentId: res.body.message.document_id,
        })
      );
    });

    test('a further pause answers no message', async () => {
      const session = await createSession();
      submitToolOutputs.mockResolvedValueOnce(
        requiresActionGeneration('gen_reply_again')
      );

      const res = await submit({
        sessionId: session.id,
        generationId: 'gen_reply_again',
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('requires_action');
      expect(res.body).not.toHaveProperty('message');
      expect(await storedMessages(session.conversationId)).toHaveLength(0);
    });
  });

  // The runtime response contract validates every reply above against this
  // schema, so a session reply cannot drift from a conversation reply.
  describe('spec', () => {
    const sessionsSpec = load(
      readFileSync(join(SPECS_DIR, 'sessions.yaml'), 'utf8')
    ) as {
      paths: Record<
        string,
        Record<
          string,
          {
            responses: Record<
              string,
              { content?: Record<string, { schema: Record<string, unknown> }> }
            >;
          }
        >
      >;
      components: { schemas: Record<string, Record<string, unknown>> };
    };

    const replySchema = (args: {
      path: string;
      status: string;
    }): Record<string, unknown> => {
      const schema =
        sessionsSpec.paths[args.path].post.responses[args.status].content?.[
          'application/json'
        ].schema ?? {};
      const ref = schema.$ref;
      return typeof ref === 'string' && ref.startsWith('#/components/schemas/')
        ? sessionsSpec.components.schemas[ref.split('/').pop() ?? '']
        : schema;
    };

    test.each([
      ['/api/v1/sessions/{session_id}/generate', '200'],
      ['/api/v1/sessions/{session_id}/tool-outputs', '200'],
    ])('%s answers the conversation reply schema', (path, status) => {
      expect(replySchema({ path, status })).toEqual({
        $ref: CONVERSATION_REPLY_REF,
      });
    });

    test('an auto-generated message answers the conversation reply schema', () => {
      const schema = replySchema({
        path: '/api/v1/sessions/{session_id}/messages',
        status: '201',
      });
      expect(schema.anyOf).toContainEqual({ $ref: CONVERSATION_REPLY_REF });
    });
  });
});
