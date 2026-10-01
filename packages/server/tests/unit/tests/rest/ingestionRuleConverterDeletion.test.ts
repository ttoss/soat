import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * An ingestion rule outlives the tool or agent it converts with. Its own
 * project's delete is refused until `force=true`; another project's rule never
 * blocks the publisher. The rule keeps naming the converter, and a document it
 * matches fails with `CONVERTER_FAILED`.
 */
describe('Ingestion rules whose converter is deleted', () => {
  let adminToken: string;
  let publisherId: string;
  let granteeId: string;
  let granteeKey: string;
  let providerId: string;
  let globCount = 0;

  const admin = () => {
    return authenticatedTestClient(adminToken);
  };

  const nextGlob = () => {
    globCount += 1;
    return `audio/x-converter-${globCount}`;
  };

  const createTool = async (name: string) => {
    const res = await admin()
      .post('/api/v1/tools')
      .send({
        project_id: publisherId,
        name,
        type: 'http',
        parameters: { type: 'object', properties: {} },
        execute: { url: 'http://127.0.0.1:9/hook', method: 'POST' },
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const createAgent = async (name: string) => {
    const res = await admin().post('/api/v1/agents').send({
      project_id: publisherId,
      name,
      ai_provider_id: providerId,
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const createRule = async (args: {
    projectId: string;
    glob: string;
    converter: { tool_id: string } | { agent_id: string };
  }) => {
    const res = await admin()
      .post('/api/v1/ingestion-rules')
      .send({
        project_id: args.projectId,
        content_type_glob: args.glob,
        ...args.converter,
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

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
    const accepted = await authenticatedTestClient(granteeKey).post(
      `/api/v1/shares/${share.body.id}/accept`
    );
    expect(accepted.status).toBe(200);
  };

  const ingest = async (args: { projectId: string; glob: string }) => {
    const file = await admin()
      .post('/api/v1/files/upload')
      .attach('file', Buffer.from('bytes'), {
        filename: 'converted.bin',
        contentType: args.glob,
      })
      .field('project_id', args.projectId);
    expect(file.status).toBe(201);
    const document = await admin()
      .post('/api/v1/documents/ingest?wait=true')
      .send({ project_id: args.projectId, file_id: file.body.id });
    const status = await admin().get(
      `/api/v1/documents/${document.body.id}/status`
    );
    return { status: document.body.status, error: status.body.error };
  };

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'ruleconverteradmin', password: 'supersecret' });
    adminToken = await loginAs('ruleconverteradmin', 'supersecret');

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
    providerId = (
      await admin().post('/api/v1/ai-providers').send({
        project_id: publisherId,
        name: 'Converter provider',
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: 'http://127.0.0.1:9',
      })
    ).body.id;
  });

  describe('DELETE /api/v1/tools/:tool_id', () => {
    test("is refused while one of the project's own rules converts with it", async () => {
      const toolId = await createTool('ownConverterTool');
      await createRule({
        projectId: publisherId,
        glob: nextGlob(),
        converter: { tool_id: toolId },
      });

      const response = await admin().delete(`/api/v1/tools/${toolId}`);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('TOOL_HAS_DEPENDENTS');
      expect(response.body.error.meta.ingestion_rule_count).toBe(1);
    });

    test('with force=true, the rule keeps naming the tool and fails what it matches', async () => {
      const toolId = await createTool('forcedConverterTool');
      const glob = nextGlob();
      const ruleId = await createRule({
        projectId: publisherId,
        glob,
        converter: { tool_id: toolId },
      });

      const response = await admin().delete(
        `/api/v1/tools/${toolId}?force=true`
      );

      expect(response.status).toBe(204);
      const rule = await admin().get(`/api/v1/ingestion-rules/${ruleId}`);
      expect(rule.body.tool_id).toBe(toolId);
      expect(rule.body.agent_id).toBeNull();
      expect(await ingest({ projectId: publisherId, glob })).toEqual({
        status: 'failed',
        error: 'CONVERTER_FAILED',
      });
    });

    test("another project's rule never blocks the publisher's force delete", async () => {
      const toolId = await createTool('sharedConverterTool');
      await shareAccepted({ type: 'tool', id: toolId });
      const ruleId = await createRule({
        projectId: granteeId,
        glob: nextGlob(),
        converter: { tool_id: toolId },
      });

      const response = await admin().delete(
        `/api/v1/tools/${toolId}?force=true`
      );

      expect(response.status).toBe(204);
      const rule = await admin().get(`/api/v1/ingestion-rules/${ruleId}`);
      expect(rule.body.tool_id).toBe(toolId);
    });
  });

  describe('DELETE /api/v1/agents/:agent_id', () => {
    test("is refused while one of the project's own rules converts with it", async () => {
      const agentId = await createAgent('Own converter agent');
      await createRule({
        projectId: publisherId,
        glob: nextGlob(),
        converter: { agent_id: agentId },
      });

      const response = await admin().delete(`/api/v1/agents/${agentId}`);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('AGENT_HAS_DEPENDENTS');
      expect(response.body.error.meta.ingestion_rule_count).toBe(1);
    });

    test('with force=true, the rule keeps naming the agent', async () => {
      const agentId = await createAgent('Forced converter agent');
      const ruleId = await createRule({
        projectId: publisherId,
        glob: nextGlob(),
        converter: { agent_id: agentId },
      });

      const response = await admin().delete(
        `/api/v1/agents/${agentId}?force=true`
      );

      expect(response.status).toBe(204);
      const rule = await admin().get(`/api/v1/ingestion-rules/${ruleId}`);
      expect(rule.body.agent_id).toBe(agentId);
      expect(rule.body.tool_id).toBeNull();
    });

    test("another project's rule never blocks the publisher's force delete", async () => {
      const agentId = await createAgent('Shared converter agent');
      await shareAccepted({ type: 'agent', id: agentId });
      const ruleId = await createRule({
        projectId: granteeId,
        glob: nextGlob(),
        converter: { agent_id: agentId },
      });

      const response = await admin().delete(
        `/api/v1/agents/${agentId}?force=true`
      );

      expect(response.status).toBe(204);
      const rule = await admin().get(`/api/v1/ingestion-rules/${ruleId}`);
      expect(rule.body.agent_id).toBe(agentId);
    });
  });

  describe('PATCH /api/v1/ingestion-rules/:id', () => {
    test('repoints a rule whose converter is gone', async () => {
      const goneId = await createTool('goneConverterTool');
      const replacementId = await createTool('replacementConverterTool');
      const ruleId = await createRule({
        projectId: publisherId,
        glob: nextGlob(),
        converter: { tool_id: goneId },
      });
      await admin().delete(`/api/v1/tools/${goneId}?force=true`);

      const response = await admin()
        .patch(`/api/v1/ingestion-rules/${ruleId}`)
        .send({ tool_id: replacementId });

      expect(response.status).toBe(200);
      expect(response.body.tool_id).toBe(replacementId);
    });

    test('switches a rule whose tool is gone to an agent', async () => {
      const goneId = await createTool('switchedConverterTool');
      const agentId = await createAgent('Replacement converter agent');
      const ruleId = await createRule({
        projectId: publisherId,
        glob: nextGlob(),
        converter: { tool_id: goneId },
      });
      await admin().delete(`/api/v1/tools/${goneId}?force=true`);

      const response = await admin()
        .patch(`/api/v1/ingestion-rules/${ruleId}`)
        .send({ tool_id: null, agent_id: agentId });

      expect(response.status).toBe(200);
      expect(response.body.tool_id).toBeNull();
      expect(response.body.agent_id).toBe(agentId);
    });
  });
});
