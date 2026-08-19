import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import * as chatsLib from 'src/lib/chats';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

describe('Chats', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let otherProjectId: string;
  let aiProviderId: string;
  let rejectingProviderId: string;
  let noPermToken: string;
  let rejectingServer: Server;

  /**
   * A local OpenAI-compatible endpoint that rejects every completion the way a
   * provider rejects an unavailable model: `404`, with the provider's own JSON
   * error body. The ollama builder targets `${base_url}/v1/chat/completions`,
   * so the real `generateText` / `streamText` call runs end to end and the AI
   * SDK raises a genuine `APICallError` — which is the thing the route has to
   * map. A mock would skip the serialization that produces it.
   */
  const startRejectingServer = async (): Promise<string> => {
    rejectingServer = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message: 'model "not-a-real-model" not found',
              type: 'invalid_request_error',
              code: 'model_not_found',
            },
          })
        );
      });
    });

    await new Promise<void>((resolve) => {
      rejectingServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = rejectingServer.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      rejectingServer.close(() => {
        resolve();
      });
    });
  });

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'chats',
      policyActions: [
        'chats:CreateChat',
        'chats:ListChats',
        'chats:GetChat',
        'chats:DeleteChat',
        'chats:CreateChatCompletion',
      ],
      createOtherProject: true,
    });

    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId as string;
    noPermToken = setup.noPermToken as string;

    const aiProvRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Chats Test Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    aiProviderId = aiProvRes.body.id;

    const rejectingRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Chats Rejecting Provider',
        provider: 'ollama',
        base_url: await startRejectingServer(),
        default_model: 'not-a-real-model',
      });
    rejectingProviderId = rejectingRes.body.id;
  });

  describe('POST /api/v1/chats', () => {
    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post('/api/v1/chats')
        .send({ ai_provider_id: aiProviderId });

      expect(response.status).toBe(401);
    });

    test('missing aiProviderId returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({ project_id: projectId });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('non-string aiProviderId returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({ project_id: projectId, ai_provider_id: 123 });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('user without project access returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post('/api/v1/chats')
        .send({ ai_provider_id: aiProviderId, project_id: otherProjectId });

      expect(response.status).toBe(403);
    });

    test('unknown aiProviderId returns 400', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/chats')
        .send({
          ai_provider_id: 'aip_doesnotexist000000',
          project_id: projectId,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('creates a chat with required fields', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.id).toMatch(/^chat_/);
      expect(response.body.ai_provider_id).toBe(aiProviderId);
      expect(response.body.project_id).toBe(projectId);
    });

    test('project-scoped API key creates a chat without an explicit project_id', async () => {
      const policyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [{ effect: 'Allow', action: ['chats:CreateChat'] }],
          },
        });
      const keyRes = await authenticatedTestClient(userToken)
        .post('/api/v1/api-keys')
        .send({
          name: 'Chat Creator Key',
          project_id: projectId,
          policy_ids: [policyRes.body.id],
        });
      expect(keyRes.status).toBe(201);

      const response = await authenticatedTestClient(keyRes.body.key as string)
        .post('/api/v1/chats')
        .send({ ai_provider_id: aiProviderId });

      expect(response.status).toBe(201);
      expect(response.body.project_id).toBe(projectId);
    });

    test('creates a chat with optional fields', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          name: 'My Chat',
          instructions: 'You are a helpful assistant',
          model: 'llama3.2',
        });

      expect(response.status).toBe(201);
      expect(response.body.name).toBe('My Chat');
      expect(response.body.instructions).toBe('You are a helpful assistant');
      expect(response.body.model).toBe('llama3.2');
    });
  });

  describe('GET /api/v1/chats', () => {
    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get('/api/v1/chats');
      expect(response.status).toBe(401);
    });

    test('user without project access returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .get('/api/v1/chats')
        .query({ project_id: otherProjectId });

      expect(response.status).toBe(403);
    });

    test('authenticated user can list chats', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/chats')
        .query({ project_id: projectId });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    test('admin without project scoping gets an empty list', async () => {
      const response =
        await authenticatedTestClient(adminToken).get('/api/v1/chats');

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
    });
  });

  describe('GET /api/v1/chats/:chatId', () => {
    let chatId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });
      chatId = res.body.id;
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(`/api/v1/chats/${chatId}`);
      expect(response.status).toBe(401);
    });

    test('unknown chatId returns 404', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/chats/cht_doesnotexist0000'
      );
      expect(response.status).toBe(404);
      expect(response.body.error).toBeDefined();
    });

    test('authenticated user can get a chat', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/chats/${chatId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(chatId);
      expect(response.body.ai_provider_id).toBe(aiProviderId);
    });

    test('user without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/chats/${chatId}`
      );
      expect(response.status).toBe(403);
    });
  });

  describe('DELETE /api/v1/chats/:chatId', () => {
    let chatId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });
      chatId = res.body.id;
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.delete(`/api/v1/chats/${chatId}`);
      expect(response.status).toBe(401);
    });

    test('unknown chatId returns 404', async () => {
      const response = await authenticatedTestClient(userToken).delete(
        '/api/v1/chats/cht_doesnotexist0000'
      );
      expect(response.status).toBe(404);
    });

    test('user without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken).delete(
        `/api/v1/chats/${chatId}`
      );
      expect(response.status).toBe(403);
    });

    test('authenticated user can delete a chat', async () => {
      const response = await authenticatedTestClient(userToken).delete(
        `/api/v1/chats/${chatId}`
      );
      expect(response.status).toBe(204);
    });

    test('deleted chat returns 404 on get', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/chats/${chatId}`
      );
      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/v1/chat/completions - chat_id target', () => {
    test('unauthenticated request returns 401', async () => {
      const response = await testClient.post('/api/v1/chat/completions').send({
        chat_id: 'cht_someid',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(response.status).toBe(401);
    });

    test('missing messages returns 400', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({ chat_id: res.body.id });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('empty messages array returns 400', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({ chat_id: res.body.id, messages: [] });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('unknown chat_id returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({
          chat_id: 'cht_doesnotexist0000',
          messages: [{ role: 'user', content: 'Hello' }],
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('CHAT_NOT_FOUND');
    });

    test('user without permission on the chat returns 403', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });

      const response = await authenticatedTestClient(noPermToken)
        .post('/api/v1/chat/completions')
        .send({
          chat_id: res.body.id,
          messages: [{ role: 'user', content: 'Hello' }],
        });

      expect(response.status).toBe(403);
    });

    test('ai_provider_id and chat_id together return 400', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({
          ai_provider_id: aiProviderId,
          chat_id: res.body.id,
          messages: [{ role: 'user', content: 'Hello' }],
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.message).toMatch(/mutually exclusive/i);
    });

    test('neither ai_provider_id nor chat_id returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({ messages: [{ role: 'user', content: 'Hello' }] });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a system message in messages is refused for a chat target', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({
          chat_id: res.body.id,
          messages: [
            { role: 'system', content: 'Be concise.' },
            { role: 'user', content: 'Hello' },
          ],
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('SYSTEM_MESSAGE_NOT_ALLOWED');
    });

    test("a chat-scoped completion applies the chat's stored instructions", async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          instructions: 'You are a helpful assistant.',
        });

      // Ollama isn't running in unit CI, so the provider call fails at the
      // socket — mapped to `502 AI_PROVIDER_ERROR` since #1081, where it used
      // to be a bare 500. This still exercises the stored-instructions branch,
      // which runs before the provider call.
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({
          chat_id: res.body.id,
          messages: [{ role: 'user', content: 'Hello' }],
        });

      expect(response.status).toBe(502);
      expect(response.body.error.code).toBe('AI_PROVIDER_ERROR');
    });
  });

  describe('POST /api/v1/chat/completions', () => {
    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post('/api/v1/chat/completions')
        .send({ messages: [{ role: 'user', content: 'Hello' }] });

      expect(response.status).toBe(401);
      expect(response.body.error).toBeDefined();
    });

    test('missing messages returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('empty messages array returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({ messages: [] });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('non-array messages returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({ messages: 'hello' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('unknown aiProviderId returns 404', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({
          ai_provider_id: 'aip_doesnotexist000000',
          messages: [{ role: 'user', content: 'Hello' }],
        });

      expect(response.status).toBe(404);
      expect(response.body.error).toBeDefined();
    });

    test('missing ai_provider_id returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({
          messages: [{ role: 'user', content: 'Hello' }],
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('user without chats:CreateChatCompletion returns 403', async () => {
      // A stateless completion is authorized against the AI provider's own
      // project — the only project such a call belongs to. Before this gate the
      // route ran on `requireAuth` alone, so the declared action was never
      // enforced on this branch.
      const response = await authenticatedTestClient(noPermToken)
        .post('/api/v1/chat/completions')
        .send({
          ai_provider_id: aiProviderId,
          messages: [{ role: 'user', content: 'Hello' }],
        });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    test('user without chats:CreateChatCompletion returns 403 when streaming', async () => {
      // The gate runs before the SSE headers are written, so the caller gets a
      // JSON 403 rather than an error frame inside a 200 stream.
      const response = await authenticatedTestClient(noPermToken)
        .post('/api/v1/chat/completions')
        .send({
          ai_provider_id: aiProviderId,
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('POST /api/v1/chat/completions - chat_id with mocked AI', () => {
    let chatId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });
      chatId = res.body.id;
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('returns 200 with completion result for a chat target', async () => {
      jest.spyOn(chatsLib, 'createChatCompletion').mockResolvedValueOnce({
        model: 'mock-model',
        content: 'Mock AI response',
        finishReason: 'stop',
      });

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({
          chat_id: chatId,
          messages: [{ role: 'user', content: 'Hello' }],
        });

      expect(response.status).toBe(200);
      expect(response.body.object).toBe('chat.completion');
      expect(response.body.model).toBe('mock-model');
      expect(response.body.choices[0].message.content).toBe('Mock AI response');
    });
  });

  describe('POST /api/v1/chat/completions - with mocked AI', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('returns 200 with completion result when createChatCompletion succeeds', async () => {
      jest.spyOn(chatsLib, 'createChatCompletion').mockResolvedValueOnce({
        model: 'direct-model',
        content: 'Direct completion response',
        finishReason: 'stop',
      });

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({
          ai_provider_id: aiProviderId,
          messages: [{ role: 'user', content: 'Hello' }],
        });

      expect(response.status).toBe(200);
      expect(response.body.object).toBe('chat.completion');
    });
  });

  // ── Upstream provider rejections (#1081) ────────────────────────────────

  describe('POST /api/v1/chat/completions - upstream provider rejection', () => {
    test('a provider rejection is mapped to 502 AI_PROVIDER_ERROR, not a bare 500', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({
          ai_provider_id: rejectingProviderId,
          messages: [{ role: 'user', content: 'Hello' }],
        });

      expect(response.status).toBe(502);
      expect(response.body.error.code).toBe('AI_PROVIDER_ERROR');
      // The provider's own status is what tells a caller "this model is not
      // available here" apart from "SOAT is broken" — the whole point of #1081.
      expect(response.body.error.message).toContain('404');
    });

    test('a provider rejection on a chat target maps the same way', async () => {
      const chatRes = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({ ai_provider_id: rejectingProviderId, project_id: projectId });

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({
          chat_id: chatRes.body.id,
          messages: [{ role: 'user', content: 'Hello' }],
        });

      expect(response.status).toBe(502);
      expect(response.body.error.code).toBe('AI_PROVIDER_ERROR');
    });

    test('an unknown ai_provider_id is still RESOURCE_NOT_FOUND, not a provider error', async () => {
      // The mapping runs *after* this branch, so widening the catch must not
      // swallow the one case it already handled.
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/chat/completions')
        .send({
          ai_provider_id: 'aip_doesnotexist000000',
          messages: [{ role: 'user', content: 'Hello' }],
        });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });

    test('a streaming provider rejection reports the mapped message in the SSE error frame', async () => {
      // Headers are already on the wire by the time the provider answers, so
      // this cannot become a status code — the terminal event carries the
      // mapped message instead of the AI SDK's raw one.
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({
          ai_provider_id: rejectingProviderId,
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/event-stream/);

      const frame = response.text.split('\n').find((line) => {
        return line.startsWith('data:') && line.includes('"error"');
      });
      expect(frame).toBeDefined();
      const payload = JSON.parse((frame as string).replace(/^data: /, '')) as {
        error: string;
      };
      expect(payload.error).toContain('Provider returned 404');
    });
  });

  // ── Streaming /chat/completions against a chat ──────────────────────────

  describe('POST /api/v1/chat/completions - chat_id streaming (real lib)', () => {
    let chatId: string;
    let chatWithSystemId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });
      chatId = res.body.id;

      // Chat with stored instructions, to exercise that branch.
      const res2 = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({
          ai_provider_id: aiProviderId,
          project_id: projectId,
          instructions: 'You are a helpful assistant.',
        });
      chatWithSystemId = res2.body.id;
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.post('/api/v1/chat/completions').send({
        chat_id: chatId,
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      });

      expect(response.status).toBe(401);
    });

    test('streams SSE response for existing chat', async () => {
      // Ollama is not running in tests; the stream will fail during iteration,
      // but the SSE response headers are set and the function body is fully exercised.
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({
          chat_id: chatId,
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/event-stream/);
      expect(response.text).toContain('data:');
    });

    test('sends error via SSE for unknown chat_id', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({
          chat_id: 'cht_doesnotexist0000',
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        });

      expect(response.status).toBe(200);
      expect(response.text).toContain('not found');
    });

    test('streams SSE response when the chat has stored instructions', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({
          chat_id: chatWithSystemId,
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/event-stream/);
    });

    test('a system message in messages is refused with 400, even when streaming', async () => {
      // The guard runs before the SSE headers are written, so the caller gets
      // a proper JSON error instead of an error frame inside a 200 stream.
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({
          chat_id: chatId,
          messages: [
            { role: 'system', content: 'Be concise.' },
            { role: 'user', content: 'Hello' },
          ],
          stream: true,
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('SYSTEM_MESSAGE_NOT_ALLOWED');
      expect(response.body.error.message).toMatch(/instructions/);
    });
  });

  // ── Streaming /chat/completions ─────────────────────────────────────────

  describe('POST /api/v1/chat/completions - streaming (real lib)', () => {
    test('unauthenticated request returns 401', async () => {
      const response = await testClient.post('/api/v1/chat/completions').send({
        ai_provider_id: aiProviderId,
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      });

      expect(response.status).toBe(401);
    });

    test('streams SSE response with ai_provider_id', async () => {
      // resolveModel + buildModel + getProviderFactory are exercised for the Ollama provider.
      // The stream iteration fails (Ollama not running), caught by the error handler.
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({
          ai_provider_id: aiProviderId,
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/event-stream/);
      expect(response.text).toContain('data:');
    });

    test('missing ai_provider_id returns 400 (streaming)', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('non-streaming request reaches createChatCompletion (propagates AI error status)', async () => {
      // createChatCompletion reaches generateText, which throws because this
      // suite has no live Ollama server (only the smoke/tutorials CI jobs set
      // one up) — the connection failure is an upstream fault, so it maps to
      // `502 AI_PROVIDER_ERROR` (#1081).
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({
          ai_provider_id: aiProviderId,
          instructions: 'Be concise.',
          messages: [{ role: 'user', content: 'Hello' }],
        });

      expect(response.status).toBe(502);
      expect(response.body.error.code).toBe('AI_PROVIDER_ERROR');
    });

    test('a system message in messages is refused with 400', async () => {
      // System content travels only in the `instructions` field — one rule on
      // every surface, mirroring the AI SDK's allowSystemInMessages: false.
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({
          ai_provider_id: aiProviderId,
          messages: [
            { role: 'system', content: 'Be concise.' },
            { role: 'user', content: 'Hello' },
          ],
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('SYSTEM_MESSAGE_NOT_ALLOWED');
      expect(response.body.error.message).toMatch(/instructions/);
    });
  });

  // ── Real createChatCompletion execution (admin) ─────────────────────────

  describe('POST /api/v1/chat/completions - real lib paths (admin)', () => {
    let realChatId: string;
    let openAiProviderId: string;

    beforeAll(async () => {
      const chatRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/chats')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });
      realChatId = chatRes.body.id;

      // openai provider to exercise getProviderFactory openai branch
      const aiRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'OpenAI Path Provider',
          provider: 'openai',
          default_model: 'gpt-4o',
        });
      openAiProviderId = aiRes.body.id;
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('non-streaming chat-scoped completion with ollama provider (reaches generateText, propagates AI error status)', async () => {
      // createChatCompletion resolves the chat's instructions and model before
      // calling generateText, which throws because this suite has no live
      // Ollama server — same reasoning as the stateless test above.
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/chat/completions')
        .send({
          chat_id: realChatId,
          messages: [{ role: 'user', content: 'Hello' }],
        });

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('AI_PROVIDER_ERROR');
    });

    test('openai provider exercises getProviderFactory openai branch and buildModel factory-true branch (streaming)', async () => {
      // isOpenAILikeProvider('openai') = true → factory is non-null → buildModel uses factory.
      // OpenAI API fails (no valid key) → error written to SSE stream.
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/chat/completions')
        .send({
          ai_provider_id: openAiProviderId,
          messages: [{ role: 'user', content: 'Hi' }],
          stream: true,
        });

      expect(res.status).toBe(200);
      expect(res.text).toContain('data:');
    });
  });

  // ── Actor linked to a chat (via POST /actors + chat_id) ─────────────────
  // The former POST /chats/:id/actors was removed; an actor is now linked to a
  // chat by passing chat_id to the top-level /actors collection, and listed
  // back with the ?chat_id= filter.

  describe('actor ↔ chat link via /actors', () => {
    let chatId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });
      chatId = res.body.id;
    });

    test('admin can create an actor linked to a chat', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/actors')
        .send({
          project_id: projectId,
          name: 'Chat Test Actor',
          chat_id: chatId,
        });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.name).toBe('Chat Test Actor');
      expect(response.body.chat_id).toBe(chatId);
    });

    test('lists actors filtered by chat_id', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        `/api/v1/actors?project_id=${projectId}&chat_id=${chatId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeGreaterThanOrEqual(1);
      expect(
        response.body.data.every((a: { chat_id: string }) => {
          return a.chat_id === chatId;
        })
      ).toBe(true);
    });
  });
});
