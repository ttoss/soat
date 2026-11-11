import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * `active_tool_ids` restricts which bound tools a generation may use
 * (`modules/agents.md` — Active Tools). Asserted on the tool block the provider
 * receives, because that is the only place the restriction shows: a generation
 * answering in text reads the same whichever tools it was offered.
 */
describe('Agent active tools', () => {
  let modelServer: Server;
  let requestBodies: Array<Record<string, unknown>> = [];
  let adminToken: string;
  let projectId: string;
  let aiProviderId: string;
  let alphaToolId: string;
  let betaToolId: string;

  const listen = async (server: Server): Promise<string> => {
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  /** The tool names one provider request offered the model, sorted. */
  const offeredToolNames = (body: Record<string, unknown>): string[] => {
    const tools = Array.isArray(body.tools) ? body.tools : [];
    return tools
      .map((entry: { function?: { name?: string } }) => {
        return entry.function?.name ?? '';
      })
      .sort();
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
    extra: Record<string, unknown>
  ): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: aiProviderId,
        name: 'active-tools-agent',
        tool_bindings: [{ tool_id: alphaToolId }, { tool_id: betaToolId }],
        ...extra,
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  /** Runs one turn and answers the tool names its provider request offered. */
  const toolsOfferedBy = async (agentId: string): Promise<string[]> => {
    requestBodies = [];
    const res = await authenticatedTestClient(adminToken)
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'hello' }] });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(requestBodies).toHaveLength(1);
    return offeredToolNames(requestBodies[0]);
  };

  beforeAll(async () => {
    modelServer = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        requestBodies.push(JSON.parse(raw) as Record<string, unknown>);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-active-tools',
            object: 'chat.completion',
            created: 0,
            model: 'stub-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'hello back' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        );
      });
    });
    const modelBaseUrl = await listen(modelServer);

    const setup = await setupProjectWithUsers({
      prefix: 'activetools',
      policyActions: ['agents:CreateAgentGeneration'],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;

    const providerRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'active-tools-provider',
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: modelBaseUrl,
      });
    expect(providerRes.status).toBe(201);
    aiProviderId = providerRes.body.id as string;

    alphaToolId = await createTool('alpha_tool');
    betaToolId = await createTool('beta_tool');
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      modelServer.close(() => {
        return resolve();
      });
    });
  });

  describe('POST /api/v1/agents/{agent_id}/generate', () => {
    test('offers every bound tool when no active set is declared', async () => {
      const agentId = await createAgent({});

      expect(await toolsOfferedBy(agentId)).toEqual([
        'alpha_tool',
        'beta_tool',
      ]);
    });

    test('offers only the bound tools the active set names', async () => {
      const agentId = await createAgent({ active_tool_ids: [betaToolId] });

      expect(await toolsOfferedBy(agentId)).toEqual(['beta_tool']);
    });

    test('an empty active set restricts nothing', async () => {
      // An empty active set would leave the agent with no tools at all, which
      // is never a deliberate configuration.
      const agentId = await createAgent({ active_tool_ids: [] });

      expect(await toolsOfferedBy(agentId)).toEqual([
        'alpha_tool',
        'beta_tool',
      ]);
    });
  });

  describe('active tools must be bound', () => {
    const postAgent = (body: Record<string, unknown>) => {
      return authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'active-tools-agent',
          ...body,
        });
    };

    const patchAgent = (agentId: string, body: Record<string, unknown>) => {
      return authenticatedTestClient(adminToken)
        .patch(`/api/v1/agents/${agentId}`)
        .send(body);
    };

    const expectUnbound = (
      res: {
        status: number;
        body: { error: { code: string; message: string } };
      },
      toolId: string
    ) => {
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.message).toContain(toolId);
    };

    test('refuses an active tool on an agent with no tool_bindings', async () => {
      const res = await postAgent({ active_tool_ids: [alphaToolId] });

      expectUnbound(res, alphaToolId);
    });

    test('refuses an active tool the agent does not bind', async () => {
      const unboundToolId = await createTool('unbound_tool');
      const res = await postAgent({
        tool_bindings: [{ tool_id: alphaToolId }],
        active_tool_ids: [unboundToolId, alphaToolId],
      });

      expectUnbound(res, unboundToolId);
    });

    test("refuses a step rule's active tool the agent does not bind", async () => {
      const res = await postAgent({
        tool_bindings: [{ tool_id: alphaToolId }],
        step_rules: [{ step: 1, active_tool_ids: [betaToolId] }],
      });

      expectUnbound(res, betaToolId);
    });

    test('accepts active tools and step rules naming bound tools', async () => {
      const res = await postAgent({
        tool_bindings: [{ tool_id: alphaToolId }, { tool_id: betaToolId }],
        active_tool_ids: [alphaToolId],
        step_rules: [{ step: 1, active_tool_ids: [betaToolId] }],
      });

      expect(res.status).toBe(201);
    });

    test('refuses an update naming an active tool the agent does not bind', async () => {
      const created = await postAgent({
        tool_bindings: [{ tool_id: alphaToolId }],
      });
      expect(created.status).toBe(201);

      const res = await patchAgent(created.body.id as string, {
        active_tool_ids: [betaToolId],
      });

      expectUnbound(res, betaToolId);
    });

    test('refuses an update removing a binding that is still active', async () => {
      const created = await postAgent({
        tool_bindings: [{ tool_id: alphaToolId }, { tool_id: betaToolId }],
        step_rules: [{ step: 1, active_tool_ids: [betaToolId] }],
      });
      expect(created.status).toBe(201);

      const res = await patchAgent(created.body.id as string, {
        tool_bindings: [{ tool_id: alphaToolId }],
      });

      expectUnbound(res, betaToolId);
    });

    test('accepts an update removing a binding together with its active id', async () => {
      const created = await postAgent({
        tool_bindings: [{ tool_id: alphaToolId }, { tool_id: betaToolId }],
        active_tool_ids: [betaToolId],
      });
      expect(created.status).toBe(201);

      const res = await patchAgent(created.body.id as string, {
        tool_bindings: [{ tool_id: alphaToolId }],
        active_tool_ids: [alphaToolId],
      });

      expect(res.status).toBe(200);
      expect(res.body.active_tool_ids).toEqual([alphaToolId]);
    });
  });
});
