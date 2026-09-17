import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

describe('Memory Rules API', () => {
  let adminToken: string;
  let scopedToken: string;
  let noPermToken: string;
  let projectId: string;
  let otherProjectId: string;
  let memoryStoreId: string;
  let otherStoreId: string;
  let agentId: string;
  let toolId: string;
  let aiProviderId: string;

  const createRule = async (
    body: Record<string, unknown>,
    token = adminToken
  ) => {
    return authenticatedTestClient(token)
      .post('/api/v1/memory-rules')
      .send({ memory_store_id: memoryStoreId, ...body });
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'memoryrules',
      policyActions: [
        'memories:ListMemoryRules',
        'memories:GetMemoryRule',
        'memories:CreateMemoryRule',
        'memories:UpdateMemoryRule',
        'memories:DeleteMemoryRule',
      ],
      createOtherProject: true,
    });
    adminToken = setup.adminToken;
    noPermToken = setup.noPermToken!;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId!;

    const storeRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/memory-stores')
      .send({ project_id: projectId, name: 'Support facts' });
    memoryStoreId = storeRes.body.id;

    const otherStoreRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/memory-stores')
      .send({ project_id: otherProjectId, name: 'Other project facts' });
    otherStoreId = otherStoreRes.body.id;

    const providerRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'MemoryRulesProvider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    aiProviderId = providerRes.body.id;

    const agentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: aiProviderId,
        name: 'MemoryRulesAgent',
      });
    agentId = agentRes.body.id;

    const toolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'MemoryRulesTool',
        type: 'client',
        description: 'Proposes facts from a finished turn',
        parameters: {
          type: 'object',
          properties: { transcript: { type: 'string' } },
        },
      });
    toolId = toolRes.body.id;

    // The default fixture policy carries no `resource`, so it reaches every
    // project; a cross-project refusal needs a principal scoped by SRN.
    scopedToken = await createScopedPrincipal({
      adminToken,
      projectId,
      username: 'memoryrulesscoped',
      actions: [
        'memories:ListMemoryRules',
        'memories:GetMemoryRule',
        'memories:CreateMemoryRule',
      ],
    });
  });

  describe('POST /api/v1/memory-rules', () => {
    test('creates a rule with no handler — the built-in extractor', async () => {
      const res = await createRule({
        on: 'agents.generation.completed',
        source_agent_ids: [agentId],
        model: 'cheap-model',
        prompt: 'Only billing facts',
        ai_provider_id: aiProviderId,
      });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.id.startsWith('mrule_')).toBe(true);
      expect(res.body.memory_store_id).toBe(memoryStoreId);
      expect(res.body.project_id).toBe(projectId);
      expect(res.body.on).toBe('agents.generation.completed');
      expect(res.body.source_agent_ids).toEqual([agentId]);
      expect(res.body.agent_id).toBeNull();
      expect(res.body.tool_id).toBeNull();
      expect(res.body.prompt).toBe('Only billing facts');
      expect(res.body.ai_provider_id).toBe(aiProviderId);
      expect(res.body.model).toBe('cheap-model');
      expect(res.body.enabled).toBe(true);
    });

    test('creates a rule with an agent handler', async () => {
      const res = await createRule({
        on: 'agents.generation.completed',
        agent_id: agentId,
      });

      expect(res.status).toBe(201);
      expect(res.body.agent_id).toBe(agentId);
      expect(res.body.tool_id).toBeNull();
    });

    test('creates a rule with a tool handler and its action', async () => {
      const res = await createRule({
        on: 'conversations.message.generated',
        tool_id: toolId,
        action: 'extract',
        preset_parameters: { style: 'terse' },
      });

      expect(res.status).toBe(201);
      expect(res.body.tool_id).toBe(toolId);
      expect(res.body.action).toBe('extract');
      expect(res.body.preset_parameters).toEqual({ style: 'terse' });
    });

    test('a null selector means every agent in the project', async () => {
      const res = await createRule({
        on: 'agents.generation.completed',
        source_agent_ids: null,
      });

      expect(res.status).toBe(201);
      expect(res.body.source_agent_ids).toBeNull();
    });

    test('rejects a rule naming both an agent and a tool handler', async () => {
      const res = await createRule({
        on: 'agents.generation.completed',
        agent_id: agentId,
        tool_id: toolId,
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MEMORY_RULE_VALIDATION_FAILED');
    });

    test('rejects the built-in extractor on the message event', async () => {
      const res = await createRule({ on: 'conversations.message.generated' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MEMORY_RULE_VALIDATION_FAILED');
    });

    test('rejects an extractor override combined with a handler', async () => {
      const res = await createRule({
        on: 'agents.generation.completed',
        agent_id: agentId,
        prompt: 'Only billing facts',
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MEMORY_RULE_VALIDATION_FAILED');
    });

    test('rejects an unknown event', async () => {
      const res = await createRule({ on: 'conversations.message.created' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MEMORY_RULE_VALIDATION_FAILED');
    });

    test('rejects a selector naming an agent from another project', async () => {
      const otherProviderRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: otherProjectId,
          name: 'OtherProjectProvider',
          provider: 'ollama',
          default_model: 'llama3.2',
        });
      const otherAgentRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: otherProjectId,
          ai_provider_id: otherProviderRes.body.id,
          name: 'OtherProjectAgent',
        });

      const res = await createRule({
        on: 'agents.generation.completed',
        source_agent_ids: [otherAgentRes.body.id],
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('AGENT_NOT_FOUND');
    });

    test('requires memory_store_id', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/memory-rules')
        .send({ on: 'agents.generation.completed' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('401 without a token', async () => {
      const res = await testClient.post('/api/v1/memory-rules').send({
        memory_store_id: memoryStoreId,
        on: 'agents.generation.completed',
      });

      expect(res.status).toBe(401);
    });

    test('403 without the action', async () => {
      const res = await createRule(
        { on: 'agents.generation.completed' },
        noPermToken
      );

      expect(res.status).toBe(403);
    });

    test('403 for a store in a project the caller cannot reach', async () => {
      const res = await authenticatedTestClient(scopedToken)
        .post('/api/v1/memory-rules')
        .send({
          memory_store_id: otherStoreId,
          on: 'agents.generation.completed',
        });

      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/v1/memory-rules', () => {
    test('lists the rules of one store', async () => {
      const storeRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/memory-stores')
        .send({ project_id: projectId, name: 'Listable store' });

      await authenticatedTestClient(adminToken)
        .post('/api/v1/memory-rules')
        .send({
          memory_store_id: storeRes.body.id,
          on: 'agents.generation.completed',
        });

      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/memory-rules?memory_store_id=${storeRes.body.id}`
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].memory_store_id).toBe(storeRes.body.id);
      expect(res.body.total).toBe(1);
    });

    test('lists a project’s rules across its stores', async () => {
      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/memory-rules?project_id=${projectId}`
      );

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      for (const rule of res.body.data) {
        expect(rule.project_id).toBe(projectId);
      }
    });

    test('401 without a token', async () => {
      const res = await testClient.get('/api/v1/memory-rules');
      expect(res.status).toBe(401);
    });

    test('403 listing a store the caller cannot reach', async () => {
      const res = await authenticatedTestClient(scopedToken).get(
        `/api/v1/memory-rules?memory_store_id=${otherStoreId}`
      );
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/v1/memory-rules/{memory_rule_id}', () => {
    test('returns the rule', async () => {
      const created = await createRule({ on: 'agents.generation.completed' });

      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/memory-rules/${created.body.id}`
      );

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(created.body.id);
      expect(res.body.memory_store_id).toBe(memoryStoreId);
    });

    test('404 for an unknown id', async () => {
      const res = await authenticatedTestClient(adminToken).get(
        '/api/v1/memory-rules/mrule_doesnotexist0000'
      );
      expect(res.status).toBe(404);
    });

    test('401 without a token', async () => {
      const res = await testClient.get(
        '/api/v1/memory-rules/mrule_doesnotexist0000'
      );
      expect(res.status).toBe(401);
    });

    test('403 without the action', async () => {
      const created = await createRule({ on: 'agents.generation.completed' });

      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/memory-rules/${created.body.id}`
      );
      expect(res.status).toBe(403);
    });
  });

  describe('PATCH /api/v1/memory-rules/{memory_rule_id}', () => {
    test('disables a rule without touching the rest of it', async () => {
      const created = await createRule({
        on: 'agents.generation.completed',
        prompt: 'Only billing facts',
      });

      const res = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/memory-rules/${created.body.id}`)
        .send({ enabled: false });

      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(false);
      expect(res.body.prompt).toBe('Only billing facts');
    });

    test('a handler cannot be added to a rule that still carries an override', async () => {
      const created = await createRule({
        on: 'agents.generation.completed',
        prompt: 'Only billing facts',
      });

      const res = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/memory-rules/${created.body.id}`)
        .send({ agent_id: agentId });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MEMORY_RULE_VALIDATION_FAILED');
    });

    test('clearing the override in the same request lets the handler through', async () => {
      const created = await createRule({
        on: 'agents.generation.completed',
        prompt: 'Only billing facts',
      });

      const res = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/memory-rules/${created.body.id}`)
        .send({ agent_id: agentId, prompt: null });

      expect(res.status).toBe(200);
      expect(res.body.agent_id).toBe(agentId);
      expect(res.body.prompt).toBeNull();
    });

    test('a handlerless rule cannot be moved onto the message event', async () => {
      const created = await createRule({ on: 'agents.generation.completed' });

      const res = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/memory-rules/${created.body.id}`)
        .send({ on: 'conversations.message.generated' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MEMORY_RULE_VALIDATION_FAILED');
    });

    test('404 for an unknown id', async () => {
      const res = await authenticatedTestClient(adminToken)
        .patch('/api/v1/memory-rules/mrule_doesnotexist0000')
        .send({ enabled: false });
      expect(res.status).toBe(404);
    });

    test('401 without a token', async () => {
      const res = await testClient
        .patch('/api/v1/memory-rules/mrule_doesnotexist0000')
        .send({ enabled: false });
      expect(res.status).toBe(401);
    });

    test('403 without the action', async () => {
      const created = await createRule({ on: 'agents.generation.completed' });

      const res = await authenticatedTestClient(noPermToken)
        .patch(`/api/v1/memory-rules/${created.body.id}`)
        .send({ enabled: false });
      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /api/v1/memory-rules/{memory_rule_id}', () => {
    test('deletes the rule', async () => {
      const created = await createRule({ on: 'agents.generation.completed' });

      const res = await authenticatedTestClient(adminToken).delete(
        `/api/v1/memory-rules/${created.body.id}`
      );
      expect(res.status).toBe(204);

      const after = await authenticatedTestClient(adminToken).get(
        `/api/v1/memory-rules/${created.body.id}`
      );
      expect(after.status).toBe(404);
    });

    test('404 for an unknown id', async () => {
      const res = await authenticatedTestClient(adminToken).delete(
        '/api/v1/memory-rules/mrule_doesnotexist0000'
      );
      expect(res.status).toBe(404);
    });

    test('401 without a token', async () => {
      const res = await testClient.delete(
        '/api/v1/memory-rules/mrule_doesnotexist0000'
      );
      expect(res.status).toBe(401);
    });

    test('403 without the action', async () => {
      const created = await createRule({ on: 'agents.generation.completed' });

      const res = await authenticatedTestClient(noPermToken).delete(
        `/api/v1/memory-rules/${created.body.id}`
      );
      expect(res.status).toBe(403);
    });
  });

  describe('an agent carries no extraction config', () => {
    test('knowledge_config.extraction is rejected as an unknown field', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'LegacyExtractionAgent',
          knowledge_config: {
            write_memory_store_id: memoryStoreId,
            extraction: true,
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('the per-turn extract flag is rejected too', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({ messages: [{ role: 'user', content: 'hi' }], extract: false });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });
});
