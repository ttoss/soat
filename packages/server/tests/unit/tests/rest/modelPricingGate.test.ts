import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * `require_priced_model`: a project that refuses to start a generation whose
 * model no price row covers, so spend it cannot measure is never incurred.
 *
 * Driven through the real generation entry point against a local
 * OpenAI-compatible stub (the `modelRouteFailover.test.ts` pattern), because
 * the claim under test is that the provider is never called — only a stub that
 * counts its requests can show that.
 *
 * Each test provisions its own project, provider and model name: the flag is
 * project-wide and price rows are keyed by `(provider, model)`, so shared ones
 * would make the tests read each other's state.
 */

const ACTIONS = [
  'ai-providers:CreateAiProvider',
  'model-routes:CreateModelRoute',
  'agents:CreateAgent',
  'agents:CreateAgentGeneration',
];

const PRICED_COMPONENTS = ['input_tokens', 'output_tokens'];

type LlmStub = {
  baseUrl: string;
  requests: () => number;
  close: () => Promise<void>;
};

const startLlmStub = async (): Promise<LlmStub> => {
  let requests = 0;
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-priced',
          object: 'chat.completion',
          created: 0,
          model: 'stub-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'served' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        })
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests: () => {
      return requests;
    },
    close: () => {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => {
          return error ? reject(error) : resolve();
        });
      });
    },
  };
};

type UnpricedRow = { provider: string; model: string; component: string };

describe('require_priced_model', () => {
  let adminToken: string;
  let userToken: string;
  let stub: LlmStub;

  beforeAll(async () => {
    stub = await startLlmStub();
    const setup = await setupProjectWithUsers({
      prefix: 'pricedmodel',
      policyActions: ACTIONS,
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
  });

  afterAll(async () => {
    await stub.close();
  });

  const createProject = async (args: {
    name: string;
    requirePricedModel?: boolean;
  }): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: args.name });
    expect(res.status).toBe(201);
    const projectId = res.body.id as string;

    if (args.requirePricedModel !== undefined) {
      const patch = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/projects/${projectId}`)
        .send({ require_priced_model: args.requirePricedModel });
      expect(patch.status).toBe(200);
    }

    return projectId;
  };

  const createProvider = async (args: {
    projectId: string;
    name: string;
    model: string;
  }): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: args.projectId,
        name: args.name,
        provider: 'ollama',
        default_model: args.model,
        base_url: stub.baseUrl,
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createAgent = async (args: {
    projectId: string;
    name: string;
    aiProviderId?: string;
    modelRouteId?: string;
  }): Promise<string> => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/agents')
      .send({
        project_id: args.projectId,
        name: args.name,
        ...(args.aiProviderId ? { ai_provider_id: args.aiProviderId } : {}),
        ...(args.modelRouteId ? { model_route_id: args.modelRouteId } : {}),
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const priceModel = async (args: {
    model: string;
    components?: string[];
  }): Promise<void> => {
    const res = await authenticatedTestClient(adminToken)
      .put('/api/v1/usage/prices')
      .send({
        prices: (args.components ?? PRICED_COMPONENTS).map((component) => {
          return {
            provider: 'ollama',
            model: args.model,
            component,
            unit: 'token',
            unit_price: 0.000001,
            effective_from: new Date(Date.now() - 60_000).toISOString(),
          };
        }),
      });
    expect(res.status).toBe(200);
  };

  const generate = async (agentId: string) => {
    return authenticatedTestClient(userToken)
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'hello' }] });
  };

  test('an unpriced model runs while the project does not require pricing', async () => {
    const projectId = await createProject({ name: 'priced-off' });
    const agentId = await createAgent({
      projectId,
      name: 'priced-off agent',
      aiProviderId: await createProvider({
        projectId,
        name: 'priced-off provider',
        model: 'unpriced-default-model',
      }),
    });

    const response = await generate(agentId);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('completed');
  });

  test('refuses an unpriced model and never calls the provider', async () => {
    const projectId = await createProject({
      name: 'priced-refuse',
      requirePricedModel: true,
    });
    const agentId = await createAgent({
      projectId,
      name: 'priced-refuse agent',
      aiProviderId: await createProvider({
        projectId,
        name: 'priced-refuse provider',
        model: 'unpriced-refused-model',
      }),
    });
    const before = stub.requests();

    const response = await generate(agentId);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('MODEL_NOT_PRICED');
    expect(response.body.error.meta.unpriced_rows).toEqual(
      PRICED_COMPONENTS.map((component) => {
        return {
          provider: 'ollama',
          model: 'unpriced-refused-model',
          component,
        };
      })
    );
    // The refusal is the point: no provider call, so nothing to meter.
    expect(stub.requests()).toBe(before);
  });

  test('runs once every billable component carries a price', async () => {
    const projectId = await createProject({
      name: 'priced-allow',
      requirePricedModel: true,
    });
    await priceModel({ model: 'fully-priced-model' });
    const agentId = await createAgent({
      projectId,
      name: 'priced-allow agent',
      aiProviderId: await createProvider({
        projectId,
        name: 'priced-allow provider',
        model: 'fully-priced-model',
      }),
    });

    const response = await generate(agentId);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('completed');
  });

  test('names the one component no price row covers', async () => {
    // A model priced for input and not output produces an event that carries a
    // real cost understating itself, which no event-level check can see.
    const projectId = await createProject({
      name: 'priced-partial',
      requirePricedModel: true,
    });
    await priceModel({
      model: 'half-priced-model',
      components: ['input_tokens'],
    });
    const agentId = await createAgent({
      projectId,
      name: 'priced-partial agent',
      aiProviderId: await createProvider({
        projectId,
        name: 'priced-partial provider',
        model: 'half-priced-model',
      }),
    });

    const response = await generate(agentId);

    expect(response.status).toBe(409);
    expect(response.body.error.meta.unpriced_rows).toEqual([
      {
        provider: 'ollama',
        model: 'half-priced-model',
        component: 'output_tokens',
      },
    ]);
  });

  test('refuses when a route target the turn may fail over to is unpriced', async () => {
    const projectId = await createProject({
      name: 'priced-route',
      requirePricedModel: true,
    });
    await priceModel({ model: 'routed-priced-model' });
    const routeRes = await authenticatedTestClient(userToken)
      .post('/api/v1/model-routes')
      .send({
        project_id: projectId,
        name: 'priced-route',
        targets: [
          {
            ai_provider_id: await createProvider({
              projectId,
              name: 'priced-route primary',
              model: 'routed-priced-model',
            }),
            model: 'routed-priced-model',
          },
          {
            ai_provider_id: await createProvider({
              projectId,
              name: 'priced-route fallback',
              model: 'routed-unpriced-model',
            }),
            model: 'routed-unpriced-model',
          },
        ],
      });
    expect(routeRes.status).toBe(201);
    const agentId = await createAgent({
      projectId,
      name: 'priced-route agent',
      modelRouteId: routeRes.body.id,
    });

    const response = await generate(agentId);

    expect(response.status).toBe(409);
    // The priced primary does not excuse the fallback: a failover spends on
    // whichever target answers.
    expect(
      response.body.error.meta.unpriced_rows.map((row: UnpricedRow) => {
        return row.model;
      })
    ).toEqual(['routed-unpriced-model', 'routed-unpriced-model']);
  });
});
