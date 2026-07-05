import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';
import {
  buildDiscussionProviderOptions,
  resolveDiscussionModel,
  runDiscussionCompletion,
} from 'src/lib/discussionCompletion';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('discussionCompletion lib', () => {
  let adminToken: string;
  let projectId: string;
  let projectDbId: number;
  let aiProviderId: string;
  let stubServer: Server;
  let lastRequestBody: Record<string, unknown> | undefined;

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
            id: 'chatcmpl-disc',
            object: 'chat.completion',
            created: 0,
            model: 'stub-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'discussion text' },
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
      .send({ username: 'disccompladmin', password: 'supersecret' });
    adminToken = await loginAs('disccompladmin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Discussion Completion Project' });
    projectId = projectRes.body.id;
    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    projectDbId = project?.id as number;

    const aiProvRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'DiscComplProvider',
        provider: 'ollama',
        default_model: 'disc-default-model',
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

  describe('buildDiscussionProviderOptions', () => {
    test('maps effort per provider and no-ops otherwise', () => {
      expect(
        buildDiscussionProviderOptions({ provider: 'openai', effort: 'low' })
          ?.providerOptions.openai
      ).toEqual({ reasoningEffort: 'low' });

      const anthropic = buildDiscussionProviderOptions({
        provider: 'anthropic',
        effort: 'high',
      });
      expect(anthropic?.providerOptions.anthropic).toBeDefined();
      expect(anthropic?.maxOutputTokens).toBeGreaterThan(0);

      expect(
        buildDiscussionProviderOptions({ provider: 'google', effort: 'medium' })
          ?.providerOptions.google
      ).toBeDefined();

      expect(
        buildDiscussionProviderOptions({ provider: 'ollama', effort: 'high' })
      ).toBeUndefined();
      expect(
        buildDiscussionProviderOptions({ provider: 'openai' })
      ).toBeUndefined();
    });
  });

  describe('resolveDiscussionModel', () => {
    test('resolves a project-scoped provider', async () => {
      const resolved = await resolveDiscussionModel({
        projectId: projectDbId,
        aiProviderId,
      });
      expect(resolved.modelName).toBe('disc-default-model');
      expect(resolved.provider).toBe('ollama');
    });

    test('throws for a provider not in the project', async () => {
      await expect(
        resolveDiscussionModel({
          projectId: projectDbId,
          aiProviderId: 'aip_x',
        })
      ).rejects.toMatchObject({ code: 'AI_PROVIDER_NOT_FOUND' });
    });
  });

  describe('runDiscussionCompletion', () => {
    test('runs the prompt against the provider and returns the text', async () => {
      const text = await runDiscussionCompletion({
        projectId: projectDbId,
        aiProviderId,
        prompt: 'Deliberate on X.',
        temperature: 0.4,
      });
      expect(text).toBe('discussion text');
      expect(lastRequestBody?.model).toBe('disc-default-model');
      expect(lastRequestBody?.temperature).toBe(0.4);
    });

    test('defaults temperature to 0 and tolerates a no-op effort', async () => {
      const text = await runDiscussionCompletion({
        projectId: projectDbId,
        aiProviderId,
        prompt: 'Deliberate deterministically.',
        effort: 'high',
      });
      expect(text).toBe('discussion text');
      expect(lastRequestBody?.temperature).toBe(0);
    });
  });
});
