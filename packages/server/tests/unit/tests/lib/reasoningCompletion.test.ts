import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { runReasoningCompletion } from 'src/lib/reasoningCompletion';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('reasoningCompletion lib', () => {
  let adminToken: string;
  let projectId: string;
  let aiProviderId: string;
  let stubServer: Server;
  let lastRequestBody: Record<string, unknown> | undefined;

  // Local OpenAI-compatible chat completions stub — the real generateText
  // call runs end-to-end with no mocks (same pattern as
  // memoryExtractionCompletion.test.ts).
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
            id: 'chatcmpl-reason',
            object: 'chat.completion',
            created: 0,
            model: 'stub-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'critique text' },
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
      .send({ username: 'reasoningcompladmin', password: 'supersecret' });

    adminToken = await loginAs('reasoningcompladmin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Reasoning Completion Project' });
    projectId = projectRes.body.id;

    const aiProvRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'ReasoningComplProvider',
        provider: 'ollama',
        default_model: 'reasoning-default-model',
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

  test('runs the prompt against the agent provider and returns the text', async () => {
    const agentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: aiProviderId,
        name: 'ReasoningComplAgent',
      });

    const text = await runReasoningCompletion({
      agentId: agentRes.body.id,
      prompt: 'Critique this draft.',
      temperature: 0.3,
    });

    expect(text).toBe('critique text');
    expect(lastRequestBody?.model).toBe('reasoning-default-model');
    expect(lastRequestBody?.temperature).toBe(0.3);
    expect(JSON.stringify(lastRequestBody?.messages)).toContain(
      'Critique this draft.'
    );
  });

  test('defaults the temperature to 0 when not provided', async () => {
    const agentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: aiProviderId,
        name: 'ReasoningComplDefaultTempAgent',
      });

    const text = await runReasoningCompletion({
      agentId: agentRes.body.id,
      prompt: 'Critique deterministically.',
    });

    expect(text).toBe('critique text');
    expect(lastRequestBody?.temperature).toBe(0);
  });

  test('rejects a provider override from another project', async () => {
    const otherProjectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Reasoning Foreign Project' });
    const foreignProvRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: otherProjectRes.body.id,
        name: 'ReasoningForeignProvider',
        provider: 'ollama',
        default_model: 'foreign-model',
      });

    const agentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: aiProviderId,
        name: 'ReasoningForeignAgent',
      });

    await expect(
      runReasoningCompletion({
        agentId: agentRes.body.id,
        aiProviderId: foreignProvRes.body.id,
        prompt: 'Critique.',
      })
    ).rejects.toMatchObject({ code: 'AI_PROVIDER_NOT_FOUND' });
  });
});
