import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { DomainError } from 'src/errors';
import { runConsolidationCompletion } from 'src/lib/memoryConsolidationCompletion';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('memoryConsolidationCompletion lib', () => {
  let adminToken: string;
  let projectId: string;
  let aiProviderId: string;
  let stubServer: Server;
  let lastRequestBody: Record<string, unknown> | undefined;

  // Local OpenAI-compatible chat completions stub. The ollama provider builder
  // targets `${base_url}/v1/chat/completions`, so the real generateText call
  // runs end-to-end with no mocks.
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
                message: {
                  role: 'assistant',
                  content: 'Customer prefers email over phone calls',
                },
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

  beforeAll(async () => {
    const stubBaseUrl = await startStubServer();

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'consolidationcompladmin', password: 'supersecret' });

    adminToken = await loginAs('consolidationcompladmin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Consolidation Completion Project' });
    projectId = projectRes.body.id;

    const aiProvRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'ConsolidationCompletionProvider',
        provider: 'ollama',
        default_model: 'default-stub-model',
        base_url: stubBaseUrl,
      });
    aiProviderId = aiProvRes.body.id;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      stubServer.close((err) => {
        return err ? reject(err) : resolve();
      });
    });
  });

  const createAgent = async (args: {
    name: string;
    model?: string;
  }): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: aiProviderId,
        name: args.name,
        model: args.model,
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  test('consolidates both facts against the agent provider and returns the text', async () => {
    const agentId = await createAgent({ name: 'ConsolDefaultModelAgent' });

    const text = await runConsolidationCompletion({
      agentId,
      existing: 'Customer prefers phone calls',
      incoming: 'Actually the customer prefers email',
    });

    expect(text).toBe('Customer prefers email over phone calls');
    // Falls back to the provider default_model when the agent has no model.
    expect(lastRequestBody?.model).toBe('default-stub-model');
    // Both facts reach the prompt, proving buildConsolidationPrompt is used.
    const messages = JSON.stringify(lastRequestBody?.messages);
    expect(messages).toContain('Customer prefers phone calls');
    expect(messages).toContain('Actually the customer prefers email');
  });

  test('uses the agent model override when set', async () => {
    const agentId = await createAgent({
      name: 'ConsolOverrideModelAgent',
      model: 'override-stub-model',
    });

    const text = await runConsolidationCompletion({
      agentId,
      existing: 'a',
      incoming: 'b',
    });

    expect(text).toBe('Customer prefers email over phone calls');
    expect(lastRequestBody?.model).toBe('override-stub-model');
  });

  test('throws RESOURCE_NOT_FOUND for an unknown agent', async () => {
    await expect(
      runConsolidationCompletion({
        agentId: 'agt_doesnotexist000',
        existing: 'a',
        incoming: 'b',
      })
    ).rejects.toBeInstanceOf(DomainError);
  });
});
