import http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

// A tool the operator publishes from its own project: callable by id from any
// project, which reads a redacted view of it, pays for its calls and gates
// them, while the tool's secrets stay in the owning project.

type WireEvent = {
  project_id: string;
  tool_id: string | null;
  cost_usd: number | null;
  components: Array<{ component: string; quantity: number }>;
};

type ChatRequest = {
  messages?: Array<{ role: string }>;
  tools?: Array<{ function: { name: string } }>;
};

const SECRET_VALUE = 'operator-ocr-key';

const chatCompletion = (body: ChatRequest) => {
  const answered = (body.messages ?? []).some((message) => {
    return message.role === 'tool';
  });
  return {
    id: 'chatcmpl-published',
    object: 'chat.completion',
    created: 0,
    model: 'stub-model',
    choices: [
      {
        index: 0,
        message: answered
          ? { role: 'assistant', content: 'done' }
          : {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_ocr',
                  type: 'function',
                  function: {
                    name: body.tools?.[0]?.function.name,
                    arguments: '{}',
                  },
                },
              ],
            },
        finish_reason: answered ? 'stop' : 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
};

describe('published tools', () => {
  let adminToken: string;
  let operatorProjectId: string;
  let tenantProjectId: string;
  let tenantToken: string;
  let tenantKey: string;
  let server: http.Server;
  let url: string;
  const receivedKeys: string[] = [];
  let secretId: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url?.startsWith('/ocr')) {
          receivedKeys.push(String(req.headers['x-api-key']));
          res.end(JSON.stringify({ page_count: 2 }));
          return;
        }
        res.end(JSON.stringify(chatCompletion(JSON.parse(raw))));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const setup = await setupProjectWithUsers({
      prefix: 'pubtool',
      policyActions: ['tools:GetTool'],
      createOtherProject: true,
    });
    adminToken = setup.adminToken;
    operatorProjectId = setup.projectId;
    tenantProjectId = setup.otherProjectId as string;

    tenantToken = await createScopedPrincipal({
      adminToken,
      projectId: tenantProjectId,
      username: 'pubtooltenant',
      actions: [
        'tools:CreateTool',
        'tools:GetTool',
        'tools:UpdateTool',
        'tools:DeleteTool',
        'tools:CallTool',
        'agents:CreateAgent',
        'agents:CreateAgentGeneration',
        'orchestrations:CreateOrchestration',
        'orchestrations:StartRun',
        'usage:ListEvents',
        'api-keys:CreateApiKey',
      ],
    });
    const key = await authenticatedTestClient(tenantToken)
      .post('/api/v1/api-keys')
      .send({ name: 'tenant key', project_id: tenantProjectId });
    expect(key.status).toBe(201);
    tenantKey = key.body.key;

    const secret = await authenticatedTestClient(adminToken)
      .post('/api/v1/secrets')
      .send({
        project_id: operatorProjectId,
        name: 'OCR_KEY',
        value: SECRET_VALUE,
      });
    expect(secret.status).toBe(201);
    secretId = secret.body.id;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  const createOperatorTool = async (
    extra: Record<string, unknown> = {}
  ): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: operatorProjectId,
        name: `ocr_${Math.random().toString(36).slice(2, 10)}`,
        type: 'http',
        description: 'Reads a document',
        parameters: { type: 'object', properties: {} },
        execute: {
          url: `${url}/ocr`,
          method: 'POST',
          headers: { 'X-Api-Key': `{{secret:${secretId}}}` },
        },
        output_mapping: { var: 'output' },
        published: true,
        ...extra,
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const eventsIn = async (
    projectId: string,
    toolId: string
  ): Promise<WireEvent[]> => {
    const res = await authenticatedTestClient(adminToken).get(
      `/api/v1/usage/events?meter_type=tool_execution&tool_id=${toolId}`
    );
    expect(res.status).toBe(200);
    return res.body.data.filter((event: WireEvent) => {
      return event.project_id === projectId;
    });
  };

  describe('POST /api/v1/tools', () => {
    test('an admin publishes a tool', async () => {
      const toolId = await createOperatorTool();
      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/tools/${toolId}`
      );
      expect(res.status).toBe(200);
      expect(res.body.published).toBe(true);
    });

    test('a tool is unpublished by default', async () => {
      const res = await authenticatedTestClient(tenantToken)
        .post('/api/v1/tools')
        .send({
          project_id: tenantProjectId,
          name: 'own_tool',
          type: 'client',
        });
      expect(res.status).toBe(201);
      expect(res.body.published).toBe(false);
    });

    test('returns 403 when a non-admin sets published', async () => {
      const res = await authenticatedTestClient(tenantToken)
        .post('/api/v1/tools')
        .send({
          project_id: tenantProjectId,
          name: 'self_published',
          type: 'client',
          published: true,
        });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('GET /api/v1/tools/{tool_id}', () => {
    test('another project reads a redacted view', async () => {
      const toolId = await createOperatorTool();

      const res = await authenticatedTestClient(tenantToken).get(
        `/api/v1/tools/${toolId}?project_id=${tenantProjectId}`
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        id: toolId,
        name: expect.any(String),
        description: 'Reads a document',
        parameters: { type: 'object', properties: {} },
        published: true,
      });
    });

    test('a key scoped to another project reads the redacted view without naming it', async () => {
      const toolId = await createOperatorTool();

      const res = await authenticatedTestClient(tenantKey).get(
        `/api/v1/tools/${toolId}`
      );

      expect(res.status).toBe(200);
      expect(res.body.execute).toBeUndefined();
      expect(res.body.project_id).toBeUndefined();
      expect(res.body.output_mapping).toBeUndefined();
    });

    test('an unpublished tool stays 404 from another project', async () => {
      const toolId = await createOperatorTool({ published: false });

      const res = await authenticatedTestClient(tenantToken).get(
        `/api/v1/tools/${toolId}?project_id=${tenantProjectId}`
      );

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });

    test('returns 401 without auth', async () => {
      const toolId = await createOperatorTool();
      const res = await testClient.get(`/api/v1/tools/${toolId}`);
      expect(res.status).toBe(401);
    });
  });

  describe('writes from another project', () => {
    test('PATCH returns 403', async () => {
      const toolId = await createOperatorTool();

      const res = await authenticatedTestClient(tenantToken)
        .patch(`/api/v1/tools/${toolId}`)
        .send({ description: 'taken over' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    test('DELETE returns 403', async () => {
      const toolId = await createOperatorTool();

      const res = await authenticatedTestClient(tenantToken).delete(
        `/api/v1/tools/${toolId}`
      );

      expect(res.status).toBe(403);
    });

    test('an admin unpublishes, and a non-admin cannot', async () => {
      const toolId = await createOperatorTool();

      const denied = await authenticatedTestClient(tenantToken)
        .patch(`/api/v1/tools/${toolId}`)
        .send({ published: false });
      expect(denied.status).toBe(403);

      const res = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/tools/${toolId}`)
        .send({ published: false });
      expect(res.status).toBe(200);
      expect(res.body.published).toBe(false);
    });
  });

  describe('POST /api/v1/tools/{tool_id}/call', () => {
    test("is metered to the calling project, with the owner's secret", async () => {
      const toolId = await createOperatorTool();
      receivedKeys.length = 0;

      const res = await authenticatedTestClient(tenantToken)
        .post(`/api/v1/tools/${toolId}/call`)
        .send({ project_id: tenantProjectId, input: {} });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ page_count: 2 });
      expect(receivedKeys).toEqual([SECRET_VALUE]);
      expect(await eventsIn(tenantProjectId, toolId)).toHaveLength(1);
      expect(await eventsIn(operatorProjectId, toolId)).toEqual([]);
    });

    test('a key scoped to another project calls it without naming it', async () => {
      const toolId = await createOperatorTool();

      const res = await authenticatedTestClient(tenantKey)
        .post(`/api/v1/tools/${toolId}/call`)
        .send({ input: {} });

      expect(res.status).toBe(200);
      expect(await eventsIn(tenantProjectId, toolId)).toHaveLength(1);
    });

    test("the tool's price row prices the caller's event", async () => {
      const toolId = await createOperatorTool();
      const price = await authenticatedTestClient(adminToken)
        .put('/api/v1/usage/prices')
        .send({
          prices: [
            {
              meter_type: 'tool_execution',
              provider: 'soat',
              model: 'tool-call',
              tool_id: toolId,
              component: 'page',
              unit: 'page',
              quantity: { var: 'response.page_count' },
              unit_price: 0.002,
              effective_from: '2000-01-01T00:00:00.000Z',
            },
          ],
        });
      expect(price.status).toBe(200);

      const res = await authenticatedTestClient(tenantToken)
        .post(`/api/v1/tools/${toolId}/call`)
        .send({ project_id: tenantProjectId });
      expect(res.status).toBe(200);

      const [event] = await eventsIn(tenantProjectId, toolId);
      expect(event.cost_usd).toBe(0.004);
      expect(event.components).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ component: 'page', quantity: 2 }),
        ])
      );
    });

    test('an unpublished tool stays 404 from another project', async () => {
      const toolId = await createOperatorTool({ published: false });

      const res = await authenticatedTestClient(tenantToken)
        .post(`/api/v1/tools/${toolId}/call`)
        .send({ project_id: tenantProjectId });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });

    test("the calling project's guardrails gate it, and the tool's own do not", async () => {
      const blockOwner = await authenticatedTestClient(adminToken)
        .post('/api/v1/guardrails')
        .send({
          project_id: operatorProjectId,
          name: 'owner block',
          document: { class: 'D' },
        });
      expect(blockOwner.status).toBe(201);
      const toolId = await createOperatorTool({
        guardrail_ids: [blockOwner.body.id],
      });

      const fromTenant = await authenticatedTestClient(tenantToken)
        .post(`/api/v1/tools/${toolId}/call`)
        .send({ project_id: tenantProjectId });
      expect(fromTenant.status).toBe(200);

      const gatedProject = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'pubtool gated project' });
      const blockCaller = await authenticatedTestClient(adminToken)
        .post('/api/v1/guardrails')
        .send({
          project_id: gatedProject.body.id,
          name: 'caller block',
          document: { class: 'D' },
        });
      expect(
        (
          await authenticatedTestClient(adminToken)
            .patch(`/api/v1/projects/${gatedProject.body.id}`)
            .send({ guardrail_ids: [blockCaller.body.id] })
        ).status
      ).toBe(200);

      const fromGated = await authenticatedTestClient(adminToken)
        .post(`/api/v1/tools/${toolId}/call`)
        .send({ project_id: gatedProject.body.id });
      expect(fromGated.body.error.code).toBe('TOOL_DISPATCH_FAILED');
    });

    test('a published pipeline runs its unpublished steps for another project', async () => {
      const stepId = await createOperatorTool({ published: false });
      const pipeline = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: operatorProjectId,
          name: 'ocr_pipeline',
          type: 'pipeline',
          published: true,
          pipeline: { steps: [{ id: 'read', tool_id: stepId }] },
        });
      expect(pipeline.status).toBe(201);

      const res = await authenticatedTestClient(tenantToken)
        .post(`/api/v1/tools/${pipeline.body.id}/call`)
        .send({ project_id: tenantProjectId });

      expect(res.status).toBe(200);
      expect(await eventsIn(tenantProjectId, stepId)).toHaveLength(1);
    });
  });

  describe('references from another project', () => {
    test("a pipeline step names it and is metered to the pipeline's project", async () => {
      const toolId = await createOperatorTool();
      const pipeline = await authenticatedTestClient(tenantToken)
        .post('/api/v1/tools')
        .send({
          project_id: tenantProjectId,
          name: 'tenant_pipeline',
          type: 'pipeline',
          pipeline: { steps: [{ id: 'read', tool_id: toolId }] },
        });
      expect(pipeline.status).toBe(201);

      const res = await authenticatedTestClient(tenantToken)
        .post(`/api/v1/tools/${pipeline.body.id}/call`)
        .send({});

      expect(res.status).toBe(200);
      expect(await eventsIn(tenantProjectId, toolId)).toHaveLength(1);
    });

    test('a pipeline step cannot name an unpublished tool of another project', async () => {
      const toolId = await createOperatorTool({ published: false });

      const res = await authenticatedTestClient(tenantToken)
        .post('/api/v1/tools')
        .send({
          project_id: tenantProjectId,
          name: 'tenant_pipeline_bad',
          type: 'pipeline',
          pipeline: { steps: [{ id: 'read', tool_id: toolId }] },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PIPELINE_INVALID_STEP');
    });

    test('an orchestration tool node calls it', async () => {
      const toolId = await createOperatorTool();
      const orchestration = await authenticatedTestClient(tenantToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'tenant ocr run',
          project_id: tenantProjectId,
          nodes: [
            { id: 'read', type: 'tool', tool_id: toolId, input_mapping: {} },
          ],
          edges: [],
        });
      expect(orchestration.status).toBe(201);

      const run = await authenticatedTestClient(tenantToken)
        .post('/api/v1/orchestration-runs')
        .send({
          wait: true,
          orchestration_id: orchestration.body.id,
          input: {},
        });

      expect(run.status).toBe(201);
      expect(run.body.status).toBe('succeeded');
      expect(await eventsIn(tenantProjectId, toolId)).toHaveLength(1);
    });

    test("an agent's tool binding calls it during a generation", async () => {
      const toolId = await createOperatorTool();
      const provider = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: tenantProjectId,
          name: 'published tool stub',
          provider: 'ollama',
          default_model: 'stub-model',
          base_url: url,
        });
      expect(provider.status).toBe(201);
      const agent = await authenticatedTestClient(tenantToken)
        .post('/api/v1/agents')
        .send({
          project_id: tenantProjectId,
          ai_provider_id: provider.body.id,
          name: 'tenant ocr agent',
          tool_bindings: [{ tool_id: toolId }],
        });
      expect(agent.status).toBe(201);

      const generation = await authenticatedTestClient(tenantToken)
        .post(`/api/v1/agents/${agent.body.id}/generate?wait=true`)
        .send({ messages: [{ role: 'user', content: 'read it' }] });

      expect(generation.status).toBe(200);
      expect(generation.body.status).toBe('completed');
      expect(await eventsIn(tenantProjectId, toolId)).toHaveLength(1);
    });
  });
});
