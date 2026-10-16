import { db } from 'src/db';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * An inline tool definition — `tool_bindings[].tool` on an agent,
 * `pipeline.steps[].tool` on a pipeline tool — carries the same `execute` /
 * `mcp` bags as a stored tool, so a literal credential in one is masked on
 * every surface that serializes it, while the stored row keeps the value the
 * call sends.
 */
describe('an inline tool definition never echoes a literal credential', () => {
  let adminToken: string;
  let projectId: string;
  let aiProviderId: string;
  let reference: string;

  const LITERAL = 'Bearer inline-literal-must-not-leak';
  const HOOK_URL = 'https://hooks.example.com/inline-tool-secret-echo';
  const MCP = {
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: LITERAL, 'X-Trace': 'keep-me' },
  };

  const inlineBinding = (name: string) => {
    return { tool: { name, type: 'mcp', mcp: MCP } };
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'itse',
      policyActions: ['tools:GetTool', 'agents:GetAgent'],
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
    const provider = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'itse-provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    aiProviderId = provider.body.id;
    const secret = await authenticatedTestClient(adminToken)
      .post('/api/v1/secrets')
      .send({ project_id: projectId, name: 'itse-secret', value: 'sk-ref' });
    reference = `Bearer {{secret:${secret.body.id}}}`;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('a pipeline step', () => {
    test('a nested inline tool is masked on create, read and list', async () => {
      const created = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'itse-pipeline',
          type: 'pipeline',
          pipeline: {
            steps: [
              {
                id: 'inline',
                tool: { name: 'itse-step', type: 'mcp', mcp: MCP },
              },
            ],
          },
        });
      expect(created.status).toBe(201);
      expect(JSON.stringify(created.body)).not.toContain(LITERAL);

      const read = await authenticatedTestClient(adminToken).get(
        `/api/v1/tools/${created.body.id}`
      );
      expect(read.status).toBe(200);
      expect(read.body.pipeline.steps[0].tool.mcp.headers).toEqual({
        Authorization: { no_echo: true },
        'X-Trace': 'keep-me',
      });

      const list = await authenticatedTestClient(adminToken).get(
        `/api/v1/tools?project_id=${projectId}`
      );
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).not.toContain(LITERAL);
    });
  });

  describe('an agent binding', () => {
    let agentId: string;
    let webhookId: string;
    let fetchSpy: jest.SpyInstance;

    beforeAll(async () => {
      const hook = await authenticatedTestClient(adminToken)
        .post('/api/v1/webhooks')
        .send({
          project_id: projectId,
          name: 'itse-hook',
          url: HOOK_URL,
          events: ['agents.*'],
        });
      expect(hook.status).toBe(201);
      webhookId = hook.body.id;

      const agent = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          name: 'itse-shared-agent',
          ai_provider_id: aiProviderId,
          tool_bindings: [inlineBinding('itse-inline')],
        });
      expect(agent.status).toBe(201);
      agentId = agent.body.id;
    });

    beforeEach(() => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response('ok', { status: 200 }));
    });

    test('the create response masks the literal and keeps a reference', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          name: 'itse-create-agent',
          ai_provider_id: aiProviderId,
          tool_bindings: [
            inlineBinding('itse-inline'),
            {
              tool: {
                name: 'itse-ref',
                type: 'mcp',
                mcp: { url: MCP.url, headers: { Authorization: reference } },
              },
            },
          ],
        });
      expect(res.status).toBe(201);
      expect(JSON.stringify(res.body)).not.toContain(LITERAL);
      expect(res.body.tool_bindings[0].tool.mcp.headers).toEqual({
        Authorization: { no_echo: true },
        'X-Trace': 'keep-me',
      });
      expect(res.body.tool_bindings[1].tool.mcp.headers.Authorization).toBe(
        reference
      );
    });

    test('the stored binding keeps the literal the call sends', async () => {
      const row = await db.Agent.findOne({ where: { publicId: agentId } });
      expect(JSON.stringify(row?.toJSON())).toContain(LITERAL);
    });

    test('read and list mask it', async () => {
      const read = await authenticatedTestClient(adminToken).get(
        `/api/v1/agents/${agentId}`
      );
      expect(read.status).toBe(200);
      expect(JSON.stringify(read.body)).not.toContain(LITERAL);

      const list = await authenticatedTestClient(adminToken).get(
        `/api/v1/agents?project_id=${projectId}`
      );
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).not.toContain(LITERAL);
    });

    test('PATCH and PUT responses mask it', async () => {
      const patched = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/agents/${agentId}`)
        .send({ name: 'itse-agent-patched' });
      expect(patched.status).toBe(200);
      expect(JSON.stringify(patched.body)).not.toContain(LITERAL);

      const put = await authenticatedTestClient(adminToken)
        .put(`/api/v1/agents/${agentId}`)
        .send({
          name: 'itse-agent-put',
          ai_provider_id: aiProviderId,
          tool_bindings: [inlineBinding('itse-inline')],
        });
      expect(put.status).toBe(200);
      expect(JSON.stringify(put.body)).not.toContain(LITERAL);
    });

    test('archived versions mask it, and restore still replays the literal', async () => {
      const patched = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/agents/${agentId}`)
        .send({ instructions: `itse-${Date.now()}` });
      expect(patched.status).toBe(200);

      const list = await authenticatedTestClient(adminToken).get(
        `/api/v1/agents/${agentId}/versions`
      );
      expect(list.status).toBe(200);
      expect(list.body.data.length).toBeGreaterThan(1);
      expect(JSON.stringify(list.body)).not.toContain(LITERAL);

      const one = await authenticatedTestClient(adminToken).get(
        `/api/v1/agents/${agentId}/versions/1`
      );
      expect(one.status).toBe(200);
      expect(JSON.stringify(one.body)).not.toContain(LITERAL);
      expect(
        one.body.config.tool_bindings[0].tool.mcp.headers.Authorization
      ).toEqual({ no_echo: true });

      const restored = await authenticatedTestClient(adminToken)
        .post(`/api/v1/agents/${agentId}/versions/1/restore`)
        .send({});
      expect(restored.status).toBe(200);
      expect(JSON.stringify(restored.body)).not.toContain(LITERAL);

      const row = await db.Agent.findOne({ where: { publicId: agentId } });
      expect(JSON.stringify(row?.toJSON())).toContain(LITERAL);
    });

    test('webhook deliveries never carry it, sent or stored', async () => {
      await authenticatedTestClient(adminToken)
        .patch(`/api/v1/agents/${agentId}`)
        .send({ name: 'itse-agent-webhook' });

      let deliveries: Array<{ payload: unknown }> = [];
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const res = await authenticatedTestClient(adminToken).get(
          `/api/v1/webhook-deliveries?webhook_id=${webhookId}&limit=100`
        );
        deliveries = res.body.data ?? [];
        const sent = fetchSpy.mock.calls.filter(([url]) => {
          return String(url) === HOOK_URL;
        });
        if (deliveries.length > 0 && sent.length > 0) break;
        await new Promise((resolve) => {
          return setTimeout(resolve, 25);
        });
      }

      expect(deliveries.length).toBeGreaterThan(0);
      expect(JSON.stringify(deliveries)).not.toContain(LITERAL);

      const sentBodies = fetchSpy.mock.calls
        .filter(([url]) => {
          return String(url) === HOOK_URL;
        })
        .map(([, init]) => {
          return String((init as RequestInit).body);
        });
      expect(sentBodies.length).toBeGreaterThan(0);
      for (const body of sentBodies) {
        expect(body).not.toContain(LITERAL);
      }
    });
  });
});
