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
 * real agent generation writes a usage event (with its component rows) we can
 * read back and assert on. Metering is modelled as one event + N priced
 * components; tokens are not privileged over infra meter types.
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

  // Component keyed by name, for concise assertions on a returned event.
  const componentsByName = (event: {
    components: Array<{ component: string }>;
  }): Record<string, Record<string, unknown>> => {
    return Object.fromEntries(
      event.components.map((c) => {
        return [c.component, c as Record<string, unknown>];
      })
    );
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

    test('records an event with token components', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/usage/meters?generation_id=${generationId}`
      );
      expect(response.status).toBe(200);
      expect(response.body.total).toBe(1);

      const event = response.body.data[0];
      expect(event.id).toMatch(/^ue_/);
      expect(event.generation_id).toBe(generationId);
      expect(event.agent_id).toBe(agentId);
      expect(event.project_id).toBe(projectId);
      expect(event.ai_provider_id).toBe(aiProviderId);
      expect(event.trace_id).toBe(traceId);
      expect(event.meter_type).toBe('llm_tokens');
      expect(event.provider).toBe('ollama');
      expect(event.model).toBe('stub-model');
      expect(event.run_id).toBeNull();
      expect(event.trigger_id).toBeNull();
      expect(event.action_id).toBeNull();

      const c = componentsByName(event);
      // uncached input = prompt 10 - cached 4
      expect(c.input_tokens.quantity).toBe(6);
      expect(c.input_tokens.unit).toBe('token');
      expect(c.input_tokens.billable).toBe(true);
      expect(c.cached_tokens.quantity).toBe(4);
      expect(c.output_tokens.quantity).toBe(20);
      expect(c.reasoning_tokens.quantity).toBe(7);
      expect(c.reasoning_tokens.billable).toBe(false);
      // no price seeded yet for this SKU in this test's timeline
      expect(event.cost_usd).toBeNull();
    });

    test('filters by meter_type', async () => {
      const match = await authenticatedTestClient(userToken).get(
        `/api/v1/usage/meters?generation_id=${generationId}&meter_type=llm_tokens`
      );
      expect(match.status).toBe(200);
      expect(match.body.total).toBe(1);

      const none = await authenticatedTestClient(userToken).get(
        `/api/v1/usage/meters?generation_id=${generationId}&meter_type=storage`
      );
      expect(none.status).toBe(200);
      expect(none.body.total).toBe(0);
    });

    test('does not expose internal numeric IDs', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/usage/meters'
      );
      expect(response.status).toBe(200);
      for (const event of response.body.data) {
        expect(typeof event.project_id).toBe('string');
        expect(typeof event.id).toBe('string');
      }
    });

    test('filters by agent_id', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/usage/meters?agent_id=${agentId}`
      );
      expect(response.status).toBe(200);
      expect(response.body.total).toBeGreaterThanOrEqual(1);
      for (const event of response.body.data) {
        expect(event.agent_id).toBe(agentId);
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

  describe('recordGenerationUsage idempotency', () => {
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

    test('maps an event with null agent/generation and a priced component', async () => {
      const project = await db.Project.findOne({
        where: { publicId: projectId },
      });
      const eventPublicId = generatePublicId(PUBLIC_ID_PREFIXES.usageEvent);
      const event = await db.UsageEvent.create({
        publicId: eventPublicId,
        projectId: project?.id as number,
        runId: null,
        nodeId: null,
        agentId: null,
        generationId: null,
        traceId: null,
        aiProviderId: null,
        triggerId: null,
        actionId: null,
        meterType: 'llm_tokens',
        provider: 'openai',
        model: 'gpt-4o',
        costUsd: '2.5',
        idempotencyKey: `manual-seed-${eventPublicId}`,
      });
      await db.UsageComponent.create({
        publicId: generatePublicId(PUBLIC_ID_PREFIXES.usageComponent),
        usageEventId: event.id,
        component: 'output_tokens',
        quantity: '5',
        unit: 'token',
        billable: true,
        unitPrice: '0.5',
        costUsd: '2.5',
        priceId: null,
      });

      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/usage/meters'
      );
      expect(response.status).toBe(200);
      const seeded = response.body.data.find((e: { id: string }) => {
        return e.id === eventPublicId;
      });
      expect(seeded).toBeDefined();
      expect(seeded.agent_id).toBeNull();
      expect(seeded.generation_id).toBeNull();
      expect(seeded.trace_id).toBeNull();
      expect(seeded.ai_provider_id).toBeNull();
      expect(seeded.run_id).toBeNull();
      expect(seeded.cost_usd).toBe(2.5);
      expect(seeded.components[0].component).toBe('output_tokens');
      expect(seeded.components[0].cost_usd).toBe(2.5);
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

    test('an admin upserts a future-dated component price and reads it back', async () => {
      const effectiveFrom = new Date(Date.now() + 86_400_000).toISOString();
      const put = await authenticatedTestClient(adminToken)
        .put('/api/v1/usage/prices')
        .send({
          prices: [
            {
              provider: 'openai',
              model: 'usage-test-model',
              component: 'input_tokens',
              unit: 'token',
              unit_price: 0.000001,
              effective_from: effectiveFrom,
            },
          ],
        });
      expect(put.status).toBe(200);
      expect(put.body.prices[0].id).toMatch(/^price_/);
      expect(put.body.prices[0].model).toBe('usage-test-model');
      expect(put.body.prices[0].component).toBe('input_tokens');
      expect(put.body.prices[0].unit_price).toBe(0.000001);

      const get = await authenticatedTestClient(userToken).get(
        '/api/v1/usage/prices'
      );
      expect(get.status).toBe(200);
      const models = get.body.prices.map((price: { model: string }) => {
        return price.model;
      });
      expect(models).toContain('usage-test-model');
    });

    test('upserts a unit-priced platform SKU (node_execution)', async () => {
      const effectiveFrom = new Date(Date.now() + 5 * 86_400_000).toISOString();
      const res = await authenticatedTestClient(adminToken)
        .put('/api/v1/usage/prices')
        .send({
          prices: [
            {
              meter_type: 'node_execution',
              provider: 'soat',
              model: 'node-second',
              component: 'node_second',
              unit: 'node_second',
              unit_price: 0.0001,
              effective_from: effectiveFrom,
            },
          ],
        });
      expect(res.status).toBe(200);
      const price = res.body.prices[0];
      expect(price.meter_type).toBe('node_execution');
      expect(price.component).toBe('node_second');
      expect(price.unit).toBe('node_second');
      expect(price.unit_price).toBe(0.0001);
    });

    test('rejects a past-dated price (immutable history)', async () => {
      const res = await authenticatedTestClient(adminToken)
        .put('/api/v1/usage/prices')
        .send({
          prices: [
            {
              provider: 'openai',
              model: 'usage-test-past',
              component: 'input_tokens',
              unit: 'token',
              unit_price: 0.000001,
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
              component: 'input_tokens',
              unit: 'token',
              unit_price: 0.000001,
              effective_from: 'not-a-date',
            },
          ],
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('rejects a price missing a unit price', async () => {
      const effectiveFrom = new Date(Date.now() + 86_400_000).toISOString();
      const res = await authenticatedTestClient(adminToken)
        .put('/api/v1/usage/prices')
        .send({
          prices: [
            {
              provider: 'openai',
              model: 'usage-test-nounit',
              component: 'input_tokens',
              unit: 'token',
              effective_from: effectiveFrom,
            },
          ],
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('re-upserting a key updates the unit price in place', async () => {
      const effectiveFrom = new Date(Date.now() + 2 * 86_400_000).toISOString();
      const send = (unitPrice: number) => {
        return authenticatedTestClient(adminToken)
          .put('/api/v1/usage/prices')
          .send({
            prices: [
              {
                provider: 'openai',
                model: 'usage-test-update',
                component: 'output_tokens',
                unit: 'token',
                unit_price: unitPrice,
                effective_from: effectiveFrom,
              },
            ],
          });
      };
      await send(0.000002);
      const second = await send(0.000005);
      expect(second.status).toBe(200);

      const get = await authenticatedTestClient(userToken).get(
        '/api/v1/usage/prices'
      );
      const updated = get.body.prices.find((p: { model: string }) => {
        return p.model === 'usage-test-update';
      });
      expect(updated.unit_price).toBe(0.000005);
    });

    test('computes cost_usd on a metered generation from the price book', async () => {
      const past = new Date('2020-01-01T00:00:00.000Z');
      const seed = (component: string, unitPrice: string) => {
        return db.PriceBook.create({
          meterType: 'llm_tokens',
          provider: 'ollama',
          model: 'stub-model',
          component,
          unit: 'token',
          unitPrice,
          effectiveFrom: past,
        });
      };
      await seed('input_tokens', '0.000001');
      await seed('cached_tokens', '0.0000005');
      await seed('output_tokens', '0.000002');

      const genRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({ messages: [{ role: 'user', content: 'priced' }] });
      expect(genRes.status).toBe(200);

      const meters = await authenticatedTestClient(userToken).get(
        `/api/v1/usage/meters?generation_id=${genRes.body.id}`
      );
      expect(meters.status).toBe(200);
      // (10-4)*1e-6 + 4*0.5e-6 + 20*2e-6 = (6 + 2 + 40)e-6 = 4.8e-5
      expect(meters.body.data[0].cost_usd).toBeCloseTo(0.000048, 9);
      const c = componentsByName(meters.body.data[0]);
      expect(c.output_tokens.price_id).toMatch(/^price_/);
      expect(c.output_tokens.cost_usd).toBeCloseTo(0.00004, 9);
    });

    test('a per-provider override wins over the global default for cost', async () => {
      const providerRow = await db.AiProvider.findOne({
        where: { publicId: aiProviderId },
      });
      const past = new Date('2019-01-01T00:00:00.000Z');
      const seed = (
        scope: { aiProviderId: number | null },
        component: string,
        unitPrice: string
      ) => {
        return db.PriceBook.create({
          ...scope,
          meterType: 'llm_tokens',
          provider: 'ollama',
          model: 'stub-model',
          component,
          unit: 'token',
          unitPrice,
          effectiveFrom: past,
        });
      };
      // Cheaper global default…
      await seed({ aiProviderId: null }, 'input_tokens', '0.000001');
      await seed({ aiProviderId: null }, 'output_tokens', '0.000001');
      // …pricier per-instance override that must win.
      await seed(
        { aiProviderId: providerRow?.id as number },
        'input_tokens',
        '0.00001'
      );
      await seed(
        { aiProviderId: providerRow?.id as number },
        'cached_tokens',
        '0.00001'
      );
      await seed(
        { aiProviderId: providerRow?.id as number },
        'output_tokens',
        '0.00002'
      );

      const genRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({ messages: [{ role: 'user', content: 'override' }] });
      expect(genRes.status).toBe(200);

      const meters = await authenticatedTestClient(userToken).get(
        `/api/v1/usage/meters?generation_id=${genRes.body.id}`
      );
      // Override: (10-4)*10e-6 + 4*10e-6 + 20*20e-6 = (60 + 40 + 400)e-6 = 5e-4.
      expect(meters.body.data[0].cost_usd).toBeCloseTo(0.0005, 9);
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
              component: 'input_tokens',
              unit: 'token',
              unit_price: 0.000001,
              effective_from: effectiveFrom,
            },
          ],
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('AI_PROVIDER_NOT_FOUND');
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
      const past = new Date('2018-01-01T00:00:00.000Z');
      const seed = (component: string, unitPrice: string) => {
        return db.PriceBook.findOrCreate({
          where: {
            aiProviderId: null,
            projectId: null,
            provider: 'ollama',
            model: 'stub-model',
            component,
            effectiveFrom: past,
          },
          defaults: {
            meterType: 'llm_tokens',
            provider: 'ollama',
            model: 'stub-model',
            component,
            unit: 'token',
            unitPrice,
            effectiveFrom: past,
          },
        });
      };
      await seed('input_tokens', '0.000001');
      await seed('output_tokens', '0.000001');

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
      expect(res.body.line_items).toHaveLength(1);

      const line = res.body.line_items[0];
      expect(line.event_id).toMatch(/^ue_/);
      expect(line.meter_type).toBe('llm_tokens');
      expect(line.provider).toBe('ollama');
      expect(line.model).toBe('stub-model');
      expect(Array.isArray(line.components)).toBe(true);
      expect(line.cost_usd).toBeGreaterThan(0);

      // Full prompt tokens are reconstructed as uncached input + cached.
      expect(res.body.total_input_tokens).toBe(10);
      expect(res.body.total_output_tokens).toBe(20);
      expect(res.body.total_cached_tokens).toBe(4);
      expect(res.body.total_reasoning_tokens).toBe(7);
      expect(res.body.total_cost_usd).toBeGreaterThan(0);

      // Single-type receipt → one by_meter_type entry equal to the total.
      expect(res.body.by_meter_type).toHaveLength(1);
      expect(res.body.by_meter_type[0].meter_type).toBe('llm_tokens');
      expect(res.body.by_meter_type[0].cost_usd).toBe(res.body.total_cost_usd);
    });

    test('an admin gets an unpriced receipt with null costs', async () => {
      // The first generation (from beforeAll) was metered before any price
      // existed, so its cost is frozen null. Fetched as admin (unscoped), this
      // exercises the null-cost line/rollup paths and the unscoped receipt path.
      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/usage/receipt?generation_id=${generationId}`
      );
      expect(res.status).toBe(200);
      expect(res.body.line_items).toHaveLength(1);

      const line = res.body.line_items[0];
      expect(line.cost_usd).toBeNull();
      const inputComponent = line.components.find(
        (c: { component: string }) => {
          return c.component === 'input_tokens';
        }
      );
      expect(inputComponent.unit_price).toBeNull();
      expect(inputComponent.cost_usd).toBeNull();
      expect(inputComponent.price_id).toBeNull();

      expect(res.body.total_cost_usd).toBeNull();
      expect(res.body.by_meter_type).toHaveLength(1);
      expect(res.body.by_meter_type[0].cost_usd).toBeNull();
      // Token totals are still reconstructed from the components.
      expect(res.body.total_input_tokens).toBe(10);
      expect(res.body.total_cached_tokens).toBe(4);
    });
  });
});
