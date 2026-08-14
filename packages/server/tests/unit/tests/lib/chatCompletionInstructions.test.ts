import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * What system content actually reaches the provider.
 *
 * The AI SDK takes system content as `instructions` and refuses it inside
 * `messages` (`allowSystemInMessages` defaults to false), so SOAT normalizes
 * every spelling into `instructions`. These assertions run the real
 * `generateText` against a local OpenAI-compatible stub and read the outgoing
 * body, which exercises the real serialization — a mock would skip exactly the
 * step being verified. The provider adapter renders `instructions` back into a
 * leading `role: "system"` message on the OpenAI wire format, so that is where
 * the content shows up.
 */
describe('chat completion system instructions', () => {
  let userToken: string;
  let projectId: string;
  let aiProviderId: string;
  let stubServer: Server;
  let lastRequestBody: { messages?: { role: string; content: unknown }[] };

  const startStubServer = async (): Promise<string> => {
    stubServer = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        lastRequestBody = JSON.parse(raw);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-stub',
            object: 'chat.completion',
            created: 0,
            model: 'stub-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'ok' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        );
      });
    });

    await new Promise<void>((resolve) => {
      stubServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = stubServer.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  /** The system content the provider was actually sent, in order. */
  const sentSystemContent = (): string[] => {
    return (lastRequestBody.messages ?? [])
      .filter((message) => {
        return message.role === 'system';
      })
      .map((message) => {
        return String(message.content);
      });
  };

  beforeAll(async () => {
    const stubBaseUrl = await startStubServer();

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'chatinstradmin', password: 'supersecret' });
    userToken = await loginAs('chatinstradmin', 'supersecret');

    const projectRes = await authenticatedTestClient(userToken)
      .post('/api/v1/projects')
      .send({ name: 'Chat Instructions Project' });
    projectId = projectRes.body.id;

    const providerRes = await authenticatedTestClient(userToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'stub-ollama',
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: stubBaseUrl,
      });
    aiProviderId = providerRes.body.id;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      stubServer.close(() => {
        resolve();
      });
    });
  });

  describe('POST /api/v1/chat/completions', () => {
    test('a system_message field reaches the provider', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({
          ai_provider_id: aiProviderId,
          system_message: 'Answer only in French.',
          messages: [{ role: 'user', content: 'Capital of Italy?' }],
        });

      expect(response.status).toBe(200);
      expect(sentSystemContent()).toEqual(['Answer only in French.']);
    });

    /* The old helper read `.find` while the filter removed every system message,
     * so a second one was silently destroyed. `Instructions` accepts an ordered
     * array, so nothing has to be dropped to fit. */
    test('every system message is sent, in order', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({
          ai_provider_id: aiProviderId,
          messages: [
            { role: 'system', content: 'Be terse.' },
            { role: 'user', content: 'Capital of Italy?' },
            { role: 'system', content: 'Answer only in French.' },
          ],
        });

      expect(response.status).toBe(200);
      expect(sentSystemContent()).toEqual([
        'Be terse.',
        'Answer only in French.',
      ]);
    });

    test('the system_message field and in-array system messages are both kept', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({
          ai_provider_id: aiProviderId,
          system_message: 'Be terse.',
          messages: [
            { role: 'system', content: 'Answer only in French.' },
            { role: 'user', content: 'Capital of Italy?' },
          ],
        });

      expect(response.status).toBe(200);
      expect(sentSystemContent()).toEqual([
        'Be terse.',
        'Answer only in French.',
      ]);
    });

    test('no system content is sent when none was supplied', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/chat/completions')
        .send({
          ai_provider_id: aiProviderId,
          messages: [{ role: 'user', content: 'Capital of Italy?' }],
        });

      expect(response.status).toBe(200);
      expect(sentSystemContent()).toEqual([]);
    });
  });

  describe('POST /api/v1/chats/:chat_id/completions', () => {
    const createChat = async (systemMessage?: string) => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/chats')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          ...(systemMessage ? { system_message: systemMessage } : {}),
        });
      return res.body.id as string;
    };

    test("the chat's stored system_message is used when the request supplies none", async () => {
      const chatId = await createChat('You are the stored prompt.');

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/chats/${chatId}/completions`)
        .send({ messages: [{ role: 'user', content: 'Hello' }] });

      expect(response.status).toBe(200);
      expect(sentSystemContent()).toEqual(['You are the stored prompt.']);
    });

    test('a request system_message overrides the stored one for that call', async () => {
      const chatId = await createChat('You are the stored prompt.');

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/chats/${chatId}/completions`)
        .send({
          system_message: 'Just this once, be terse.',
          messages: [{ role: 'user', content: 'Hello' }],
        });

      expect(response.status).toBe(200);
      expect(sentSystemContent()).toEqual(['Just this once, be terse.']);
    });
  });
});
