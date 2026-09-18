import type { Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * What the model is told when a tool binding resolves to nothing.
 *
 * Asserted on the bytes the provider receives, because that is the only place
 * the difference shows: the generation completes, carries no error, and reads
 * identically whether the binding was dropped or the agent never had one. A
 * model told nothing answers that it has no such capability, or invents a cause
 * for a failure it was never shown.
 */
describe('Unavailable tool bindings', () => {
  let providerStub: Server;
  let mcpStub: Server;
  let requestBodies: Array<Record<string, unknown>>;
  let mcpStatus: number;
  let userToken: string;
  let projectId: string;
  let aiProviderId: string;
  let mcpToolId: string;

  const anthropicResponse = {
    id: 'msg_stub',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    content: [{ type: 'text', text: 'all set' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 4, output_tokens: 2 },
  };

  const startProviderStub = async (): Promise<string> => {
    providerStub = createServer((req, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        requestBodies.push(JSON.parse(raw));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(anthropicResponse));
      });
    });
    await new Promise<void>((resolve) => {
      providerStub.listen(0, '127.0.0.1', resolve);
    });
    const { port } = providerStub.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  // Answers whatever `mcpStatus` currently holds, so one server covers both the
  // rejected credential and the listing that succeeds.
  const startMcpStub = async (): Promise<string> => {
    mcpStub = createServer((req, res: ServerResponse) => {
      req.resume();
      req.on('end', () => {
        if (mcpStatus !== 200) {
          res.writeHead(mcpStatus, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              tools: [
                {
                  name: 'lookupOrder',
                  description: 'Look an order up',
                  inputSchema: { type: 'object', properties: {} },
                },
              ],
            },
          })
        );
      });
    });
    await new Promise<void>((resolve) => {
      mcpStub.listen(0, '127.0.0.1', resolve);
    });
    const { port } = mcpStub.address() as AddressInfo;
    return `http://127.0.0.1:${port}/mcp`;
  };

  /** The `system` text of the most recent request the provider stub received. */
  const lastSystemText = (): string => {
    const body = requestBodies.at(-1);
    const system = body?.system;
    if (typeof system === 'string') return system;
    if (!Array.isArray(system)) return '';
    return system
      .map((block) => {
        return typeof block === 'object' && block && 'text' in block
          ? String((block as { text: unknown }).text)
          : '';
      })
      .join('\n');
  };

  const generate = async (agentId: string) => {
    return authenticatedTestClient(userToken)
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'where is my order?' }] });
  };

  beforeAll(async () => {
    requestBodies = [];
    mcpStatus = 401;
    const providerBaseUrl = await startProviderStub();
    const mcpUrl = await startMcpStub();

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'unavailadmin', password: 'supersecret' });
    const adminToken = await loginAs('unavailadmin', 'supersecret');

    const userRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'unavailuser', password: 'unavailpass' });
    userToken = await loginAs('unavailuser', 'unavailpass');

    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: [
                'agents:CreateAgent',
                'agents:GetAgent',
                'agents:CreateAgentGeneration',
                'secrets:CreateSecret',
                'tools:CreateTool',
                'activity:ListActivity',
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
      .send({ name: 'Unavailable Tools Project' });
    projectId = projectRes.body.id;

    const secretRes = await authenticatedTestClient(userToken)
      .post('/api/v1/secrets')
      .send({
        project_id: projectId,
        name: 'Unavailable Provider Key',
        value: 'sk-ant-stub',
      });

    const aiProviderRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Stub Anthropic',
        provider: 'anthropic',
        default_model: 'claude-haiku-4-5',
        secret_id: secretRes.body.id,
        base_url: providerBaseUrl,
      });
    aiProviderId = aiProviderRes.body.id;

    const toolRes = await authenticatedTestClient(userToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'orderDesk',
        type: 'mcp',
        mcp: { url: mcpUrl },
      });
    expect(toolRes.status).toBe(201);
    mcpToolId = toolRes.body.id;
  });

  const createAgent = async (body: Record<string, unknown>) => {
    const response = await authenticatedTestClient(userToken)
      .post('/api/v1/agents')
      .send({
        ai_provider_id: aiProviderId,
        project_id: projectId,
        model: 'claude-haiku-4-5',
        tool_bindings: [{ tool_id: mcpToolId }],
        ...body,
      });
    expect(response.status).toBe(201);
    return response.body.id as string;
  };

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      providerStub.close(() => {
        return resolve();
      });
    });
    await new Promise<void>((resolve) => {
      mcpStub.close(() => {
        return resolve();
      });
    });
  });

  test('a dropped binding is named to the model as unavailable', async () => {
    mcpStatus = 401;
    const agentId = await createAgent({
      name: 'Order Agent',
      instructions: 'Be terse.',
    });

    const response = await generate(agentId);
    expect(response.status).toBe(200);

    const system = lastSystemText();
    expect(system).toContain('orderDesk');
    expect(system).toContain('unavailable');
    // The agent's own instructions still reach the turn.
    expect(system).toContain('Be terse.');
  });

  test('the operator-grade reason never reaches the model', async () => {
    mcpStatus = 403;
    const agentId = await createAgent({ name: 'Sanitized Agent' });

    const response = await generate(agentId);
    expect(response.status).toBe(200);

    const wire = JSON.stringify(requestBodies.at(-1));
    expect(wire).not.toContain('tools/list');
    expect(wire).not.toContain('403');
  });

  test('a binding that resolves adds no note', async () => {
    mcpStatus = 200;
    const agentId = await createAgent({ name: 'Healthy Agent' });

    const response = await generate(agentId);
    expect(response.status).toBe(200);

    expect(lastSystemText()).not.toContain('unavailable');
    const tools = requestBodies.at(-1)?.tools;
    expect(Array.isArray(tools) ? tools.length : 0).toBe(1);
  });

  test('an agent with no bindings at all adds no note', async () => {
    const response = await authenticatedTestClient(userToken)
      .post('/api/v1/agents')
      .send({
        ai_provider_id: aiProviderId,
        project_id: projectId,
        model: 'claude-haiku-4-5',
        name: 'Toolless Agent',
      });
    expect(response.status).toBe(201);

    const generated = await generate(response.body.id);
    expect(generated.status).toBe(200);
    expect(lastSystemText()).not.toContain('unavailable');
  });
});
