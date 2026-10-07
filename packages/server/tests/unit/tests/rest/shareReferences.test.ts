import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * What a grantee project has built on a resource shared with it: listed by
 * `GET /shares/{id}/references`, and what keeps the grantee from revoking its
 * own acceptance by accident. The publisher's revoke is never held up.
 */
describe('Share references', () => {
  let adminToken: string;
  let publisherId: string;
  let granteeId: string;
  let granteeKey: string;

  const admin = () => {
    return authenticatedTestClient(adminToken);
  };

  const grantee = () => {
    return authenticatedTestClient(granteeKey);
  };

  const createInPublisher = async (
    path: string,
    body: Record<string, unknown>
  ) => {
    const res = await admin()
      .post(path)
      .send({ project_id: publisherId, ...body });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const createInGrantee = async (
    path: string,
    body: Record<string, unknown>
  ) => {
    const res = await admin()
      .post(path)
      .send({ project_id: granteeId, ...body });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  /** A resource of P shared with Q and accepted by Q. */
  const shareAccepted = async (args: {
    type: 'tool' | 'agent';
    id: string;
  }) => {
    const share = await admin()
      .post('/api/v1/shares')
      .send({
        project_id: publisherId,
        resource: `srn:${publisherId}:${args.type}:${args.id}`,
        actions: [
          args.type === 'tool'
            ? 'tools:CallTool'
            : 'agents:CreateAgentGeneration',
        ],
        grantee: granteeId,
      });
    expect(share.status).toBe(201);
    const accepted = await grantee().post(
      `/api/v1/shares/${share.body.id}/accept`
    );
    expect(accepted.status).toBe(200);
    return share.body.id as string;
  };

  const newTool = (name: string) => {
    return createInPublisher('/api/v1/tools', {
      name,
      type: 'http',
      parameters: { type: 'object', properties: {} },
      execute: { url: 'http://127.0.0.1:9/hook', method: 'POST' },
    });
  };

  let providerId: string;
  let toolId: string;
  let toolShareId: string;
  let agentId: string;
  let agentShareId: string;
  let toolReferences: Array<{ type: string; id: string }>;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'sharerefsadmin', password: 'supersecret' });
    adminToken = await loginAs('sharerefsadmin', 'supersecret');

    publisherId = (
      await admin().post('/api/v1/projects').send({ name: 'Publisher' })
    ).body.id;
    granteeId = (
      await admin().post('/api/v1/projects').send({ name: 'Grantee' })
    ).body.id;
    granteeKey = (
      await admin()
        .post('/api/v1/api-keys')
        .send({ name: 'Grantee key', project_id: granteeId })
    ).body.key;

    providerId = await createInPublisher('/api/v1/ai-providers', {
      name: 'Publisher provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: 'http://127.0.0.1:9',
    });
    toolId = await newTool('sharedRefTool');
    toolShareId = await shareAccepted({ type: 'tool', id: toolId });
    agentId = await createInPublisher('/api/v1/agents', {
      name: 'Shared Ref Agent',
      ai_provider_id: providerId,
    });
    agentShareId = await shareAccepted({ type: 'agent', id: agentId });

    const granteeProvider = await createInGrantee('/api/v1/ai-providers', {
      name: 'Grantee provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: 'http://127.0.0.1:9',
    });
    const bindingAgent = await createInGrantee('/api/v1/agents', {
      name: 'Binds the shared tool',
      ai_provider_id: granteeProvider,
      tool_bindings: [{ tool_id: toolId }],
    });
    const pipeline = await createInGrantee('/api/v1/tools', {
      name: 'granteePipeline',
      type: 'pipeline',
      parameters: { type: 'object', properties: {} },
      pipeline: { steps: [{ id: 'call', tool_id: toolId }] },
    });
    const rule = await createInGrantee('/api/v1/ingestion-rules', {
      content_type_glob: 'audio/x-share-ref',
      tool_id: toolId,
    });
    const orchestration = await createInGrantee('/api/v1/orchestrations', {
      name: 'Shared tool node',
      nodes: [{ id: 'call', type: 'tool', tool_id: toolId }],
      edges: [],
    });
    const trigger = await createInGrantee('/api/v1/triggers', {
      name: 'shared-ref-trigger',
      type: 'manual',
      target_type: 'tool',
      target_id: toolId,
    });
    toolReferences = [
      { type: 'agent', id: bindingAgent },
      { type: 'tool', id: pipeline },
      { type: 'ingestion_rule', id: rule },
      { type: 'orchestration', id: orchestration },
      { type: 'trigger', id: trigger },
    ];

    await createInGrantee('/api/v1/orchestrations', {
      name: 'Shared agent node',
      nodes: [{ id: 'ask', type: 'agent', agent_id: agentId }],
      edges: [],
    });
  });

  describe('GET /api/v1/shares/:share_id/references', () => {
    test("lists the grantee's resources naming the shared tool", async () => {
      const response = await grantee().get(
        `/api/v1/shares/${toolShareId}/references`
      );

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(
        expect.arrayContaining(toolReferences)
      );
      expect(response.body.data).toHaveLength(toolReferences.length);
    });

    describe('pagination', () => {
      const list = (query: Record<string, string | number> = {}) => {
        return grantee()
          .get(`/api/v1/shares/${toolShareId}/references`)
          .query(query);
      };

      test('the default page carries the envelope', async () => {
        const response = await list();

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
          total: toolReferences.length,
          limit: 50,
          offset: 0,
        });
      });

      test('pages walk the same order without repeats', async () => {
        const all = (await list()).body.data;

        const first = await list({ limit: 2, offset: 0 });
        const second = await list({ limit: 2, offset: 2 });

        expect(first.status).toBe(200);
        expect(first.body).toMatchObject({ total: 5, limit: 2, offset: 0 });
        expect([...first.body.data, ...second.body.data]).toEqual(
          all.slice(0, 4)
        );
      });

      test('the last page holds the remainder', async () => {
        const response = await list({ limit: 2, offset: 4 });

        expect(response.status).toBe(200);
        expect(response.body.total).toBe(5);
        expect(response.body.data).toHaveLength(1);
      });

      test('a limit above the ceiling is clamped to it', async () => {
        const response = await list({ limit: 1000 });

        expect(response.status).toBe(200);
        expect(response.body.limit).toBe(100);
      });

      test('a non-numeric limit falls back to the default', async () => {
        const response = await list({ limit: 'abc' });

        expect(response.status).toBe(200);
        expect(response.body.limit).toBe(50);
      });
    });

    test('lists a formation declaring a resource on the shared tool', async () => {
      const tool = await newTool('formationRefTool');
      const shareId = await shareAccepted({ type: 'tool', id: tool });
      const formation = await admin()
        .post('/api/v1/formations')
        .send({
          project_id: granteeId,
          name: 'shared-ref-formation',
          template: {
            resources: {
              Rule: {
                type: 'ingestion_rule',
                properties: {
                  content_type_glob: 'audio/x-formation-ref',
                  tool_id: tool,
                },
              },
            },
          },
        });
      expect(formation.body.status).toBe('active');

      const response = await grantee().get(
        `/api/v1/shares/${shareId}/references`
      );

      expect(response.body.data).toEqual(
        expect.arrayContaining([
          { type: 'formation', id: formation.body.id },
          { type: 'ingestion_rule', id: expect.any(String) },
        ])
      );
    });

    test('lists what names a shared agent', async () => {
      const response = await grantee().get(
        `/api/v1/shares/${agentShareId}/references`
      );

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([
        { type: 'orchestration', id: expect.any(String) },
      ]);
    });

    test('requires authentication', async () => {
      const response = await testClient.get(
        `/api/v1/shares/${toolShareId}/references`
      );

      expect(response.status).toBe(401);
    });

    test('a project the share is not addressed to gets 404', async () => {
      const outsider = (
        await admin().post('/api/v1/projects').send({ name: 'Outsider' })
      ).body.id;

      const response = await admin()
        .get(`/api/v1/shares/${toolShareId}/references`)
        .query({ project_id: outsider });

      expect(response.status).toBe(404);
    });

    test('the publisher, which holds none of them, is refused', async () => {
      const response = await admin().get(
        `/api/v1/shares/${toolShareId}/references`
      );

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('POST /api/v1/shares/:share_id/revoke by the grantee', () => {
    test('is refused while the grantee still names the resource', async () => {
      const response = await grantee().post(
        `/api/v1/shares/${toolShareId}/revoke`
      );

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('SHARE_IN_USE');
      expect(response.body.error.meta.references).toEqual(
        expect.arrayContaining(toolReferences)
      );
    });

    test('proceeds with force=true', async () => {
      const tool = await newTool('forcedRefTool');
      const shareId = await shareAccepted({ type: 'tool', id: tool });
      await createInGrantee('/api/v1/triggers', {
        name: 'forced-ref-trigger',
        type: 'manual',
        target_type: 'tool',
        target_id: tool,
      });

      const response = await grantee().post(
        `/api/v1/shares/${shareId}/revoke?force=true`
      );

      expect(response.status).toBe(200);
      expect(response.body.acceptance.status).toBe('revoked');
    });

    test('proceeds when nothing names the resource', async () => {
      const tool = await newTool('unusedRefTool');
      const shareId = await shareAccepted({ type: 'tool', id: tool });

      const response = await grantee().post(`/api/v1/shares/${shareId}/revoke`);

      expect(response.status).toBe(200);
      expect(response.body.acceptance.status).toBe('revoked');
    });
  });

  test("the publisher's revoke is never held up", async () => {
    const tool = await newTool('publisherRevokedTool');
    const shareId = await shareAccepted({ type: 'tool', id: tool });
    await createInGrantee('/api/v1/triggers', {
      name: 'publisher-revoked-trigger',
      type: 'manual',
      target_type: 'tool',
      target_id: tool,
    });

    const response = await admin().post(`/api/v1/shares/${shareId}/revoke`);

    expect(response.status).toBe(200);
    expect(response.body.revoked_at).not.toBeNull();
  });
});
