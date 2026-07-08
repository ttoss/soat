import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import { db } from 'src/db';
import { createGeneration } from 'src/lib/agents';
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
        'usage:GetReceipt',
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
      expect(meter.trigger_id).toBeNull();
      expect(meter.action_id).toBeNull();
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

  describe('trigger and action attribution', () => {
    test('records a caller-supplied action_id and filters by it', async () => {
      const genRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({
          messages: [{ role: 'user', content: 'labelled' }],
          action_id: 'action-A',
        });
      expect(genRes.status).toBe(200);
      const actionGenerationId = genRes.body.id;

      const byGeneration = await authenticatedTestClient(userToken).get(
        `/api/v1/usage/meters?generation_id=${actionGenerationId}`
      );
      expect(byGeneration.status).toBe(200);
      expect(byGeneration.body.total).toBe(1);
      expect(byGeneration.body.data[0].action_id).toBe('action-A');
      expect(byGeneration.body.data[0].trigger_id).toBeNull();

      const byAction = await authenticatedTestClient(userToken).get(
        '/api/v1/usage/meters?action_id=action-A'
      );
      expect(byAction.status).toBe(200);
      expect(byAction.body.total).toBe(1);
      expect(byAction.body.data[0].action_id).toBe('action-A');
    });

    test('records trigger_id when a trigger initiates the generation', async () => {
      // Mirrors how trigger dispatch calls createGeneration with a triggerId;
      // exercises the metadata -> meter plumbing without a full trigger fire.
      const triggerPublicId = generatePublicId(PUBLIC_ID_PREFIXES.trigger);
      const project = await db.Project.findOne({
        where: { publicId: projectId },
      });
      const generation = (await createGeneration({
        agentId,
        projectIds: [project?.id as number],
        messages: [{ role: 'user', content: 'from trigger' }],
        stream: false,
        authHeader: `Bearer ${userToken}`,
        triggerId: triggerPublicId,
      })) as { id: string };

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/usage/meters?trigger_id=${triggerPublicId}`
      );
      expect(response.status).toBe(200);
      expect(response.body.total).toBe(1);
      expect(response.body.data[0].generation_id).toBe(generation.id);
      expect(response.body.data[0].trigger_id).toBe(triggerPublicId);
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
        triggerId: null,
        actionId: null,
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

  describe('price book and cost', () => {
    test('GET /usage/prices requires authentication', async () => {
      const res = await testClient.get('/api/v1/usage/prices');
      expect(res.status).toBe(401);
    });

    test('a non-admin cannot upsert prices', async () => {
      const res = await authenticatedTestClient(userToken)
        .put('/api/v1/usage/prices')
        .send({ prices: [] });
      expect(res.status).toBe(403);
    });

    test('an admin upserts a future-dated price and reads it back', async () => {
      const effectiveFrom = new Date(Date.now() + 86_400_000).toISOString();
      const put = await authenticatedTestClient(adminToken)
        .put('/api/v1/usage/prices')
        .send({
          prices: [
            {
              provider: 'openai',
              model: 'usage-test-model',
              input_price_per_m: 1,
              output_price_per_m: 2,
              cached_price_per_m: 0.5,
              effective_from: effectiveFrom,
            },
          ],
        });
      expect(put.status).toBe(200);
      expect(put.body.prices[0].id).toMatch(/^price_/);
      expect(put.body.prices[0].model).toBe('usage-test-model');
      expect(put.body.prices[0].input_price_per_m).toBe(1);

      const get = await authenticatedTestClient(userToken).get(
        '/api/v1/usage/prices'
      );
      expect(get.status).toBe(200);
      const models = get.body.prices.map((price: { model: string }) => {
        return price.model;
      });
      expect(models).toContain('usage-test-model');
    });

    test('rejects a past-dated price (immutable history)', async () => {
      const res = await authenticatedTestClient(adminToken)
        .put('/api/v1/usage/prices')
        .send({
          prices: [
            {
              provider: 'openai',
              model: 'usage-test-past',
              input_price_per_m: 1,
              output_price_per_m: 2,
              effective_from: '2020-01-01T00:00:00.000Z',
            },
          ],
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('rejects an invalid effective_from', async () => {
      const res = await authenticatedTestClient(adminToken)
        .put('/api/v1/usage/prices')
        .send({
          prices: [
            {
              provider: 'openai',
              model: 'usage-test-invalid',
              input_price_per_m: 1,
              output_price_per_m: 2,
              effective_from: 'not-a-date',
            },
          ],
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('re-upserting a key updates in place and can clear the cached rate', async () => {
      const effectiveFrom = new Date(Date.now() + 2 * 86_400_000).toISOString();
      const send = (price: Record<string, unknown>) => {
        return authenticatedTestClient(adminToken)
          .put('/api/v1/usage/prices')
          .send({ prices: [{ ...price, effective_from: effectiveFrom }] });
      };

      await send({
        provider: 'openai',
        model: 'usage-test-update',
        input_price_per_m: 1,
        output_price_per_m: 2,
        cached_price_per_m: 0.5,
      });
      const second = await send({
        provider: 'openai',
        model: 'usage-test-update',
        input_price_per_m: 5,
        output_price_per_m: 6,
      });
      expect(second.status).toBe(200);

      const get = await authenticatedTestClient(userToken).get(
        '/api/v1/usage/prices'
      );
      const updated = get.body.prices.find((price: { model: string }) => {
        return price.model === 'usage-test-update';
      });
      expect(updated.input_price_per_m).toBe(5);
      expect(updated.cached_price_per_m).toBeNull();
    });

    test('computes cost_usd on a metered generation from the price book', async () => {
      await db.PriceBook.create({
        provider: 'ollama',
        model: 'stub-model',
        inputPricePerM: '1',
        outputPricePerM: '2',
        cachedPricePerM: '0.5',
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      });

      const genRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({ messages: [{ role: 'user', content: 'priced' }] });
      expect(genRes.status).toBe(200);

      const meters = await authenticatedTestClient(userToken).get(
        `/api/v1/usage/meters?generation_id=${genRes.body.id}`
      );
      expect(meters.status).toBe(200);
      // (10-4)*1 + 4*0.5 + 20*2 = 48 → 48 / 1e6 USD
      expect(meters.body.data[0].cost_usd).toBeCloseTo(0.000048, 9);
      // The applied price row is linked for auditability.
      expect(meters.body.data[0].price_id).toMatch(/^price_/);
    });

    test('admin upserts a per-provider override', async () => {
      const effectiveFrom = new Date(Date.now() + 3 * 86_400_000).toISOString();
      const res = await authenticatedTestClient(adminToken)
        .put('/api/v1/usage/prices')
        .send({
          prices: [
            {
              ai_provider_id: aiProviderId,
              provider: 'ollama',
              model: 'override-put-model',
              input_price_per_m: 9,
              output_price_per_m: 9,
              effective_from: effectiveFrom,
            },
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body.prices[0].ai_provider_id).toBe(aiProviderId);
    });

    test('rejects an override for an unknown provider', async () => {
      const effectiveFrom = new Date(Date.now() + 3 * 86_400_000).toISOString();
      const res = await authenticatedTestClient(adminToken)
        .put('/api/v1/usage/prices')
        .send({
          prices: [
            {
              ai_provider_id: 'aip_doesNotExist01',
              provider: 'ollama',
              model: 'x',
              input_price_per_m: 1,
              output_price_per_m: 1,
              effective_from: effectiveFrom,
            },
          ],
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('AI_PROVIDER_NOT_FOUND');
    });

    test('a per-provider override wins over the global default for cost', async () => {
      const providerRow = await db.AiProvider.findOne({
        where: { publicId: aiProviderId },
      });
      const past = new Date('2020-01-01T00:00:00.000Z');
      // The stub always reports model 'stub-model', so both rows price that.
      // Global default — the cheaper rate.
      await db.PriceBook.create({
        aiProviderId: null,
        provider: 'ollama',
        model: 'stub-model',
        inputPricePerM: '1',
        outputPricePerM: '1',
        cachedPricePerM: null,
        effectiveFrom: past,
      });
      // Override for this provider instance — the pricier rate that must win.
      await db.PriceBook.create({
        aiProviderId: providerRow?.id as number,
        provider: 'ollama',
        model: 'stub-model',
        inputPricePerM: '10',
        outputPricePerM: '20',
        cachedPricePerM: null,
        effectiveFrom: past,
      });

      const genRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({ messages: [{ role: 'user', content: 'override' }] });
      expect(genRes.status).toBe(200);

      const meters = await authenticatedTestClient(userToken).get(
        `/api/v1/usage/meters?generation_id=${genRes.body.id}`
      );
      // Override rate: (10-4)*10 + 4*10 + 20*20 = 500 → 500 / 1e6 USD.
      // The cheaper global default (26 / 1e6) must not win.
      expect(meters.body.data[0].cost_usd).toBeCloseTo(0.0005, 9);
    });
  });

  describe('GET /api/v1/usage/receipt', () => {
    test('unauthenticated request returns 401', async () => {
      const res = await testClient.get(
        '/api/v1/usage/receipt?generation_id=gen_x'
      );
      expect(res.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        '/api/v1/usage/receipt?generation_id=gen_x'
      );
      expect(res.status).toBe(403);
    });

    test('missing generation_id returns 400', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/usage/receipt'
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('unknown generation returns 404', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/usage/receipt?generation_id=gen_doesNotExist01'
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });

    test('returns a priced receipt for a completed generation', async () => {
      // A global default price covers the stub model so the line is priced.
      await db.PriceBook.findOrCreate({
        where: {
          aiProviderId: null,
          provider: 'ollama',
          model: 'stub-model',
          effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
        },
        defaults: {
          aiProviderId: null,
          provider: 'ollama',
          model: 'stub-model',
          inputPricePerM: '1',
          outputPricePerM: '1',
          cachedPricePerM: null,
          effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
        },
      });

      const genRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({ messages: [{ role: 'user', content: 'receipt' }] });
      expect(genRes.status).toBe(200);

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/usage/receipt?generation_id=${genRes.body.id}`
      );
      expect(res.status).toBe(200);
      expect(res.body.generation_id).toBe(genRes.body.id);
      expect(res.body.currency).toBe('USD');
      expect(Array.isArray(res.body.line_items)).toBe(true);
      expect(res.body.line_items.length).toBeGreaterThan(0);

      const line = res.body.line_items[0];
      expect(line.provider).toBe('ollama');
      expect(line.model).toBe('stub-model');
      expect(line.price_id).toMatch(/^price_/);
      expect(line.input_tokens).toBe(10);
      expect(line.output_tokens).toBe(20);
      expect(line.cached_tokens).toBe(4);
      expect(line.reasoning_tokens).toBe(7);
      expect(line.cost_usd).toBeGreaterThan(0);

      expect(res.body.total_input_tokens).toBe(10);
      expect(res.body.total_output_tokens).toBe(20);
      expect(res.body.total_cached_tokens).toBe(4);
      expect(res.body.total_reasoning_tokens).toBe(7);
      expect(res.body.total_cost_usd).toBeGreaterThan(0);
    });
  });
});
