import { resetModelRouteBreakers } from 'src/lib/modelRouteBreaker';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import {
  type ChatCompletionsStub,
  startChatCompletionsStub,
  type StubReply,
  type StubResponder,
} from '../../fixtures/chatCompletionsStub';
import { authenticatedTestClient } from '../../testClient';

/**
 * A usage event is priced by `(ai_provider_id, model)`, so it must name the
 * model the provider served — never the route id, never the configured alias
 * when the provider answered with a versioned id. Driven end to end against a
 * local OpenAI-compatible stub.
 */

type UsageEvent = {
  model: string | null;
  ai_provider_id: string | null;
  cost_usd: number | null;
};

const USAGE = { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 };

// `model` omitted is a provider that sends no response metadata, which leaves
// the SDK to fill `response.modelId` from the model it called.
const completion = (args: {
  model?: string;
  content?: string;
  toolCall?: { id: string; name: string };
}): StubReply => {
  return {
    body: {
      id: 'chatcmpl-served',
      object: 'chat.completion',
      created: 0,
      ...(args.model !== undefined && { model: args.model }),
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: args.content ?? null,
            ...(args.toolCall && {
              tool_calls: [
                {
                  id: args.toolCall.id,
                  type: 'function',
                  function: { name: args.toolCall.name, arguments: '{}' },
                },
              ],
            }),
          },
          finish_reason: args.toolCall ? 'tool_calls' : 'stop',
        },
      ],
      usage: USAGE,
    },
  };
};

const streamed = (args: { model?: string; content: string }): StubReply => {
  const chunk = (payload: Record<string, unknown>): string => {
    return `data: ${JSON.stringify({
      id: 'chatcmpl-served-stream',
      object: 'chat.completion.chunk',
      created: 0,
      ...(args.model !== undefined && { model: args.model }),
      ...payload,
    })}\n\n`;
  };
  return {
    contentType: 'text/event-stream',
    body: Buffer.from(
      chunk({
        choices: [
          { index: 0, delta: { role: 'assistant', content: args.content } },
        ],
      }) +
        chunk({
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: USAGE,
        }) +
        'data: [DONE]\n\n'
    ),
  };
};

describe('Usage — the served model is what an event records', () => {
  let adminToken: string;
  let projectId: string;
  const stubs: ChatCompletionsStub[] = [];

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'usageserved',
      policyActions: [],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
  });

  beforeEach(() => {
    resetModelRouteBreakers();
  });

  afterAll(async () => {
    await Promise.all(
      stubs.map((stub) => {
        return stub.close();
      })
    );
  });

  const startStub = async (
    routes?: Record<string, StubResponder>
  ): Promise<ChatCompletionsStub> => {
    const stub = await startChatCompletionsStub({ routes });
    stubs.push(stub);
    return stub;
  };

  const createPricedProvider = async (args: {
    name: string;
    baseUrl: string;
    defaultModel: string;
    pricedModel: string;
  }): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: args.name,
        provider: 'ollama',
        default_model: args.defaultModel,
        base_url: args.baseUrl,
      });
    expect(res.status).toBe(201);
    const priceRes = await authenticatedTestClient(adminToken)
      .put(`/api/v1/ai-providers/${res.body.id}/prices`)
      .send({
        prices: [
          {
            model: args.pricedModel,
            component: 'input_tokens',
            unit: 'token',
            unit_price: 0.000001,
            effective_from: new Date(Date.now() - 1000).toISOString(),
          },
        ],
      });
    expect(priceRes.status).toBe(200);
    return res.body.id;
  };

  const createRoutedAgent = async (args: {
    name: string;
    providerId: string;
    model: string;
  }): Promise<string> => {
    const routeRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/model-routes')
      .send({
        project_id: projectId,
        name: args.name,
        targets: [{ ai_provider_id: args.providerId, model: args.model }],
      });
    expect(routeRes.status).toBe(201);
    const agentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        name: args.name,
        model_route_id: routeRes.body.id,
      });
    expect(agentRes.status).toBe(201);
    return agentRes.body.id;
  };

  // Metering a streamed turn is a side effect of the stream's end, so the
  // listing is polled until the event lands.
  const eventsWhere = async (
    query: Record<string, string>
  ): Promise<UsageEvent[]> => {
    let events: UsageEvent[] = [];
    for (let attempt = 0; attempt < 200 && events.length === 0; attempt++) {
      const res = await authenticatedTestClient(adminToken)
        .get('/api/v1/usage/events')
        .query({ ...query, meter_type: 'llm_tokens' });
      expect(res.status).toBe(200);
      events = res.body.data;
      if (events.length === 0) {
        await new Promise((resolve) => {
          return setTimeout(resolve, 25);
        });
      }
    }
    return events;
  };

  const latestGenerationOf = async (agentId: string): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .get('/api/v1/generations')
      .query({ agent_id: agentId });
    expect(res.status).toBe(200);
    return res.body.data[0].id;
  };

  describe('POST /api/v1/agents/{agent_id}/generate', () => {
    test('a routed target answering without a model id meters its own model, priced', async () => {
      const stub = await startStub();
      stub.reply(completion({ content: 'routed answer' }));
      const providerId = await createPricedProvider({
        name: 'usageserved-routed',
        baseUrl: stub.baseUrl,
        defaultModel: 'routed-model',
        pricedModel: 'routed-model',
      });
      const agentId = await createRoutedAgent({
        name: 'usageserved-routed',
        providerId,
        model: 'routed-model',
      });

      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/agents/${agentId}/generate?wait=true`)
        .send({ messages: [{ role: 'user', content: 'hello' }] });

      expect(res.status).toBe(200);
      expect(res.body.output.model).toBe('routed-model');
      const events = await eventsWhere({ generation_id: res.body.id });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        model: 'routed-model',
        ai_provider_id: providerId,
      });
      expect(events[0].cost_usd).not.toBeNull();
    });

    test('a streamed routed turn answering without a model id meters its own model, priced', async () => {
      const stub = await startStub();
      stub.reply(streamed({ content: 'streamed routed answer' }));
      const providerId = await createPricedProvider({
        name: 'usageserved-routed-stream',
        baseUrl: stub.baseUrl,
        defaultModel: 'routed-stream-model',
        pricedModel: 'routed-stream-model',
      });
      const agentId = await createRoutedAgent({
        name: 'usageserved-routed-stream',
        providerId,
        model: 'routed-stream-model',
      });

      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/agents/${agentId}/generate?wait=true`)
        .send({ messages: [{ role: 'user', content: 'hello' }], stream: true });

      expect(res.status).toBe(200);
      expect(res.text).toContain('streamed routed answer');
      const events = await eventsWhere({
        generation_id: await latestGenerationOf(agentId),
      });
      expect(events).toHaveLength(1);
      expect(events[0].model).toBe('routed-stream-model');
      expect(events[0].cost_usd).not.toBeNull();
    });

    test('a failed segment meters the versioned model the provider served, as success does', async () => {
      const stub = await startStub({
        '/forecast': () => {
          return { body: { temperature: 21 } };
        },
      });
      stub.reply(
        completion({
          model: 'pinned-model-2026',
          toolCall: { id: 'call_1', name: 'usageserved_forecast' },
        }),
        { status: 400, body: { error: { message: 'refused' } } }
      );
      const providerId = await createPricedProvider({
        name: 'usageserved-failed',
        baseUrl: stub.baseUrl,
        defaultModel: 'pinned-model',
        pricedModel: 'pinned-model-2026',
      });
      const toolRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'usageserved_forecast',
          type: 'http',
          description: 'Returns the forecast',
          parameters: { type: 'object', properties: {} },
          execute: { url: `${stub.baseUrl}/forecast`, method: 'GET' },
        });
      expect(toolRes.status).toBe(201);
      const agentRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          name: 'usageserved-failed',
          ai_provider_id: providerId,
          model: 'pinned-model',
          tool_bindings: [{ tool_id: toolRes.body.id }],
        });
      expect(agentRes.status).toBe(201);

      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/agents/${agentRes.body.id}/generate?wait=true`)
        .send({ messages: [{ role: 'user', content: 'forecast?' }] });

      expect(res.status).toBe(502);
      const events = await eventsWhere({
        generation_id: res.body.error.meta.generation_id,
      });
      expect(events).toHaveLength(1);
      expect(events[0].model).toBe('pinned-model-2026');
      expect(events[0].cost_usd).not.toBeNull();
    });
  });

  describe('POST /api/v1/chat/completions (stream: true)', () => {
    test('a streamed completion on the default model meters the model the provider served', async () => {
      const stub = await startStub();
      stub.reply(
        streamed({ model: 'chat-default-2026', content: 'streamed chat' })
      );
      const providerId = await createPricedProvider({
        name: 'usageserved-chat',
        baseUrl: stub.baseUrl,
        defaultModel: 'chat-default',
        pricedModel: 'chat-default-2026',
      });

      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/chat/completions')
        .send({
          ai_provider_id: providerId,
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        });

      expect(res.status).toBe(200);
      const events = await eventsWhere({ ai_provider_id: providerId });
      expect(events).toHaveLength(1);
      expect(events[0].model).toBe('chat-default-2026');
      expect(events[0].cost_usd).not.toBeNull();
    });
  });
});
