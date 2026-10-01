import type { Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

type Component = {
  component: string;
  quantity: number;
  cost_usd: number | null;
};

type UsageEvent = {
  generation_id: string | null;
  agent_id: string | null;
  cost_usd: number | null;
  components: Component[];
};

/**
 * A project prices an agent it owns with resource rows: each adds a component
 * to the agent's `llm_tokens` events beside the provider cost, its quantity
 * read off the turn. A turn through a share carries the owner's provider cost
 * plus the owner's resource component.
 */
describe('Agent resource prices', () => {
  let providerStub: Server;
  let adminToken: string;
  let publisherId: string;
  let granteeId: string;
  let granteeKey: string;
  let providerId: string;
  let unpricedProviderId: string;
  let agentCount = 0;

  const admin = () => {
    return authenticatedTestClient(adminToken);
  };

  const grantee = () => {
    return authenticatedTestClient(granteeKey);
  };

  // An OpenAI-compatible chat endpoint, which accepts image and audio parts.
  const startProviderStub = async (): Promise<string> => {
    providerStub = createServer((req, res: ServerResponse) => {
      req.resume();
      req.on('end', () => {
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
                message: { role: 'assistant', content: 'converted text' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
          })
        );
      });
    });
    await new Promise<void>((resolve) => {
      providerStub.listen(0, '127.0.0.1', resolve);
    });
    const { port } = providerStub.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  const srn = (agentId: string) => {
    return `srn:${publisherId}:agent:${agentId}`;
  };

  /** An agent of P priced by one resource row, shared with Q and accepted. */
  const pricedSharedAgent = async (row: {
    component?: string;
    quantity?: unknown;
    unitPrice?: number;
    aiProviderId?: string;
  }) => {
    agentCount += 1;
    const agent = await admin()
      .post('/api/v1/agents')
      .send({
        project_id: publisherId,
        name: `Priced Agent ${String(agentCount)}`,
        ai_provider_id: row.aiProviderId ?? providerId,
        model: 'stub-model',
      });
    expect(agent.status).toBe(201);
    const priced = await admin()
      .put(`/api/v1/projects/${publisherId}/prices`)
      .send({
        prices: [
          {
            meter_type: 'llm_tokens',
            resource: srn(agent.body.id),
            component: row.component ?? 'turn',
            unit: 'count',
            ...(row.quantity === undefined ? {} : { quantity: row.quantity }),
            unit_price: row.unitPrice ?? 0.1,
            effective_from: '2026-01-01T00:00:00Z',
          },
        ],
      });
    expect(priced.status).toBe(200);
    const share = await admin()
      .post('/api/v1/shares')
      .send({
        project_id: publisherId,
        resource: srn(agent.body.id),
        actions: ['agents:CreateAgentGeneration'],
        grantee: granteeId,
      });
    await grantee().post(`/api/v1/shares/${share.body.id}/accept`);
    return agent.body.id as string;
  };

  const generate = async (agentId: string) => {
    const response = await grantee()
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'hello' }] });
    expect(response.status).toBe(200);
    return response.body.id as string;
  };

  const eventOf = async (filter: Record<string, string>) => {
    const res = await grantee()
      .get('/api/v1/usage/events')
      .query({ meter_type: 'llm_tokens', ...filter });
    expect(res.status).toBe(200);
    return (res.body.data as UsageEvent[])[0];
  };

  // The usage events' `agent_id` filter reaches the project's own agents only.
  const agentEvent = async (agentId: string) => {
    const res = await grantee()
      .get('/api/v1/usage/events')
      .query({ meter_type: 'llm_tokens' });
    expect(res.status).toBe(200);
    return (res.body.data as UsageEvent[]).find((event) => {
      return event.agent_id === agentId;
    });
  };

  const componentOf = (event: UsageEvent | undefined, name: string) => {
    return event?.components.find((component) => {
      return component.component === name;
    });
  };

  /** A converter turn on `contentType` through the shared agent `agentId`. */
  const convert = async (args: { agentId: string; contentType: string }) => {
    const glob = args.contentType;
    await admin().post('/api/v1/ingestion-rules').send({
      project_id: granteeId,
      content_type_glob: glob,
      agent_id: args.agentId,
    });
    const file = await admin()
      .post('/api/v1/files/upload')
      .attach('file', Buffer.from(`input as ${args.contentType}`), {
        filename: `${args.contentType.replace('/', '-')}.bin`,
        contentType: args.contentType,
      })
      .field('project_id', granteeId);
    expect(file.status).toBe(201);
    const ingest = await admin()
      .post('/api/v1/documents/ingest?wait=true')
      .send({ project_id: granteeId, file_id: file.body.id });
    expect(ingest.body).toMatchObject({ status: 'ready' });
  };

  beforeAll(async () => {
    const providerBaseUrl = await startProviderStub();
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'agentpriceadmin', password: 'supersecret' });
    adminToken = await loginAs('agentpriceadmin', 'supersecret');

    publisherId = (
      await admin().post('/api/v1/projects').send({ name: 'Publisher' })
    ).body.id;
    granteeId = (
      await admin().post('/api/v1/projects').send({ name: 'Grantee' })
    ).body.id;
    granteeKey = (
      await admin()
        .post('/api/v1/api-keys')
        .send({ name: 'Grantee key', project_id: granteeId })
    ).body.key;
    providerId = (
      await admin().post('/api/v1/ai-providers').send({
        project_id: publisherId,
        name: 'Stub provider',
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: providerBaseUrl,
      })
    ).body.id;
    unpricedProviderId = (
      await admin().post('/api/v1/ai-providers').send({
        project_id: publisherId,
        name: 'Unpriced stub provider',
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: providerBaseUrl,
      })
    ).body.id;
    const prices = await admin()
      .put(`/api/v1/ai-providers/${providerId}/prices`)
      .send({
        prices: ['input_tokens', 'output_tokens'].map((component, index) => {
          return {
            model: 'stub-model',
            component,
            unit: 'token',
            unit_price: index === 0 ? 0.001 : 0.002,
            effective_from: '2026-01-01T00:00:00Z',
          };
        }),
      });
    expect(prices.status).toBe(200);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      providerStub.close(() => {
        return resolve();
      });
    });
  });

  describe('PUT /api/v1/projects/:project_id/prices', () => {
    test("another project naming the owner's agent is 403", async () => {
      const agentId = await pricedSharedAgent({});

      const response = await admin()
        .put(`/api/v1/projects/${granteeId}/prices`)
        .send({
          prices: [
            {
              meter_type: 'llm_tokens',
              resource: srn(agentId),
              component: 'turn',
              unit: 'count',
              unit_price: 0.01,
              effective_from: '2026-01-01T00:00:00Z',
            },
          ],
        });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    test('an agent row prices llm_tokens only', async () => {
      const agentId = await pricedSharedAgent({});

      const response = await admin()
        .put(`/api/v1/projects/${publisherId}/prices`)
        .send({
          prices: [
            {
              meter_type: 'tool_execution',
              resource: srn(agentId),
              component: 'turn',
              unit: 'count',
              unit_price: 0.01,
              effective_from: '2026-01-01T00:00:00Z',
            },
          ],
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe("a shared agent's turn", () => {
    test("carries the owner's provider cost plus the resource component", async () => {
      const agentId = await pricedSharedAgent({});

      const generationId = await generate(agentId);

      const event = await eventOf({ generation_id: generationId });
      expect(componentOf(event, 'input_tokens')?.cost_usd).toBe(0.004);
      expect(componentOf(event, 'output_tokens')?.cost_usd).toBe(0.004);
      expect(componentOf(event, 'turn')).toMatchObject({
        quantity: 1,
        cost_usd: 0.1,
      });
      expect(event.cost_usd).toBe(0.108);
    });

    test('reads the usage off the response', async () => {
      const agentId = await pricedSharedAgent({
        quantity: { var: 'response.usage.output_tokens' },
      });

      const event = await eventOf({ generation_id: await generate(agentId) });

      expect(componentOf(event, 'turn')?.quantity).toBe(2);
    });

    test("reads the provider cost the turn's own rows produced", async () => {
      const agentId = await pricedSharedAgent({
        quantity: { '*': [{ var: 'response.cost_usd' }, 1000] },
        unitPrice: 0.5,
      });

      const event = await eventOf({ generation_id: await generate(agentId) });

      expect(componentOf(event, 'turn')).toMatchObject({
        quantity: 8,
        cost_usd: 4,
      });
    });

    test('reads a null provider cost when no provider row priced the tokens', async () => {
      const agentId = await pricedSharedAgent({
        quantity: {
          if: [{ '==': [{ var: 'response.cost_usd' }, null] }, 1, 0],
        },
        aiProviderId: unpricedProviderId,
      });

      const event = await eventOf({ generation_id: await generate(agentId) });

      expect(componentOf(event, 'turn')?.quantity).toBe(1);
    });

    test('reads steps, tool calls and the stop reason', async () => {
      const agentId = await pricedSharedAgent({
        quantity: {
          if: [
            { '==': [{ var: 'response.stop_reason' }, 'stop'] },
            {
              '+': [{ var: 'response.steps' }, { var: 'response.tool_calls' }],
            },
            100,
          ],
        },
      });

      const event = await eventOf({ generation_id: await generate(agentId) });

      expect(componentOf(event, 'turn')?.quantity).toBe(1);
    });
  });

  describe('input_modalities', () => {
    const modalityQuantity = (modality: string) => {
      return {
        if: [
          { in: [modality, { var: 'response.usage.input_modalities' }] },
          1,
          0,
        ],
      };
    };

    test.each([
      ['image', 'image/png'],
      ['audio', 'audio/wav'],
    ])('names %s on a turn with that part', async (modality, contentType) => {
      const agentId = await pricedSharedAgent({
        quantity: modalityQuantity(modality),
      });

      await convert({ agentId, contentType });

      const event = await agentEvent(agentId);
      expect(componentOf(event, 'turn')?.quantity).toBe(1);
    });

    test('a text-only turn names no image', async () => {
      const agentId = await pricedSharedAgent({
        quantity: modalityQuantity('image'),
      });

      const event = await eventOf({ generation_id: await generate(agentId) });

      expect(componentOf(event, 'turn')?.quantity).toBe(0);
    });
  });
});
