import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * Session forking branches a new session from a point in another session's
 * history. The fork references the parent's documents rather than copying them,
 * so every assertion below that matters is on **document identity**
 * (`document_id`), not on content equality.
 */
describe('Session forking', () => {
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let otherProjectId: string;
  let agentId: string;
  let altAgentId: string;
  let otherProjectAgentId: string;

  /** Lists a session's messages through its underlying conversation. */
  const listMessages = async (sessionId: string) => {
    const session = await authenticatedTestClient(userToken).get(
      `/api/v1/sessions/${sessionId}`
    );
    const res = await authenticatedTestClient(userToken).get(
      `/api/v1/conversations/${session.body.conversation_id}/messages`
    );
    return res.body.data as Array<{
      role: string;
      document_id: string;
      position: number;
      content: string;
    }>;
  };

  /** A session with `count` user messages at positions 0..count-1. */
  const seedSession = async (args: { name: string; count: number }) => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/sessions')
      .send({ agent_id: agentId, name: args.name });
    for (let index = 0; index < args.count; index += 1) {
      await authenticatedTestClient(userToken)
        .post(`/api/v1/sessions/${res.body.id}/messages`)
        .send({ message: `Message ${index}` });
    }
    return res.body.id as string;
  };

  const createAgent = async (args: {
    name: string;
    projectPublicId: string;
    providerId: string;
  }) => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: args.projectPublicId,
        ai_provider_id: args.providerId,
        name: args.name,
      });
    return res.body.id as string;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'fork',
      policyActions: [
        'agents:CreateAgent',
        'agents:CreateSession',
        'agents:ListSessions',
        'agents:GetSession',
        'agents:UpdateSession',
        'agents:DeleteSession',
        'agents:SendSessionMessage',
        'conversations:GetConversation',
        'documents:GetDocument',
      ],
      createOtherProject: true,
      createNoPermUser: true,
    });

    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId as string;

    const provider = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Fork Test Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });

    const otherProvider = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: otherProjectId,
        name: 'Fork Other Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });

    agentId = await createAgent({
      name: 'Fork Test Agent',
      projectPublicId: projectId,
      providerId: provider.body.id,
    });
    altAgentId = await createAgent({
      name: 'Fork Alt Agent',
      projectPublicId: projectId,
      providerId: provider.body.id,
    });
    otherProjectAgentId = await createAgent({
      name: 'Fork Cross Project Agent',
      projectPublicId: otherProjectId,
      providerId: otherProvider.body.id,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/v1/sessions/:session_id/fork', () => {
    test('forks at a position, referencing the parent documents', async () => {
      const parentId = await seedSession({ name: 'Fork Source', count: 4 });
      const parentMessages = await listMessages(parentId);

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/sessions/${parentId}/fork`)
        .send({ fork_at_position: 1, name: 'Branch at 1' });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.id).not.toBe(parentId);
      expect(response.body.conversation_id).toBeDefined();
      expect(response.body.status).toBe('open');
      expect(response.body.name).toBe('Branch at 1');
      expect(response.body.agent_id).toBe(agentId);
      expect(response.body.forked_from_session_id).toBe(parentId);
      expect(response.body.forked_from_position).toBe(1);

      const forkMessages = await listMessages(response.body.id);
      expect(forkMessages).toHaveLength(2);
      expect(
        forkMessages.map((m) => {
          return m.document_id;
        })
      ).toEqual(
        parentMessages.slice(0, 2).map((m) => {
          return m.document_id;
        })
      );
      expect(
        forkMessages.map((m) => {
          return m.position;
        })
      ).toEqual([0, 1]);
    });

    test('omitting fork_at_position branches at the tip', async () => {
      const parentId = await seedSession({ name: 'Fork Tip', count: 3 });

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/sessions/${parentId}/fork`)
        .send({});

      expect(response.status).toBe(201);
      expect(response.body.forked_from_position).toBeNull();
      expect(await listMessages(response.body.id)).toHaveLength(3);
    });

    test('the parent session is unmodified by the fork', async () => {
      const parentId = await seedSession({
        name: 'Fork Parent Intact',
        count: 3,
      });
      const before = await authenticatedTestClient(userToken).get(
        `/api/v1/sessions/${parentId}`
      );
      const beforeMessages = await listMessages(parentId);

      await authenticatedTestClient(userToken)
        .post(`/api/v1/sessions/${parentId}/fork`)
        .send({ fork_at_position: 0 });

      const after = await authenticatedTestClient(userToken).get(
        `/api/v1/sessions/${parentId}`
      );
      expect(after.body.status).toBe(before.body.status);
      expect(after.body.conversation_id).toBe(before.body.conversation_id);
      expect(after.body.forked_from_session_id).toBeNull();
      expect(await listMessages(parentId)).toEqual(beforeMessages);
    });

    test('agent_id override is honoured', async () => {
      const parentId = await seedSession({
        name: 'Fork Agent Override',
        count: 1,
      });

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/sessions/${parentId}/fork`)
        .send({ agent_id: altAgentId });

      expect(response.status).toBe(201);
      expect(response.body.agent_id).toBe(altAgentId);
    });

    test('the fork inherits tool_context and accepts an override', async () => {
      const created = await authenticatedTestClient(userToken)
        .post('/api/v1/sessions')
        .send({
          agent_id: agentId,
          name: 'Fork Tool Context',
          tool_context: { tenant: 'acme' },
        });
      const parentId = created.body.id;

      const inherited = await authenticatedTestClient(userToken)
        .post(`/api/v1/sessions/${parentId}/fork`)
        .send({});
      expect(inherited.status).toBe(201);
      expect(inherited.body.tool_context).toEqual({ tenant: 'acme' });

      const overridden = await authenticatedTestClient(userToken)
        .post(`/api/v1/sessions/${parentId}/fork`)
        .send({ tool_context: { tenant: 'globex' } });
      expect(overridden.status).toBe(201);
      expect(overridden.body.tool_context).toEqual({ tenant: 'globex' });
    });

    test('tags are set on the fork', async () => {
      const parentId = await seedSession({ name: 'Fork Tags', count: 1 });

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/sessions/${parentId}/fork`)
        .send({ tags: { experiment: 'prompt-v2' } });

      expect(response.status).toBe(201);
      expect(response.body.tags).toEqual({ experiment: 'prompt-v2' });
    });

    test('the fork is created inert — no generation is triggered', async () => {
      const parentId = await seedSession({ name: 'Fork Inert', count: 2 });

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/sessions/${parentId}/fork`)
        .send({});

      expect(response.status).toBe(201);
      expect(response.body.auto_generate).toBe(false);
      expect(mockCreateGeneration).not.toHaveBeenCalled();
    });

    test('a forked session can be driven to a completed generation', async () => {
      const parentId = await seedSession({ name: 'Fork Drive', count: 2 });
      const fork = await authenticatedTestClient(userToken)
        .post(`/api/v1/sessions/${parentId}/fork`)
        .send({});

      mockCreateGeneration.mockResolvedValueOnce({
        id: 'gen_fork_01',
        traceId: 'trc_fork_01',
        status: 'completed',
        output: {
          model: 'test-model',
          content: 'Forked answer',
          finishReason: 'stop',
        },
      });

      const response = await authenticatedTestClient(userToken).post(
        `/api/v1/sessions/${fork.body.id}/generate?wait=true`
      );

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('completed');
    });

    test('recorded tool results replay in the fork instead of being re-invoked', async () => {
      const parentId = await seedSession({ name: 'Fork Replay', count: 1 });

      mockCreateGeneration.mockResolvedValueOnce({
        id: 'gen_replay_01',
        traceId: 'trc_replay_01',
        status: 'completed',
        output: {
          model: 'test-model',
          content: 'It is sunny.',
          finishReason: 'stop',
          responseMessages: [
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool-call',
                  toolCallId: 'call_1',
                  toolName: 'get_weather',
                  input: { city: 'Recife' },
                },
              ],
            },
            {
              role: 'tool',
              content: [
                {
                  type: 'tool-result',
                  toolCallId: 'call_1',
                  toolName: 'get_weather',
                  output: { forecast: 'sunny' },
                },
              ],
            },
            { role: 'assistant', content: 'It is sunny.' },
          ],
        },
      });

      await authenticatedTestClient(userToken).post(
        `/api/v1/sessions/${parentId}/generate?wait=true`
      );

      const fork = await authenticatedTestClient(userToken)
        .post(`/api/v1/sessions/${parentId}/fork`)
        .send({});
      expect(fork.status).toBe(201);

      jest.clearAllMocks();
      mockCreateGeneration.mockResolvedValueOnce({
        id: 'gen_replay_02',
        traceId: 'trc_replay_02',
        status: 'completed',
        output: {
          model: 'test-model',
          content: 'Still sunny.',
          finishReason: 'stop',
        },
      });

      await authenticatedTestClient(userToken).post(
        `/api/v1/sessions/${fork.body.id}/generate?wait=true`
      );

      expect(mockCreateGeneration).toHaveBeenCalledTimes(1);
      const call = mockCreateGeneration.mock.calls[0][0] as {
        messages: Array<{ role: string; content: unknown }>;
      };
      // The recorded tool call and its result are replayed verbatim as model
      // input; nothing re-executes `get_weather`.
      expect(JSON.stringify(call.messages)).toContain('"toolCallId":"call_1"');
      expect(JSON.stringify(call.messages)).toContain('"forecast":"sunny"');
    });

    test('forking a fork works and records its own lineage', async () => {
      const parentId = await seedSession({ name: 'Fork Depth', count: 2 });
      const first = await authenticatedTestClient(userToken)
        .post(`/api/v1/sessions/${parentId}/fork`)
        .send({});

      const second = await authenticatedTestClient(userToken)
        .post(`/api/v1/sessions/${first.body.id}/fork`)
        .send({ fork_at_position: 0 });

      expect(second.status).toBe(201);
      expect(second.body.forked_from_session_id).toBe(first.body.id);
      expect(second.body.forked_from_position).toBe(0);
      expect(await listMessages(second.body.id)).toHaveLength(1);
    });

    test('deleting the parent does not delete the fork', async () => {
      const parentId = await seedSession({ name: 'Fork Orphan', count: 2 });
      const fork = await authenticatedTestClient(userToken)
        .post(`/api/v1/sessions/${parentId}/fork`)
        .send({});

      const deleted = await authenticatedTestClient(userToken).delete(
        `/api/v1/sessions/${parentId}`
      );
      expect(deleted.status).toBe(204);

      const survivor = await authenticatedTestClient(userToken).get(
        `/api/v1/sessions/${fork.body.id}`
      );
      expect(survivor.status).toBe(200);
      expect(survivor.body.forked_from_session_id).toBeNull();
      // The referenced documents outlive the parent conversation, so the fork
      // keeps its context.
      expect(await listMessages(fork.body.id)).toHaveLength(2);
    });

    test('a position outside the parent history returns 400', async () => {
      const parentId = await seedSession({ name: 'Fork Range', count: 2 });

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/sessions/${parentId}/fork`)
        .send({ fork_at_position: 9 });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a non-integer position returns 400', async () => {
      const parentId = await seedSession({
        name: 'Fork Bad Position',
        count: 1,
      });

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/sessions/${parentId}/fork`)
        .send({ fork_at_position: -1 });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('an unknown agent_id returns 400', async () => {
      const parentId = await seedSession({
        name: 'Fork Unknown Agent',
        count: 1,
      });

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/sessions/${parentId}/fork`)
        .send({ agent_id: 'agent_does_not_exist' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('AGENT_NOT_FOUND');
    });

    test('forking onto an agent in another project is refused', async () => {
      const parentId = await seedSession({
        name: 'Fork Cross Project',
        count: 1,
      });

      const response = await authenticatedTestClient(adminToken)
        .post(`/api/v1/sessions/${parentId}/fork`)
        .send({ agent_id: otherProjectAgentId });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('unknown session returns 404', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/sessions/sess_does_not_exist/fork')
        .send({});

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });

    test('unauthenticated request returns 401', async () => {
      const parentId = await seedSession({ name: 'Fork Unauth', count: 1 });

      const response = await testClient
        .post(`/api/v1/sessions/${parentId}/fork`)
        .send({});

      expect(response.status).toBe(401);
    });

    test('a user without permission returns 403', async () => {
      const parentId = await seedSession({ name: 'Fork Forbidden', count: 1 });

      const response = await authenticatedTestClient(noPermToken)
        .post(`/api/v1/sessions/${parentId}/fork`)
        .send({});

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/sessions/:session_id/forks', () => {
    test('lists the sessions forked from this one', async () => {
      const parentId = await seedSession({ name: 'Fork List', count: 2 });
      const first = await authenticatedTestClient(userToken)
        .post(`/api/v1/sessions/${parentId}/fork`)
        .send({ name: 'branch a', fork_at_position: 0 });
      const second = await authenticatedTestClient(userToken)
        .post(`/api/v1/sessions/${parentId}/fork`)
        .send({ name: 'branch b' });

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/sessions/${parentId}/forks`
      );

      expect(response.status).toBe(200);
      expect(response.body.total).toBe(2);
      const ids = (response.body.data as Array<{ id: string }>).map((s) => {
        return s.id;
      });
      expect(ids).toContain(first.body.id);
      expect(ids).toContain(second.body.id);
      expect(
        (response.body.data as Array<{ forked_from_session_id: string }>).every(
          (s) => {
            return s.forked_from_session_id === parentId;
          }
        )
      ).toBe(true);
    });

    test('a session with no forks returns an empty page', async () => {
      const parentId = await seedSession({ name: 'Fork Empty', count: 1 });

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/sessions/${parentId}/forks`
      );

      expect(response.status).toBe(200);
      expect(response.body.total).toBe(0);
      expect(response.body.data).toEqual([]);
    });

    test('unknown session returns 404', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/sessions/sess_does_not_exist/forks'
      );

      expect(response.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const parentId = await seedSession({
        name: 'Fork List Unauth',
        count: 1,
      });

      const response = await testClient.get(
        `/api/v1/sessions/${parentId}/forks`
      );

      expect(response.status).toBe(401);
    });

    test('a user without permission returns 403', async () => {
      const parentId = await seedSession({
        name: 'Fork List Forbidden',
        count: 1,
      });

      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/sessions/${parentId}/forks`
      );

      expect(response.status).toBe(403);
    });
  });
});
