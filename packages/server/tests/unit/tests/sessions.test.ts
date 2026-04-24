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
      .send({ user_id: userId, policy_id: policyId });

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
        .send({ user_id: res.body.id, policy_id: emptyPolicy.body.id });
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
        jest.spyOn(agentsModule, 'createGeneration').mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              signalGenerationStarted();
              resolveGeneration = () =>
                resolve({
                  id: 'gen_auto_01',
                  traceId: 'trc_auto_01',
                  status: 'completed',
                  output: {
                    model: 'test-model',
                    content: 'Auto reply',
                    finishReason: 'stop',
                  },
                });
            })
        );
      });

      afterEach(() => {
        jest.restoreAllMocks();
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
          .then((r) => r);

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
        jest.restoreAllMocks();
      });

      test('returns saved user message when generation is already in progress', async () => {
        let signalGenerationStarted!: () => void;
        const generationStarted = new Promise<void>((r) => {
          signalGenerationStarted = r;
        });

        jest.spyOn(agentsModule, 'createGeneration').mockImplementation(
          () =>
            new Promise(() => {
              // Signal that createGeneration was called (generatingAt is already
              // set in DB before this point), then never resolve to keep session busy
              signalGenerationStarted();
            })
        );

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

  // ── Cancel-Previous: AbortController lifecycle ────────────────────────

  describe('cancel-previous: AbortController lifecycle', () => {
    let cancelSessionId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ name: 'cancel-previous-test' });
      cancelSessionId = res.body.id;

      // Seed an initial user message
      await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions/${cancelSessionId}/messages`)
        .send({ message: 'Initial message' });
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('second generate request aborts the first in-flight generation', async () => {
      let signalFirstStarted!: () => void;
      const firstStarted = new Promise<void>((r) => {
        signalFirstStarted = r;
      });
      let firstAborted = false;

      // First call: blocks until its AbortSignal fires
      jest
        .spyOn(agentsModule, 'createGeneration')
        .mockImplementationOnce((args) => {
          return new Promise<GenerationResult>((_, reject) => {
            signalFirstStarted();
            args.signal?.addEventListener('abort', () => {
              firstAborted = true;
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          });
        })
        // Second call: resolves immediately so the sync request completes
        .mockImplementationOnce(() => {
          return Promise.resolve<GenerationResult>({
            id: 'gen_cancel_02',
            traceId: 'trc_cancel_02',
            status: 'completed',
            output: {
              model: 'test-model',
              content: 'New reply after abort',
              finishReason: 'stop',
            },
          });
        });

      // Trigger first generation as fire-and-forget (async=true)
      await authenticatedTestClient(userToken)
        .post(
          `/api/v1/agents/${agentId}/sessions/${cancelSessionId}/generate?async=true`
        )
        .expect(202);

      // Wait for the first generation mock to be entered
      await firstStarted;

      // Trigger second generation (sync) — should abort the first
      const secondResult = await authenticatedTestClient(userToken).post(
        `/api/v1/agents/${agentId}/sessions/${cancelSessionId}/generate`
      );

      expect(secondResult.status).toBe(200);
      expect(secondResult.body.status).toBe('completed');
      expect(secondResult.body.message.content).toBe('New reply after abort');

      // The first generation should have been aborted via its signal
      expect(firstAborted).toBe(true);

      // generatingAt should be null after the second generation completes
      const sessionRes = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}/sessions/${cancelSessionId}`
      );
      expect(sessionRes.body.generating_at).toBeNull();
    });

    test('aborted generation (A) does not clear generatingAt while replacement generation (B) is still running', async () => {
      // This test verifies the critical path in the finally block:
      // when generation A is superseded by B, A's finally block must NOT clear
      // generatingAt (leaving that responsibility to B's finally block).
      const twoGenSessionRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ name: 'two-gen-no-premature-clear' });
      const twoGenSessionId = twoGenSessionRes.body.id;

      await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions/${twoGenSessionId}/messages`)
        .send({ message: 'First message' });

      let signalAStarted!: () => void;
      const aStarted = new Promise<void>((r) => {
        signalAStarted = r;
      });

      let signalBStarted!: () => void;
      const bStarted = new Promise<void>((r) => {
        signalBStarted = r;
      });
      let resolveB!: () => void;

      // Generation A: blocks until its signal fires (aborted by B), then rejects
      jest
        .spyOn(agentsModule, 'createGeneration')
        .mockImplementationOnce((args) => {
          return new Promise<GenerationResult>((_, reject) => {
            signalAStarted();
            args.signal?.addEventListener('abort', () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          });
        })
        // Generation B: signals when entered, then blocks until released
        .mockImplementationOnce(() => {
          return new Promise<GenerationResult>((resolve) => {
            signalBStarted();
            resolveB = () =>
              resolve({
                id: 'gen_b_01',
                traceId: 'trc_b_01',
                status: 'completed',
                output: {
                  model: 'test-model',
                  content: 'B reply',
                  finishReason: 'stop',
                },
              });
          });
        });

      // Start A as fire-and-forget
      await authenticatedTestClient(userToken)
        .post(
          `/api/v1/agents/${agentId}/sessions/${twoGenSessionId}/generate?async=true`
        )
        .expect(202);
      await aStarted;

      // Start B as fire-and-forget — aborts A, starts fresh
      await authenticatedTestClient(userToken)
        .post(
          `/api/v1/agents/${agentId}/sessions/${twoGenSessionId}/generate?async=true`
        )
        .expect(202);
      await bStarted;

      // At this point A has been aborted and its finally block has run.
      // B is still in-flight. generatingAt must still be set.
      const duringBRes = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}/sessions/${twoGenSessionId}`
      );
      expect(duringBRes.body.generating_at).not.toBeNull();

      // Now let B finish
      resolveB();

      // Poll until generatingAt is cleared by B's finally block.
      // The global jest config uses advanceTimers:true so fake timers advance
      // automatically when the event loop is idle, making setTimeout reliable here.
      const deadline = Date.now() + 5000;
      await new Promise<void>((resolve, reject) => {
        const poll = async () => {
          if (Date.now() >= deadline)
            return reject(
              new Error('Timeout waiting for B generation to complete')
            );
          const s = await authenticatedTestClient(userToken).get(
            `/api/v1/agents/${agentId}/sessions/${twoGenSessionId}`
          );
          if (!s.body.generating_at) return resolve();
          setTimeout(poll, 50);
        };
        setTimeout(poll, 50);
      });
    });

    test('controller is removed from map after successful generation', async () => {
      const successSessionRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ name: 'success-cleanup-test' });
      const successSessionId = successSessionRes.body.id;

      await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions/${successSessionId}/messages`)
        .send({ message: 'Test message' });

      jest
        .spyOn(agentsModule, 'createGeneration')
        .mockImplementationOnce(() => {
          return Promise.resolve<GenerationResult>({
            id: 'gen_success_01',
            traceId: 'trc_success_01',
            status: 'completed',
            output: {
              model: 'test-model',
              content: 'Successful reply',
              finishReason: 'stop',
            },
          });
        });

      const result = await authenticatedTestClient(userToken).post(
        `/api/v1/agents/${agentId}/sessions/${successSessionId}/generate`
      );

      expect(result.status).toBe(200);

      // After successful generation, generatingAt must be cleared
      const sessionRes = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}/sessions/${successSessionId}`
      );
      expect(sessionRes.body.generating_at).toBeNull();
    });

    test('controller is removed from map after generation error', async () => {
      const errorSessionRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions`)
        .send({ name: 'error-cleanup-test' });
      const errorSessionId = errorSessionRes.body.id;

      await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/sessions/${errorSessionId}/messages`)
        .send({ message: 'Test message' });

      jest
        .spyOn(agentsModule, 'createGeneration')
        .mockImplementationOnce(() => {
          return Promise.reject(new Error('Simulated LLM error'));
        });

      const result = await authenticatedTestClient(userToken).post(
        `/api/v1/agents/${agentId}/sessions/${errorSessionId}/generate`
      );

      // Unexpected errors propagate as 500
      expect(result.status).toBe(500);

      // After an error, the finally block must still clear generatingAt
      const sessionRes = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}/sessions/${errorSessionId}`
      );
      expect(sessionRes.body.generating_at).toBeNull();
    });
  });
});
