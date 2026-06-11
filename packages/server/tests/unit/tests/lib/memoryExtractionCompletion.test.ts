import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { DomainError } from 'src/errors';
import { runExtractionCompletion } from 'src/lib/memoryExtractionCompletion';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('memoryExtractionCompletion lib', () => {
  let adminToken: string;
  let projectId: string;
  let aiProviderId: string;
  let stubServer: Server;
  let lastRequestBody: Record<string, unknown> | undefined;

  // Local OpenAI-compatible chat completions stub. The ollama provider
  // builder targets `${base_url}/v1/chat/completions`, so the real
  // generateText call runs end-to-end with no mocks.
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
                message: { role: 'assistant', content: '["stub fact"]' },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 1,
              completion_tokens: 1,
              total_tokens: 2,
            },
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
      .send({ username: 'extractioncompladmin', password: 'supersecret' });

    adminToken = await loginAs('extractioncompladmin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Extraction Completion Project' });
    projectId = projectRes.body.id;

    const aiProvRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'ExtractionCompletionProvider',
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

  test('runs the prompt against the agent provider and returns the text', async () => {
    const agentId = await createAgent({ name: 'ComplDefaultModelAgent' });

    const text = await runExtractionCompletion({
      agentId,
      prompt: 'Extract facts from: user prefers email.',
    });

    expect(text).toBe('["stub fact"]');
    // Falls back to the provider default_model when the agent has no model.
    expect(lastRequestBody?.model).toBe('default-stub-model');
    expect(JSON.stringify(lastRequestBody?.messages)).toContain(
      'user prefers email.'
    );
  });

  test('uses the agent model override when set', async () => {
    const agentId = await createAgent({
      name: 'ComplOverrideModelAgent',
      model: 'override-stub-model',
    });

    const text = await runExtractionCompletion({
      agentId,
      prompt: 'Extract facts.',
    });

    expect(text).toBe('["stub fact"]');
    expect(lastRequestBody?.model).toBe('override-stub-model');
  });

  test('throws RESOURCE_NOT_FOUND for an unknown agent', async () => {
    await expect(
      runExtractionCompletion({
        agentId: 'agt_doesnotexist000',
        prompt: 'irrelevant',
      })
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });

    await expect(
      runExtractionCompletion({
        agentId: 'agt_doesnotexist000',
        prompt: 'irrelevant',
      })
    ).rejects.toBeInstanceOf(DomainError);
  });
});
