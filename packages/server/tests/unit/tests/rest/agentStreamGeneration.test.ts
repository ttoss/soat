import type http from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import * as generationsModule from 'src/lib/generations';

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
    res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
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
      if (generation && generation.status !== 'in_progress') return generation;
      await new Promise((resolve) => {
        return setTimeout(resolve, 25);
      });
    }
    throw new Error(`no settled generation for ${agentId}`);
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
        requestBodies.push(JSON.parse(raw) as Record<string, unknown>);
        writeStream(res);
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
  });
});
