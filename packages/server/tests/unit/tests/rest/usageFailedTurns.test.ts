import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import * as clientToolGuardrail from 'src/lib/agentClientToolGuardrail';
import * as usageTokenEvent from 'src/lib/usageTokenEvent';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { stubCompletion } from '../../fixtures/stubChatProvider';
import { authenticatedTestClient } from '../../testClient';

// The provider bills every model call that completed, whatever the turn did
// afterwards. Each scenario scripts the provider call by call: a reply, or a
// `400` (which the SDK does not retry), and reads the turn's metered tokens.

type Reply = Record<string, unknown> | 'fail';

const TOOL = 'lookup_weather';
const CLIENT_TOOL = 'ask_manager';

const toolCall = (
  usage: { prompt_tokens: number; completion_tokens: number },
  name = TOOL
) => {
  return stubCompletion({
    toolCalls: [{ id: 'call_1', name, arguments: '{}' }],
    content: '',
    usage: {
      ...usage,
      total_tokens: usage.prompt_tokens + usage.completion_tokens,
    },
  });
};

const answer = (args: {
  content?: string;
  usage: { prompt_tokens: number; completion_tokens: number };
}) => {
  return stubCompletion({
    content: args.content ?? 'It is sunny.',
    usage: {
      ...args.usage,
      total_tokens: args.usage.prompt_tokens + args.usage.completion_tokens,
    },
  });
};

// The same reply as server-sent chunks, its usage in the closing chunk.
const writeStream = (res: ServerResponse, reply: Record<string, unknown>) => {
  const [choice] = reply.choices as Array<{
    message: { content: string; tool_calls?: unknown[] };
    finish_reason: string;
  }>;
  const frame = (body: Record<string, unknown>) => {
    res.write(
      `data: ${JSON.stringify({ id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: 0, model: 'stub-model', ...body })}\n\n`
    );
  };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  frame({
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          content: choice.message.content,
          ...(choice.message.tool_calls
            ? {
                tool_calls: choice.message.tool_calls.map((call, index) => {
                  return { index, ...(call as object) };
                }),
              }
            : {}),
        },
        finish_reason: null,
      },
    ],
  });
  frame({
    choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }],
  });
  frame({ choices: [], usage: reply.usage });
  res.write('data: [DONE]\n\n');
  res.end();
};

describe('Usage — provider calls a failed turn completed', () => {
  let adminToken: string;
  let projectId: string;
  let agentId: string;
  let clientAgentId: string;
  let modelServer: Server;
  let toolServer: Server;
  let script: Reply[] = [];

  const startServer = async (handler: Parameters<typeof createServer>[1]) => {
    const server = createServer(handler);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    return {
      server,
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    };
  };

  const meteredTokens = async (generationId: string) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const res = await authenticatedTestClient(adminToken)
        .get('/api/v1/usage/events')
        .query({ generation_id: generationId, meter_type: 'llm_tokens' });
      expect(res.status).toBe(200);
      const events = res.body.data as Array<{
        components: Array<{ component: string; quantity: number }>;
      }>;
      if (events.length > 0) {
        const sum = (name: string) => {
          return events
            .flatMap((event) => {
              return event.components;
            })
            .filter((component) => {
              return component.component === name;
            })
            .reduce((total, component) => {
              return total + Number(component.quantity);
            }, 0);
        };
        return {
          events: events.length,
          input: sum('input_tokens'),
          output: sum('output_tokens'),
        };
      }
      await new Promise((resolve) => {
        return setTimeout(resolve, 20);
      });
    }
    return { events: 0, input: 0, output: 0 };
  };

  const generate = () => {
    return authenticatedTestClient(adminToken)
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'weather?' }] });
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'usagefailedturns',
      policyActions: [],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;

    ({ server: modelServer } = await startServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += String(chunk);
      });
      req.on('end', () => {
        const reply = script.shift() ?? 'fail';
        if (reply === 'fail') {
          res.setHeader('Content-Type', 'application/json');
          res.statusCode = 400;
          res.end(JSON.stringify({ error: { message: 'scripted failure' } }));
          return;
        }
        if ((JSON.parse(raw) as { stream?: boolean }).stream) {
          writeStream(res, reply);
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(reply));
      });
    }));
    const modelUrl = `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}`;

    let toolUrl: string;
    ({ server: toolServer, url: toolUrl } = await startServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ forecast: 'sunny' }));
      });
    }));

    const providerRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'scripted provider',
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: modelUrl,
      });
    expect(providerRes.status).toBe(201);
    const toolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: TOOL,
        type: 'http',
        description: 'Weather',
        parameters: { type: 'object', properties: {} },
        execute: { url: toolUrl, method: 'POST' },
      });
    expect(toolRes.status).toBe(201);
    const agentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: providerRes.body.id,
        name: 'scripted agent',
        tool_bindings: [{ tool_id: toolRes.body.id }],
      });
    expect(agentRes.status).toBe(201);
    agentId = agentRes.body.id;

    const clientToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: CLIENT_TOOL,
        type: 'client',
        description: 'Asks the manager',
        parameters: { type: 'object', properties: {} },
      });
    expect(clientToolRes.status).toBe(201);
    const clientAgentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: providerRes.body.id,
        name: 'scripted client agent',
        tool_bindings: [
          { tool_id: toolRes.body.id },
          { tool_id: clientToolRes.body.id },
        ],
      });
    expect(clientAgentRes.status).toBe(201);
    clientAgentId = clientAgentRes.body.id;
  });

  afterEach(() => {
    script = [];
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    for (const server of [modelServer, toolServer]) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });

  describe('POST /api/v1/agents/{agent_id}/generate', () => {
    test('a turn that fails after a completed step meters that step', async () => {
      // Step 1 calls the tool; step 2 fails, and so does the retry without
      // tools.
      script = [
        toolCall({ prompt_tokens: 10, completion_tokens: 5 }),
        'fail',
        'fail',
      ];

      const res = await generate();

      expect(res.status).toBe(502);
      const metered = await meteredTokens(res.body.error.meta.generation_id);
      expect(metered).toEqual({ events: 1, input: 10, output: 5 });
    });

    test('a turn retried without tools meters the abandoned attempt too', async () => {
      script = [
        toolCall({ prompt_tokens: 10, completion_tokens: 5 }),
        'fail',
        answer({ usage: { prompt_tokens: 3, completion_tokens: 2 } }),
      ];

      const res = await generate();

      expect(res.status).toBe(200);
      const metered = await meteredTokens(res.body.id);
      expect(metered).toEqual({ events: 1, input: 13, output: 7 });
    });

    test('a completed call refused as a text-encoded tool call is metered', async () => {
      script = [
        answer({
          content: `{"name": "${TOOL}", "arguments": {}}`,
          usage: { prompt_tokens: 4, completion_tokens: 6 },
        }),
      ];

      const res = await generate();

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('TEXT_ENCODED_TOOL_CALL');
      const metered = await meteredTokens(res.body.error.meta.generation_id);
      expect(metered).toEqual({ events: 1, input: 4, output: 6 });
    });
  });

  describe('POST /api/v1/agents/{agent_id}/generate/{generation_id}/tool-outputs', () => {
    test('a resumed turn that fails after a completed step meters that step', async () => {
      script = [
        toolCall({ prompt_tokens: 2, completion_tokens: 1 }, CLIENT_TOOL),
        toolCall({ prompt_tokens: 7, completion_tokens: 3 }),
        'fail',
      ];
      const paused = await authenticatedTestClient(adminToken)
        .post(`/api/v1/agents/${clientAgentId}/generate?wait=true`)
        .send({ messages: [{ role: 'user', content: 'refund?' }] });
      expect(paused.status).toBe(200);
      expect(paused.body.status).toBe('requires_action');

      const resumed = await authenticatedTestClient(adminToken)
        .post(
          `/api/v1/agents/${clientAgentId}/generate/${paused.body.id}/tool-outputs`
        )
        .send({ tool_outputs: [{ tool_call_id: 'call_1', output: 'yes' }] });

      expect(resumed.status).toBe(502);
      const metered = await meteredTokens(paused.body.id);
      expect(metered).toEqual({ events: 2, input: 9, output: 4 });
    });
  });

  // The gate on the client calls a turn proposed runs after those calls were
  // made; a gate that fails still leaves them billed.
  describe('a client-call gate that fails', () => {
    const gateFails = () => {
      jest
        .spyOn(clientToolGuardrail, 'gatePendingClientTools')
        .mockRejectedValueOnce(new Error('gate unavailable'));
    };

    test('meters the unstreamed turn it refused', async () => {
      gateFails();
      script = [
        toolCall({ prompt_tokens: 5, completion_tokens: 2 }, CLIENT_TOOL),
      ];

      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/agents/${clientAgentId}/generate?wait=true`)
        .send({ messages: [{ role: 'user', content: 'refund?' }] });

      expect(res.status).toBe(500);
      const listed = await authenticatedTestClient(adminToken)
        .get('/api/v1/generations')
        .query({ agent_id: clientAgentId, limit: 1 });
      const metered = await meteredTokens(listed.body.data[0].id);
      expect(metered).toEqual({ events: 1, input: 5, output: 2 });
    });

    test('meters the streamed turn it refused', async () => {
      gateFails();
      script = [
        toolCall({ prompt_tokens: 6, completion_tokens: 4 }, CLIENT_TOOL),
      ];

      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/agents/${clientAgentId}/generate?wait=true`)
        .send({
          messages: [{ role: 'user', content: 'refund?' }],
          stream: true,
        });

      expect(res.status).toBe(200);
      const listed = await authenticatedTestClient(adminToken)
        .get('/api/v1/generations')
        .query({ agent_id: clientAgentId, limit: 1 });
      const metered = await meteredTokens(listed.body.data[0].id);
      expect(metered).toEqual({ events: 1, input: 6, output: 4 });
    });

    test('meters a tool-outputs continuation it refused, and fails it', async () => {
      script = [
        toolCall({ prompt_tokens: 2, completion_tokens: 1 }, CLIENT_TOOL),
        toolCall({ prompt_tokens: 8, completion_tokens: 5 }, CLIENT_TOOL),
      ];
      const paused = await authenticatedTestClient(adminToken)
        .post(`/api/v1/agents/${clientAgentId}/generate?wait=true`)
        .send({ messages: [{ role: 'user', content: 'refund?' }] });
      expect(paused.body.status).toBe('requires_action');
      gateFails();

      const resumed = await authenticatedTestClient(adminToken)
        .post(
          `/api/v1/agents/${clientAgentId}/generate/${paused.body.id}/tool-outputs`
        )
        .send({ tool_outputs: [{ tool_call_id: 'call_1', output: 'yes' }] });

      expect(resumed.status).toBe(500);
      const metered = await meteredTokens(paused.body.id);
      expect(metered).toEqual({ events: 2, input: 10, output: 6 });
      const record = await authenticatedTestClient(adminToken).get(
        `/api/v1/generations/${paused.body.id}`
      );
      expect(record.body.status).toBe('failed');
    });
  });

  // `debug` is off in production, so a usage event the meter could not write
  // is reported where an operator reads, never only behind it.
  describe('a usage write that fails', () => {
    test('is logged at error level and does not fail the turn', async () => {
      const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {
        return undefined;
      });
      jest
        .spyOn(usageTokenEvent, 'persistTokenEvent')
        .mockRejectedValueOnce(new Error('usage table unavailable'));
      script = [answer({ usage: { prompt_tokens: 1, completion_tokens: 1 } })];

      const res = await generate();

      expect(res.status).toBe(200);
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('recordGenerationUsage'),
        expect.any(Error)
      );
    });
  });
});
