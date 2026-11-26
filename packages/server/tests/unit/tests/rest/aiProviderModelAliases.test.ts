import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import {
  type ChatCompletionsStub,
  startChatCompletionsStub,
  textCompletion,
} from '../../fixtures/chatCompletionsStub';
import { pollUntil } from '../../fixtures/poll';
import { authenticatedTestClient, testClient } from '../../testClient';

const ALIASES = { fast: 'vendor-fast-2026', smart: 'vendor-smart-2026' };

describe('AI provider model_aliases', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let stub: ChatCompletionsStub;
  let openProviderId: string;
  let closedProviderId: string;
  let builtinToolId: string;
  let counter = 0;

  const unique = (prefix: string): string => {
    counter += 1;
    return `${prefix}-${Date.now()}-${counter}`;
  };

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const createProvider = async (extra: Record<string, unknown>) => {
    return asAdmin()
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: unique('aliases-provider'),
        provider: 'ollama',
        base_url: stub.baseUrl,
        ...extra,
      });
  };

  const createAgent = async (args: { providerId: string; model?: string }) => {
    return asAdmin()
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        name: unique('aliases-agent'),
        ai_provider_id: args.providerId,
        ...(args.model !== undefined && { model: args.model }),
      });
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'modelaliases',
      policyActions: ['ai-providers:GetAiProvider'],
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
    stub = await startChatCompletionsStub();

    const open = await createProvider({
      default_model: 'fast',
      model_aliases: ALIASES,
    });
    expect(open.status).toBe(201);
    openProviderId = open.body.id;

    const closed = await createProvider({
      default_model: 'fast',
      model_aliases: ALIASES,
      model_aliases_only: true,
    });
    expect(closed.status).toBe(201);
    closedProviderId = closed.body.id;

    const builtin = await asAdmin()
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: unique('aliases-builtin'),
        type: 'builtin',
        actions: ['get-agent', 'create-agent'],
      });
    expect(builtin.status).toBe(201);
    builtinToolId = builtin.body.id;
  });

  afterAll(async () => {
    await stub.close();
  });

  describe('POST /api/v1/ai-providers', () => {
    test('stores the aliases and shows them on the read', async () => {
      const read = await asAdmin().get(
        `/api/v1/ai-providers/${openProviderId}`
      );
      expect(read.status).toBe(200);
      expect(read.body.model_aliases).toEqual(ALIASES);
      expect(read.body.model_aliases_only).toBe(false);
    });

    test('a provider with no aliases reads an empty map', async () => {
      const res = await createProvider({ default_model: 'plain-model' });
      expect(res.status).toBe(201);
      expect(res.body.model_aliases).toEqual({});
      expect(res.body.model_aliases_only).toBe(false);
    });

    test('an alias mapping to a non-string is 400', async () => {
      const res = await createProvider({
        default_model: 'fast',
        model_aliases: { fast: 3 },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a closed provider whose default_model is not an alias is 400', async () => {
      const res = await createProvider({
        default_model: 'vendor-fast-2026',
        model_aliases: ALIASES,
        model_aliases_only: true,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MODEL_NOT_OFFERED');
    });
  });

  describe('PATCH /api/v1/ai-providers/{ai_provider_id}', () => {
    test('401 without credentials', async () => {
      const res = await testClient
        .patch(`/api/v1/ai-providers/${openProviderId}`)
        .send({ model_aliases: { evil: 'x' } });
      expect(res.status).toBe(401);
    });

    test('403 without ai-providers:UpdateAiProvider', async () => {
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/ai-providers/${openProviderId}`)
        .send({ model_aliases: { evil: 'x' } });
      expect(res.status).toBe(403);
    });

    test('closing the catalog with a default_model outside it is 400', async () => {
      const created = await createProvider({ default_model: 'raw-model' });
      const res = await asAdmin()
        .patch(`/api/v1/ai-providers/${created.body.id}`)
        .send({ model_aliases: ALIASES, model_aliases_only: true });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MODEL_NOT_OFFERED');
    });

    test('null clears the aliases', async () => {
      const created = await createProvider({
        default_model: 'fast',
        model_aliases: ALIASES,
      });
      const res = await asAdmin()
        .patch(`/api/v1/ai-providers/${created.body.id}`)
        .send({ model_aliases: null });
      expect(res.status).toBe(200);
      expect(res.body.model_aliases).toEqual({});
    });
  });

  describe('POST /api/v1/agents/{agent_id}/generate', () => {
    test('an agent named by alias calls the vendor id and answers the alias everywhere', async () => {
      const agent = await createAgent({
        providerId: openProviderId,
        model: 'smart',
      });
      expect(agent.status).toBe(201);
      expect(agent.body.model).toBe('smart');

      stub.reply(textCompletion('aliased answer'));
      const before = stub.completions.length;
      const res = await asAdmin()
        .post(`/api/v1/agents/${agent.body.id}/generate?wait=true`)
        .send({ messages: [{ role: 'user', content: 'hello' }] });

      expect(res.status).toBe(200);
      expect(stub.completions[before].body.model).toBe('vendor-smart-2026');
      expect(res.body.output.model).toBe('smart');

      const read = await asAdmin().get(`/api/v1/agents/${agent.body.id}`);
      expect(read.body.model).toBe('smart');

      const events = await pollUntil({
        read: async () => {
          const usage = await asAdmin()
            .get('/api/v1/usage/events')
            .query({ generation_id: res.body.id, meter_type: 'llm_tokens' });
          return usage.body.data as Array<{ model: string }>;
        },
        done: (found) => {
          return found.length > 0;
        },
      });
      expect(events).toHaveLength(1);
      expect(events[0].model).toBe('smart');
    });

    test('a streamed turn answers the alias', async () => {
      const agent = await createAgent({ providerId: openProviderId });
      stub.reply(textCompletion('streamed aliased answer'));
      const before = stub.completions.length;
      const res = await asAdmin()
        .post(`/api/v1/agents/${agent.body.id}/generate?wait=true`)
        .send({
          messages: [{ role: 'user', content: 'hello' }],
          stream: true,
        });
      expect(res.status).toBe(200);
      expect(stub.completions[before].body.model).toBe('vendor-fast-2026');
      expect(res.text).not.toContain('vendor-fast-2026');
    });
  });

  describe('POST /api/v1/chat/completions', () => {
    test('a request model outside a closed catalog is 400 and never reaches the vendor', async () => {
      const before = stub.completions.length;
      const res = await asAdmin()
        .post('/api/v1/chat/completions')
        .send({
          ai_provider_id: closedProviderId,
          model: 'vendor-fast-2026',
          messages: [{ role: 'user', content: 'hello' }],
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MODEL_NOT_OFFERED');
      expect(stub.completions.length).toBe(before);
    });

    test('a request model named by alias answers the alias', async () => {
      stub.reply(textCompletion('chat aliased answer'));
      const before = stub.completions.length;
      const res = await asAdmin()
        .post('/api/v1/chat/completions')
        .send({
          ai_provider_id: openProviderId,
          model: 'smart',
          messages: [{ role: 'user', content: 'hello' }],
        });
      expect(res.status).toBe(200);
      expect(stub.completions[before].body.model).toBe('vendor-smart-2026');
      expect(res.body.model).toBe('smart');
    });
  });

  describe('a model outside a closed catalog', () => {
    test('POST /api/v1/agents is 400', async () => {
      const res = await createAgent({
        providerId: closedProviderId,
        model: 'vendor-fast-2026',
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MODEL_NOT_OFFERED');
    });

    test('PATCH /api/v1/agents/{agent_id} is 400', async () => {
      const agent = await createAgent({ providerId: closedProviderId });
      const res = await asAdmin()
        .patch(`/api/v1/agents/${agent.body.id}`)
        .send({ model: 'other' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MODEL_NOT_OFFERED');
    });

    test('POST /api/v1/model-routes is 400', async () => {
      const res = await asAdmin()
        .post('/api/v1/model-routes')
        .send({
          project_id: projectId,
          name: unique('aliases-route'),
          targets: [{ ai_provider_id: closedProviderId, model: 'other' }],
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MODEL_NOT_OFFERED');
    });

    test('a builtin create-agent is refused by the 400 of the call it makes', async () => {
      const res = await asAdmin()
        .post(`/api/v1/tools/${builtinToolId}/call`)
        .send({
          action: 'create-agent',
          input: {
            project_id: projectId,
            name: unique('aliases-builtin-agent'),
            ai_provider_id: closedProviderId,
            model: 'other',
          },
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MODEL_NOT_OFFERED');
    });

    test('a formation agent fails its apply with MODEL_NOT_OFFERED', async () => {
      const res = await asAdmin()
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: unique('aliases-formation'),
          template: {
            resources: {
              Closed: {
                type: 'agent',
                properties: {
                  name: unique('aliases-formation-agent'),
                  ai_provider_id: closedProviderId,
                  model: 'other',
                },
              },
            },
          },
        });
      expect(res.body.status).toBe('failed');
      expect(res.body.error.code).toBe('MODEL_NOT_OFFERED');
    });
  });

  describe('GET /api/v1/ai-providers/{ai_provider_id}/models', () => {
    const listIds = async (args: {
      providerId: string;
      query?: Record<string, string>;
    }) => {
      const res = await asAdmin()
        .get(`/api/v1/ai-providers/${args.providerId}/models`)
        .query(args.query ?? {});
      expect(res.status).toBe(200);
      return res.body.data.map((model: { id: string }) => {
        return model.id;
      });
    };

    test('a closed catalog lists its aliases without calling the vendor', async () => {
      const before = stub.routeRequests.length + stub.completions.length;
      expect(await listIds({ providerId: closedProviderId })).toEqual([
        'fast',
        'smart',
      ]);
      expect(stub.routeRequests.length + stub.completions.length).toBe(before);
    });

    test('q and paging apply to the aliases', async () => {
      expect(
        await listIds({ providerId: closedProviderId, query: { q: 'SMA' } })
      ).toEqual(['smart']);
      expect(
        await listIds({ providerId: closedProviderId, query: { limit: '1' } })
      ).toEqual(['fast']);
    });

    test('an open catalog still asks the vendor', async () => {
      const res = await asAdmin().get(
        `/api/v1/ai-providers/${openProviderId}/models`
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MODEL_LISTING_UNSUPPORTED');
    });
  });

  test('a builtin get-agent answers the alias', async () => {
    const agent = await createAgent({
      providerId: closedProviderId,
      model: 'smart',
    });
    expect(agent.status).toBe(201);
    const res = await asAdmin()
      .post(`/api/v1/tools/${builtinToolId}/call`)
      .send({ action: 'get-agent', input: { agent_id: agent.body.id } });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('"model":"smart"');
  });
});
