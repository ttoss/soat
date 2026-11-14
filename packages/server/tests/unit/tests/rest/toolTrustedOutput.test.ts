import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * `trusted_output: true` loosens every guardrail reading
 * `runtime.generations.untrusted_tool_results`, so whoever writes it holds
 * `guardrails:DetachGuardrail` besides the write's own permission, on every
 * path a tool definition is written through.
 */
describe('Tool trusted_output', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let providerId: string;

  const admin = () => {
    return authenticatedTestClient(adminToken);
  };
  const user = () => {
    return authenticatedTestClient(userToken);
  };
  const unique = (base: string) => {
    return `${base}-${Math.random().toString(36).slice(2, 8)}`;
  };

  const toolBody = (fields: Record<string, unknown> = {}) => {
    return {
      name: unique('trusted'),
      type: 'http',
      parameters: { type: 'object', properties: {} },
      execute: { url: 'https://example.com/read', method: 'GET' },
      ...fields,
    };
  };

  const expectNotHeld = (res: {
    status: number;
    body: { error: { code: string; meta: unknown } };
  }) => {
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACTION_NOT_HELD');
    expect(res.body.error.meta).toEqual({
      action: 'guardrails:DetachGuardrail',
      resource: `srn:${projectId}:guardrail:*`,
    });
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'tooltrusted',
      policyActions: [
        'tools:CreateTool',
        'tools:UpdateTool',
        'tools:GetTool',
        'agents:CreateAgent',
        'formations:CreateFormation',
        'formations:GetFormation',
      ],
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;

    const provider = await admin().post('/api/v1/ai-providers').send({
      project_id: projectId,
      name: 'Trusted Output Provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: 'http://127.0.0.1:9',
    });
    expect(provider.status).toBe(201);
    providerId = provider.body.id;
  });

  describe('POST /api/v1/tools', () => {
    test('defaults to false', async () => {
      const res = await user()
        .post('/api/v1/tools')
        .send({ project_id: projectId, ...toolBody() });

      expect(res.status).toBe(201);
      expect(res.body.trusted_output).toBe(false);
    });

    test('true with guardrails:DetachGuardrail', async () => {
      const res = await admin()
        .post('/api/v1/tools')
        .send({ project_id: projectId, ...toolBody({ trusted_output: true }) });

      expect(res.status).toBe(201);
      expect(res.body.trusted_output).toBe(true);
    });

    test('true without guardrails:DetachGuardrail is 403 ACTION_NOT_HELD', async () => {
      const res = await user()
        .post('/api/v1/tools')
        .send({ project_id: projectId, ...toolBody({ trusted_output: true }) });

      expectNotHeld(res);
    });

    test('a non-boolean is 400', async () => {
      const res = await admin()
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          ...toolBody({ trusted_output: 'yes' }),
        });

      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /api/v1/tools/{tool_id}', () => {
    let toolId: string;

    beforeAll(async () => {
      const res = await user()
        .post('/api/v1/tools')
        .send({ project_id: projectId, ...toolBody() });
      expect(res.status).toBe(201);
      toolId = res.body.id;
    });

    test('setting true without guardrails:DetachGuardrail is 403 ACTION_NOT_HELD', async () => {
      const res = await user()
        .patch(`/api/v1/tools/${toolId}`)
        .send({ trusted_output: true });

      expectNotHeld(res);
      const read = await admin().get(`/api/v1/tools/${toolId}`);
      expect(read.body.trusted_output).toBe(false);
    });

    test('setting false needs no more than the update', async () => {
      const res = await user()
        .patch(`/api/v1/tools/${toolId}`)
        .send({ trusted_output: false, description: 'still untrusted' });

      expect(res.status).toBe(200);
      expect(res.body.trusted_output).toBe(false);
    });

    test('setting true with guardrails:DetachGuardrail', async () => {
      const res = await admin()
        .patch(`/api/v1/tools/${toolId}`)
        .send({ trusted_output: true });

      expect(res.status).toBe(200);
      expect(res.body.trusted_output).toBe(true);
    });
  });

  describe("an agent's inline tool definition", () => {
    const createAgent = (
      client: () => ReturnType<typeof authenticatedTestClient>,
      tool: Record<string, unknown>
    ) => {
      return client()
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: providerId,
          name: unique('trusted-agent'),
          tool_bindings: [{ tool: toolBody(tool) }],
        });
    };

    test('true without guardrails:DetachGuardrail is 403 ACTION_NOT_HELD', async () => {
      expectNotHeld(await createAgent(user, { trusted_output: true }));
    });

    test('true with guardrails:DetachGuardrail is stored and read back', async () => {
      const res = await createAgent(admin, { trusted_output: true });

      expect(res.status).toBe(201);
      expect(res.body.tool_bindings[0].tool.trusted_output).toBe(true);
    });
  });

  describe('a formation tool resource', () => {
    const applyTool = (
      client: () => ReturnType<typeof authenticatedTestClient>
    ) => {
      return client()
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: unique('trusted-formation'),
          template: {
            resources: {
              Reader: {
                type: 'tool',
                properties: toolBody({ trusted_output: true }),
              },
            },
          },
        });
    };

    test('true without guardrails:DetachGuardrail is refused ACTION_NOT_HELD', async () => {
      const res = await applyTool(user);

      expect(res.body.status).not.toBe('active');
      expect(JSON.stringify(res.body)).toContain('ACTION_NOT_HELD');
    });

    test('carries trusted_output onto the tool', async () => {
      const res = await applyTool(admin);
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');

      const toolId = res.body.resources.find(
        (resource: { logical_id: string }) => {
          return resource.logical_id === 'Reader';
        }
      ).physical_resource_id;
      const read = await admin().get(`/api/v1/tools/${toolId}`);
      expect(read.body.trusted_output).toBe(true);
    });
  });
});
