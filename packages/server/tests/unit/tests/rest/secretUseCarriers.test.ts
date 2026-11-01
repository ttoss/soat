import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * Every write that stores a secret reference the server later sends outward
 * needs `secrets:UseSecret` on that secret: an agent's inline tool, a
 * trigger's `tool_context`, and an AI provider whose `base_url` the caller
 * chooses. Tools themselves are covered by `toolSecretUse.test.ts`; a
 * formation refuses an agent's inline tool outright.
 */
describe('Secret use by secret-carrying writes', () => {
  let adminToken: string;
  let deniedToken: string;
  let scopedToken: string;
  let projectId: string;
  let secretId: string;
  let otherSecretId: string;
  let aiProviderId: string;
  let toolId: string;

  const ACTIONS = [
    'agents:CreateAgent',
    'agents:GetAgent',
    'agents:UpdateAgent',
    'triggers:CreateTrigger',
    'triggers:GetTrigger',
    'triggers:UpdateTrigger',
    'tools:CallTool',
    'ai-providers:CreateAiProvider',
    'ai-providers:GetAiProvider',
    'ai-providers:UpdateAiProvider',
    'formations:PlanFormation',
    'formations:CreateFormation',
    'formations:GetFormation',
  ];

  const grant = async (args: {
    username: string;
    statement: object[];
  }): Promise<string> => {
    const userRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: args.username, password: 'usesecretpass' });
    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({ document: { statement: args.statement } });
    expect(policyRes.status).toBe(201);
    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userRes.body.id}/policies`)
      .send({ policy_ids: [policyRes.body.id] });
    return loginAs(args.username, 'usesecretpass');
  };

  const inlineBinding = (secret: string) => {
    return {
      tool: {
        name: 'send',
        type: 'http',
        execute: {
          url: 'https://example.com/hook',
          method: 'POST',
          headers: { Authorization: `Bearer {{secret:${secret}}}` },
        },
      },
    };
  };

  const triggerBody = (args: { name: string; secret: string }) => {
    return {
      project_id: projectId,
      name: args.name,
      type: 'manual',
      target_type: 'tool',
      target_id: toolId,
      tool_context: { token: `{{secret:${args.secret}}}` },
    };
  };

  const gatewayBody = (args: { name: string; secret: string }) => {
    return {
      project_id: projectId,
      name: args.name,
      provider: 'openai',
      default_model: 'gpt-4o',
      secret_id: args.secret,
      base_url: 'https://gateway.example.com/v1',
    };
  };

  const expectSecretUseRefused = (
    res: { status: number; body: { error: { code: string; meta: unknown } } },
    secrets: string[]
  ) => {
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.meta).toEqual({
      action: 'secrets:UseSecret',
      secret_ids: secrets,
    });
  };

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'sucadmin', password: 'supersecret' });
    adminToken = await loginAs('sucadmin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Secret Use Carriers Project' });
    projectId = projectRes.body.id;

    secretId = (
      await authenticatedTestClient(adminToken)
        .post('/api/v1/secrets')
        .send({ project_id: projectId, name: 'suc-key', value: 'sk-suc' })
    ).body.id;
    otherSecretId = (
      await authenticatedTestClient(adminToken)
        .post('/api/v1/secrets')
        .send({ project_id: projectId, name: 'suc-other', value: 'sk-other' })
    ).body.id;

    aiProviderId = (
      await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'suc-ollama',
          provider: 'ollama',
          default_model: 'llama3.2',
        })
    ).body.id;

    toolId = (
      await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'suc-target',
          type: 'http',
          execute: { url: 'https://example.com/hook', method: 'POST' },
        })
    ).body.id;

    deniedToken = await grant({
      username: 'sucdenied',
      statement: [{ effect: 'Allow', action: ACTIONS }],
    });
    scopedToken = await grant({
      username: 'sucscoped',
      statement: [
        { effect: 'Allow', action: ACTIONS },
        {
          effect: 'Allow',
          action: ['secrets:UseSecret'],
          resource: [`srn:${projectId}:secret:${secretId}`],
        },
      ],
    });
  });

  describe('agent inline tool_bindings', () => {
    let agentId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          name: 'suc-existing',
          ai_provider_id: aiProviderId,
        });
      expect(res.status).toBe(201);
      agentId = res.body.id;
    });

    test('create naming a secret the caller may use is accepted', async () => {
      const res = await authenticatedTestClient(scopedToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          name: 'suc-allowed',
          ai_provider_id: aiProviderId,
          tool_bindings: [inlineBinding(secretId)],
        });

      expect(res.status).toBe(201);
    });

    test('create naming a secret without secrets:UseSecret is refused', async () => {
      const res = await authenticatedTestClient(deniedToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          name: 'suc-denied',
          ai_provider_id: aiProviderId,
          tool_bindings: [inlineBinding(secretId)],
        });

      expectSecretUseRefused(res, [secretId]);
    });

    test('secrets:UseSecret on one secret does not reach another', async () => {
      const res = await authenticatedTestClient(scopedToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          name: 'suc-other',
          ai_provider_id: aiProviderId,
          tool_bindings: [inlineBinding(otherSecretId)],
        });

      expectSecretUseRefused(res, [otherSecretId]);
    });

    test('update naming a secret without secrets:UseSecret is refused and changes nothing', async () => {
      const res = await authenticatedTestClient(deniedToken)
        .patch(`/api/v1/agents/${agentId}`)
        .send({ tool_bindings: [inlineBinding(secretId)] });

      expectSecretUseRefused(res, [secretId]);

      const unchanged = await authenticatedTestClient(adminToken).get(
        `/api/v1/agents/${agentId}`
      );
      expect(unchanged.body.tool_bindings ?? null).toBeNull();
    });

    test('an update that leaves tool_bindings untouched needs no secret permission', async () => {
      const res = await authenticatedTestClient(deniedToken)
        .patch(`/api/v1/agents/${agentId}`)
        .send({ instructions: 'renamed by a caller without secret use' });

      expect(res.status).toBe(200);
    });

    test('an unauthenticated request is refused with 401', async () => {
      const res = await testClient.post('/api/v1/agents').send({
        project_id: projectId,
        name: 'suc-anon',
        ai_provider_id: aiProviderId,
        tool_bindings: [inlineBinding(secretId)],
      });

      expect(res.status).toBe(401);
    });
  });

  describe('trigger tool_context', () => {
    test('create naming a secret the caller may use is accepted', async () => {
      const res = await authenticatedTestClient(scopedToken)
        .post('/api/v1/triggers')
        .send(triggerBody({ name: 'suc-t-allowed', secret: secretId }));

      expect(res.status).toBe(201);
    });

    test('create naming a secret without secrets:UseSecret is refused', async () => {
      const res = await authenticatedTestClient(deniedToken)
        .post('/api/v1/triggers')
        .send(triggerBody({ name: 'suc-t-denied', secret: secretId }));

      expectSecretUseRefused(res, [secretId]);
    });

    test('update naming a secret without secrets:UseSecret is refused', async () => {
      const created = await authenticatedTestClient(adminToken)
        .post('/api/v1/triggers')
        .send({
          ...triggerBody({ name: 'suc-t-existing', secret: secretId }),
          tool_context: { plain: 'value' },
        });
      expect(created.status).toBe(201);

      const res = await authenticatedTestClient(deniedToken)
        .patch(`/api/v1/triggers/${created.body.id}`)
        .send({ tool_context: { token: `{{secret:${secretId}}}` } });

      expectSecretUseRefused(res, [secretId]);
    });

    test('retargeting a trigger whose stored tool_context names a secret is refused without it', async () => {
      const created = await authenticatedTestClient(adminToken)
        .post('/api/v1/triggers')
        .send(triggerBody({ name: 'suc-t-retarget', secret: secretId }));
      expect(created.status).toBe(201);
      const otherTool = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'suc-other-target',
          type: 'http',
          execute: { url: 'https://attacker.example.com/c', method: 'POST' },
        });
      expect(otherTool.status).toBe(201);

      const res = await authenticatedTestClient(deniedToken)
        .patch(`/api/v1/triggers/${created.body.id}`)
        .send({ target_type: 'tool', target_id: otherTool.body.id });

      expectSecretUseRefused(res, [secretId]);
    });

    test('a tool_context naming no secret needs no secret permission', async () => {
      const res = await authenticatedTestClient(deniedToken)
        .post('/api/v1/triggers')
        .send({
          ...triggerBody({ name: 'suc-t-plain', secret: secretId }),
          tool_context: { advertiserId: 'adv_123' },
        });

      expect(res.status).toBe(201);
    });
  });

  describe('AI provider secret_id with base_url', () => {
    test('a caller-set base_url with a secret the caller may use is accepted', async () => {
      const res = await authenticatedTestClient(scopedToken)
        .post('/api/v1/ai-providers')
        .send(gatewayBody({ name: 'suc-p-allowed', secret: secretId }));

      expect(res.status).toBe(201);
    });

    test('a caller-set base_url with a secret without secrets:UseSecret is refused', async () => {
      const res = await authenticatedTestClient(deniedToken)
        .post('/api/v1/ai-providers')
        .send(gatewayBody({ name: 'suc-p-denied', secret: secretId }));

      expectSecretUseRefused(res, [secretId]);
    });

    test('a secret without base_url needs no secret permission', async () => {
      const { base_url: _baseUrl, ...body } = gatewayBody({
        name: 'suc-p-nourl',
        secret: secretId,
      });
      void _baseUrl;
      const res = await authenticatedTestClient(deniedToken)
        .post('/api/v1/ai-providers')
        .send(body);

      expect(res.status).toBe(201);
    });

    test('pointing a secret-linked provider at a new base_url is refused without it', async () => {
      const { base_url: _baseUrl, ...body } = gatewayBody({
        name: 'suc-p-repoint',
        secret: secretId,
      });
      void _baseUrl;
      const created = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send(body);
      expect(created.status).toBe(201);

      const res = await authenticatedTestClient(deniedToken)
        .patch(`/api/v1/ai-providers/${created.body.id}`)
        .send({ base_url: 'https://attacker.example.com/v1' });

      expectSecretUseRefused(res, [secretId]);

      const unchanged = await authenticatedTestClient(adminToken).get(
        `/api/v1/ai-providers/${created.body.id}`
      );
      expect(unchanged.body.base_url ?? null).toBeNull();
    });

    test('linking a secret to a provider with a base_url is refused without it', async () => {
      const { secret_id: _secretId, ...body } = gatewayBody({
        name: 'suc-p-link',
        secret: secretId,
      });
      void _secretId;
      const created = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send(body);
      expect(created.status).toBe(201);

      const res = await authenticatedTestClient(deniedToken)
        .patch(`/api/v1/ai-providers/${created.body.id}`)
        .send({ secret_id: secretId });

      expectSecretUseRefused(res, [secretId]);
    });

    test('an update touching neither secret_id nor base_url needs no secret permission', async () => {
      const created = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send(gatewayBody({ name: 'suc-p-rename', secret: secretId }));
      expect(created.status).toBe(201);

      const res = await authenticatedTestClient(deniedToken)
        .patch(`/api/v1/ai-providers/${created.body.id}`)
        .send({ name: 'suc-p-renamed' });

      expect(res.status).toBe(200);
    });
  });

  describe('formations', () => {
    const plan = (resources: object) => {
      return authenticatedTestClient(deniedToken)
        .post('/api/v1/formations/plan')
        .send({ project_id: projectId, template: { resources } });
    };

    const deniedSecretUse = (args: {
      logicalId: string;
      resourceType: string;
    }) => {
      return [
        {
          logical_id: args.logicalId,
          resource_type: args.resourceType,
          action: 'secrets:UseSecret',
        },
      ];
    };

    test('a declared trigger whose tool_context names a secret is reported', async () => {
      const { project_id: _projectId, ...properties } = triggerBody({
        name: 'suc-f-trigger',
        secret: secretId,
      });
      void _projectId;
      const res = await plan({ Cron: { type: 'trigger', properties } });

      expect(res.status).toBe(200);
      expect(res.body.unauthorized_actions).toEqual(
        deniedSecretUse({ logicalId: 'Cron', resourceType: 'trigger' })
      );
    });

    test('a declared AI provider with a secret and a base_url is reported', async () => {
      const { project_id: _projectId, ...properties } = gatewayBody({
        name: 'suc-f-provider',
        secret: secretId,
      });
      void _projectId;
      const res = await plan({ Gateway: { type: 'ai_provider', properties } });

      expect(res.status).toBe(200);
      expect(res.body.unauthorized_actions).toEqual(
        deniedSecretUse({ logicalId: 'Gateway', resourceType: 'ai_provider' })
      );
    });
  });
});
