import * as agentsModule from '../../../../src/lib/agents';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('Sessions', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectId: string;
  let policyId: string;
  let aiProviderId: string;
  let agentId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'sessadmin', password: 'supersecret' });

    adminToken = await loginAs('sessadmin', 'supersecret');

    const createUserRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'sessuser', password: 'sesspass' });

    userId = createUserRes.body.id;
    userToken = await loginAs('sessuser', 'sesspass');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Sessions Test Project' });
    projectId = projectRes.body.id;

    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: [
                'agents:CreateAgent',
                'agents:CreateSession',
                'agents:ListSessions',
                'agents:GetSession',
                'agents:UpdateSession',
                'agents:DeleteSession',
                'agents:SendSessionMessage',
                'agents:SubmitSessionToolOutputs',
                'agents:ListSessionMessages',
                'documents:GetDocument',
              ],
            },
          ],
        },
      });
    policyId = policyRes.body.id;

    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userId}/policies`)
      .send({ policy_ids: [policyId] });

    const aiProvRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Sessions Test Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    aiProviderId = aiProvRes.body.id;

    const agentRes = await authenticatedTestClient(userToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: aiProviderId,
        name: 'Sessions Test Agent',
      });
    agentId = agentRes.body.id;
  });

  // ── Create Session ─────────────────────────────────────────────────────

  describe('POST /api/v1/agents/:agentId/sessions', () => {
    test('authenticated user can create a session', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({});

      expect(response.status).toBe(201);
      expect(response.body.id).toMatch(/^sess_/);
      expect(response.body.agent_id).toBe(agentId);
      expect(response.body.conversation_id).toMatch(/^conv_/);
      expect(response.body.status).toBe('open');
    });

    test('can create a session with optional fields', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ name: 'Test Session' });

      expect(response.status).toBe(201);
      expect(response.body.name).toBe('Test Session');
      expect(response.body.actor_id).toBeNull();
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({});

      expect(response.status).toBe(401);
    });

    test('invalid agentId returns 404', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/agents/agt_nonexistent/sessions')
        .send({});

      expect(response.status).toBe(404);
    });

    test('can create a session with toolContext', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ tool_context: { user_id: 'u1', env: 'test' } });

      expect(response.status).toBe(201);
      expect(response.body.tool_context).toEqual({
        user_id: 'u1',
        env: 'test',
      });
    });
  });

  // ── List Sessions ──────────────────────────────────────────────────────

  describe('GET /api/v1/agents/:agentId/sessions', () => {
    test('authenticated user can list sessions', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}/sessions`
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThan(0);
    });

    test('can filter by status', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}/sessions?status=open`
      );

      expect(response.status).toBe(200);
      for (const session of response.body.data) {
        expect(session.status).toBe('open');
      }
    });

    test('can filter by actorId', async () => {
      // Create an actor to use for filtering
      const actorRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/actors')
        .send({
          project_id: projectId,
          name: 'filter-test-actor',
          type: 'user',
        });
      const actorId = actorRes.body.id;
      expect(actorId).toMatch(/^actor_/);

      // Create two sessions using that actor
      await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ name: 'actorId filter seed', actor_id: actorId });

      await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ actor_id: actorId });

      // Filter by actorId — all returned sessions must share the same actorId
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}/sessions?actor_id=${actorId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeGreaterThanOrEqual(2);
      for (const session of response.body.data) {
        expect(session.actor_id).toBe(actorId);
      }
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/agents/${agentId}/sessions`
      );

      expect(response.status).toBe(401);
    });
  });

  // ── Get Session ────────────────────────────────────────────────────────

  describe('GET /api/v1/agents/:agentId/sessions/:sessionId', () => {
    let sessionId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ name: 'Get Test Session' });
      sessionId = res.body.id;
    });

    test('authenticated user can get a session', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}/sessions/${sessionId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(sessionId);
      expect(response.body.name).toBe('Get Test Session');
    });

    test('non-existent session returns 404', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}/sessions/sess_nonexistent`
      );

      expect(response.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/agents/${agentId}/sessions/${sessionId}`
      );

      expect(response.status).toBe(401);
    });
  });

  // ── Update Session ─────────────────────────────────────────────────────

  describe('PATCH /api/v1/agents/:agentId/sessions/:sessionId', () => {
    let sessionId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ name: 'Update Test' });
      sessionId = res.body.id;
    });

    test('can update session name', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${agentId}/sessions/${sessionId}`)
        .send({ name: 'Updated Name' });

      expect(response.status).toBe(200);
      expect(response.body.name).toBe('Updated Name');
    });

    test('can close a session', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${agentId}/sessions/${sessionId}`)
        .send({ status: 'closed' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('closed');
    });

    test('can update session toolContext', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${agentId}/sessions/${sessionId}`)
        .send({ tool_context: { env: 'prod' } });

      expect(response.status).toBe(200);
      expect(response.body.tool_context).toEqual({ env: 'prod' });
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .patch(`/api/v1/agents/${agentId}/sessions/${sessionId}`)
        .send({ name: 'Nope' });

      expect(response.status).toBe(401);
    });
  });

  // ── Delete Session ─────────────────────────────────────────────────────

  describe('DELETE /api/v1/agents/:agentId/sessions/:sessionId', () => {
    let sessionId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ name: 'Delete Test' });
      sessionId = res.body.id;
    });

    test('can delete a session', async () => {
      const response = await authenticatedTestClient(userToken).delete(
        `/api/v1/agents/${agentId}/sessions/${sessionId}`
      );

      expect(response.status).toBe(204);
    });

    test('deleted session returns 404', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}/sessions/${sessionId}`
      );

      expect(response.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.delete(
        `/api/v1/agents/${agentId}/sessions/sess_doesnotmatter`
      );

      expect(response.status).toBe(401);
    });
  });

  // ── List Messages ──────────────────────────────────────────────────────

  describe('GET /api/v1/agents/:agentId/sessions/:sessionId/messages', () => {
    let sessionId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ name: 'Messages Test' });
      sessionId = res.body.id;
    });

    test('returns empty messages for new session', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}/sessions/${sessionId}/messages`
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBe(0);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/agents/${agentId}/sessions/${sessionId}/messages`
      );

      expect(response.status).toBe(401);
    });

    test('non-existent session returns 404', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}/sessions/sess_doesnotexist/messages`
      );

      expect(response.status).toBe(404);
    });

    test('regression: RESOURCE_NOT_FOUND when session_id belongs to a different agent (no nested error.error)', async () => {
      // Create a second agent in the same project
      const agent2Res = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'Sessions Test Agent 2',
        });
      const agent2Id = agent2Res.body.id;

      // Create a session for the FIRST agent
      const sessRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ name: 'Cross-Agent Session' });
      const crossSessionId = sessRes.body.id;

      // Access the first agent's session through the SECOND agent's route
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agent2Id}/sessions/${crossSessionId}/messages`
      );

      expect(response.status).toBe(404);
      // The error must be a structured object — not a nested error.error payload
      expect(typeof response.body.error).toBe('object');
      expect(response.body.error.code).toBe('RESOURCE_NOT_FOUND');
      expect(typeof response.body.error.message).toBe('string');
    });
  });

  // ── Add Session Message ────────────────────────────────────────────────

  describe('POST /api/v1/agents/:agentId/sessions/:sessionId/messages', () => {
    let sessionId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ name: 'Add Message Test' });
      sessionId = res.body.id;
    });

    test('saves user message and returns 201', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions/${sessionId}/messages`)
        .send({ message: 'Hello from test' });

      expect(response.status).toBe(201);
      expect(response.body.role).toBe('user');
      expect(response.body.content).toBe('Hello from test');
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post(`/api/v1/agents/${agentId}/sessions/${sessionId}/messages`)
        .send({ message: 'Hello' });

      expect(response.status).toBe(401);
    });

    test('unknown session returns 404', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions/sess_doesnotexist/messages`)
        .send({ message: 'Hello' });

      expect(response.status).toBe(404);
    });

    test('accepts per-request toolContext', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions/${sessionId}/messages`)
        .send({ message: 'Hi', tool_context: { req_key: 'val' } });

      expect(response.status).toBe(201);
    });

    test('accepts document_id and stores document-backed user message', async () => {
      const createDocumentRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/documents')
        .send({
          project_id: projectId,
          content: 'Document content for session input',
          filename: 'session-input.txt',
        });

      expect(createDocumentRes.status).toBe(201);

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions/${sessionId}/messages`)
        .send({ document_id: createDocumentRes.body.id });

      expect(response.status).toBe(201);
      expect(response.body.role).toBe('user');
      expect(response.body.content).toBe('Document content for session input');
      expect(response.body.document_id).toBe(createDocumentRes.body.id);
    });

    test('missing message body returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions/${sessionId}/messages`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.message).toMatch(/message/);
    });

    describe('idempotency_key', () => {
      test('first call with idempotency_key returns 201', async () => {
        const response = await authenticatedTestClient(userToken)
          .post(`/api/v1/agents/${agentId}/sessions/${sessionId}/messages`)
          .send({ message: 'Idempotent message', idempotency_key: 'idem-key-1' });

        expect(response.status).toBe(201);
        expect(response.body.role).toBe('user');
        expect(response.body.content).toBe('Idempotent message');
      });

      test('duplicate call with same idempotency_key returns 200 with original message', async () => {
        const key = 'idem-key-dup-' + Date.now();

        const first = await authenticatedTestClient(userToken)
          .post(`/api/v1/agents/${agentId}/sessions/${sessionId}/messages`)
          .send({ message: 'Original message', idempotency_key: key });

        expect(first.status).toBe(201);

        const second = await authenticatedTestClient(userToken)
          .post(`/api/v1/agents/${agentId}/sessions/${sessionId}/messages`)
          .send({ message: 'Different message', idempotency_key: key });

        expect(second.status).toBe(200);
        expect(second.body.role).toBe('user');
        expect(second.body.content).toBe('Original message');
      });

      test('same idempotency_key in different sessions is allowed', async () => {
        const key = 'idem-key-cross-session-' + Date.now();

        const sessionRes = await authenticatedTestClient(userToken)
          .post(`/api/v1/agents/${agentId}/sessions`)
          .send({ name: 'Second session for idempotency test' });
        const secondSessionId = sessionRes.body.id;

        const first = await authenticatedTestClient(userToken)
          .post(`/api/v1/agents/${agentId}/sessions/${sessionId}/messages`)
          .send({ message: 'Session 1 message', idempotency_key: key });

        expect(first.status).toBe(201);

        const second = await authenticatedTestClient(userToken)
          .post(`/api/v1/agents/${agentId}/sessions/${secondSessionId}/messages`)
          .send({ message: 'Session 2 message', idempotency_key: key });

        expect(second.status).toBe(201);
        expect(second.body.content).toBe('Session 2 message');
      });
    });
  });

  // ── Generate Session Response ──────────────────────────────────────────

  describe('POST /api/v1/agents/:agentId/sessions/:sessionId/generate', () => {
    let sessionId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ name: 'Generate Test' });
      sessionId = res.body.id;
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.post(
        `/api/v1/agents/${agentId}/sessions/${sessionId}/generate`
      );

      expect(response.status).toBe(401);
    });

    test('unknown session returns 404', async () => {
      const response = await authenticatedTestClient(userToken).post(
        `/api/v1/agents/${agentId}/sessions/sess_doesnotexist/generate`
      );

      expect(response.status).toBe(404);
    });

    test('async mode returns 202 accepted', async () => {
      // Add a message first so there is something to generate from
      await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions/${sessionId}/messages`)
        .send({ message: 'Tell me about deployment' });

      const response = await authenticatedTestClient(userToken).post(
        `/api/v1/agents/${agentId}/sessions/${sessionId}/generate?async=true`
      );

      expect(response.status).toBe(202);
      expect(response.body.status).toBe('accepted');
      expect(response.body.session_id).toBe(sessionId);
    });

    test('accepts per-request toolContext in async mode', async () => {
      await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions/${sessionId}/messages`)
        .send({ message: 'Another message' });

      const response = await authenticatedTestClient(userToken)
        .post(
          `/api/v1/agents/${agentId}/sessions/${sessionId}/generate?async=true`
        )
        .send({ tool_context: { req_key: 'val' } });

      expect(response.status).toBe(202);
    });
  });

  // ── Tags ───────────────────────────────────────────────────────────────

  describe('Session Tags', () => {
    let sessionId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ name: 'Tags Test' });
      sessionId = res.body.id;
    });

    test('GET tags returns empty object for new session', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}/sessions/${sessionId}/tags`
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({});
    });

    test('PUT replaces all tags', async () => {
      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agentId}/sessions/${sessionId}/tags`)
        .send({ env: 'production', priority: 'high' });

      expect(response.status).toBe(200);
      expect(response.body.env).toBe('production');
      expect(response.body.priority).toBe('high');
    });

    test('PATCH merges tags', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${agentId}/sessions/${sessionId}/tags`)
        .send({ team: 'support' });

      expect(response.status).toBe(200);
      expect(response.body.env).toBe('production');
      expect(response.body.team).toBe('support');
    });

    test('GET tags returns 404 for non-existent session', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}/sessions/sess_nonexistent/tags`
      );

      expect(response.status).toBe(404);
    });

    test('PUT tags returns 404 for non-existent session', async () => {
      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/agents/${agentId}/sessions/sess_nonexistent/tags`)
        .send({ env: 'test' });

      expect(response.status).toBe(404);
    });

    test('PATCH tags returns 404 for non-existent session', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${agentId}/sessions/sess_nonexistent/tags`)
        .send({ env: 'test' });

      expect(response.status).toBe(404);
    });
  });

  // ── Context window limiting ───────────────────────────────────────────

  describe('Context window limiting', () => {
    let contextAgentId: string;
    let contextSessionId: string;

    beforeAll(async () => {
      const agentRes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'Context Limit Agent',
          max_context_messages: 2,
        });
      contextAgentId = agentRes.body.id;

      const sessionRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${contextAgentId}/sessions`)
        .send({ name: 'Context Limit Test' });
      contextSessionId = sessionRes.body.id;

      for (let i = 1; i <= 4; i++) {
        await authenticatedTestClient(userToken)
          .post(
            `/api/v1/agents/${contextAgentId}/sessions/${contextSessionId}/messages`
          )
          .send({ message: `Message ${i}` });
      }
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    test('generation sends only the last max_context_messages messages to the model', async () => {
      mockCreateGeneration.mockResolvedValueOnce({
        id: 'gen_ctx_01',
        traceId: 'trc_ctx_01',
        status: 'completed',
        output: { model: 'test-model', content: 'Reply', finishReason: 'stop' },
      });

      const response = await authenticatedTestClient(userToken).post(
        `/api/v1/agents/${contextAgentId}/sessions/${contextSessionId}/generate`
      );

      expect(response.status).toBe(200);
      expect(mockCreateGeneration).toHaveBeenCalledTimes(1);

      const callArgs = mockCreateGeneration.mock.calls[0][0] as {
        messages: Array<{ role: string; content: string }>;
      };
      const nonSystemMessages = callArgs.messages.filter((m) => {
        return m.role !== 'system';
      });
      expect(nonSystemMessages).toHaveLength(2);
      expect(nonSystemMessages[0].content).toContain('Message 3');
      expect(nonSystemMessages[1].content).toContain('Message 4');
    });
  });

  // ── Permission checks ─────────────────────────────────────────────────

  describe('Permission enforcement', () => {
    let unprivilegedToken: string;

    beforeAll(async () => {
      // User with no policies has no access to project resources
      const _res = await authenticatedTestClient(adminToken)
        .post('/api/v1/users')
        .send({ username: 'sessnoperm', password: 'sessnopass' });

      unprivilegedToken = await loginAs('sessnoperm', 'sessnopass');
    });

    test('user without CreateSession permission returns 403', async () => {
      const response = await authenticatedTestClient(unprivilegedToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({});

      expect(response.status).toBe(403);
    });

    test('user without ListSessions permission returns 403', async () => {
      const response = await authenticatedTestClient(unprivilegedToken).get(
        `/api/v1/agents/${agentId}/sessions`
      );

      expect(response.status).toBe(403);
    });
  });

  // ── Message ordering with concurrent writes ─────────────────────────────

  describe('Message ordering with concurrent writes', () => {
    let resolveGeneration: (() => void) | undefined;
    let orderingSessionId: string;

    beforeEach(async () => {
      jest.useRealTimers();
      resolveGeneration = undefined;

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ name: 'ordering-test' });
      orderingSessionId = res.body.id;

      mockCreateGeneration.mockImplementationOnce(() => {
        return new Promise((resolve) => {
          resolveGeneration = () => {
            return resolve({
              id: 'gen_test_01',
              traceId: 'trc_test_01',
              status: 'completed',
              output: {
                model: 'test-model',
                content: 'Hi there',
                finishReason: 'stop',
              },
            });
          };
        });
      });
    });

    afterEach(() => {
      jest.clearAllMocks();
      jest.useFakeTimers({ advanceTimers: true });
    });

    test('assistant reply is inserted at snapshotPosition+1, not after concurrent user message', async () => {
      // 1. Add initial user message → position 0
      await authenticatedTestClient(userToken)
        .post(
          `/api/v1/agents/${agentId}/sessions/${orderingSessionId}/messages`
        )
        .send({ message: 'Hello' })
        .expect(201);

      // 2. Trigger async generation (returns 202, background task starts)
      await authenticatedTestClient(userToken)
        .post(
          `/api/v1/agents/${agentId}/sessions/${orderingSessionId}/generate?async=true`
        )
        .expect(202);

      // 3. Poll until the mock has been entered (resolveGeneration is assigned)
      const mockDeadline = Date.now() + 5000;
      await new Promise<void>((resolve, reject) => {
        const check = () => {
          if (resolveGeneration) return resolve();
          if (Date.now() >= mockDeadline)
            return reject(
              new Error('Timeout: createGeneration mock was never invoked')
            );
          setImmediate(check);
        };
        setImmediate(check);
      });

      // 4. Insert concurrent user message while LLM is paused
      await authenticatedTestClient(userToken)
        .post(
          `/api/v1/agents/${agentId}/sessions/${orderingSessionId}/messages`
        )
        .send({ message: 'Follow-up?' })
        .expect(201);

      // 5. Unblock the LLM mock → generation completes
      resolveGeneration!();

      // 6. Poll until generation is done (generatingAt becomes falsy)
      const doneDeadline = Date.now() + 5000;
      await new Promise<void>((resolve, reject) => {
        const poll = async () => {
          if (Date.now() >= doneDeadline)
            return reject(
              new Error('Timeout waiting for generation to complete')
            );
          const s = await authenticatedTestClient(userToken).get(
            `/api/v1/agents/${agentId}/sessions/${orderingSessionId}`
          );
          if (!s.body.generating_at) return resolve();
          setTimeout(poll, 50);
        };
        setTimeout(poll, 50);
      });

      // 7. Fetch messages ordered by position ASC
      const msgsRes = await authenticatedTestClient(userToken)
        .get(`/api/v1/agents/${agentId}/sessions/${orderingSessionId}/messages`)
        .expect(200);

      const messages: Array<{
        role: string;
        content: string;
        position: number;
      }> = msgsRes.body.data;

      // The fix guarantees: assistant is at position 1 (snapshotPosition+1),
      // not pushed to position 2 by the concurrent user message
      expect(messages).toHaveLength(3);
      expect(messages[0]).toMatchObject({
        role: 'user',
        content: 'Hello',
        position: 0,
      });
      expect(messages[1]).toMatchObject({
        role: 'assistant',
        content: 'Hi there',
        position: 1,
      });
      expect(messages[2]).toMatchObject({
        role: 'user',
        content: 'Follow-up?',
        position: 2,
      });
    });
  });

  // ── Cancel-previous generation ─────────────────────────────────────────

  describe('Cancel-previous generation', () => {
    let cancelSessionId: string;

    beforeEach(async () => {
      jest.useRealTimers();

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ name: 'cancel-previous-test' });
      cancelSessionId = res.body.id;

      // Add a message so there's something to generate from
      await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions/${cancelSessionId}/messages`)
        .send({ message: 'Initial message' });
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    test('second generate request aborts in-flight generation and starts a new one', async () => {
      let firstAborted = false;
      let signalFirstStarted!: () => void;
      const firstStarted = new Promise<void>((r) => {
        signalFirstStarted = r;
      });

      // First call: blocks until the abort signal fires
      mockCreateGeneration.mockImplementationOnce((args) => {
        return new Promise((_, reject) => {
          signalFirstStarted();
          args.abortSignal?.addEventListener('abort', () => {
            firstAborted = true;
            reject(
              Object.assign(new Error('The operation was aborted'), {
                name: 'AbortError',
              })
            );
          });
        });
      });

      // Second call: resolves immediately to simulate a successful generation
      mockCreateGeneration.mockImplementationOnce(() => {
        return Promise.resolve({
          id: 'gen_cancel_02',
          traceId: 'trc_cancel_02',
          status: 'completed',
          output: {
            model: 'test-model',
            content: 'Second reply',
            finishReason: 'stop',
          },
        });
      });

      // Start first generation (async, fire-and-forget)
      await authenticatedTestClient(userToken)
        .post(
          `/api/v1/agents/${agentId}/sessions/${cancelSessionId}/generate?async=true`
        )
        .expect(202);

      // Wait until the first mock has started (generatingAt is set in DB)
      await firstStarted;

      // Trigger second generation — should cancel the first and start fresh
      const secondRes = await authenticatedTestClient(userToken).post(
        `/api/v1/agents/${agentId}/sessions/${cancelSessionId}/generate?async=true`
      );
      expect(secondRes.status).toBe(202);

      // Poll until the abort propagates to the first mock's listener
      const deadline = Date.now() + 5000;
      await new Promise<void>((resolve, reject) => {
        const check = () => {
          if (firstAborted) return resolve();
          if (Date.now() >= deadline)
            return reject(
              new Error('Timeout: first generation was never aborted')
            );
          setImmediate(check);
        };
        setImmediate(check);
      });

      expect(firstAborted).toBe(true);
    });

    test('controller is removed from map after successful generation', async () => {
      mockCreateGeneration.mockResolvedValueOnce({
        id: 'gen_cleanup_01',
        traceId: 'trc_cleanup_01',
        status: 'completed',
        output: { model: 'test-model', content: 'Done', finishReason: 'stop' },
      });

      // Sync generate — waits for completion
      const res = await authenticatedTestClient(userToken).post(
        `/api/v1/agents/${agentId}/sessions/${cancelSessionId}/generate`
      );
      expect(res.status).toBe(200);

      // generating_at should be cleared, meaning the controller was removed
      const sessionRes = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}/sessions/${cancelSessionId}`
      );
      expect(sessionRes.body.generating_at).toBeNull();

      // A subsequent generate should NOT return 409 (controller was cleaned up)
      mockCreateGeneration.mockResolvedValueOnce({
        id: 'gen_cleanup_02',
        traceId: 'trc_cleanup_02',
        status: 'completed',
        output: {
          model: 'test-model',
          content: 'Second',
          finishReason: 'stop',
        },
      });

      const secondRes = await authenticatedTestClient(userToken).post(
        `/api/v1/agents/${agentId}/sessions/${cancelSessionId}/generate`
      );
      expect(secondRes.status).toBe(200);
    });

    test('controller is removed from map after generation error', async () => {
      // Simulate createGeneration throwing a non-abort error
      mockCreateGeneration.mockRejectedValueOnce(
        new Error('Simulated LLM error')
      );

      const res = await authenticatedTestClient(userToken).post(
        `/api/v1/agents/${agentId}/sessions/${cancelSessionId}/generate`
      );
      // The error propagates as a 500
      expect(res.status).toBe(500);

      // generating_at should be cleared even after an error
      const sessionRes = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}/sessions/${cancelSessionId}`
      );
      expect(sessionRes.body.generating_at).toBeNull();

      // A subsequent generate should work normally (no stale controller)
      mockCreateGeneration.mockResolvedValueOnce({
        id: 'gen_after_err_01',
        traceId: 'trc_after_err_01',
        status: 'completed',
        output: {
          model: 'test-model',
          content: 'Recovery',
          finishReason: 'stop',
        },
      });

      const recoveryRes = await authenticatedTestClient(userToken).post(
        `/api/v1/agents/${agentId}/sessions/${cancelSessionId}/generate`
      );
      expect(recoveryRes.status).toBe(200);
    });
  });

  describe('autoGenerate', () => {
    let autoSessionId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ auto_generate: true });
      autoSessionId = res.body.id;
    });

    beforeEach(() => {
      jest.useRealTimers();
    });

    test('create session with autoGenerate returns autoGenerate: true', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}/sessions/${autoSessionId}`
      );
      expect(res.status).toBe(200);
      expect(res.body.auto_generate).toBe(true);
    });

    test('PATCH session toggles autoGenerate', async () => {
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${agentId}/sessions/${autoSessionId}`)
        .send({ auto_generate: false });
      expect(res.status).toBe(200);
      expect(res.body.auto_generate).toBe(false);

      // restore
      await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${agentId}/sessions/${autoSessionId}`)
        .send({ auto_generate: true });
    });

    describe('POST /messages with autoGenerate=true (idle session)', () => {
      let resolveGeneration: (() => void) | undefined;
      let generationStarted: Promise<void>;
      let signalGenerationStarted: () => void;

      beforeEach(() => {
        generationStarted = new Promise<void>((r) => {
          signalGenerationStarted = r;
        });
        mockCreateGeneration.mockImplementationOnce(() => {
          return new Promise((resolve) => {
            signalGenerationStarted();
            resolveGeneration = () => {
              return resolve({
                id: 'gen_auto_01',
                traceId: 'trc_auto_01',
                status: 'completed',
                output: {
                  model: 'test-model',
                  content: 'Auto reply',
                  finishReason: 'stop',
                },
              });
            };
          });
        });
      });

      afterEach(() => {
        jest.clearAllMocks();
      });

      test('triggers generation and returns generation result', async () => {
        // Ensure session is idle (no generatingAt)
        const sessionRes = await authenticatedTestClient(userToken).get(
          `/api/v1/agents/${agentId}/sessions/${autoSessionId}`
        );
        expect(sessionRes.body.generating_at).toBeNull();

        // Calling .then() immediately starts the HTTP request without waiting for
        // the response, so the server begins processing and eventually calls
        // createGeneration — necessary before we can await generationStarted.
        const messagePromise = authenticatedTestClient(userToken)
          .post(`/api/v1/agents/${agentId}/sessions/${autoSessionId}/messages`)
          .send({ message: 'Trigger auto-gen' })
          .then((r) => {
            return r;
          });

        // Wait for mock to be entered using Promise signaling (timer-independent)
        await generationStarted;
        resolveGeneration!();

        const res = await messagePromise;
        expect(res.status).toBe(201);
        // When autoGenerate fires, response should have generation fields
        expect(res.body).toHaveProperty('generation_id');
        expect(res.body.status).toBe('completed');
      });
    });

    describe('POST /messages with autoGenerate=true but busy session', () => {
      let busySessionId: string;

      beforeAll(async () => {
        const res = await authenticatedTestClient(userToken)
          .post(`/api/v1/agents/${agentId}/sessions`)
          .send({ auto_generate: true });
        busySessionId = res.body.id;
      });

      afterEach(() => {
        jest.clearAllMocks();
      });

      test('returns saved user message when generation is already in progress', async () => {
        let signalGenerationStarted!: () => void;
        const generationStarted = new Promise<void>((r) => {
          signalGenerationStarted = r;
        });

        mockCreateGeneration.mockImplementation(() => {
          return new Promise(() => {
            // Signal that createGeneration was called (generatingAt is already
            // set in DB before this point), then never resolve to keep session busy
            signalGenerationStarted();
          });
        });

        // Trigger async generation to set generatingAt in the background
        await authenticatedTestClient(userToken)
          .post(
            `/api/v1/agents/${agentId}/sessions/${busySessionId}/generate?async=true`
          )
          .expect(202);

        // Wait for createGeneration to be called via Promise signaling (timer-independent).
        // By the time createGeneration is called, generatingAt is already set in DB.
        await generationStarted;

        // Now add a message while generation is in progress
        const res = await authenticatedTestClient(userToken)
          .post(`/api/v1/agents/${agentId}/sessions/${busySessionId}/messages`)
          .send({ message: 'Message while busy' });

        expect(res.status).toBe(201);
        expect(res.body.role).toBe('user');
        expect(res.body.content).toBe('Message while busy');
      });
    });
  });

  // ── Tool Outputs ─────────────────────────────────────────────────────────

  describe('POST /api/v1/agents/:agentId/sessions/:sessionId/tool-outputs', () => {
    let sessionId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ name: 'Tool Outputs Test' });
      sessionId = res.body.id;
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post(`/api/v1/agents/${agentId}/sessions/${sessionId}/tool-outputs`)
        .send({
          generationId: 'gen_1',
          toolOutputs: [{ toolCallId: 'tc_1', output: 'result' }],
        });

      expect(response.status).toBe(401);
    });

    test('missing generationId returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions/${sessionId}/tool-outputs`)
        .send({ toolOutputs: [{ toolCallId: 'tc_1', output: 'result' }] });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toMatch(/generationId/);
    });

    test('missing toolOutputs returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions/${sessionId}/tool-outputs`)
        .send({ generationId: 'gen_test_001' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('empty toolOutputs array returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions/${sessionId}/tool-outputs`)
        .send({ generationId: 'gen_test_001', toolOutputs: [] });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });
  });

  // ── Sync Generate ─────────────────────────────────────────────────────────

  describe('POST /api/v1/agents/:agentId/sessions/:sessionId/generate - sync', () => {
    let syncSessionId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ name: 'Sync Generate Test' });
      syncSessionId = res.body.id;

      await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions/${syncSessionId}/messages`)
        .send({ message: 'Hello sync' });
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    test('sync generate returns 200 with generation result when successful', async () => {
      mockCreateGeneration.mockResolvedValueOnce({
        id: 'gen_sync_test',
        traceId: 'trc_sync_test',
        status: 'completed',
        output: {
          model: 'test-model',
          content: 'Sync response',
          finishReason: 'stop',
        },
      });

      const response = await authenticatedTestClient(userToken).post(
        `/api/v1/agents/${agentId}/sessions/${syncSessionId}/generate`
      );

      expect(response.status).toBe(200);
      expect(response.body).toBeDefined();
    });
  });

  // ── Generate - requires_action ────────────────────────────────────────────

  describe('POST /api/v1/agents/:agentId/sessions/:sessionId/generate - requires_action', () => {
    let sessionId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ name: 'Requires Action Test' });
      sessionId = res.body.id;

      await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions/${sessionId}/messages`)
        .send({ message: 'Use a tool' });
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    test('returns requires_action when generation needs tool outputs', async () => {
      mockCreateGeneration.mockResolvedValueOnce({
        id: 'gen_req_action_01',
        traceId: 'trc_req_action_01',
        status: 'requires_action',
        requiredAction: {
          type: 'submit_tool_outputs' as const,
          toolCalls: [
            {
              id: 'tc_req_001',
              toolName: 'get_weather',
              args: { location: 'Paris' },
            },
          ],
        },
      });

      const response = await authenticatedTestClient(userToken).post(
        `/api/v1/agents/${agentId}/sessions/${sessionId}/generate`
      );

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('requires_action');
      expect(response.body.generation_id).toBe('gen_req_action_01');
      expect(response.body.required_action).toBeDefined();
    });
  });

  // ── Tool Outputs - execution paths ────────────────────────────────────────

  describe('POST /api/v1/agents/:agentId/sessions/:sessionId/tool-outputs - execution', () => {
    let sessionId: string;
    let submitToolOutputsSpy: jest.SpiedFunction<
      typeof agentsModule.submitToolOutputs
    >;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ name: 'Tool Outputs Exec Test' });
      sessionId = res.body.id;
    });

    beforeEach(() => {
      submitToolOutputsSpy = jest.spyOn(agentsModule, 'submitToolOutputs');
    });

    afterEach(() => {
      submitToolOutputsSpy.mockRestore();
      jest.clearAllMocks();
    });

    test('returns 404 when generationId does not exist in pending generations', async () => {
      // submitToolOutputs checks pendingGenerations map; an unknown generationId
      // returns 'generation_not_found', exercising submitSessionToolOutputs and
      // fetchSessionAndConversationActors.
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions/${sessionId}/tool-outputs`)
        .send({
          generationId: 'gen_nonexistent_tooltest_001',
          toolOutputs: [{ toolCallId: 'tc_1', output: 'some result' }],
        });

      expect(response.status).toBe(404);
      expect(response.body.error.message).toMatch(/generation/i);
    });

    test('returns 404 when session does not exist', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(
          `/api/v1/agents/${agentId}/sessions/sess_doesnotexist000/tool-outputs`
        )
        .send({
          generationId: 'gen_any_001',
          toolOutputs: [{ toolCallId: 'tc_1', output: 'result' }],
        });

      expect(response.status).toBe(404);
      expect(response.body.error).toBeDefined();
    });

    test('returns completed result and persists the assistant reply', async () => {
      submitToolOutputsSpy.mockResolvedValueOnce({
        id: 'gen_submit_done_01',
        traceId: 'trc_submit_done_01',
        status: 'completed',
        output: {
          model: 'test-model',
          content: 'Weather in Paris: 18C',
          finishReason: 'stop',
        },
      });

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions/${sessionId}/tool-outputs`)
        .send({
          generationId: 'gen_submit_done_01',
          toolOutputs: [
            { toolCallId: 'tc_done_01', output: { city: 'Paris' } },
          ],
        });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('completed');
      expect(response.body.generation_id).toBe('gen_submit_done_01');
      expect(response.body.message.content).toBe('Weather in Paris: 18C');

      const messagesResponse = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}/sessions/${sessionId}/messages`
      );

      expect(messagesResponse.status).toBe(200);
      expect(messagesResponse.body.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'assistant',
            content: 'Weather in Paris: 18C',
          }),
        ])
      );
    });

    test('returns requires_action result when more tool outputs are needed', async () => {
      submitToolOutputsSpy.mockResolvedValueOnce({
        id: 'gen_submit_req_01',
        traceId: 'trc_submit_req_01',
        status: 'requires_action',
        requiredAction: {
          type: 'submit_tool_outputs',
          toolCalls: [
            {
              id: 'tc_req_followup_01',
              toolName: 'get_forecast',
              args: { location: 'Paris' },
            },
          ],
        },
      });

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions/${sessionId}/tool-outputs`)
        .send({
          generationId: 'gen_submit_req_01',
          toolOutputs: [{ toolCallId: 'tc_req_01', output: 'partial result' }],
        });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('requires_action');
      expect(response.body.generation_id).toBe('gen_submit_req_01');
      expect(response.body.required_action).toEqual(
        expect.objectContaining({
          type: 'submit_tool_outputs',
        })
      );
    });
  });

  // ── Session with pre-existing actor (bug regression) ─────────────────────

  describe('Session created with pre-existing actor_id', () => {
    let preExistingActorId: string;
    let sessionWithActorId: string;

    beforeAll(async () => {
      // Create a human actor explicitly (adminToken has all permissions)
      const actorRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/actors')
        .send({ project_id: projectId, name: 'Pedro', type: 'human' });
      expect(actorRes.status).toBe(201);
      preExistingActorId = actorRes.body.id;

      // Create a session using the pre-existing actor
      const sessionRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ actor_id: preExistingActorId, auto_generate: false });
      expect(sessionRes.status).toBe(201);
      sessionWithActorId = sessionRes.body.id;
      expect(sessionRes.body.actor_id).toBe(preExistingActorId);
    });

    test('adding a message to a session with pre-existing actor returns 201', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(
          `/api/v1/agents/${agentId}/sessions/${sessionWithActorId}/messages`
        )
        .send({ message: 'olá, tudo bem?' });

      expect(response.status).toBe(201);
      expect(response.body.role).toBe('user');
      expect(response.body.content).toBe('olá, tudo bem?');
    });

    test('delete session with pre-existing actor does not delete the actor', async () => {
      // Create a second session reusing the same actor to verify it is not
      // deleted when the first session is deleted.
      const secondSessionRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ actor_id: preExistingActorId });
      expect(secondSessionRes.status).toBe(201);
      const secondSessionId = secondSessionRes.body.id;

      // Deleting the first session must not delete the pre-existing actor
      // (which is still referenced by the second session).
      const deleteRes = await authenticatedTestClient(userToken).delete(
        `/api/v1/agents/${agentId}/sessions/${sessionWithActorId}`
      );
      expect(deleteRes.status).toBe(204);

      // Second session must still be usable — the actor was not deleted.
      const msgRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions/${secondSessionId}/messages`)
        .send({ message: 'still works?' });
      expect(msgRes.status).toBe(201);

      // Clean up the second session
      await authenticatedTestClient(userToken).delete(
        `/api/v1/agents/${agentId}/sessions/${secondSessionId}`
      );
    });
  });

  // ── buildToolContext: actor keys in generation toolContext ────────────────

  describe('actor context keys in generation toolContext', () => {
    let noActorSessionId: string;
    let withActorSessionId: string;
    let testActorId: string;
    const testActorExternalId = '+15559876543';

    beforeAll(async () => {
      // Session without an actor
      const noActorRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ name: 'No Actor Context Test' });
      noActorSessionId = noActorRes.body.id;

      await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions/${noActorSessionId}/messages`)
        .send({ message: 'test message' });

      // Create an actor with an external ID, then a session using it
      const actorRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/actors')
        .send({
          project_id: projectId,
          name: 'Context Test Actor',
          external_id: testActorExternalId,
          type: 'human',
        });
      expect(actorRes.status).toBe(201);
      testActorId = actorRes.body.id;

      const withActorRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ name: 'With Actor Context Test', actor_id: testActorId });
      withActorSessionId = withActorRes.body.id;

      await authenticatedTestClient(userToken)
        .post(
          `/api/v1/agents/${agentId}/sessions/${withActorSessionId}/messages`
        )
        .send({ message: 'test message with actor' });
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    test('actorId and actorExternalId are omitted from toolContext when session has no actor', async () => {
      mockCreateGeneration.mockResolvedValueOnce({
        id: 'gen_no_actor_ctx_01',
        traceId: 'trc_no_actor_ctx_01',
        status: 'completed',
        output: {
          model: 'test-model',
          content: 'Reply without actor',
          finishReason: 'stop',
        },
      });

      const response = await authenticatedTestClient(userToken).post(
        `/api/v1/agents/${agentId}/sessions/${noActorSessionId}/generate`
      );

      expect(response.status).toBe(200);
      expect(mockCreateGeneration).toHaveBeenCalledTimes(1);

      const callArgs = mockCreateGeneration.mock.calls[0][0] as {
        toolContext?: Record<string, string>;
      };
      expect(callArgs.toolContext).toBeDefined();
      // sessionId is always present
      expect(callArgs.toolContext).toHaveProperty('sessionId');
      // actor keys must be absent (not empty strings) when no actor is set
      expect(callArgs.toolContext).not.toHaveProperty('actorId');
      expect(callArgs.toolContext).not.toHaveProperty('actorExternalId');
    });

    test('actorId and actorExternalId are populated in toolContext when session has an actor', async () => {
      mockCreateGeneration.mockResolvedValueOnce({
        id: 'gen_with_actor_ctx_01',
        traceId: 'trc_with_actor_ctx_01',
        status: 'completed',
        output: {
          model: 'test-model',
          content: 'Reply with actor',
          finishReason: 'stop',
        },
      });

      const response = await authenticatedTestClient(userToken).post(
        `/api/v1/agents/${agentId}/sessions/${withActorSessionId}/generate`
      );

      expect(response.status).toBe(200);
      expect(mockCreateGeneration).toHaveBeenCalledTimes(1);

      const callArgs = mockCreateGeneration.mock.calls[0][0] as {
        toolContext?: Record<string, string>;
      };
      expect(callArgs.toolContext).toBeDefined();
      expect(callArgs.toolContext).toHaveProperty('sessionId');
      expect(callArgs.toolContext).toHaveProperty('actorId', testActorId);
      expect(callArgs.toolContext).toHaveProperty(
        'actorExternalId',
        testActorExternalId
      );
    });
  });

  // ── Inactivity TTL ─────────────────────────────────────────────────────

  describe('inactivity TTL', () => {
    test('can create a session with inactivity_ttl_seconds', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ inactivity_ttl_seconds: 300 });

      expect(response.status).toBe(201);
      expect(response.body.inactivity_ttl_seconds).toBe(300);
    });

    test('inactivity_ttl_seconds defaults to 0 (never expires)', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({});

      expect(response.status).toBe(201);
      expect(response.body.inactivity_ttl_seconds).toBe(0);
    });

    test('generate returns SESSION_EXPIRED when TTL has elapsed', async () => {
      // Create a session with a very short TTL (1 second)
      const sessionRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ inactivity_ttl_seconds: 1 });
      expect(sessionRes.status).toBe(201);
      const sessionId = sessionRes.body.id;

      // Add a message to start the inactivity clock
      await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions/${sessionId}/messages`)
        .send({ message: 'hello' });

      // Wait for TTL to elapse
      await new Promise((resolve) => {
        return setTimeout(resolve, 1500);
      });

      // Generate should fail with SESSION_EXPIRED
      const genRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions/${sessionId}/generate`)
        .send({});

      expect(genRes.status).toBe(410);
      expect(genRes.body.error.code).toBe('SESSION_EXPIRED');
    });

    test('generate succeeds when within TTL window', async () => {
      mockCreateGeneration.mockResolvedValueOnce({
        id: 'gen_ttl_ok',
        traceId: 'trc_ttl_ok',
        status: 'completed',
        output: {
          model: 'test-model',
          content: 'hello',
          finishReason: 'stop',
        },
      });

      const sessionRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ inactivity_ttl_seconds: 60 });
      expect(sessionRes.status).toBe(201);
      const sessionId = sessionRes.body.id;

      await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions/${sessionId}/messages`)
        .send({ message: 'hello' });

      const genRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions/${sessionId}/generate`)
        .send({});

      expect(genRes.status).toBe(200);
    });

    test('expired session is excluded from ?status=open', async () => {
      const sessionRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ inactivity_ttl_seconds: 1 });
      expect(sessionRes.status).toBe(201);
      const expiredId = sessionRes.body.id;

      await new Promise((resolve) => {
        return setTimeout(resolve, 1500);
      });

      // Trigger lazy expiry via GET
      const getRes = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}/sessions/${expiredId}`
      );
      expect(getRes.status).toBe(200);
      expect(getRes.body.status).toBe('expired');

      // Must not appear in ?status=open
      const listOpen = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}/sessions?status=open`
      );
      expect(listOpen.status).toBe(200);
      const openIds = listOpen.body.data.map((s: { id: string }) => {
        return s.id;
      });
      expect(openIds).not.toContain(expiredId);

      // Must appear in ?status=expired
      const listExpired = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}/sessions?status=expired`
      );
      expect(listExpired.status).toBe(200);
      const expiredIds = listExpired.body.data.map((s: { id: string }) => {
        return s.id;
      });
      expect(expiredIds).toContain(expiredId);
    });

    test('listSessions lazily expires rows before returning', async () => {
      const sessionRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ inactivity_ttl_seconds: 1 });
      expect(sessionRes.status).toBe(201);
      const lazyId = sessionRes.body.id;

      await new Promise((resolve) => {
        return setTimeout(resolve, 1500);
      });

      // Trigger expiry via list (no single GET)
      const listRes = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}/sessions`
      );
      expect(listRes.status).toBe(200);
      const found = listRes.body.data.find((s: { id: string }) => {
        return s.id === lazyId;
      });
      expect(found).toBeDefined();
      expect(found.status).toBe('expired');
    });

    test('generate on expired session updates status to expired before returning 410', async () => {
      const sessionRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ inactivity_ttl_seconds: 1 });
      expect(sessionRes.status).toBe(201);
      const sessionId = sessionRes.body.id;

      await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions/${sessionId}/messages`)
        .send({ message: 'hello' });

      await new Promise((resolve) => {
        return setTimeout(resolve, 1500);
      });

      const genRes = await authenticatedTestClient(userToken).post(
        `/api/v1/agents/${agentId}/sessions/${sessionId}/generate`
      );
      expect(genRes.status).toBe(410);
      expect(genRes.body.error.code).toBe('SESSION_EXPIRED');

      // DB must now reflect expired status
      const getRes = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}/sessions/${sessionId}`
      );
      expect(getRes.status).toBe(200);
      expect(getRes.body.status).toBe('expired');
    });

    test('session with TTL 0 never expires', async () => {
      mockCreateGeneration.mockResolvedValueOnce({
        id: 'gen_ttl_zero',
        traceId: 'trc_ttl_zero',
        status: 'completed',
        output: {
          model: 'test-model',
          content: 'hello',
          finishReason: 'stop',
        },
      });

      const sessionRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ inactivity_ttl_seconds: 0 });
      expect(sessionRes.status).toBe(201);
      const sessionId = sessionRes.body.id;

      await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions/${sessionId}/messages`)
        .send({ message: 'hello' });

      const genRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions/${sessionId}/generate`)
        .send({});

      expect(genRes.status).toBe(200);
    });
  });

  // ── single_session_per_actor ───────────────────────────────────────────

  describe('single_session_per_actor', () => {
    let singleSessionAgentId: string;
    let singleSessionActorId: string;

    beforeAll(async () => {
      const agentRes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'Single Session Agent',
          single_session_per_actor: true,
        });
      singleSessionAgentId = agentRes.body.id;

      const actorRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/actors')
        .send({ project_id: projectId, name: 'Single Session Actor' });
      singleSessionActorId = actorRes.body.id;
    });

    test('agent has single_session_per_actor true', async () => {
      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/agents/${singleSessionAgentId}`
      );
      expect(res.status).toBe(200);
      expect(res.body.single_session_per_actor).toBe(true);
    });

    test('first session with actor_id succeeds', async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${singleSessionAgentId}/sessions`)
        .send({ actor_id: singleSessionActorId });
      expect(res.status).toBe(201);
      expect(res.body.id).toMatch(/^sess_/);
    });

    test('second session with same actor_id returns 409 with session_id in meta', async () => {
      // ensure first session exists
      const first = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${singleSessionAgentId}/sessions`)
        .send({ actor_id: singleSessionActorId });
      // might be 409 if previous test created it, or 201
      const existingId =
        first.status === 201
          ? first.body.id
          : first.body.error?.meta?.session_id;

      const second = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${singleSessionAgentId}/sessions`)
        .send({ actor_id: singleSessionActorId });
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('SINGLE_SESSION_CONFLICT');
      expect(second.body.error.meta.session_id).toMatch(/^sess_/);
      if (existingId) {
        expect(second.body.error.meta.session_id).toBe(existingId);
      }
    });

    test('expired session does not block new session creation', async () => {
      const actorRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/actors')
        .send({ project_id: projectId, name: 'Expired Session Actor' });
      const expiredActorId = actorRes.body.id;

      // Create a session with very short TTL
      const sess1 = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${singleSessionAgentId}/sessions`)
        .send({ actor_id: expiredActorId, inactivity_ttl_seconds: 1 });
      expect(sess1.status).toBe(201);
      const expiredSessId = sess1.body.id;

      // Wait for TTL to elapse and trigger lazy expiry via GET
      await new Promise((resolve) => {
        return setTimeout(resolve, 1500);
      });
      const getRes = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${singleSessionAgentId}/sessions/${expiredSessId}`
      );
      expect(getRes.body.status).toBe('expired');

      // New session for same actor should now succeed (expired != open)
      const sess2 = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${singleSessionAgentId}/sessions`)
        .send({ actor_id: expiredActorId });
      expect(sess2.status).toBe(201);
    });

    test('no enforcement when actor_id is absent', async () => {
      const res1 = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${singleSessionAgentId}/sessions`)
        .send({});
      expect(res1.status).toBe(201);

      const res2 = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${singleSessionAgentId}/sessions`)
        .send({});
      expect(res2.status).toBe(201);
    });

    test('no enforcement when single_session_per_actor is false', async () => {
      const agentRes = await authenticatedTestClient(userToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'No Single Session Agent',
          single_session_per_actor: false,
        });
      const normalAgentId = agentRes.body.id;

      const actorRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/actors')
        .send({ project_id: projectId, name: 'Normal Actor' });
      const normalActorId = actorRes.body.id;

      const res1 = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${normalAgentId}/sessions`)
        .send({ actor_id: normalActorId });
      expect(res1.status).toBe(201);

      const res2 = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${normalAgentId}/sessions`)
        .send({ actor_id: normalActorId });
      expect(res2.status).toBe(201);
    });

    test('after closing existing session, new session can be created', async () => {
      const actorRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/actors')
        .send({ project_id: projectId, name: 'Reopen Actor' });
      const actorId = actorRes.body.id;

      const sess1 = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${singleSessionAgentId}/sessions`)
        .send({ actor_id: actorId });
      expect(sess1.status).toBe(201);
      const sessId = sess1.body.id;

      await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${singleSessionAgentId}/sessions/${sessId}`)
        .send({ status: 'closed' });

      const sess2 = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${singleSessionAgentId}/sessions`)
        .send({ actor_id: actorId });
      expect(sess2.status).toBe(201);
    });
  });

  // ── Message Delay ──────────────────────────────────────────────────────

  describe('message delay', () => {
    test('can create a session with message_delay_seconds', async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ message_delay_seconds: 5 });
      expect(res.status).toBe(201);
      expect(res.body.message_delay_seconds).toBe(5);
    });

    test('message_delay_seconds defaults to null', async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({});
      expect(res.status).toBe(201);
      expect(res.body.message_delay_seconds).toBeNull();
    });

    test('PATCH can set and clear message_delay_seconds', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({});
      expect(createRes.status).toBe(201);
      const sessionId = createRes.body.id;

      const setRes = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${agentId}/sessions/${sessionId}`)
        .send({ message_delay_seconds: 10 });
      expect(setRes.status).toBe(200);
      expect(setRes.body.message_delay_seconds).toBe(10);

      const clearRes = await authenticatedTestClient(userToken)
        .patch(`/api/v1/agents/${agentId}/sessions/${sessionId}`)
        .send({ message_delay_seconds: null });
      expect(clearRes.status).toBe(200);
      expect(clearRes.body.message_delay_seconds).toBeNull();
    });

    describe('POST /messages with message_delay_seconds and auto_generate', () => {
      let delaySessionId: string;

      beforeAll(async () => {
        const res = await authenticatedTestClient(userToken)
          .post(`/api/v1/agents/${agentId}/sessions`)
          .send({ auto_generate: true, message_delay_seconds: 1 });
        expect(res.status).toBe(201);
        delaySessionId = res.body.id;
      });

      afterEach(() => {
        jest.clearAllMocks();
      });

      test('returns user message immediately instead of triggering generation synchronously', async () => {
        const res = await authenticatedTestClient(userToken)
          .post(
            `/api/v1/agents/${agentId}/sessions/${delaySessionId}/messages`
          )
          .send({ message: 'hello with delay' });
        expect(res.status).toBe(201);
        expect(res.body.role).toBe('user');
        expect(res.body.content).toBe('hello with delay');
        expect(res.body).not.toHaveProperty('generation_id');
      });

      test('after delay elapses, generation is triggered', async () => {
        let signalGenerationStarted!: () => void;
        const generationStarted = new Promise<void>((r) => {
          signalGenerationStarted = r;
        });

        mockCreateGeneration.mockImplementationOnce(() => {
          return new Promise((resolve) => {
            signalGenerationStarted();
            resolve({
              id: 'gen_delay_01',
              traceId: 'trc_delay_01',
              status: 'completed',
              output: {
                model: 'test-model',
                content: 'Delayed reply',
                finishReason: 'stop',
              },
            });
          });
        });

        await authenticatedTestClient(userToken)
          .post(
            `/api/v1/agents/${agentId}/sessions/${delaySessionId}/messages`
          )
          .send({ message: 'trigger delayed gen' });

        await generationStarted;
        expect(mockCreateGeneration).toHaveBeenCalledTimes(1);
      });

      test('second message within delay window resets the timer (debounce)', async () => {
        let callCount = 0;
        let signalGenerationStarted!: () => void;
        const generationStarted = new Promise<void>((r) => {
          signalGenerationStarted = r;
        });

        mockCreateGeneration.mockImplementation(() => {
          callCount++;
          signalGenerationStarted();
          return Promise.resolve({
            id: `gen_debounce_0${callCount}`,
            traceId: `trc_debounce_0${callCount}`,
            status: 'completed',
            output: {
              model: 'test-model',
              content: 'Debounced reply',
              finishReason: 'stop',
            },
          });
        });

        // Send two messages in quick succession (well within the 1-second delay)
        await authenticatedTestClient(userToken)
          .post(
            `/api/v1/agents/${agentId}/sessions/${delaySessionId}/messages`
          )
          .send({ message: 'first message' });

        await authenticatedTestClient(userToken)
          .post(
            `/api/v1/agents/${agentId}/sessions/${delaySessionId}/messages`
          )
          .send({ message: 'second message within delay' });

        // Wait for the delay to elapse and exactly one generation to fire
        await generationStarted;
        await new Promise((resolve) => {
          return setTimeout(resolve, 200);
        });

        expect(mockCreateGeneration).toHaveBeenCalledTimes(1);
      });
    });
  });
});
