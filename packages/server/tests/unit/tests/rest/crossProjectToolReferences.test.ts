import type { Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * A tool reference on an agent or a pipeline names a tool in the referencing
 * row's own project, never one the caller's credential happens to reach.
 *
 * The run-time cases seed the stored reference directly: the write path now
 * refuses it, and a row written before that check is the state a generation
 * must still resolve safely.
 */
describe('Cross-project tool references', () => {
  let providerStub: Server;
  let toolStub: Server;
  let toolStubHits: number;
  let requestBodies: Array<Record<string, unknown>>;
  let adminToken: string;
  let projectAId: string;
  let projectBId: string;
  let aiProviderId: string;
  let ownToolId: string;
  let foreignToolId: string;

  // Calls `callPipeline` once when a turn offers it, then answers in text.
  const startProviderStub = async (): Promise<string> => {
    providerStub = createServer((req, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        requestBodies.push(body);
        const offered = Array.isArray(body.tools)
          ? (body.tools as Array<{ name: string }>).map((tool) => {
              return tool.name;
            })
          : [];
        const answered = JSON.stringify(body.messages).includes('tool_result');
        const content =
          offered.includes('callPipeline') && !answered
            ? [
                {
                  type: 'tool_use',
                  id: 'toolu_pipeline',
                  name: 'callPipeline',
                  input: {},
                },
              ]
            : [{ type: 'text', text: 'done' }];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'msg_stub',
            type: 'message',
            role: 'assistant',
            model: 'claude-haiku-4-5',
            content,
            stop_reason:
              content[0].type === 'tool_use' ? 'tool_use' : 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 4, output_tokens: 2 },
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

  const startToolStub = async (): Promise<string> => {
    toolStub = createServer((req, res: ServerResponse) => {
      req.resume();
      req.on('end', () => {
        toolStubHits += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => {
      toolStub.listen(0, '127.0.0.1', resolve);
    });
    const { port } = toolStub.address() as AddressInfo;
    return `http://127.0.0.1:${port}/hook`;
  };

  const createHttpTool = async (args: {
    projectId: string;
    name: string;
    url: string;
  }): Promise<string> => {
    const response = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: args.projectId,
        name: args.name,
        type: 'http',
        parameters: { type: 'object', properties: {} },
        execute: { url: args.url, method: 'POST' },
      });
    expect(response.status).toBe(201);
    return response.body.id as string;
  };

  const createAgent = async (
    body: Record<string, unknown> = {}
  ): Promise<string> => {
    const response = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectAId,
        ai_provider_id: aiProviderId,
        model: 'claude-haiku-4-5',
        tool_bindings: [{ tool_id: ownToolId }],
        ...body,
      });
    expect(response.status).toBe(201);
    return response.body.id as string;
  };

  const generateInConversation = async (agentId: string) => {
    const conversation = await authenticatedTestClient(adminToken)
      .post('/api/v1/conversations')
      .send({ project_id: projectAId });
    await authenticatedTestClient(adminToken)
      .post(`/api/v1/conversations/${conversation.body.id}/messages`)
      .send({ role: 'user', message: 'go' });
    return authenticatedTestClient(adminToken)
      .post(`/api/v1/conversations/${conversation.body.id}/generate?wait=true`)
      .send({ agent_id: agentId });
  };

  const offeredToolNames = (): string[] => {
    const tools = requestBodies.at(-1)?.tools;
    if (!Array.isArray(tools)) return [];
    return (tools as Array<{ name: string }>).map((tool) => {
      return tool.name;
    });
  };

  beforeAll(async () => {
    requestBodies = [];
    toolStubHits = 0;
    const providerBaseUrl = await startProviderStub();
    const toolUrl = await startToolStub();

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'xprojadmin', password: 'supersecret' });
    adminToken = await loginAs('xprojadmin', 'supersecret');

    const projectA = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Referencing Project' });
    projectAId = projectA.body.id;
    const projectB = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Foreign Project' });
    projectBId = projectB.body.id;

    const secret = await authenticatedTestClient(adminToken)
      .post('/api/v1/secrets')
      .send({ project_id: projectAId, name: 'Provider Key', value: 'sk-ant' });
    const aiProvider = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectAId,
        name: 'Stub Anthropic',
        provider: 'anthropic',
        default_model: 'claude-haiku-4-5',
        secret_id: secret.body.id,
        base_url: providerBaseUrl,
      });
    aiProviderId = aiProvider.body.id;

    ownToolId = await createHttpTool({
      projectId: projectAId,
      name: 'ownTool',
      url: toolUrl,
    });
    foreignToolId = await createHttpTool({
      projectId: projectBId,
      name: 'foreignTool',
      url: toolUrl,
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      providerStub.close(() => {
        return resolve();
      });
    });
    await new Promise<void>((resolve) => {
      toolStub.close(() => {
        return resolve();
      });
    });
  });

  describe('POST /api/v1/agents', () => {
    test('refuses a tool_bindings tool_id from another project', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectAId,
          ai_provider_id: aiProviderId,
          model: 'claude-haiku-4-5',
          tool_bindings: [{ tool_id: foreignToolId }],
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('TOOL_NOT_FOUND');
      expect(response.body.error.meta.missing).toEqual([foreignToolId]);
    });

    test('refuses a tool_bindings tool_id that names no tool', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectAId,
          ai_provider_id: aiProviderId,
          model: 'claude-haiku-4-5',
          tool_bindings: [{ tool_id: 'tool_doesnotexist' }],
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('TOOL_NOT_FOUND');
    });

    test('accepts a tool_bindings tool_id from its own project', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectAId,
          ai_provider_id: aiProviderId,
          model: 'claude-haiku-4-5',
          tool_bindings: [{ tool_id: ownToolId }],
        });

      expect(response.status).toBe(201);
      expect(response.body.tool_bindings).toEqual([{ tool_id: ownToolId }]);
    });
  });

  describe('PATCH /api/v1/agents/:agent_id', () => {
    test('refuses a tool_bindings tool_id from another project', async () => {
      const agentId = await createAgent();

      const response = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/agents/${agentId}`)
        .send({ tool_bindings: [{ tool_id: foreignToolId }] });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('TOOL_NOT_FOUND');
    });

    test('an update that leaves tool_bindings alone does not re-check them', async () => {
      const agentId = await createAgent();
      await db.Agent.update(
        { toolBindings: [{ toolId: 'tool_deletedlongago' }] },
        { where: { publicId: agentId } }
      );

      const response = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/agents/${agentId}`)
        .send({ name: 'Renamed' });

      expect(response.status).toBe(200);
    });
  });

  describe('POST /api/v1/orchestrations', () => {
    const createOrchestration = (node: Record<string, unknown>) => {
      return authenticatedTestClient(adminToken)
        .post('/api/v1/orchestrations')
        .send({
          project_id: projectAId,
          name: `Foreign ${String(node.type)} node`,
          nodes: [{ id: 'node', ...node }],
          edges: [],
        });
    };

    test("refuses a tool node naming another project's tool", async () => {
      const response = await createOrchestration({
        type: 'tool',
        tool_id: foreignToolId,
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('TOOL_NOT_FOUND');
    });

    test("refuses a poll node naming another project's tool", async () => {
      const response = await createOrchestration({
        type: 'poll',
        tool_id: foreignToolId,
        interval: '1s',
        exit_condition: true,
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('TOOL_NOT_FOUND');
    });

    test("refuses an agent node naming another project's agent", async () => {
      const provider = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectBId,
          name: 'Foreign Provider',
          provider: 'ollama',
          default_model: 'llama3.2',
        });
      const foreignAgent = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({ project_id: projectBId, ai_provider_id: provider.body.id });
      expect(foreignAgent.status).toBe(201);

      const response = await createOrchestration({
        type: 'agent',
        agent_id: foreignAgent.body.id,
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('AGENT_NOT_FOUND');
    });
  });

  describe('POST /api/v1/workflows', () => {
    test("refuses a tool dispatch naming another project's tool", async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/workflows')
        .send({
          project_id: projectAId,
          name: 'foreign-tool-dispatch',
          states: [
            {
              name: 'calling',
              initial: true,
              on_enter: { dispatch: { kind: 'tool', tool_id: foreignToolId } },
            },
            { name: 'done', terminal: true },
          ],
          transitions: [{ name: 'to_done', from: ['calling'], to: 'done' }],
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('WORKFLOW_VALIDATION_FAILED');
    });
  });

  describe('POST /api/v1/guardrails', () => {
    test("refuses a context_tool_id naming another project's tool", async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/guardrails')
        .send({
          project_id: projectAId,
          name: 'Foreign context tool',
          document: { default_class: 'C', class: 'C' },
          context_tool_id: foreignToolId,
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('TOOL_NOT_FOUND');
    });
  });

  describe('step_rules on POST /api/v1/agents', () => {
    test("refuses an active_tool_ids entry naming another project's tool", async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectAId,
          ai_provider_id: aiProviderId,
          model: 'claude-haiku-4-5',
          tool_bindings: [{ tool_id: ownToolId }],
          step_rules: [{ step: 1, active_tool_ids: [foreignToolId] }],
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('TOOL_NOT_FOUND');
    });
  });

  describe('PUT /api/v1/formations/:formation_id', () => {
    test("refuses a pipeline step naming another project's tool", async () => {
      const pipelineTemplate = (toolId: string) => {
        return {
          resources: {
            Pipe: {
              type: 'tool',
              properties: {
                name: 'formationPipeline',
                type: 'pipeline',
                parameters: { type: 'object', properties: {} },
                pipeline: { steps: [{ id: 'hit', tool_id: toolId }] },
              },
            },
          },
        };
      };
      const created = await authenticatedTestClient(adminToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectAId,
          name: 'cross-project-pipeline',
          template: pipelineTemplate(ownToolId),
        });
      expect(created.body.status).toBe('active');

      const updated = await authenticatedTestClient(adminToken)
        .put(`/api/v1/formations/${created.body.id}`)
        .send({ template: pipelineTemplate(foreignToolId) });

      expect(updated.body.status).toBe('failed');
      const pipeline = await db.Tool.findOne({
        where: { name: 'formationPipeline' },
      });
      expect(JSON.stringify(pipeline?.pipeline)).not.toContain(foreignToolId);
    });
  });

  describe('POST /api/v1/conversations/:id/generate', () => {
    test('a stored binding to another project resolves to nothing', async () => {
      const agentId = await createAgent();
      await db.Agent.update(
        { toolBindings: [{ toolId: ownToolId }, { toolId: foreignToolId }] },
        { where: { publicId: agentId } }
      );

      const response = await generateInConversation(agentId);

      expect(response.status).toBe(200);
      expect(offeredToolNames()).toEqual(['ownTool']);
    });

    test("a pipeline step naming another project's tool never runs it", async () => {
      const pipeline = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectAId,
          name: 'callPipeline',
          type: 'pipeline',
          parameters: { type: 'object', properties: {} },
          pipeline: { steps: [{ id: 'hit', tool_id: ownToolId, input: {} }] },
        });
      expect(pipeline.status).toBe(201);
      const pipelineToolId = pipeline.body.id as string;
      const agentId = await createAgent({
        tool_bindings: [{ tool_id: pipelineToolId }],
      });
      await db.Tool.update(
        {
          pipeline: {
            steps: [{ id: 'hit', tool_id: foreignToolId, input: {} }],
          },
        },
        { where: { publicId: pipelineToolId } }
      );
      const hitsBefore = toolStubHits;

      const response = await generateInConversation(agentId);

      expect(response.status).toBe(200);
      expect(toolStubHits).toBe(hitsBefore);
    });
  });
});
