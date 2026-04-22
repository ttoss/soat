import type { GenerationResult } from '../../../src/lib/agents';
import * as agentsModule from '../../../src/lib/agents';
import { authenticatedTestClient, loginAs, testClient } from '../testClient';

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
      .post(`/api/v1/projects/${projectId}/policies`)
      .send({
        permissions: [
          'agents:CreateAgent',
          'agents:CreateSession',
          'agents:ListSessions',
          'agents:GetSession',
          'agents:UpdateSession',
          'agents:DeleteSession',
          'agents:SendSessionMessage',
          'agents:SubmitSessionToolOutputs',
          'agents:ListSessionMessages',
        ],
      });
    policyId = policyRes.body.id;

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/members`)
      .send({ userId, policyId });

    const aiProvRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        projectId,
        name: 'Sessions Test Provider',
        provider: 'ollama',
        defaultModel: 'llama3.2',
      });
    aiProviderId = aiProvRes.body.id;

    const agentRes = await authenticatedTestClient(userToken)
      .post('/api/v1/agents')
      .send({
        projectId,
        aiProviderId,
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
      expect(response.body.agentId).toBe(agentId);
      expect(response.body.conversationId).toMatch(/^conv_/);
      expect(response.body.status).toBe('open');
    });

    test('can create a session with optional fields', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ name: 'Test Session' });

      expect(response.status).toBe(201);
      expect(response.body.name).toBe('Test Session');
      expect(response.body.actorId).toMatch(/^act_/);
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
      // Create a session and capture its actorId
      const createRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ name: 'actorId filter seed' });
      const actorId = createRes.body.actorId;
      expect(actorId).toMatch(/^act_/);

      // Create a second session reusing that actor
      await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ actorId });

      // Filter by actorId — all returned sessions must share the same actorId
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}/sessions?actorId=${actorId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeGreaterThanOrEqual(2);
      for (const session of response.body.data) {
        expect(session.actorId).toBe(actorId);
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
      expect(response.body.sessionId).toBe(sessionId);
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
  });

  // ── Permission checks ─────────────────────────────────────────────────

  describe('Permission enforcement', () => {
    let unprivilegedToken: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/users')
        .send({ username: 'sessnoperm', password: 'sessnopass' });

      unprivilegedToken = await loginAs('sessnoperm', 'sessnopass');

      // Add to project with no session permissions
      const emptyPolicy = await authenticatedTestClient(adminToken)
        .post(`/api/v1/projects/${projectId}/policies`)
        .send({ permissions: [] });

      await authenticatedTestClient(adminToken)
        .post(`/api/v1/projects/${projectId}/members`)
        .send({ userId: res.body.id, policyId: emptyPolicy.body.id });
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

      jest
        .spyOn(agentsModule, 'createGeneration')
        .mockImplementationOnce(() => {
          return new Promise<GenerationResult>((resolve) => {
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
      jest.restoreAllMocks();
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
          if (!s.body.generatingAt) return resolve();
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
});
