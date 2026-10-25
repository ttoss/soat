import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient, testClient } from '../../testClient';

describe('Session context window (max_context_messages)', () => {
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let unlimitedAgentId: string;
  let limitedAgentId: string;

  const createSession = (body: Record<string, unknown>) => {
    return authenticatedTestClient(userToken)
      .post('/api/v1/sessions')
      .send(body);
  };

  /** Posts `count` user messages, then generates and returns the history sent. */
  const historySent = async (args: { sessionId: string; count: number }) => {
    for (let i = 1; i <= args.count; i++) {
      await authenticatedTestClient(userToken)
        .post(`/api/v1/sessions/${args.sessionId}/messages`)
        .send({ message: `Message ${i}` });
    }
    mockCreateGeneration.mockResolvedValueOnce({
      id: 'gen_window',
      traceId: 'trc_window',
      status: 'completed',
      output: { model: 'test-model', content: 'Reply', finishReason: 'stop' },
    });
    const response = await authenticatedTestClient(userToken).post(
      `/api/v1/sessions/${args.sessionId}/generate?wait=true`
    );
    expect(response.status).toBe(200);
    const call = mockCreateGeneration.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    return call.messages.filter((message) => {
      return message.role !== 'system';
    });
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'sesswin',
      policyActions: [
        'agents:CreateAgent',
        'agents:CreateSession',
        'agents:GetSession',
        'agents:UpdateSession',
        'agents:SendSessionMessage',
      ],
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken!;

    const provider = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: setup.projectId,
        name: 'Window Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });

    const createAgent = async (maxContextMessages?: number) => {
      const agent = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          project_id: setup.projectId,
          ai_provider_id: provider.body.id,
          name: `Window Agent ${maxContextMessages ?? 'unlimited'}`,
          ...(maxContextMessages
            ? { max_context_messages: maxContextMessages }
            : {}),
        });
      return agent.body.id as string;
    };
    unlimitedAgentId = await createAgent();
    limitedAgentId = await createAgent(2);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/v1/sessions', () => {
    test('defaults to null, deferring to the agent', async () => {
      const response = await createSession({ agent_id: unlimitedAgentId });

      expect(response.status).toBe(201);
      expect(response.body.max_context_messages).toBeNull();
    });

    test('a session window sends only the most recent messages', async () => {
      const response = await createSession({
        agent_id: unlimitedAgentId,
        max_context_messages: 2,
      });
      expect(response.status).toBe(201);
      expect(response.body.max_context_messages).toBe(2);

      const sent = await historySent({ sessionId: response.body.id, count: 4 });

      expect(sent).toHaveLength(2);
      expect(sent[0].content).toContain('Message 3');
      expect(sent[1].content).toContain('Message 4');
    });

    test('a session window takes precedence over the agent window', async () => {
      const response = await createSession({
        agent_id: limitedAgentId,
        max_context_messages: 3,
      });

      const sent = await historySent({ sessionId: response.body.id, count: 4 });

      expect(sent).toHaveLength(3);
      expect(sent[0].content).toContain('Message 2');
    });

    test('without a session window the agent window applies', async () => {
      const response = await createSession({ agent_id: limitedAgentId });

      const sent = await historySent({ sessionId: response.body.id, count: 4 });

      expect(sent).toHaveLength(2);
    });

    test.each([0, -1, 1.5, '3'])(
      'max_context_messages %p is 400',
      async (value) => {
        const response = await createSession({
          agent_id: unlimitedAgentId,
          max_context_messages: value,
        });

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_FAILED');
      }
    );

    test('401 without credentials', async () => {
      const response = await testClient
        .post('/api/v1/sessions')
        .send({ agent_id: unlimitedAgentId, max_context_messages: 2 });

      expect(response.status).toBe(401);
    });
  });

  describe('PATCH /api/v1/sessions/:session_id', () => {
    test('sets the window, and null clears it back to the agent', async () => {
      const created = await createSession({ agent_id: limitedAgentId });
      const sessionId = created.body.id as string;

      const set = await authenticatedTestClient(userToken)
        .patch(`/api/v1/sessions/${sessionId}`)
        .send({ max_context_messages: 10 });
      expect(set.status).toBe(200);
      expect(set.body.max_context_messages).toBe(10);

      const cleared = await authenticatedTestClient(userToken)
        .patch(`/api/v1/sessions/${sessionId}`)
        .send({ max_context_messages: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.max_context_messages).toBeNull();

      const sent = await historySent({ sessionId, count: 4 });
      expect(sent).toHaveLength(2);
    });

    test('omitting it leaves the window unchanged', async () => {
      const created = await createSession({
        agent_id: unlimitedAgentId,
        max_context_messages: 5,
      });

      const patched = await authenticatedTestClient(userToken)
        .patch(`/api/v1/sessions/${created.body.id}`)
        .send({ name: 'renamed' });

      expect(patched.body.max_context_messages).toBe(5);
    });

    test('0 is 400', async () => {
      const created = await createSession({ agent_id: unlimitedAgentId });

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/sessions/${created.body.id}`)
        .send({ max_context_messages: 0 });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('404 without UpdateSession', async () => {
      const created = await createSession({ agent_id: unlimitedAgentId });

      const response = await authenticatedTestClient(noPermToken)
        .patch(`/api/v1/sessions/${created.body.id}`)
        .send({ max_context_messages: 2 });

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/v1/sessions/:session_id/fork', () => {
    test('a fork keeps its parent window', async () => {
      const parent = await createSession({
        agent_id: unlimitedAgentId,
        max_context_messages: 4,
      });

      const fork = await authenticatedTestClient(userToken)
        .post(`/api/v1/sessions/${parent.body.id}/fork`)
        .send({});

      expect(fork.status).toBe(201);
      expect(fork.body.max_context_messages).toBe(4);
    });
  });
});
