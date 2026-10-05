import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  type ChatRequest,
  startChatCompletionStub,
} from '../../fixtures/chatCompletionStub';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * A generation's message may name a document or a tool call instead of
 * carrying text; the server resolves it, before the model runs, into the text
 * the model is sent. Every generation here is real: the provider points at a
 * local chat-completions stub, whose recorded request is where the resolved
 * text is read, and every `http` tool points at a second local server that
 * answers by path.
 */
const toolResponses: Record<string, unknown> = {
  '/audio': { data: { transcription: { text: 'hello from audio' } } },
  '/counter': { data: { count: 42 } },
  '/list': { data: { items: ['first', 'second', 'third'] } },
  '/nullable': { data: { value: null } },
  '/plain': 'plain tool text',
  '/echo': { data: { ok: true } },
};

const stubPromise = startChatCompletionStub({
  reply: () => {
    return { content: 'Done.' };
  },
});

describe('POST /api/v1/agents/:agent_id/generate — resolved message content', () => {
  let adminToken: string;
  let limitedToken: string;
  let projectId: string;
  let providerId: string;
  let toolServer: Server;
  const echoed: unknown[] = [];
  const toolIds: Record<string, string> = {};
  let documentId: string;
  let scopedStoreId: string;
  let otherStoreId: string;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const create = async (path: string, body: Record<string, unknown>) => {
    const res = await asAdmin().post(path).send(body);
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const createAgent = async (args: {
    toolIds: string[];
    boundaryPolicy?: Record<string, unknown>;
  }): Promise<string> => {
    return create('/api/v1/agents', {
      project_id: projectId,
      ai_provider_id: providerId,
      name: `content-agent-${Math.random().toString(36).slice(2)}`,
      tool_bindings: args.toolIds.map((toolId) => {
        return { tool_id: toolId };
      }),
      ...(args.boundaryPolicy ? { boundary_policy: args.boundaryPolicy } : {}),
    });
  };

  const generate = (args: {
    agentId: string;
    content: unknown;
    token?: string;
    toolContext?: Record<string, string>;
  }) => {
    return authenticatedTestClient(args.token ?? adminToken)
      .post(`/api/v1/agents/${args.agentId}/generate?wait=true`)
      .send({
        messages: [{ role: 'user', content: args.content }],
        ...(args.toolContext ? { tool_context: args.toolContext } : {}),
      });
  };

  /** The user message the model was sent for the last generation. */
  const sentToModel = async (): Promise<unknown> => {
    const { requests } = await stubPromise;
    const last: ChatRequest = requests[requests.length - 1];
    return last.messages.find((message) => {
      return message.role === 'user';
    })?.content;
  };

  const toolOutput = (args: {
    tool: string;
    outputPath?: string;
    action?: string;
    input?: Record<string, unknown>;
  }) => {
    return {
      type: 'tool_output',
      tool_id: toolIds[args.tool],
      input: args.input ?? {},
      ...(args.action ? { action: args.action } : {}),
      ...(args.outputPath ? { output_path: args.outputPath } : {}),
    };
  };

  beforeAll(async () => {
    toolServer = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += String(chunk);
      });
      req.on('end', () => {
        const path = req.url ?? '';
        if (path === '/echo') echoed.push(raw ? JSON.parse(raw) : null);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(toolResponses[path] ?? {}));
      });
    });
    await new Promise<void>((resolve) => {
      toolServer.listen(0, '127.0.0.1', resolve);
    });
    const toolBaseUrl = `http://127.0.0.1:${(toolServer.address() as AddressInfo).port}`;

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'contentadmin', password: 'supersecret' });
    adminToken = await loginAs('contentadmin', 'supersecret');

    projectId = await create('/api/v1/projects', {
      name: 'Message content resolution',
    });
    providerId = await create('/api/v1/ai-providers', {
      project_id: projectId,
      name: 'Content provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: (await stubPromise).baseUrl,
    });

    for (const path of Object.keys(toolResponses)) {
      const name = path.slice(1);
      toolIds[name] = await create('/api/v1/tools', {
        project_id: projectId,
        name,
        type: 'http',
        parameters: {
          type: 'object',
          properties: { adAccountId: { type: 'string' } },
        },
        execute: { url: `${toolBaseUrl}${path}`, method: 'POST' },
        ...(name === 'echo'
          ? { preset_parameters: { adAccountId: '{{context:adAccountId}}' } }
          : {}),
      });
    }
    toolIds.listTools = await create('/api/v1/tools', {
      project_id: projectId,
      name: 'platform',
      type: 'builtin',
      actions: ['list-tools'],
    });
    toolIds.getStore = await create('/api/v1/tools', {
      project_id: projectId,
      name: 'stores',
      type: 'builtin',
      actions: ['get-memory-store'],
    });

    documentId = await create('/api/v1/documents', {
      project_id: projectId,
      content: 'The document the message names.',
      path: '/docs/spec.md',
    });
    scopedStoreId = await create('/api/v1/memory-stores', {
      project_id: projectId,
      name: 'Scoped store',
    });
    otherStoreId = await create('/api/v1/memory-stores', {
      project_id: projectId,
      name: 'Other store',
    });

    // May run a generation, but neither read a document nor call a tool.
    const limited = await asAdmin()
      .post('/api/v1/users')
      .send({ username: 'contentlimited', password: 'limitedpass' });
    const policy = await asAdmin()
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: ['agents:CreateAgentGeneration', 'agents:GetAgent'],
            },
          ],
        },
      });
    await asAdmin()
      .put(`/api/v1/users/${limited.body.id}/policies`)
      .send({ policy_ids: [policy.body.id] });
    limitedToken = await loginAs('contentlimited', 'limitedpass');
  });

  afterAll(async () => {
    await (await stubPromise).close();
    await new Promise<void>((resolve) => {
      toolServer.close(() => {
        resolve();
      });
    });
  });

  describe('a document block', () => {
    test('is replaced by the document text', async () => {
      const agentId = await createAgent({ toolIds: [] });

      const res = await generate({
        agentId,
        content: { type: 'document', document_id: documentId },
      });

      expect(res.status).toBe(200);
      expect(await sentToModel()).toBe('The document the message names.');
    });

    // The caller is checked against both names a document has, so a grant on
    // its directory admits it as well as a grant on its id.
    test("admits a caller whose grant names the document's directory", async () => {
      const user = await asAdmin()
        .post('/api/v1/users')
        .send({ username: 'contentpathuser', password: 'pathpass' });
      const policy = await asAdmin()
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [
              {
                effect: 'Allow',
                action: ['agents:CreateAgentGeneration', 'agents:GetAgent'],
              },
              {
                effect: 'Allow',
                action: ['documents:GetDocument'],
                resource: [`srn:${projectId}:document:/docs/*`],
              },
            ],
          },
        });
      await asAdmin()
        .put(`/api/v1/users/${user.body.id}/policies`)
        .send({ policy_ids: [policy.body.id] });
      const agentId = await createAgent({ toolIds: [] });

      const res = await generate({
        agentId,
        token: await loginAs('contentpathuser', 'pathpass'),
        content: { type: 'document', document_id: documentId },
      });

      expect(res.status).toBe(200);
      expect(await sentToModel()).toBe('The document the message names.');
    });

    test('naming no document is 404', async () => {
      const agentId = await createAgent({ toolIds: [] });

      const res = await generate({
        agentId,
        content: { type: 'document', document_id: 'doc_missing' },
      });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });

    test('is refused to a caller who may not read the document', async () => {
      const agentId = await createAgent({ toolIds: [] });

      const res = await generate({
        agentId,
        token: limitedToken,
        content: { type: 'document', document_id: documentId },
      });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    test("is refused when the agent's boundary does not allow reading it", async () => {
      const agentId = await createAgent({
        toolIds: [],
        boundaryPolicy: {
          statement: [
            { effect: 'Allow', action: ['tools:CallTool'], resource: ['*'] },
          ],
        },
      });

      const res = await generate({
        agentId,
        content: { type: 'document', document_id: documentId },
      });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('a tool_output block', () => {
    test('is replaced by the value at output_path', async () => {
      const agentId = await createAgent({ toolIds: [toolIds.audio] });

      const res = await generate({
        agentId,
        content: toolOutput({
          tool: 'audio',
          outputPath: 'data.transcription.text',
        }),
      });

      expect(res.status).toBe(200);
      expect(await sentToModel()).toBe('hello from audio');
    });

    test.each([
      ['a number', 'counter', 'data.count', '42'],
      ['an object', 'counter', 'data', '{"count":42}'],
      ['null', 'nullable', 'data.value', 'null'],
      ['an array element', 'list', 'data.items.1', 'second'],
    ])(
      'sends %s at output_path as its JSON text',
      async (_label, tool, outputPath, expected) => {
        const agentId = await createAgent({ toolIds: [toolIds[tool]] });

        const res = await generate({
          agentId,
          content: toolOutput({ tool, outputPath }),
        });

        expect(res.status).toBe(200);
        expect(await sentToModel()).toBe(expected);
      }
    );

    test('without output_path sends the whole output', async () => {
      const agentId = await createAgent({ toolIds: [toolIds.plain] });

      const res = await generate({
        agentId,
        content: toolOutput({ tool: 'plain' }),
      });

      expect(res.status).toBe(200);
      expect(await sentToModel()).toBe('plain tool text');
    });

    test.each([
      ['an index past the end', 'list', 'data.items.9'],
      ['a segment that is not an index', 'list', 'data.items.first'],
      ['a key under a scalar', 'counter', 'data.count.value'],
    ])('naming %s at output_path is 400', async (_label, tool, outputPath) => {
      const agentId = await createAgent({ toolIds: [toolIds[tool]] });

      const res = await generate({
        agentId,
        content: toolOutput({ tool, outputPath }),
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    // The generation calling a tool on its own behalf, before the model runs,
    // carries the turn's `tool_context` like every other tool call it makes.
    test("resolves a {{context:}} preset from the turn's tool_context", async () => {
      const agentId = await createAgent({ toolIds: [toolIds.echo] });
      echoed.length = 0;

      const res = await generate({
        agentId,
        content: toolOutput({ tool: 'echo', outputPath: 'data.ok' }),
        toolContext: { adAccountId: 'act_1330065197707199' },
      });

      expect(res.status).toBe(200);
      expect(await sentToModel()).toBe('true');
      expect(echoed).toEqual([{ adAccountId: 'act_1330065197707199' }]);
    });

    test('is refused for a tool the agent does not bind', async () => {
      const agentId = await createAgent({ toolIds: [toolIds.counter] });

      const res = await generate({
        agentId,
        content: toolOutput({ tool: 'audio' }),
      });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    test('is refused to a caller who may not call tools', async () => {
      const agentId = await createAgent({ toolIds: [toolIds.audio] });

      const res = await generate({
        agentId,
        token: limitedToken,
        content: toolOutput({ tool: 'audio' }),
      });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    describe('naming a builtin action', () => {
      const storeBoundary = () => {
        return {
          statement: [
            {
              effect: 'Allow',
              action: ['memories:*'],
              resource: [`srn:${projectId}:memory_store:${scopedStoreId}`],
            },
          ],
        };
      };

      test("is refused when the agent's boundary does not allow the action", async () => {
        const agentId = await createAgent({
          toolIds: [toolIds.listTools],
          boundaryPolicy: {
            statement: [
              {
                effect: 'Allow',
                action: ['documents:GetDocument'],
                resource: ['*'],
              },
            ],
          },
        });

        const res = await generate({
          agentId,
          content: toolOutput({ tool: 'listTools', action: 'list-tools' }),
        });

        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
      });

      // The caller-driven door reaches the same builtin actions the model
      // does, so a boundary confined to one resource binds here too.
      test('is refused when aimed at a resource outside the boundary', async () => {
        const agentId = await createAgent({
          toolIds: [toolIds.getStore],
          boundaryPolicy: storeBoundary(),
        });

        const res = await generate({
          agentId,
          content: toolOutput({
            tool: 'getStore',
            action: 'get-memory-store',
            input: { memory_store_id: otherStoreId },
          }),
        });

        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
      });

      test('reaches the resource the boundary names', async () => {
        const agentId = await createAgent({
          toolIds: [toolIds.getStore],
          boundaryPolicy: storeBoundary(),
        });

        const res = await generate({
          agentId,
          content: toolOutput({
            tool: 'getStore',
            action: 'get-memory-store',
            input: { memory_store_id: scopedStoreId },
            outputPath: 'id',
          }),
        });

        expect(res.status).toBe(200);
        expect(await sentToModel()).toBe(scopedStoreId);
      });
    });
  });
});
