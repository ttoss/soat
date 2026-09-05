import * as fs from 'node:fs';
import * as path from 'node:path';

import { load } from 'js-yaml';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * The properties the list operation's row schema declares. Read from the spec
 * rather than from a generated client: the spec is what the SDK, CLI and MCP
 * surface are built from, so it is the artefact that must not under-describe
 * the response.
 */
const listedRowProperties = (): Record<string, unknown> => {
  const spec: unknown = load(
    fs.readFileSync(
      path.resolve(
        __dirname,
        '../../../../src/rest/openapi/v1/ai-providers.yaml'
      ),
      'utf8'
    )
  );
  const at = (node: unknown, key: string): unknown => {
    return node && typeof node === 'object'
      ? (node as Record<string, unknown>)[key]
      : undefined;
  };
  const properties = [
    'paths',
    '/api/v1/ai-providers',
    'get',
    'responses',
    '200',
    'content',
    'application/json',
    'schema',
    'properties',
    'data',
    'items',
    'properties',
  ].reduce(at, spec);
  return (properties as Record<string, unknown> | undefined) ?? {};
};

describe('AI Providers', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let otherProjectId: string;
  let secretId: string;
  let noPermToken: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'aiprov',
      policyActions: [
        'ai-providers:ListAiProviders',
        'ai-providers:GetAiProvider',
        'ai-providers:CreateAiProvider',
        'ai-providers:UpdateAiProvider',
        'ai-providers:DeleteAiProvider',
        'ai-providers:ListAiProviderModels',
        'ai-providers:GetAiProviderPrices',
        'ai-providers:ManageAiProviderPrices',
      ],
      createOtherProject: true,
    });

    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId as string;
    noPermToken = setup.noPermToken as string;

    const secretRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/secrets')
      .send({
        project_id: projectId,
        name: 'AI Provider Secret',
        value: 'sk-test',
      });
    secretId = secretRes.body.id;
  });

  describe('GET /api/v1/ai-providers', () => {
    test('authenticated user can list AI providers', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/ai-providers')
        .query({ project_id: projectId });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    test('every field a listed row carries is declared in the spec', async () => {
      // The list rows are built by the same `mapAiProvider` as the item read,
      // so they carry `secret_id`, `base_url` and `config` — none of which the
      // list schema declared. A generated client types the row from that
      // schema, so the fields were invisible to every SDK consumer.
      const created = await authenticatedTestClient(userToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'Listed Shape',
          provider: 'bedrock',
          default_model: 'model-x',
          secret_id: secretId,
          base_url: 'https://example.invalid',
          config: { region: 'us-east-1' },
        });
      expect(created.status).toBe(201);

      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/ai-providers')
        .query({ project_id: projectId, limit: 100 });
      expect(response.status).toBe(200);

      const row = response.body.data.find((item: { id: string }) => {
        return item.id === created.body.id;
      });
      expect(row).toBeDefined();

      const undeclared = Object.keys(row).filter((key) => {
        return !(key in listedRowProperties());
      });
      expect(undeclared).toEqual([]);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get('/api/v1/ai-providers');
      expect(response.status).toBe(401);
    });

    test('user without access to project returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .get('/api/v1/ai-providers')
        .query({ project_id: otherProjectId });

      expect(response.status).toBe(403);
    });
  });

  describe('POST /api/v1/ai-providers', () => {
    test('authenticated user with permission can create an AI provider', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'My OpenAI',
          provider: 'openai',
          default_model: 'gpt-4o',
        });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.name).toBe('My OpenAI');
      expect(response.body.project_id).toBe(projectId);
      expect(response.body.provider).toBe('openai');
      expect(response.body.default_model).toBe('gpt-4o');
      expect(response.body.secret_id).toBeNull();
      expect(response.body.updated_at).toBeDefined();
    });

    test.each([
      'openai',
      'anthropic',
      'google',
      'xai',
      'groq',
      'ollama',
      'azure',
      'bedrock',
      'vertex',
      'gateway',
      'custom',
    ])('can create an AI provider with runtime slug %s', async (provider) => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: `Provider ${provider}`,
          provider,
          default_model: 'model-x',
        });

      expect(response.status).toBe(201);
      expect(response.body.provider).toBe(provider);
    });

    test('can create AI provider linked to a secret', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          secret_id: secretId,
          name: 'My OpenAI With Key',
          provider: 'openai',
          default_model: 'gpt-4o',
        });

      expect(response.status).toBe(201);
      expect(response.body.secret_id).toBe(secretId);
    });

    test('create without name returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          provider: 'openai',
          default_model: 'gpt-4o',
        });

      expect(response.status).toBe(400);
    });

    test('create with invalid provider returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'x',
          provider: 'invalid',
          default_model: 'gpt-4o',
        });

      expect(response.status).toBe(400);
    });

    test('create without defaultModel returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/ai-providers')
        .send({ project_id: projectId, name: 'x', provider: 'openai' });

      expect(response.status).toBe(400);
    });

    test('create with secretId from wrong project returns 400', async () => {
      const otherSecretRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/secrets')
        .send({
          project_id: otherProjectId,
          name: 'Other Project Secret',
          value: 'sk-test',
        });
      const otherSecretId = otherSecretRes.body.id;

      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          secret_id: otherSecretId,
          name: 'x',
          provider: 'openai',
          default_model: 'gpt-4o',
        });

      expect(response.status).toBe(400);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.post('/api/v1/ai-providers').send({
        project_id: projectId,
        name: 'x',
        provider: 'openai',
        default_model: 'gpt-4o',
      });

      expect(response.status).toBe(401);
    });

    test('user without permission on project returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: otherProjectId,
          name: 'x',
          provider: 'openai',
          default_model: 'gpt-4o',
        });

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/ai-providers/:aiProviderId', () => {
    let aiProviderId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'Get Test Provider',
          provider: 'anthropic',
          default_model: 'claude-3-5-haiku-latest',
        });
      aiProviderId = res.body.id;
    });

    test('authenticated user with permission can get an AI provider', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/ai-providers/${aiProviderId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(aiProviderId);
      expect(response.body.project_id).toBe(projectId);
      expect(response.body.provider).toBe('anthropic');
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/ai-providers/${aiProviderId}`
      );
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const adminRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: otherProjectId,
          name: 'Other Provider',
          provider: 'openai',
          default_model: 'gpt-4o',
        });

      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/ai-providers/${adminRes.body.id}`
      );
      expect(response.status).toBe(403);
    });

    test('unknown ID returns 404', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/ai-providers/aip_doesnotexist'
      );
      expect(response.status).toBe(404);
    });
  });

  describe('PATCH /api/v1/ai-providers/:aiProviderId', () => {
    let aiProviderId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'Patch Test Provider',
          provider: 'openai',
          default_model: 'gpt-4o-mini',
        });
      aiProviderId = res.body.id;
    });

    test('authenticated user with permission can update an AI provider', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/ai-providers/${aiProviderId}`)
        .send({ name: 'Updated Provider', default_model: 'gpt-4o' });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(aiProviderId);
      expect(response.body.name).toBe('Updated Provider');
      expect(response.body.default_model).toBe('gpt-4o');
    });

    test('can link a secret when updating', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/ai-providers/${aiProviderId}`)
        .send({ secret_id: secretId });

      expect(response.status).toBe(200);
      expect(response.body.secret_id).toBe(secretId);
    });

    test('returns 400 when updating with an invalid secret ID', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/ai-providers/${aiProviderId}`)
        .send({ secret_id: 'sec_nonexistent12345' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.message).toBe('Invalid secret ID');
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .patch(`/api/v1/ai-providers/${aiProviderId}`)
        .send({ name: 'x' });
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const adminRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: otherProjectId,
          name: 'Other Patch Provider',
          provider: 'openai',
          default_model: 'gpt-4o',
        });

      const response = await authenticatedTestClient(noPermToken)
        .patch(`/api/v1/ai-providers/${adminRes.body.id}`)
        .send({ name: 'x' });
      expect(response.status).toBe(403);
    });

    test('unknown ID returns 404', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch('/api/v1/ai-providers/aip_doesnotexist')
        .send({ name: 'x' });
      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /api/v1/ai-providers/:aiProviderId', () => {
    test('authenticated user with permission can delete an AI provider', async () => {
      const createRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'To Delete',
          provider: 'openai',
          default_model: 'gpt-4o',
        });
      const aiProviderId = createRes.body.id;

      const response = await authenticatedTestClient(userToken).delete(
        `/api/v1/ai-providers/${aiProviderId}`
      );
      expect(response.status).toBe(204);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.delete(
        '/api/v1/ai-providers/aip_doesnotexist'
      );
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const adminRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: otherProjectId,
          name: 'Other Delete Provider',
          provider: 'openai',
          default_model: 'gpt-4o',
        });

      const response = await authenticatedTestClient(noPermToken).delete(
        `/api/v1/ai-providers/${adminRes.body.id}`
      );
      expect(response.status).toBe(403);
    });

    test('unknown ID returns 404', async () => {
      const response = await authenticatedTestClient(userToken).delete(
        '/api/v1/ai-providers/aip_doesnotexist'
      );
      expect(response.status).toBe(404);
    });

    test('returns 409 with actionable chat IDs when provider has a dependent chat', async () => {
      const providerRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'Provider With Chat',
          provider: 'openai',
          default_model: 'gpt-4o',
        });
      const aiProviderId = providerRes.body.id;

      const chatRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/chats')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });
      const chatId = chatRes.body.id;

      const response = await authenticatedTestClient(userToken).delete(
        `/api/v1/ai-providers/${aiProviderId}`
      );
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('AI_PROVIDER_HAS_DEPENDENTS');
      // Hard reference: force is powerless and the block names the offenders.
      expect(response.body.error.meta.chatCount).toBe(1);
      expect(response.body.error.meta.chatIds).toContain(chatId);
      expect(response.body.error.meta.forcible).toBe(false);
    });

    test('hard reference (agent) blocks deletion even with force=true', async () => {
      const providerRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'Provider With Agent',
          provider: 'openai',
          default_model: 'gpt-4o',
        });
      const aiProviderId = providerRes.body.id;

      const agentRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({ ai_provider_id: aiProviderId, project_id: projectId });
      const agentId = agentRes.body.id;

      const response = await authenticatedTestClient(userToken)
        .delete(`/api/v1/ai-providers/${aiProviderId}`)
        .query({ force: 'true' });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('AI_PROVIDER_HAS_DEPENDENTS');
      expect(response.body.error.meta.agentCount).toBe(1);
      expect(response.body.error.meta.agentIds).toContain(agentId);
      // force never cascades hard references.
      expect(response.body.error.meta.forcible).toBe(false);

      // The provider must still exist — the block left it intact.
      const getRes = await authenticatedTestClient(userToken).get(
        `/api/v1/ai-providers/${aiProviderId}`
      );
      expect(getRes.status).toBe(200);
    });

    test('soft dependents (price overrides) block deletion without force', async () => {
      const providerRes = await authenticatedTestClient(userToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'Provider With Overrides',
          provider: 'openai',
          default_model: 'gpt-4o',
        });
      const aiProviderId = providerRes.body.id;

      await authenticatedTestClient(userToken)
        .put(`/api/v1/ai-providers/${aiProviderId}/prices`)
        .send({
          prices: [
            {
              model: 'gpt-4o',
              component: 'input_tokens',
              unit: 'token',
              unit_price: 0.000001,
              effective_from: '2099-01-01T00:00:00.000Z',
            },
          ],
        });

      const response = await authenticatedTestClient(userToken).delete(
        `/api/v1/ai-providers/${aiProviderId}`
      );
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('AI_PROVIDER_HAS_DEPENDENTS');
      expect(response.body.error.meta.priceOverrideCount).toBe(1);
      // Only soft dependents block, so force=true would resolve it.
      expect(response.body.error.meta.forcible).toBe(true);
    });

    test('force=true deletes a provider with only soft dependents and drops its overrides', async () => {
      const providerRes = await authenticatedTestClient(userToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'Provider Force Delete',
          provider: 'openai',
          default_model: 'gpt-4o',
        });
      const aiProviderId = providerRes.body.id;

      await authenticatedTestClient(userToken)
        .put(`/api/v1/ai-providers/${aiProviderId}/prices`)
        .send({
          prices: [
            {
              model: 'gpt-4o',
              component: 'input_tokens',
              unit: 'token',
              unit_price: 0.000001,
              effective_from: '2099-01-01T00:00:00.000Z',
            },
          ],
        });

      const response = await authenticatedTestClient(userToken)
        .delete(`/api/v1/ai-providers/${aiProviderId}`)
        .query({ force: 'true' });
      expect(response.status).toBe(204);

      // Provider is gone.
      const getRes = await authenticatedTestClient(userToken).get(
        `/api/v1/ai-providers/${aiProviderId}`
      );
      expect(getRes.status).toBe(404);
    });
  });

  describe('per-provider price overrides', () => {
    let pricedProviderId: string;
    const futureFrom = '2099-01-01T00:00:00.000Z';

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'Priced Provider',
          provider: 'openai',
          default_model: 'gpt-4o',
        });
      pricedProviderId = res.body.id;
    });

    describe('GET /api/v1/ai-providers/:ai_provider_id/prices', () => {
      test('unauthenticated request returns 401', async () => {
        const res = await testClient.get(
          `/api/v1/ai-providers/${pricedProviderId}/prices`
        );
        expect(res.status).toBe(401);
      });

      test('user without permission returns 403', async () => {
        const res = await authenticatedTestClient(noPermToken).get(
          `/api/v1/ai-providers/${pricedProviderId}/prices`
        );
        expect(res.status).toBe(403);
      });

      test('unknown provider returns 404', async () => {
        const res = await authenticatedTestClient(userToken).get(
          '/api/v1/ai-providers/aip_doesNotExist01/prices'
        );
        expect(res.status).toBe(404);
      });

      test('starts empty for a provider with no overrides', async () => {
        const res = await authenticatedTestClient(userToken).get(
          `/api/v1/ai-providers/${pricedProviderId}/prices`
        );
        expect(res.status).toBe(200);
        expect(res.body.prices).toEqual([]);
      });
    });

    describe('PUT /api/v1/ai-providers/:ai_provider_id/prices', () => {
      test('unauthenticated request returns 401', async () => {
        const res = await testClient
          .put(`/api/v1/ai-providers/${pricedProviderId}/prices`)
          .send({ prices: [] });
        expect(res.status).toBe(401);
      });

      test('user without permission returns 403', async () => {
        const res = await authenticatedTestClient(noPermToken)
          .put(`/api/v1/ai-providers/${pricedProviderId}/prices`)
          .send({ prices: [] });
        expect(res.status).toBe(403);
      });

      test('rejects an unparseable effective_from with 400', async () => {
        const res = await authenticatedTestClient(userToken)
          .put(`/api/v1/ai-providers/${pricedProviderId}/prices`)
          .send({
            prices: [
              {
                model: 'gpt-4o',
                component: 'input_tokens',
                unit: 'token',
                unit_price: 0.000001,
                effective_from: 'not-a-timestamp',
              },
            ],
          });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
        expect(res.body.error.meta).toEqual({
          provider: 'openai',
          model: 'gpt-4o',
          component: 'input_tokens',
          effective_from: 'not-a-timestamp',
        });
      });

      test('upserts a component override and reads it back', async () => {
        const putRes = await authenticatedTestClient(userToken)
          .put(`/api/v1/ai-providers/${pricedProviderId}/prices`)
          .send({
            prices: [
              {
                model: 'gpt-4o',
                component: 'output_tokens',
                unit: 'token',
                unit_price: 0.000015,
                effective_from: futureFrom,
              },
            ],
          });
        expect(putRes.status).toBe(200);
        expect(putRes.body.prices).toHaveLength(1);
        const price = putRes.body.prices[0];
        expect(price.id).toMatch(/^price_/);
        // The override records the provider it prices and the provider's slug.
        expect(price.ai_provider_id).toBe(pricedProviderId);
        expect(price.provider).toBe('openai');
        expect(price.model).toBe('gpt-4o');
        expect(price.component).toBe('output_tokens');
        expect(price.unit).toBe('token');
        expect(price.unit_price).toBe(0.000015);

        const getRes = await authenticatedTestClient(userToken).get(
          `/api/v1/ai-providers/${pricedProviderId}/prices`
        );
        expect(getRes.status).toBe(200);
        expect(getRes.body.prices).toHaveLength(1);
        expect(getRes.body.prices[0].id).toBe(price.id);
      });

      test('re-upserting the same key updates the rate in place', async () => {
        const res = await authenticatedTestClient(userToken)
          .put(`/api/v1/ai-providers/${pricedProviderId}/prices`)
          .send({
            prices: [
              {
                model: 'gpt-4o',
                component: 'output_tokens',
                unit: 'token',
                unit_price: 0.000018,
                effective_from: futureFrom,
              },
            ],
          });
        expect(res.status).toBe(200);
        expect(res.body.prices[0].unit_price).toBe(0.000018);

        // Still a single row for that (model, component, effective_from) key.
        const getRes = await authenticatedTestClient(userToken).get(
          `/api/v1/ai-providers/${pricedProviderId}/prices`
        );
        expect(
          getRes.body.prices.filter((p: { model: string }) => {
            return p.model === 'gpt-4o';
          })
        ).toHaveLength(1);
      });
    });
  });

  // A price for a (model, component) nothing has priced yet may take effect
  // immediately: there is no row to rewrite and no frozen cost to protect, and
  // a mandatory future date leaves the provider live and unpriced until it
  // lands — a generation in that window is metered at zero forever (#1196).
  describe('first-write prices take effect immediately', () => {
    let providerId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'First Write Provider',
          provider: 'openai',
          default_model: 'gpt-4o',
        });
      providerId = res.body.id;
    });

    test('accepts a past effective_from on a component with no rows', async () => {
      const effectiveFrom = new Date(Date.now() - 1000).toISOString();
      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/ai-providers/${providerId}/prices`)
        .send({
          prices: [
            {
              model: 'first-write-model',
              component: 'input_tokens',
              unit: 'token',
              unit_price: 0.000001,
              effective_from: effectiveFrom,
            },
          ],
        });
      expect(res.status).toBe(200);
      expect(new Date(res.body.prices[0].effective_from).toISOString()).toBe(
        effectiveFrom
      );
    });

    test('rejects a back-dated write once the component has a row', async () => {
      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/ai-providers/${providerId}/prices`)
        .send({
          prices: [
            {
              model: 'first-write-model',
              component: 'input_tokens',
              unit: 'token',
              unit_price: 0.000002,
              effective_from: new Date(Date.now() - 500).toISOString(),
            },
          ],
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    // A PUT carries a batch, so the refusal has to say which row it is about:
    // reading that out of the message is the only alternative (#1203).
    test('names the refused row in meta', async () => {
      const effectiveFrom = new Date(Date.now() - 500).toISOString();
      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/ai-providers/${providerId}/prices`)
        .send({
          prices: [
            {
              model: 'batch-first-write-model',
              component: 'input_tokens',
              unit: 'token',
              unit_price: 0.000001,
              effective_from: effectiveFrom,
            },
            {
              model: 'first-write-model',
              component: 'input_tokens',
              unit: 'token',
              unit_price: 0.000002,
              effective_from: effectiveFrom,
            },
          ],
        });
      expect(res.status).toBe(400);
      expect(res.body.error.meta).toEqual({
        provider: 'openai',
        model: 'first-write-model',
        component: 'input_tokens',
        effective_from: effectiveFrom,
      });
    });

    test('another component on the same model is still a first write', async () => {
      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/ai-providers/${providerId}/prices`)
        .send({
          prices: [
            {
              model: 'first-write-model',
              component: 'output_tokens',
              unit: 'token',
              unit_price: 0.000003,
              effective_from: new Date(Date.now() - 1000).toISOString(),
            },
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body.prices[0].component).toBe('output_tokens');
    });
  });

  describe('GET /api/v1/ai-providers/:aiProviderId/models', () => {
    let azureProviderId: string;
    let vertexProviderId: string;

    beforeAll(async () => {
      const azureRes = await authenticatedTestClient(userToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'Azure Listing',
          provider: 'azure',
          default_model: 'gpt-4o',
        });
      azureProviderId = azureRes.body.id;

      const vertexRes = await authenticatedTestClient(userToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'Vertex Listing',
          provider: 'vertex',
          default_model: 'gemini-2.5-flash',
        });
      vertexProviderId = vertexRes.body.id;
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/ai-providers/${azureProviderId}/models`
      );
      expect(response.status).toBe(401);
    });

    test('unknown ID returns 404', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/ai-providers/aip_doesnotexist/models'
      );
      expect(response.status).toBe(404);
    });

    test('user without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/ai-providers/${azureProviderId}/models`
      );
      expect(response.status).toBe(403);
    });

    test('a provider type that cannot enumerate models returns 400', async () => {
      // Authorization is reached and passed first — this 400 is the provider
      // type's answer, not a permission problem.
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/ai-providers/${azureProviderId}/models`
      );
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('MODEL_LISTING_UNSUPPORTED');
    });

    test('a vertex provider with no project configured returns 400', async () => {
      // Fails on the missing config before any network call, so this asserts the
      // misconfiguration path without reaching Google.
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/ai-providers/${vertexProviderId}/models`
      );
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('AI_PROVIDER_MISCONFIGURED');
    });

    test('an API-key provider with no secret linked returns 400', async () => {
      // An OpenAI-family listing needs the record's own key, so a secret-less
      // record cannot list — while `vertex`/`bedrock` resolve credentials from
      // the environment, which is why the vertex case above complains about
      // `config.project` rather than a missing key.
      const openaiRes = await authenticatedTestClient(userToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'OpenAI Listing No Secret',
          provider: 'openai',
          default_model: 'gpt-4o',
        });
      expect(openaiRes.body.secret_id).toBeNull();

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/ai-providers/${openaiRes.body.id}/models`
      );
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('AI_PROVIDER_MISCONFIGURED');
      expect(response.body.error.message).toMatch(/API key/i);
    });
  });
});
