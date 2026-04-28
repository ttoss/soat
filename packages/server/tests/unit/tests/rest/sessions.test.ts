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
      expect(response.body.actor_id).toMatch(/^act_/);
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
      // Create a session and capture its actorId
      const createRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ name: 'actorId filter seed' });
      const actorId = createRes.body.actor_id;
      expect(actorId).toMatch(/^act_/);

      // Create a second session reusing that actor
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

    test('missing message body returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions/${sessionId}/messages`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
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
      expect(response.body.error).toMatch(/generationId/);
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

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ name: 'Tool Outputs Exec Test' });
      sessionId = res.body.id;
    });

    afterEach(() => {
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
      expect(response.body.error).toMatch(/generation/i);
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
  });
});
