import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

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
      expect(response.body.error).toBe('Invalid secret ID');
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

      test('rejects a non-future effective_from with 400', async () => {
        const res = await authenticatedTestClient(userToken)
          .put(`/api/v1/ai-providers/${pricedProviderId}/prices`)
          .send({
            prices: [
              {
                model: 'gpt-4o',
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
});
