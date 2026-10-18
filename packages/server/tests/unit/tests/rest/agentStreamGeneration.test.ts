import type http from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { eventBus, type SoatEvent } from 'src/lib/eventBus';
import * as generationsModule from 'src/lib/generations';
import * as tracesModule from 'src/lib/traces';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * A streamed generation (`stream: true`) persists everything after the last
 * chunk has gone down the wire: the trace, the terminal status and the stop
 * reason. Asserted on the generation record and on the request the provider
 * received, because the stream itself reads the same either way.
 *
 * The provider is a local fake streaming the OpenAI chat-completions SSE shape;
 * each test sets the text it streams.
 */
describe('Streamed agent generations', () => {
  let adminToken: string;
  let projectId: string;
  let aiProviderId: string;
  let weatherToolId: string;
  let newsToolId: string;
  let modelServer: http.Server;
  let requestBodies: Array<Record<string, unknown>> = [];
  let streamedText = 'It is sunny in Lisbon.';
  // When set, the streamed step ends on this tool call instead of `stop`.
  let streamedToolCall: { name: string; args: unknown } | undefined;
  let agentCount = 0;

  const WEATHER_TOOL = 'lookup_weather';
  const NEWS_TOOL = 'lookup_news';

  const writeStream = (res: http.ServerResponse): void => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const chunk = (delta: Record<string, unknown>, finish: string | null) => {
      return {
        id: 'chatcmpl-stream',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'stub-model',
        choices: [{ index: 0, delta, finish_reason: finish }],
      };
    };
    res.write(
      `data: ${JSON.stringify(chunk({ role: 'assistant', content: streamedText }, null))}\n\n`
    );
    const toolCall = streamedToolCall;
    streamedToolCall = undefined;
    if (toolCall) {
      res.write(
        `data: ${JSON.stringify(
          chunk(
            {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_stream_1',
                  type: 'function',
                  function: {
                    name: toolCall.name,
                    arguments: JSON.stringify(toolCall.args),
                  },
                },
              ],
            },
            null
          )
        )}\n\n`
      );
    }
    res.write(
      `data: ${JSON.stringify(chunk({}, toolCall ? 'tool_calls' : 'stop'))}\n\n`
    );
    res.write('data: [DONE]\n\n');
    res.end();
  };

  // A resume after `tool-outputs` runs unstreamed.
  const writeCompletion = (res: http.ServerResponse): void => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-resume',
        object: 'chat.completion',
        created: 0,
        model: 'stub-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'The manager agreed.' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    );
  };

  const createTool = async (name: string): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name,
        type: 'http',
        description: `The ${name} tool`,
        parameters: { type: 'object', properties: {} },
        execute: { url: 'http://127.0.0.1:1/unused', method: 'POST' },
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const createAgent = async (
    extra: Record<string, unknown> = {}
  ): Promise<string> => {
    agentCount += 1;
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: aiProviderId,
        name: `stream agent ${agentCount}`,
        tool_bindings: [{ tool_id: weatherToolId }, { tool_id: newsToolId }],
        ...extra,
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const stream = async (agentId: string) => {
    requestBodies = [];
    const res = await authenticatedTestClient(adminToken)
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({
        messages: [{ role: 'user', content: 'weather?' }],
        stream: true,
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    return res;
  };

  type Generation = {
    id: string;
    status: string;
    stop_reason: string | null;
    trace_id: string;
    error: { code?: string } | null;
  };

  /** The agent's one generation, once its terminal status has been written. */
  const settledGenerationOf = async (agentId: string): Promise<Generation> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const res = await authenticatedTestClient(adminToken)
        .get('/api/v1/generations')
        .query({ agent_id: agentId });
      expect(res.status).toBe(200);
      const [generation] = res.body.data as Generation[];
      if (generation && generation.status !== 'running') return generation;
      await new Promise((resolve) => {
        return setTimeout(resolve, 25);
      });
    }
    throw new Error(`no settled generation for ${agentId}`);
  };

  /**
   * Streams one turn while collecting `generations.*` events, and waits until
   * its record is settled. The completed event follows the settled record, so
   * the wait also gives it time to arrive.
   */
  const streamCollectingEvents = async (agentId: string) => {
    const events: SoatEvent[] = [];
    const handler = (event: SoatEvent) => {
      if (event.type.startsWith('generations.')) events.push(event);
    };
    eventBus.on('soat:event', handler);
    try {
      await stream(agentId);
      const generation = await settledGenerationOf(agentId);
      const settled = () => {
        return events.some((event) => {
          return event.resourceId === generation.id;
        });
      };
      for (let tick = 0; tick < 200 && !settled(); tick += 1) {
        await new Promise((resolve) => {
          return setTimeout(resolve, 10);
        });
      }
      return {
        generation,
        events: events.filter((event) => {
          return event.resourceId === generation.id;
        }),
      };
    } finally {
      eventBus.off('soat:event', handler);
    }
  };

  const offeredToolNames = (body: Record<string, unknown>): string[] => {
    const tools = Array.isArray(body.tools) ? body.tools : [];
    return tools
      .map((tool: { function?: { name?: string } }) => {
        return tool.function?.name ?? '';
      })
      .sort();
  };

  beforeAll(async () => {
    modelServer = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        requestBodies.push(body);
        if (body.stream) {
          writeStream(res);
        } else {
          writeCompletion(res);
        }
      });
    });
    await new Promise<void>((resolve) => {
      modelServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = modelServer.address() as AddressInfo;

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'streamgenadmin', password: 'supersecret' });
    adminToken = await loginAs('streamgenadmin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Stream Generation Project' });
    projectId = projectRes.body.id as string;

    const providerRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'stream provider',
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: `http://127.0.0.1:${port}`,
      });
    expect(providerRes.status).toBe(201);
    aiProviderId = providerRes.body.id as string;

    weatherToolId = await createTool(WEATHER_TOOL);
    newsToolId = await createTool(NEWS_TOOL);
  });

  afterEach(() => {
    streamedText = 'It is sunny in Lisbon.';
    streamedToolCall = undefined;
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      modelServer.close(() => {
        return resolve();
      });
    });
  });

  describe('POST /api/v1/agents/{agent_id}/generate (stream: true)', () => {
    test('a streamed answer is recorded completed', async () => {
      const agentId = await createAgent();

      const res = await stream(agentId);

      expect(res.text).toContain('It is sunny in Lisbon.');
      expect(res.text).toContain('[DONE]');
      const generation = await settledGenerationOf(agentId);
      expect(generation.status).toBe('completed');
      expect(generation.stop_reason).toBe('stop');
      expect(generation.error).toBeNull();
    });

    // The agent names no model, so it runs its provider's default: the meter
    // records the model the provider served, which is what a price matches.
    test('a streamed turn of an agent with no model meters the served model, priced', async () => {
      const priceRes = await authenticatedTestClient(adminToken)
        .put(`/api/v1/ai-providers/${aiProviderId}/prices`)
        .send({
          prices: [
            {
              model: 'stub-model',
              component: 'input_tokens',
              unit: 'token',
              unit_price: 0.000001,
              effective_from: new Date(Date.now() - 1000).toISOString(),
            },
          ],
        });
      expect(priceRes.status).toBe(200);
      const agentId = await createAgent();

      await stream(agentId);
      const generation = await settledGenerationOf(agentId);

      let events: Array<{ model: string | null; cost_usd: number | null }> = [];
      for (let attempt = 0; attempt < 200 && events.length === 0; attempt++) {
        const res = await authenticatedTestClient(adminToken)
          .get('/api/v1/usage/events')
          .query({ generation_id: generation.id, meter_type: 'llm_tokens' });
        expect(res.status).toBe(200);
        events = res.body.data;
        if (events.length === 0) {
          await new Promise((resolve) => {
            return setTimeout(resolve, 25);
          });
        }
      }
      expect(events).toHaveLength(1);
      expect(events[0].model).toBe('stub-model');
      expect(events[0].cost_usd).not.toBeNull();
    });

    test('a streamed answer emits generations.completed once, carrying its record', async () => {
      const agentId = await createAgent();

      const { generation, events } = await streamCollectingEvents(agentId);

      expect(
        events.map((event) => {
          return event.type;
        })
      ).toEqual(['generations.completed']);
      const [event] = events;
      expect(event.assistantContent).toBe('It is sunny in Lisbon.');
      const record = await authenticatedTestClient(adminToken).get(
        `/api/v1/generations/${generation.id}`
      );
      expect(JSON.parse(JSON.stringify(event.data))).toEqual(record.body);
      expect(event.data.status).toBe('completed');
    });

    test('a streamed answer recorded failed emits no generations.completed', async () => {
      streamedText =
        '```json\n{"name": "lookup_weather", "arguments": {}}\n```';
      const agentId = await createAgent();

      const { generation, events } = await streamCollectingEvents(agentId);

      expect(generation.status).toBe('failed');
      expect(
        events.filter((event) => {
          return event.type === 'generations.completed';
        })
      ).toEqual([]);
    });

    test('a streamed tool call the model wrote out as text is recorded failed', async () => {
      // The blob has already been delivered and cannot be recalled; the record
      // is what can still say it was not an answer.
      streamedText =
        '```json\n{"name": "lookup_weather", "arguments": {}}\n```';
      const agentId = await createAgent();

      const res = await stream(agentId);

      expect(res.text).toContain('lookup_weather');
      const generation = await settledGenerationOf(agentId);
      expect(generation.status).toBe('failed');
      expect(generation.stop_reason).toBe('error');
      expect(generation.error).toMatchObject({
        code: 'TEXT_ENCODED_TOOL_CALL',
      });

      const trace = await authenticatedTestClient(adminToken).get(
        `/api/v1/traces/${generation.trace_id}`
      );
      expect(trace.status).toBe(200);
      expect(trace.body.error).toMatchObject({
        code: 'TEXT_ENCODED_TOOL_CALL',
      });
    });

    test("the agent's tool_choice reaches the streamed request", async () => {
      const agentId = await createAgent({
        tool_choice: { type: 'tool', tool_name: WEATHER_TOOL },
        stop_conditions: [{ type: 'has_tool_call', tool_name: WEATHER_TOOL }],
      });

      await stream(agentId);

      expect(requestBodies[0].tool_choice).toEqual({
        type: 'function',
        function: { name: WEATHER_TOOL },
      });
    });

    test("a step rule's tool_choice and active tools apply to a streamed step", async () => {
      const agentId = await createAgent({
        step_rules: [
          { step: 1, tool_choice: 'none', active_tool_ids: [newsToolId] },
        ],
      });

      await stream(agentId);

      expect(requestBodies[0].tool_choice).toBe('none');
      expect(offeredToolNames(requestBodies[0])).toEqual([NEWS_TOOL]);
    });

    test('a status write that fails after the stream does not break it', async () => {
      // Drives the swallow on the fire-and-forget completion write; the
      // generation itself runs on the real database.
      const agentId = await createAgent();
      jest
        .spyOn(generationsModule, 'updateGenerationRecord')
        .mockRejectedValueOnce(new Error('status write failed'));

      const res = await stream(agentId);

      expect(res.text).toContain('It is sunny in Lisbon.');
      expect(res.text).toContain('[DONE]');
    });

    test('a trace write that fails after the stream does not break it', async () => {
      // Drives the swallow on the fire-and-forget trace write.
      const agentId = await createAgent();
      jest
        .spyOn(tracesModule, 'saveTrace')
        .mockRejectedValueOnce(new Error('trace write failed'));

      const res = await stream(agentId);

      expect(res.text).toContain('It is sunny in Lisbon.');
      expect(res.text).toContain('[DONE]');
      const generation = await settledGenerationOf(agentId);
      expect(generation.status).toBe('completed');
    });
  });

  describe('POST /api/v1/agents/{agent_id}/generate (stream: true) — client tool', () => {
    const CLIENT_TOOL = 'ask_manager';
    let clientAgentId: string;

    /** Every `data:` payload, `[DONE]` excluded. */
    const framesOf = (text: string): Array<Record<string, unknown>> => {
      return text
        .split('\n')
        .filter((line) => {
          return line.startsWith('data: ') && line !== 'data: [DONE]';
        })
        .map((line) => {
          return JSON.parse(line.slice('data: '.length)) as Record<
            string,
            unknown
          >;
        });
    };

    beforeAll(async () => {
      const toolRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: CLIENT_TOOL,
          type: 'client',
          description: 'Asks the manager',
          parameters: {
            type: 'object',
            properties: { question: { type: 'string' } },
          },
        });
      expect(toolRes.status).toBe(201);
      clientAgentId = await createAgent({
        tool_bindings: [
          { tool_id: weatherToolId },
          { tool_id: toolRes.body.id },
        ],
      });
    });

    const streamPausedTurn = async () => {
      streamedText = 'Let me check with the manager.';
      streamedToolCall = { name: CLIENT_TOOL, args: { question: 'refund?' } };
      return stream(clientAgentId);
    };

    test('the stream ends on a requires_action frame naming the pending call', async () => {
      const res = await streamPausedTurn();

      expect(res.text).toContain('Let me check with the manager.');
      expect(res.text).toContain('[DONE]');
      const last = framesOf(res.text).at(-1) as {
        id: string;
        status: string;
        trace_id: string;
        required_action: {
          type: string;
          tool_calls: Array<{ id: string; tool_name: string; args: unknown }>;
        };
      };
      expect(last.id).toMatch(/^gen_/);
      expect(last.trace_id).toBeDefined();
      expect(last.status).toBe('requires_action');
      expect(last.required_action).toEqual({
        type: 'submit_tool_outputs',
        tool_calls: [
          {
            id: 'call_stream_1',
            tool_name: CLIENT_TOOL,
            args: { question: 'refund?' },
          },
        ],
      });

      const record = await authenticatedTestClient(adminToken).get(
        `/api/v1/generations/${last.id}`
      );
      expect(record.body.status).toBe('requires_action');
    });

    test('tool-outputs resumes the paused streamed turn', async () => {
      const res = await streamPausedTurn();
      const last = framesOf(res.text).at(-1) as { id: string };

      const resumed = await authenticatedTestClient(adminToken)
        .post(
          `/api/v1/agents/${clientAgentId}/generate/${last.id}/tool-outputs`
        )
        .send({
          tool_outputs: [{ tool_call_id: 'call_stream_1', output: 'yes' }],
        });

      expect(resumed.status).toBe(200);
      expect(resumed.body.id).toBe(last.id);
      expect(resumed.body.status).toBe('completed');
      expect(resumed.body.output.content).toBe('The manager agreed.');
    });

    test('a pause that cannot be recorded fails the stream instead of claiming [DONE]', async () => {
      // Drives the catch around the pause write; everything else runs on the
      // real database.
      jest
        .spyOn(generationsModule, 'updateGenerationRecord')
        .mockRejectedValueOnce(new Error('pause write failed'));

      const res = await streamPausedTurn();

      expect(res.text).not.toContain('[DONE]');
      expect(framesOf(res.text).at(-1)).toEqual({
        error: 'pause write failed',
      });
      const generation = await settledGenerationOf(clientAgentId);
      expect(generation.status).toBe('failed');
    });
  });
});
