import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { resetModelRouteBreakers } from 'src/lib/modelRouteBreaker';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * End-to-end failover through the real agent generation entry point: the AI SDK
 * runs for real against local OpenAI-compatible stub servers (the
 * `memoryExtractionCompletion.test.ts` pattern), so the composite model, the retry
 * budget, the tool loop, and the client-tool resumption path all execute exactly
 * as they would against a live provider. Nothing owned is mocked.
 */

const ACTIONS = [
  'model-routes:CreateModelRoute',
  'ai-providers:CreateAiProvider',
  'tools:CreateTool',
  'agents:CreateAgent',
  'agents:CreateAgentGeneration',
  'generations:GetGeneration',
];

type StubReply = {
  status: number;
  body: unknown;
  /** Pre-serialized body + content type, for SSE replies. */
  raw?: { contentType: string; text: string };
};

type LlmStub = {
  baseUrl: string;
  requests: () => number;
  close: () => Promise<void>;
};

const chatCompletion = (args: {
  model: string;
  content?: string;
  toolCall?: { id: string; name: string; args: unknown };
}): StubReply => {
  return {
    status: 200,
    body: {
      id: 'chatcmpl-stub',
      object: 'chat.completion',
      created: 0,
      model: args.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: args.content ?? null,
            ...(args.toolCall
              ? {
                  tool_calls: [
                    {
                      id: args.toolCall.id,
                      type: 'function',
                      function: {
                        name: args.toolCall.name,
                        arguments: JSON.stringify(args.toolCall.args),
                      },
                    },
                  ],
                }
              : {}),
          },
          finish_reason: args.toolCall ? 'tool_calls' : 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  };
};

/** An OpenAI-compatible SSE reply: one content delta, then a stop chunk. */
const chatCompletionStream = (args: {
  model: string;
  content: string;
}): StubReply => {
  const chunk = (choice: Record<string, unknown>): string => {
    return `data: ${JSON.stringify({
      id: 'chatcmpl-stub',
      object: 'chat.completion.chunk',
      created: 0,
      model: args.model,
      choices: [choice],
    })}\n\n`;
  };

  return {
    status: 200,
    body: null,
    raw: {
      contentType: 'text/event-stream',
      text:
        chunk({
          index: 0,
          delta: { role: 'assistant', content: args.content },
          finish_reason: null,
        }) +
        chunk({ index: 0, delta: {}, finish_reason: 'stop' }) +
        'data: [DONE]\n\n',
    },
  };
};

/** An OpenAI-compatible stub whose reply is chosen per request number. */
const startLlmStub = async (
  replyFor: (requestNumber: number) => StubReply
): Promise<LlmStub> => {
  let requests = 0;
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests += 1;
      const reply = replyFor(requests);
      if (reply.raw) {
        res.writeHead(reply.status, { 'Content-Type': reply.raw.contentType });
        res.end(reply.raw.text);
        return;
      }
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.body));
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
        server.close((err) => {
          return err ? reject(err) : resolve();
        });
      });
    },
  };
};

describe('Model route failover through agent generation', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  const openServers: LlmStub[] = [];

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'mrfail',
      policyActions: ACTIONS,
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
  });

  beforeEach(() => {
    // Breaker state is process-wide and keyed by (provider, model); each test
    // provisions its own providers, but resetting keeps them independent of
    // ordering.
    resetModelRouteBreakers();
  });

  afterAll(async () => {
    await Promise.all(
      openServers.map((server) => {
        return server.close();
      })
    );
  });

  const track = (server: LlmStub): LlmStub => {
    openServers.push(server);
    return server;
  };

  const createProvider = async (args: {
    name: string;
    baseUrl: string;
    defaultModel: string;
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
    return res.body.id;
  };

  const createRoute = async (args: {
    name: string;
    targets: Array<Record<string, unknown>>;
    retryOn?: string[];
  }): Promise<string> => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/model-routes')
      .send({
        project_id: projectId,
        name: args.name,
        targets: args.targets,
        ...(args.retryOn ? { retry_on: args.retryOn } : {}),
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createRoutedAgent = async (args: {
    name: string;
    routeId: string;
    toolIds?: string[];
  }): Promise<string> => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        name: args.name,
        model_route_id: args.routeId,
        ...(args.toolIds
          ? {
              tool_bindings: args.toolIds.map((toolId) => {
                return { tool_id: toolId };
              }),
            }
          : {}),
      });
    expect(res.status).toBe(201);
    expect(res.body.ai_provider_id).toBeNull();
    return res.body.id;
  };

  const generate = (agentId: string, content = 'hello') => {
    return authenticatedTestClient(userToken)
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content }] });
  };

  test('a route-only agent completes via the second target when the first 500s', async () => {
    const failing = track(
      await startLlmStub(() => {
        return { status: 500, body: { error: 'provider on fire' } };
      })
    );
    const healthy = track(
      await startLlmStub(() => {
        return chatCompletion({
          model: 'healthy-model',
          content: 'served by the fallback',
        });
      })
    );

    const healthyProviderId = await createProvider({
      name: 'mrfail-basic-healthy',
      baseUrl: healthy.baseUrl,
      defaultModel: 'healthy-model',
    });
    const routeId = await createRoute({
      name: 'failover-basic',
      targets: [
        {
          ai_provider_id: await createProvider({
            name: 'mrfail-basic-failing',
            baseUrl: failing.baseUrl,
            defaultModel: 'failing-model',
          }),
          model: 'failing-model',
        },
        { ai_provider_id: healthyProviderId, model: 'healthy-model' },
      ],
    });
    const agentId = await createRoutedAgent({
      name: 'Failover Agent',
      routeId,
    });

    const res = await generate(agentId);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.output.content).toBe('served by the fallback');
    // The record names the target that actually answered.
    expect(res.body.output.model).toBe('healthy-model');
    // And the result attributes that model to the provider that served it,
    // never the dead primary the route abandoned.
    expect(res.body.ai_provider_id).toBe(healthyProviderId);
    expect(failing.requests()).toBe(1);
    expect(healthy.requests()).toBe(1);

    // The generation explains the failover: which target served, how many
    // fallbacks, and why each earlier attempt was abandoned.
    const record = await authenticatedTestClient(userToken).get(
      `/api/v1/generations/${res.body.id}`
    );
    expect(record.status).toBe(200);
    expect(record.body.routing).toMatchObject({
      route_id: routeId,
      target_index: 1,
      fallbacks: 1,
    });
    expect(record.body.routing.attempts).toHaveLength(2);
    expect(record.body.routing.attempts[0].error_class).toBe('provider_error');
    expect(record.body.routing.attempts[1].error_class).toBeUndefined();
    expect(record.body.routing.attempts[1].model).toBe('healthy-model');
  });

  test('a streaming generation fails over before the first token', async () => {
    const failing = track(
      await startLlmStub(() => {
        return { status: 503, body: { error: 'no tokens for you' } };
      })
    );
    const healthy = track(
      await startLlmStub(() => {
        return chatCompletionStream({
          model: 'healthy-model',
          content: 'streamed by the fallback',
        });
      })
    );

    const routeId = await createRoute({
      name: 'streaming-failover',
      targets: [
        {
          ai_provider_id: await createProvider({
            name: 'mrfail-stream-failing',
            baseUrl: failing.baseUrl,
            defaultModel: 'stream-failing-model',
          }),
          model: 'stream-failing-model',
        },
        {
          ai_provider_id: await createProvider({
            name: 'mrfail-stream-healthy',
            baseUrl: healthy.baseUrl,
            defaultModel: 'healthy-model',
          }),
          model: 'healthy-model',
        },
      ],
    });
    const agentId = await createRoutedAgent({
      name: 'Streaming Agent',
      routeId,
    });

    const res = await authenticatedTestClient(userToken)
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'hello' }], stream: true });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('streamed by the fallback');
    expect(res.text).toContain('[DONE]');
    expect(failing.requests()).toBe(1);
    expect(healthy.requests()).toBe(1);
  });

  test('a fully failed route records every burned attempt on the generation', async () => {
    const alwaysFailing = track(
      await startLlmStub(() => {
        return { status: 500, body: { error: 'down' } };
      })
    );

    const routeId = await createRoute({
      name: 'all-attempts-recorded',
      targets: [
        {
          ai_provider_id: await createProvider({
            name: 'mrfail-record-a',
            baseUrl: alwaysFailing.baseUrl,
            defaultModel: 'down-model',
          }),
          model: 'down-model',
          max_retries: 1,
        },
      ],
    });
    const agentId = await createRoutedAgent({
      name: 'Recorded Failure Agent',
      routeId,
    });

    const res = await generate(agentId);
    expect(res.status).toBe(502);

    // 1 attempt + 1 retry, and both are named on the failed generation — the
    // unmetered-failed-attempt gap is visible rather than silent.
    expect(alwaysFailing.requests()).toBe(2);

    const record = await authenticatedTestClient(userToken).get(
      `/api/v1/generations/${res.body.error.meta.generation_id}`
    );
    expect(record.status).toBe(200);
    expect(record.body.status).toBe('failed');
    expect(record.body.routing.route_id).toBe(routeId);
    expect(record.body.routing.target_index).toBeNull();
    expect(record.body.routing.attempts).toHaveLength(2);
    expect(
      record.body.routing.attempts.every(
        (attempt: { error_class?: string }) => {
          return attempt.error_class === 'provider_error';
        }
      )
    ).toBe(true);
  });

  test('route retries are not amplified by the SDK’s own retry loop', async () => {
    const alwaysFailing = track(
      await startLlmStub(() => {
        return { status: 500, body: { error: 'still on fire' } };
      })
    );

    const routeId = await createRoute({
      name: 'retry-budget',
      targets: [
        {
          ai_provider_id: await createProvider({
            name: 'mrfail-retry-failing',
            baseUrl: alwaysFailing.baseUrl,
            defaultModel: 'retry-model',
          }),
          model: 'retry-model',
          max_retries: 1,
        },
      ],
    });
    const agentId = await createRoutedAgent({ name: 'Retry Agent', routeId });

    const res = await generate(agentId);

    expect(res.status).toBe(502);
    // 1 attempt + 1 route retry. With the SDK default (maxRetries: 2) still in
    // play this would be 6.
    expect(alwaysFailing.requests()).toBe(2);
  });

  test('a deterministic 400 fails the generation without touching the next target', async () => {
    const rejecting = track(
      await startLlmStub(() => {
        return { status: 400, body: { error: { message: 'bad request' } } };
      })
    );
    const untouched = track(
      await startLlmStub(() => {
        return chatCompletion({ model: 'untouched-model', content: 'nope' });
      })
    );

    const routeId = await createRoute({
      name: 'deterministic-failure',
      targets: [
        {
          ai_provider_id: await createProvider({
            name: 'mrfail-det-rejecting',
            baseUrl: rejecting.baseUrl,
            defaultModel: 'rejecting-model',
          }),
          model: 'rejecting-model',
          max_retries: 2,
        },
        {
          ai_provider_id: await createProvider({
            name: 'mrfail-det-untouched',
            baseUrl: untouched.baseUrl,
            defaultModel: 'untouched-model',
          }),
          model: 'untouched-model',
        },
      ],
    });
    const agentId = await createRoutedAgent({
      name: 'Deterministic Agent',
      routeId,
    });

    const res = await generate(agentId);

    expect(res.status).toBe(502);
    expect(rejecting.requests()).toBe(1);
    expect(untouched.requests()).toBe(0);
  });

  test('failing over mid-run never re-executes an already-completed tool call', async () => {
    let toolCalls = 0;
    const toolServer = track(
      await startLlmStub(() => {
        toolCalls += 1;
        return { status: 200, body: { temperature: 21 } };
      })
    );

    // Target 0 answers step 1 with a tool call, then dies on the step-2 call.
    const failingAtStepTwo = track(
      await startLlmStub((requestNumber) => {
        return requestNumber === 1
          ? chatCompletion({
              model: 'step-model',
              toolCall: { id: 'call_1', name: 'get_weather', args: {} },
            })
          : { status: 503, body: { error: 'died between steps' } };
      })
    );
    const healthy = track(
      await startLlmStub(() => {
        return chatCompletion({
          model: 'healthy-model',
          content: 'it is 21 degrees',
        });
      })
    );

    const toolRes = await authenticatedTestClient(userToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'get_weather',
        type: 'http',
        description: 'Returns the weather',
        parameters: { type: 'object', properties: {} },
        execute: { url: `${toolServer.baseUrl}/weather`, method: 'GET' },
      });
    expect(toolRes.status).toBe(201);

    const routeId = await createRoute({
      name: 'mid-run-failover',
      targets: [
        {
          ai_provider_id: await createProvider({
            name: 'mrfail-step-failing',
            baseUrl: failingAtStepTwo.baseUrl,
            defaultModel: 'step-model',
          }),
          model: 'step-model',
        },
        {
          ai_provider_id: await createProvider({
            name: 'mrfail-step-healthy',
            baseUrl: healthy.baseUrl,
            defaultModel: 'healthy-model',
          }),
          model: 'healthy-model',
        },
      ],
    });
    const agentId = await createRoutedAgent({
      name: 'Multi Step Agent',
      routeId,
      toolIds: [toolRes.body.id],
    });

    const res = await generate(agentId, 'what is the weather?');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.output.content).toBe('it is 21 degrees');
    // The step-1 tool result survived the failover in the message history: the
    // fallback continued the run instead of restarting it.
    expect(toolCalls).toBe(1);
    expect(failingAtStepTwo.requests()).toBe(2);
    expect(healthy.requests()).toBe(1);
  });

  test('a route-only agent resumes a client-tool generation through the recovery path', async () => {
    // Target 0 pauses the run with a client tool call, then 500s on the
    // continuation so the resumption itself has to fail over — the recovery
    // path has no pinned provider to fall back on.
    const pausing = track(
      await startLlmStub((requestNumber) => {
        return requestNumber === 1
          ? chatCompletion({
              model: 'pause-model',
              toolCall: { id: 'call_client', name: 'ask_user', args: {} },
            })
          : { status: 500, body: { error: 'died on resume' } };
      })
    );
    const healthy = track(
      await startLlmStub(() => {
        return chatCompletion({
          model: 'healthy-model',
          content: 'thanks for the answer',
        });
      })
    );

    const toolRes = await authenticatedTestClient(userToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'ask_user',
        type: 'client',
        description: 'Asks the caller something',
        parameters: { type: 'object', properties: {} },
      });
    expect(toolRes.status).toBe(201);

    const routeId = await createRoute({
      name: 'client-tool-resumption',
      targets: [
        {
          ai_provider_id: await createProvider({
            name: 'mrfail-client-pausing',
            baseUrl: pausing.baseUrl,
            defaultModel: 'pause-model',
          }),
          model: 'pause-model',
        },
        {
          ai_provider_id: await createProvider({
            name: 'mrfail-client-healthy',
            baseUrl: healthy.baseUrl,
            defaultModel: 'healthy-model',
          }),
          model: 'healthy-model',
        },
      ],
    });
    const agentId = await createRoutedAgent({
      name: 'Client Tool Agent',
      routeId,
      toolIds: [toolRes.body.id],
    });

    const paused = await generate(agentId, 'ask me something');
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe('requires_action');
    const toolCall = paused.body.required_action.tool_calls[0];
    expect(toolCall.tool_name).toBe('ask_user');

    const resumed = await authenticatedTestClient(userToken)
      .post(`/api/v1/agents/${agentId}/generate/${paused.body.id}/tool-outputs`)
      .send({
        tool_outputs: [{ tool_call_id: toolCall.id, output: '42' }],
      });

    expect(resumed.status).toBe(200);
    expect(resumed.body.status).toBe('completed');
    expect(resumed.body.output.content).toBe('thanks for the answer');
    expect(healthy.requests()).toBe(1);
  });
});
