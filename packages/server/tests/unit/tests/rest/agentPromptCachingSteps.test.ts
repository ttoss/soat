import type { Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * Prompt caching across the steps of one turn, on the wire.
 *
 * The stub stands in for Anthropic's prefix cache: every breakpoint a request
 * carries stores the prefix ending at it, and a later request reads the cache
 * when one of its message boundaries ends a stored prefix. That is the lookup
 * the provider does, and it is what turns a breakpoint on the last message of
 * one step into a read on the next.
 */
describe('Agent prompt caching across steps', () => {
  let stubServer: Server;
  let requestBodies: Array<Record<string, unknown>>;
  let cachedPrefixes: Set<string>;
  let userToken: string;
  let projectId: string;
  let aiProviderId: string;
  let httpToolId: string;
  let clientToolId: string;

  const CACHE_READ_TOKENS = 100;

  type Block = Record<string, unknown>;
  type WireMessage = { role: string; content: Block[] | string };

  const blocksOf = (message: WireMessage): Block[] => {
    return Array.isArray(message.content) ? message.content : [];
  };

  const withoutMarks = (value: unknown): unknown => {
    return JSON.parse(JSON.stringify(value), (key, inner) => {
      return key === 'cache_control' ? undefined : inner;
    });
  };

  const prefixKey = (body: Record<string, unknown>, end: number): string => {
    const messages = (body.messages as WireMessage[]).slice(0, end);
    return JSON.stringify(withoutMarks([body.tools, body.system, messages]));
  };

  const isMarked = (message: WireMessage): boolean => {
    return blocksOf(message).some((block) => {
      return block.cache_control !== undefined;
    });
  };

  /** Reads the cache, then writes a prefix at every breakpoint the body has. */
  const emulateCache = (body: Record<string, unknown>): number => {
    const messages = body.messages as WireMessage[];
    let read = false;
    for (let end = 1; end <= messages.length; end += 1) {
      if (cachedPrefixes.has(prefixKey(body, end))) read = true;
    }
    for (const [index, message] of messages.entries()) {
      if (isMarked(message)) cachedPrefixes.add(prefixKey(body, index + 1));
    }
    return read ? CACHE_READ_TOKENS : 0;
  };

  const toolResultCount = (body: Record<string, unknown>): number => {
    return (JSON.stringify(body.messages).match(/"tool_result"/g) ?? []).length;
  };

  /**
   * Calls `toolName` (read from the request's only tool) until the turn holds
   * two tool results, then answers in text: a three-step turn.
   */
  const startStubServer = async (): Promise<string> => {
    stubServer = createServer((req, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(raw);
        requestBodies.push(body);
        const cacheRead = emulateCache(body);
        const toolName = (
          body.tools as Array<{ name: string }> | undefined
        )?.[0]?.name;
        const callTool = toolName && toolResultCount(body) < 2;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'msg_stub',
            type: 'message',
            role: 'assistant',
            model: 'claude-haiku-4-5',
            stop_reason: callTool ? 'tool_use' : 'end_turn',
            stop_sequence: null,
            usage: {
              input_tokens: 4,
              output_tokens: 2,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: cacheRead,
            },
            content: callTool
              ? [
                  {
                    type: 'tool_use',
                    id: `toolu_stub_${requestBodies.length}`,
                    name: toolName,
                    input: {},
                  },
                ]
              : [{ type: 'text', text: 'done' }],
          })
        );
      });
    });
    await new Promise<void>((resolve) => {
      stubServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = stubServer.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  const createTool = async (args: {
    name: string;
    type: 'http' | 'client';
  }): Promise<string> => {
    const response = await authenticatedTestClient(userToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: args.name,
        type: args.type,
        description: `The ${args.name} tool`,
        parameters: { type: 'object', properties: {} },
        ...(args.type === 'http'
          ? { execute: { url: 'http://127.0.0.1:1/unused', method: 'POST' } }
          : {}),
      });
    expect(response.status).toBe(201);
    return response.body.id;
  };

  const createAgent = async (args: {
    toolId: string;
    promptCaching: object | null;
  }): Promise<string> => {
    const response = await authenticatedTestClient(userToken)
      .post('/api/v1/agents')
      .send({
        ai_provider_id: aiProviderId,
        project_id: projectId,
        model: 'claude-haiku-4-5',
        name: `Step Caching Agent ${requestBodies.length}`,
        instructions: 'Be terse.',
        prompt_caching: args.promptCaching,
        tool_bindings: [{ tool_id: args.toolId }],
        max_steps: 5,
      });
    expect(response.status).toBe(201);
    return response.body.id;
  };

  const generate = async (agentId: string) => {
    return authenticatedTestClient(userToken)
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'go' }] });
  };

  /** Every block the request marks: system blocks, then message blocks. */
  const marksOf = (body: Record<string, unknown>) => {
    const system = (body.system as Block[]).filter((block) => {
      return block.cache_control !== undefined;
    });
    const messages = body.messages as WireMessage[];
    const markedMessageIndexes = messages.flatMap((message, index) => {
      return isMarked(message) ? [index] : [];
    });
    return { system, markedMessageIndexes, messageCount: messages.length };
  };

  const readEventQuantities = async (
    generationId: string
  ): Promise<Record<string, number>> => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const events = await authenticatedTestClient(userToken).get(
        `/api/v1/usage/events?generation_id=${generationId}`
      );
      expect(events.status).toBe(200);
      const event = events.body.data[0];
      if (event) {
        return Object.fromEntries(
          event.components.map(
            (component: { component: string; quantity: number }) => {
              return [component.component, component.quantity];
            }
          )
        );
      }
    }
    throw new Error(`no usage event recorded for ${generationId}`);
  };

  beforeAll(async () => {
    requestBodies = [];
    cachedPrefixes = new Set();
    const stubBaseUrl = await startStubServer();

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'stepcacheadmin', password: 'supersecret' });
    const adminToken = await loginAs('stepcacheadmin', 'supersecret');

    const userRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'stepcacheuser', password: 'stepcachepass' });
    userToken = await loginAs('stepcacheuser', 'stepcachepass');

    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: [
                'agents:CreateAgent',
                'agents:CreateAgentGeneration',
                'secrets:CreateSecret',
                'tools:CreateTool',
                'usage:ListEvents',
              ],
            },
          ],
        },
      });
    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userRes.body.id}/policies`)
      .send({ policy_ids: [policyRes.body.id] });

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Step Caching Project' });
    projectId = projectRes.body.id;

    const secretRes = await authenticatedTestClient(userToken)
      .post('/api/v1/secrets')
      .send({ project_id: projectId, name: 'Step Caching Key', value: 'sk' });

    const aiProviderRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Stub Anthropic',
        provider: 'anthropic',
        default_model: 'claude-haiku-4-5',
        secret_id: secretRes.body.id,
        base_url: stubBaseUrl,
      });
    aiProviderId = aiProviderRes.body.id;

    httpToolId = await createTool({ name: 'lookup_tool', type: 'http' });
    clientToolId = await createTool({ name: 'client_tool', type: 'client' });
  });

  beforeEach(() => {
    requestBodies = [];
    cachedPrefixes = new Set();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      stubServer.close(() => {
        return resolve();
      });
    });
  });

  describe('POST /api/v1/agents/:agent_id/generate', () => {
    test('marks the system block and the last message of every step', async () => {
      const agentId = await createAgent({
        toolId: httpToolId,
        promptCaching: { enabled: true },
      });

      const response = await generate(agentId);
      expect(response.status).toBe(200);
      expect(requestBodies).toHaveLength(3);

      for (const body of requestBodies) {
        const marks = marksOf(body);
        expect(marks.system).toHaveLength(1);
        expect(marks.markedMessageIndexes).toEqual([marks.messageCount - 1]);
      }
    });

    test('every step after the first reads the previous step from cache', async () => {
      const agentId = await createAgent({
        toolId: httpToolId,
        promptCaching: { enabled: true },
      });

      const response = await generate(agentId);
      expect(response.status).toBe(200);

      const quantities = await readEventQuantities(response.body.id);
      expect(quantities.cached_tokens).toBe(2 * CACHE_READ_TOKENS);
    });

    test('sends no marks when caching is off', async () => {
      const agentId = await createAgent({
        toolId: httpToolId,
        promptCaching: null,
      });

      const response = await generate(agentId);
      expect(response.status).toBe(200);
      expect(requestBodies).toHaveLength(3);
      expect(JSON.stringify(requestBodies)).not.toContain('cache_control');
    });

    test('returns 401 when unauthenticated', async () => {
      const response = await testClient
        .post('/api/v1/agents/agt_missing/generate?wait=true')
        .send({ messages: [{ role: 'user', content: 'go' }] });

      expect(response.status).toBe(401);
    });
  });

  describe('POST /api/v1/agents/:agent_id/generate/:generation_id/tool-outputs', () => {
    // The paused turn persists its messages; a step mark stored there would
    // ride along on resume beside the new one.
    test('a resumed turn carries one step mark and reads the paused prefix', async () => {
      const agentId = await createAgent({
        toolId: clientToolId,
        promptCaching: { enabled: true },
      });

      const started = await generate(agentId);
      expect(started.status).toBe(200);
      expect(started.body.status).toBe('requires_action');

      const resumed = await authenticatedTestClient(userToken)
        .post(
          `/api/v1/agents/${agentId}/generate/${started.body.id}/tool-outputs`
        )
        .send({
          tool_outputs: [
            {
              tool_call_id: started.body.required_action.tool_calls[0].id,
              output: 'ok',
            },
          ],
        });
      expect(resumed.status).toBe(200);

      const resumedBody = requestBodies[1];
      const marks = marksOf(resumedBody);
      expect(marks.system).toHaveLength(1);
      expect(marks.markedMessageIndexes).toEqual([marks.messageCount - 1]);

      const quantities = await readEventQuantities(resumed.body.id);
      expect(quantities.cached_tokens).toBeGreaterThan(0);
    });
  });
});
