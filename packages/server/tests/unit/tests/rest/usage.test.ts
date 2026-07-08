import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import { db } from 'src/db';
import { recordGenerationUsage } from 'src/lib/usage';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * Usage metering, end-to-end. A local OpenAI-compatible stub returns a
 * completion whose `usage` carries reasoning and cached token breakdowns, so a
 * real agent generation writes a usage-meter row we can then read back and
 * assert on — proving reasoning-token capture through the real provider path.
 */
describe('Usage', () => {
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let agentId: string;
  let aiProviderId: string;
  let generationId: string;
  let traceId: string;
  let stubServer: Server;

  const startStubServer = async (): Promise<string> => {
    stubServer = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-usage',
            object: 'chat.completion',
            created: 0,
            model: 'stub-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'metered text' },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 20,
              total_tokens: 30,
              prompt_tokens_details: { cached_tokens: 4 },
              completion_tokens_details: { reasoning_tokens: 7 },
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

    const setup = await setupProjectWithUsers({
      prefix: 'usage',
      policyActions: [
        'agents:CreateAgent',
        'agents:CreateAgentGeneration',
        'usage:ListUsageMeters',
      ],
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;

    const aiProvRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Usage Stub Provider',
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: stubBaseUrl,
      });
    aiProviderId = aiProvRes.body.id;

    const agentRes = await authenticatedTestClient(userToken)
      .post('/api/v1/agents')
      .send({
        ai_provider_id: aiProvRes.body.id,
        project_id: projectId,
        name: 'Usage Metered Agent',
      });
    agentId = agentRes.body.id;

    const genRes = await authenticatedTestClient(userToken)
      .post(`/api/v1/agents/${agentId}/generate`)
      .send({ messages: [{ role: 'user', content: 'hello' }] });
    expect(genRes.status).toBe(200);
    expect(genRes.body.status).toBe('completed');
    generationId = genRes.body.id;
    traceId = genRes.body.trace_id;
  }, 60000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      stubServer.close((err) => {
        return err ? reject(err) : resolve();
      });
    });
  });

  describe('GET /api/v1/usage/meters', () => {
    test('returns 401 when unauthenticated', async () => {
      const response = await testClient.get('/api/v1/usage/meters');
      expect(response.status).toBe(401);
    });

    test('returns 403 when the user lacks permission', async () => {
      const response = await authenticatedTestClient(noPermToken).get(
        '/api/v1/usage/meters'
      );
      expect(response.status).toBe(403);
    });

    test('admin without project scoping lists across all projects', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        '/api/v1/usage/meters'
      );
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    test('accepts limit and offset query params', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/usage/meters?limit=1&offset=0'
      );
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    test('records a meter row with reasoning and cached tokens', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/usage/meters?generation_id=${generationId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.total).toBe(1);
      const meter = response.body.data[0];
      expect(meter.id).toMatch(/^um_/);
      expect(meter.generation_id).toBe(generationId);
      expect(meter.agent_id).toBe(agentId);
      expect(meter.project_id).toBe(projectId);
      expect(meter.ai_provider_id).toBe(aiProviderId);
      expect(meter.trace_id).toBe(traceId);
      expect(meter.provider).toBe('ollama');
      expect(meter.model).toBe('stub-model');
      expect(meter.input_tokens).toBe(10);
      expect(meter.output_tokens).toBe(20);
      expect(meter.cached_tokens).toBe(4);
      expect(meter.reasoning_tokens).toBe(7);
      expect(meter.cost_usd).toBeNull();
      expect(meter.run_id).toBeNull();
    });

    test('does not expose internal numeric IDs', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/usage/meters'
      );
      expect(response.status).toBe(200);
      for (const meter of response.body.data) {
        expect(typeof meter.project_id).toBe('string');
        expect(typeof meter.id).toBe('string');
      }
    });

    test('filters by agent_id', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/usage/meters?agent_id=${agentId}`
      );
      expect(response.status).toBe(200);
      expect(response.body.total).toBeGreaterThanOrEqual(1);
      for (const meter of response.body.data) {
        expect(meter.agent_id).toBe(agentId);
      }
    });

    test('unknown agent_id filter returns an empty page', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/usage/meters?agent_id=agent_doesnotexist0'
      );
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
      expect(response.body.total).toBe(0);
    });

    test('filters by trace_id', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/usage/meters?trace_id=${traceId}`
      );
      expect(response.status).toBe(200);
      expect(response.body.total).toBe(1);
      expect(response.body.data[0].trace_id).toBe(traceId);
    });

    test('unknown trace_id filter returns an empty page', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/usage/meters?trace_id=trace_doesnotexist'
      );
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
      expect(response.body.total).toBe(0);
    });
  });

  describe('recordGenerationUsage attribution and idempotency', () => {
    test('re-recording the same generation is a no-op (idempotent)', async () => {
      await recordGenerationUsage({
        generationId,
        model: 'stub-model',
        usage: undefined,
      });
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/usage/meters?generation_id=${generationId}`
      );
      expect(response.status).toBe(200);
      expect(response.body.total).toBe(1);
    });

    test('recording usage for an unknown generation is a no-op', async () => {
      await expect(
        recordGenerationUsage({
          generationId: 'gen_doesNotExist01',
          model: 'm',
          usage: undefined,
        })
      ).resolves.toBeUndefined();
    });

    test('maps a meter with null agent/generation and a priced cost', async () => {
      const project = await db.Project.findOne({
        where: { publicId: projectId },
      });
      const publicId = generatePublicId(PUBLIC_ID_PREFIXES.usageMeter);
      await db.UsageMeter.create({
        publicId,
        projectId: project?.id as number,
        runId: null,
        nodeId: null,
        agentId: null,
        generationId: null,
        traceId: null,
        aiProviderId: null,
        provider: 'openai',
        model: 'gpt-4o',
        inputTokens: 3,
        outputTokens: 5,
        cachedTokens: 0,
        reasoningTokens: 2,
        costUsd: '2.5',
        idempotencyKey: `manual-seed-${publicId}`,
      });

      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/usage/meters'
      );
      expect(response.status).toBe(200);
      const seeded = response.body.data.find((meter: { id: string }) => {
        return meter.id === publicId;
      });
      expect(seeded).toBeDefined();
      expect(seeded.agent_id).toBeNull();
      expect(seeded.generation_id).toBeNull();
      expect(seeded.trace_id).toBeNull();
      expect(seeded.ai_provider_id).toBeNull();
      expect(seeded.run_id).toBeNull();
      expect(seeded.cost_usd).toBe(2.5);
    });
  });
});
