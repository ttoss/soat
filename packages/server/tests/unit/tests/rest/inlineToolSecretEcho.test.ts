import { db } from 'src/db';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A credential slot in a tool definition — stored, a pipeline step's inline
 * `tool`, or an agent's `tool_bindings[].tool` — takes a reference and refuses
 * a literal. A literal already in the database is masked on every surface that
 * serializes the definition; the API cannot write one, so those rows are
 * planted directly.
 */
describe('a literal credential in a tool definition', () => {
  let adminToken: string;
  let projectId: string;
  let aiProviderId: string;
  let reference: string;

  const LITERAL = 'Bearer inline-literal-must-not-leak';
  const HOOK_URL = 'https://hooks.example.com/inline-tool-secret-echo';
  const MCP_URL = 'https://mcp.example.com/mcp';

  const mcpWith = (authorization: string) => {
    return {
      url: MCP_URL,
      headers: { Authorization: authorization, 'X-Trace': 'keep-me' },
    };
  };

  const client = () => {
    return authenticatedTestClient(adminToken);
  };

  /** Swaps the reference for the literal inside one stored JSON column. */
  const plantLiteral = async (args: {
    row: {
      get: (field: string) => unknown;
      update: (values: object) => Promise<unknown>;
    };
    field: string;
  }) => {
    const planted = JSON.parse(
      JSON.stringify(args.row.get(args.field)).split(reference).join(LITERAL)
    );
    await args.row.update({ [args.field]: planted });
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'itse',
      policyActions: ['tools:GetTool', 'agents:GetAgent'],
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
    const provider = await client().post('/api/v1/ai-providers').send({
      project_id: projectId,
      name: 'itse-provider',
      provider: 'ollama',
      default_model: 'llama3.2',
    });
    aiProviderId = provider.body.id;
    const secret = await client()
      .post('/api/v1/secrets')
      .send({ project_id: projectId, name: 'itse-secret', value: 'sk-ref' });
    reference = `Bearer {{secret:${secret.body.id}}}`;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('is refused on write', () => {
    test.each([
      [
        'a credential-named header',
        {
          type: 'mcp',
          mcp: { url: MCP_URL, headers: { 'X-Api-Key': 'sk-1' } },
        },
        'mcp.headers.X-Api-Key',
      ],
      [
        'an auth secret field',
        {
          type: 'http',
          execute: {
            url: 'https://s3.example.com/{key}',
            auth: {
              type: 'aws_sigv4',
              region: 'us-east-1',
              service: 's3',
              access_key_id: 'AKIA',
              secret_access_key: 'shh',
            },
          },
        },
        'execute.auth.secret_access_key',
      ],
      [
        'a credential-named query parameter',
        {
          type: 'http',
          execute: { url: 'https://api.example.com/q?key=sk-2' },
        },
        'execute.url',
      ],
      [
        'a url password',
        { type: 'mcp', mcp: { url: 'https://user:hunter2@mcp.example.com' } },
        'mcp.url',
      ],
    ])('POST /tools: %s', async (_label, definition, path) => {
      const res = await client()
        .post('/api/v1/tools')
        .send({ project_id: projectId, name: 'itse-refused', ...definition });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('LITERAL_CREDENTIAL');
      expect(res.body.error.meta.paths).toEqual([path]);
    });

    test('POST /tools accepts references, argument placeholders and plain headers', async () => {
      const res = await client()
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'itse-accepted',
          type: 'http',
          execute: {
            url: 'https://api.example.com/q?key={api_key}&page=2',
            headers: {
              Authorization: reference,
              'X-Token': 'Bearer {{context:userToken}}',
              'X-Trace': 'keep-me',
            },
          },
        });

      expect(res.status).toBe(201);
      expect(res.body.execute.headers.Authorization).toBe(reference);
    });

    test('PATCH /tools/{tool_id}', async () => {
      const created = await client()
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'itse-patch',
          type: 'mcp',
          mcp: mcpWith(reference),
        });
      const res = await client()
        .patch(`/api/v1/tools/${created.body.id}`)
        .send({ mcp: mcpWith(LITERAL) });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('LITERAL_CREDENTIAL');
    });

    test('a pipeline step names the step in the path', async () => {
      const res = await client()
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'itse-pipeline-refused',
          type: 'pipeline',
          pipeline: {
            steps: [
              {
                id: 'inline',
                tool: { name: 'itse-step', type: 'mcp', mcp: mcpWith(LITERAL) },
              },
            ],
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('LITERAL_CREDENTIAL');
      expect(res.body.error.meta.paths).toEqual([
        'pipeline.steps[0].tool.mcp.headers.Authorization',
      ]);
    });

    test('an agent binding, on create and on update', async () => {
      const binding = {
        tool: { name: 'itse-inline', type: 'mcp', mcp: mcpWith(LITERAL) },
      };
      const created = await client()
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          name: 'itse-agent-refused',
          ai_provider_id: aiProviderId,
          tool_bindings: [binding],
        });
      expect(created.status).toBe(400);
      expect(created.body.error.code).toBe('LITERAL_CREDENTIAL');

      const agent = await client().post('/api/v1/agents').send({
        project_id: projectId,
        name: 'itse-agent-patch-refused',
        ai_provider_id: aiProviderId,
      });
      const patched = await client()
        .patch(`/api/v1/agents/${agent.body.id}`)
        .send({ tool_bindings: [binding] });
      expect(patched.status).toBe(400);
      expect(patched.body.error.code).toBe('LITERAL_CREDENTIAL');
    });
  });

  describe('already stored in a pipeline step', () => {
    test('is masked on read and list', async () => {
      const created = await client()
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'itse-pipeline',
          type: 'pipeline',
          pipeline: {
            steps: [
              {
                id: 'inline',
                tool: {
                  name: 'itse-step',
                  type: 'mcp',
                  mcp: mcpWith(reference),
                },
              },
            ],
          },
        });
      expect(created.status).toBe(201);
      const row = await db.Tool.findOne({
        where: { publicId: created.body.id },
      });
      await plantLiteral({ row: row!, field: 'pipeline' });

      const read = await client().get(`/api/v1/tools/${created.body.id}`);
      expect(read.status).toBe(200);
      expect(read.body.pipeline.steps[0].tool.mcp.headers).toEqual({
        Authorization: { no_echo: true },
        'X-Trace': 'keep-me',
      });

      const list = await client().get(`/api/v1/tools?project_id=${projectId}`);
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).not.toContain(LITERAL);
    });
  });

  describe('already stored in an agent binding', () => {
    let agentId: string;
    let webhookId: string;
    let fetchSpy: jest.SpyInstance;

    beforeAll(async () => {
      const hook = await client()
        .post('/api/v1/webhooks')
        .send({
          project_id: projectId,
          name: 'itse-hook',
          url: HOOK_URL,
          events: ['agents.*'],
        });
      expect(hook.status).toBe(201);
      webhookId = hook.body.id;

      const agent = await client()
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          name: 'itse-shared-agent',
          ai_provider_id: aiProviderId,
          tool_bindings: [
            {
              tool: {
                name: 'itse-inline',
                type: 'mcp',
                mcp: mcpWith(reference),
              },
            },
          ],
        });
      expect(agent.status).toBe(201);
      agentId = agent.body.id;

      const row = await db.Agent.findOne({ where: { publicId: agentId } });
      await plantLiteral({ row: row!, field: 'toolBindings' });
      const versions = await db.AgentVersion.findAll({
        where: { agentId: row!.id },
      });
      for (const version of versions) {
        await plantLiteral({ row: version, field: 'config' });
      }
    });

    beforeEach(() => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response('ok', { status: 200 }));
    });

    test('read and list mask it', async () => {
      const read = await client().get(`/api/v1/agents/${agentId}`);
      expect(read.status).toBe(200);
      expect(JSON.stringify(read.body)).not.toContain(LITERAL);
      expect(read.body.tool_bindings[0].tool.mcp.headers).toEqual({
        Authorization: { no_echo: true },
        'X-Trace': 'keep-me',
      });

      const list = await client().get(`/api/v1/agents?project_id=${projectId}`);
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).not.toContain(LITERAL);
    });

    test('a PATCH response masks it', async () => {
      const patched = await client()
        .patch(`/api/v1/agents/${agentId}`)
        .send({ name: 'itse-agent-patched' });
      expect(patched.status).toBe(200);
      expect(JSON.stringify(patched.body)).not.toContain(LITERAL);
    });

    test('archived versions mask it, and restoring one is refused', async () => {
      const list = await client().get(`/api/v1/agents/${agentId}/versions`);
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).not.toContain(LITERAL);

      const one = await client().get(`/api/v1/agents/${agentId}/versions/1`);
      expect(one.status).toBe(200);
      expect(
        one.body.config.tool_bindings[0].tool.mcp.headers.Authorization
      ).toEqual({ no_echo: true });

      const restored = await client()
        .post(`/api/v1/agents/${agentId}/versions/1/restore`)
        .send({});
      expect(restored.status).toBe(400);
      expect(restored.body.error.code).toBe('LITERAL_CREDENTIAL');
    });

    test('webhook deliveries never carry it, sent or stored', async () => {
      await client()
        .patch(`/api/v1/agents/${agentId}`)
        .send({ instructions: `itse-${Date.now()}` });

      let deliveries: Array<{ payload: unknown }> = [];
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const res = await client().get(
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
