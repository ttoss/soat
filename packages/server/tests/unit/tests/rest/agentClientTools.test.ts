import type http from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * A client tool has no server-side `execute`, so a turn that calls one pauses
 * at `requires_action` and hands the call to the caller, who submits its output
 * to resume the turn.
 *
 * The provider is a local fake: on a turn with no tool result yet it calls
 * `firstCall`, and once a tool result is in the conversation it answers.
 */
describe('Agent client tools', () => {
  let adminToken: string;
  let projectId: string;
  let aiProviderId: string;
  let modelServer: http.Server;
  let toolServer: http.Server;
  let toolBaseUrl: string;
  let modelRequestCount = 0;
  let firstCall: { name: string; args: Record<string, unknown> } = {
    name: 'write_local_file',
    args: {},
  };
  let toolCount = 0;

  const listen = async (server: http.Server): Promise<string> => {
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  const close = async (server: http.Server): Promise<void> => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        return resolve();
      });
    });
  };

  const completionFor = (body: { messages?: Array<{ role?: string }> }) => {
    const answered = (body.messages ?? []).some((message) => {
      return message.role === 'tool';
    });
    const message = answered
      ? { role: 'assistant', content: 'all done' }
      : {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: `call_client_${modelRequestCount}`,
              type: 'function',
              function: {
                name: firstCall.name,
                arguments: JSON.stringify(firstCall.args),
              },
            },
          ],
        };
    return {
      id: 'chatcmpl-client-tools',
      object: 'chat.completion',
      created: 0,
      model: 'stub-model',
      choices: [
        {
          index: 0,
          message,
          finish_reason: answered ? 'stop' : 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  };

  const createTool = async (body: Record<string, unknown>): Promise<string> => {
    toolCount += 1;
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({ project_id: projectId, ...body });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const createAgent = async (toolIds: string[]): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: aiProviderId,
        name: `client tools agent ${toolCount}`,
        tool_bindings: toolIds.map((toolId) => {
          return { tool_id: toolId };
        }),
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const generate = async (agentId: string) => {
    const res = await authenticatedTestClient(adminToken)
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'go' }] });
    expect(res.status).toBe(200);
    return res.body as {
      id: string;
      status: string;
      output?: { content: string; finish_reason: string };
      required_action?: {
        tool_calls: Array<{
          id: string;
          tool_name: string;
          args: Record<string, unknown>;
        }>;
      };
    };
  };

  beforeAll(async () => {
    modelServer = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        modelRequestCount += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(completionFor(JSON.parse(raw))));
      });
    });
    const modelBaseUrl = await listen(modelServer);

    toolServer = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    toolBaseUrl = await listen(toolServer);

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'clienttoolsadmin', password: 'supersecret' });
    adminToken = await loginAs('clienttoolsadmin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Client Tools Project' });
    projectId = projectRes.body.id as string;

    const providerRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'client tools provider',
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: modelBaseUrl,
      });
    expect(providerRes.status).toBe(201);
    aiProviderId = providerRes.body.id as string;
  });

  afterAll(async () => {
    await close(modelServer);
    await close(toolServer);
  });

  describe('POST /api/v1/agents/{agent_id}/generate', () => {
    test("a client tool's preset_parameters are pinned over the model's arguments", async () => {
      const toolId = await createTool({
        name: 'write_local_file',
        type: 'client',
        description: 'Write a file on the caller machine',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            region: { type: 'string' },
          },
        },
        preset_parameters: { region: 'eu' },
      });
      const agentId = await createAgent([toolId]);
      firstCall = {
        name: 'write_local_file',
        args: { path: '/tmp/report', region: 'us' },
      };

      const result = await generate(agentId);

      expect(result.status).toBe('requires_action');
      expect(result.required_action?.tool_calls).toEqual([
        expect.objectContaining({
          tool_name: 'write_local_file',
          args: { path: '/tmp/report', region: 'eu' },
        }),
      ]);
    });

    describe('an agent whose max_steps is cleared', () => {
      let agentId: string;

      beforeAll(async () => {
        const serverToolId = await createTool({
          name: 'lookup_order',
          type: 'http',
          description: 'Look an order up',
          parameters: { type: 'object', properties: {} },
          execute: { url: `${toolBaseUrl}/lookup`, method: 'POST' },
        });
        const clientToolId = await createTool({
          name: 'confirm_with_user',
          type: 'client',
          description: 'Ask the user to confirm',
          parameters: { type: 'object', properties: {} },
        });
        agentId = await createAgent([serverToolId, clientToolId]);
        const patched = await authenticatedTestClient(adminToken)
          .patch(`/api/v1/agents/${agentId}`)
          .send({ max_steps: null });
        expect(patched.status).toBe(200);
        expect(patched.body.max_steps).toBeNull();
      });

      test('runs a multi-step turn under the platform default', async () => {
        firstCall = { name: 'lookup_order', args: {} };

        const result = await generate(agentId);

        expect(result.status).toBe('completed');
        expect(result.output).toMatchObject({
          content: 'all done',
          finish_reason: 'stop',
        });
      });

      test('resumes a paused turn under the platform default', async () => {
        firstCall = { name: 'confirm_with_user', args: {} };
        const paused = await generate(agentId);
        expect(paused.status).toBe('requires_action');
        const [call] = paused.required_action?.tool_calls ?? [];

        const res = await authenticatedTestClient(adminToken)
          .post(`/api/v1/agents/${agentId}/generate/${paused.id}/tool-outputs`)
          .send({ tool_outputs: [{ tool_call_id: call.id, output: 'yes' }] });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('completed');
        expect(res.body.output).toMatchObject({ content: 'all done' });
      });
    });
  });
});
