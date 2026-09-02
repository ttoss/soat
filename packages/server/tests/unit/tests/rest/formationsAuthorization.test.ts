import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * A formation used to be authorized once, as `formations:CreateFormation` on the
 * request, so every resource a template declared was applied with no per-action
 * check of its own (#1181) — and a template could name another project's secret,
 * because the module's id lookup was not scoped to the project (#1180).
 */
describe('Formation resource authorization', () => {
  let adminToken: string;
  let deployToken: string;
  let deployUserId: string;
  let noKeyToken: string;
  let ownerUserId: string;
  let projectId: string;
  let otherProjectId: string;

  const grant = async (args: {
    username: string;
    password: string;
    actions: string[];
  }): Promise<{ token: string; userId: string }> => {
    const userRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: args.username, password: args.password });

    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [{ effect: 'Allow', action: args.actions }],
        },
      });

    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userRes.body.id}/policies`)
      .send({ policy_ids: [policyRes.body.id] });

    return {
      token: await loginAs(args.username, args.password),
      userId: userRes.body.id,
    };
  };

  const FORMATION_ACTIONS = [
    'formations:PlanFormation',
    'formations:CreateFormation',
    'formations:GetFormation',
    'formations:ListFormations',
    'formations:UpdateFormation',
    'formations:DeleteFormation',
  ];

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'fraadmin', password: 'supersecret' });
    adminToken = await loginAs('fraadmin', 'supersecret');

    const me =
      await authenticatedTestClient(adminToken).get('/api/v1/users/me');
    // The bootstrap admin creates the projects, so it is the billing owner an
    // `api_key` resource used to be minted under.
    ownerUserId = me.body.id;

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Formation Authorization Project' });
    projectId = projectRes.body.id;

    const otherProjectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Formation Authorization Other Project' });
    otherProjectId = otherProjectRes.body.id;

    // Everything a memory needs, and deliberately nothing a guardrail does.
    const deploy = await grant({
      username: 'fradeploy',
      password: 'deploypass',
      actions: [
        ...FORMATION_ACTIONS,
        'memories:CreateMemory',
        'memories:UpdateMemory',
        'memories:DeleteMemory',
        // Granted to prove `policy` is refused on the role gate, not on this.
        'policies:CreatePolicy',
        'api-keys:CreateApiKey',
      ],
    });
    deployToken = deploy.token;
    deployUserId = deploy.userId;

    noKeyToken = (
      await grant({
        username: 'franokey',
        password: 'nokeypass',
        actions: FORMATION_ACTIONS,
      })
    ).token;
  });

  describe('POST /api/v1/formations', () => {
    test('a resource the caller may create is applied', async () => {
      const res = await authenticatedTestClient(deployToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: 'authorized-memory-stack',
          template: {
            resources: {
              MyMemory: { type: 'memory', properties: { name: 'fra-allowed' } },
            },
          },
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');
    });

    test('a resource the caller may not create is refused, and nothing is applied', async () => {
      const res = await authenticatedTestClient(deployToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: 'guardrail-stack',
          template: {
            resources: {
              MyMemory: { type: 'memory', properties: { name: 'fra-mem' } },
              MyGuardrail: {
                type: 'guardrail',
                properties: { name: 'fra-guardrail', class: 'A' },
              },
            },
          },
        });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(res.body.error.meta.denied_actions).toEqual([
        {
          logical_id: 'MyGuardrail',
          resource_type: 'guardrail',
          action: 'guardrails:CreateGuardrail',
        },
      ]);

      // The refusal happens before anything is created: no formation row, and
      // the memory ordered ahead of the guardrail was never applied.
      const formations = await authenticatedTestClient(adminToken).get(
        `/api/v1/formations?project_id=${projectId}`
      );
      expect(
        formations.body.data.some((formation: { name: string }) => {
          return formation.name === 'guardrail-stack';
        })
      ).toBe(false);

      const memories = await authenticatedTestClient(adminToken).get(
        `/api/v1/memories?project_id=${projectId}`
      );
      expect(
        memories.body.data.some((memory: { name: string }) => {
          return memory.name === 'fra-mem';
        })
      ).toBe(false);
    });

    test('a policy resource is refused for a non-admin even with the action granted', async () => {
      const res = await authenticatedTestClient(deployToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: 'policy-stack',
          template: {
            resources: {
              Escalation: {
                type: 'policy',
                properties: {
                  document: { statement: [{ effect: 'Allow', action: ['*'] }] },
                },
              },
            },
          },
        });

      expect(res.status).toBe(403);
      expect(res.body.error.meta.denied_actions).toEqual([
        {
          logical_id: 'Escalation',
          resource_type: 'policy',
          action: 'policies:CreatePolicy',
        },
      ]);
    });

    // An `api_key` resource mints under the caller, as `POST /api-keys` does,
    // so the key it produces can never exceed the permissions of whoever
    // deployed it — that is what makes the type safe to declare (#1181).
    test('an api_key resource is minted under the caller, not the project owner', async () => {
      const res = await authenticatedTestClient(deployToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: 'api-key-stack',
          template: {
            resources: {
              Key: { type: 'api_key', properties: { name: 'fra-key' } },
            },
          },
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');

      const keyId = res.body.resources[0].physical_resource_id;
      const key = await authenticatedTestClient(adminToken).get(
        `/api/v1/api-keys/${keyId}`
      );
      expect(key.body.user_id).toBe(deployUserId);
      expect(key.body.user_id).not.toBe(ownerUserId);
    });

    // The common deploy path is a CI credential, not a JWT. An API key's acting
    // user is the key's owner, so the minted key cannot outrank the key that
    // deployed it either.
    test('an api_key resource deployed with an API key is minted under that key owner', async () => {
      const deployKey = await authenticatedTestClient(deployToken)
        .post('/api/v1/api-keys')
        .send({ name: 'fra-deploy-key', project_id: projectId });
      expect(deployKey.status).toBe(201);

      const res = await authenticatedTestClient(deployKey.body.key)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: 'api-key-via-key-stack',
          template: {
            resources: {
              Key: { type: 'api_key', properties: { name: 'fra-nested-key' } },
            },
          },
        });

      expect(res.status).toBe(201);
      const minted = await authenticatedTestClient(adminToken).get(
        `/api/v1/api-keys/${res.body.resources[0].physical_resource_id}`
      );
      expect(minted.body.user_id).toBe(deployUserId);
    });

    test('an api_key resource is refused without the create action', async () => {
      const res = await authenticatedTestClient(noKeyToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: 'api-key-denied-stack',
          template: {
            resources: {
              Key: { type: 'api_key', properties: { name: 'fra-denied-key' } },
            },
          },
        });

      expect(res.status).toBe(403);
      expect(res.body.error.meta.denied_actions).toEqual([
        {
          logical_id: 'Key',
          resource_type: 'api_key',
          action: 'api-keys:CreateApiKey',
        },
      ]);
    });
  });

  describe('POST /api/v1/formations/plan', () => {
    test('a plan names every action the caller lacks instead of refusing', async () => {
      const res = await authenticatedTestClient(deployToken)
        .post('/api/v1/formations/plan')
        .send({
          project_id: projectId,
          template: {
            resources: {
              MyMemory: { type: 'memory', properties: { name: 'fra-planned' } },
              MyGuardrail: {
                type: 'guardrail',
                properties: { name: 'fra-planned-guardrail', class: 'A' },
              },
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.changes).toHaveLength(2);
      expect(res.body.unauthorized_actions).toEqual([
        {
          logical_id: 'MyGuardrail',
          resource_type: 'guardrail',
          action: 'guardrails:CreateGuardrail',
        },
      ]);
    });

    test('a plan the caller may apply reports no unauthorized actions', async () => {
      const res = await authenticatedTestClient(deployToken)
        .post('/api/v1/formations/plan')
        .send({
          project_id: projectId,
          template: {
            resources: {
              MyMemory: { type: 'memory', properties: { name: 'fra-planned' } },
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.unauthorized_actions).toBeUndefined();
    });
  });

  describe('PUT /api/v1/formations/:formation_id', () => {
    test('an added resource the caller may not create is refused', async () => {
      const created = await authenticatedTestClient(deployToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: 'update-stack',
          template: {
            resources: {
              MyMemory: { type: 'memory', properties: { name: 'fra-update' } },
            },
          },
        });
      expect(created.status).toBe(201);

      const res = await authenticatedTestClient(deployToken)
        .put(`/api/v1/formations/${created.body.id}`)
        .send({
          template: {
            resources: {
              MyMemory: { type: 'memory', properties: { name: 'fra-update' } },
              Added: {
                type: 'guardrail',
                properties: { name: 'fra-added-guardrail', class: 'A' },
              },
            },
          },
        });

      expect(res.status).toBe(403);
      expect(res.body.error.meta.denied_actions).toEqual([
        {
          logical_id: 'Added',
          resource_type: 'guardrail',
          action: 'guardrails:CreateGuardrail',
        },
      ]);

      const unchanged = await authenticatedTestClient(deployToken).get(
        `/api/v1/formations/${created.body.id}`
      );
      expect(unchanged.body.status).toBe('active');
      expect(Object.keys(unchanged.body.template.resources)).toEqual([
        'MyMemory',
      ]);
    });
  });

  describe('a type with no update operation', () => {
    // `chat` declares no `update`, so an apply validates and no-ops. There is no
    // mutation to authorize, and demanding a permission for one would refuse a
    // request that changes nothing.
    test('re-applying a chat resource needs no update action', async () => {
      const chatDeployToken = (
        await grant({
          username: 'frachat',
          password: 'chatpass',
          actions: [...FORMATION_ACTIONS, 'chats:CreateChat'],
        })
      ).token;

      // A chat that pins no provider inherits the project's default model
      // route, which this project has none of.
      const provider = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'fra-chat-provider',
          provider: 'openai',
          default_model: 'gpt-4o',
        });
      expect(provider.status).toBe(201);

      const template = {
        resources: {
          MyChat: {
            type: 'chat',
            properties: {
              name: 'fra-chat',
              ai_provider_id: provider.body.id,
            },
          },
        },
      };

      const created = await authenticatedTestClient(chatDeployToken)
        .post('/api/v1/formations')
        .send({ project_id: projectId, name: 'chat-stack', template });
      expect(created.status).toBe(201);
      expect(created.body.status).toBe('active');

      const updated = await authenticatedTestClient(chatDeployToken)
        .put(`/api/v1/formations/${created.body.id}`)
        .send({
          template: {
            resources: {
              MyChat: {
                type: 'chat',
                properties: {
                  name: 'fra-chat-2',
                  ai_provider_id: provider.body.id,
                },
              },
            },
          },
        });

      expect(updated.status).toBe(200);
      expect(updated.body.status).toBe('active');
    });
  });

  describe('DELETE /api/v1/formations/:formation_id', () => {
    test('a teardown the caller may not perform is refused and the stack survives', async () => {
      const { token: noDeleteToken } = await grant({
        username: 'franodelete',
        password: 'nodeletepass',
        actions: [...FORMATION_ACTIONS, 'memories:CreateMemory'],
      });

      const created = await authenticatedTestClient(noDeleteToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: 'teardown-stack',
          template: {
            resources: {
              MyMemory: {
                type: 'memory',
                properties: { name: 'fra-teardown' },
              },
            },
          },
        });
      expect(created.status).toBe(201);

      const res = await authenticatedTestClient(noDeleteToken).delete(
        `/api/v1/formations/${created.body.id}`
      );

      expect(res.status).toBe(403);
      expect(res.body.error.meta.denied_actions).toEqual([
        {
          logical_id: 'MyMemory',
          resource_type: 'memory',
          action: 'memories:DeleteMemory',
        },
      ]);

      const survived = await authenticatedTestClient(noDeleteToken).get(
        `/api/v1/formations/${created.body.id}`
      );
      expect(survived.body.status).toBe('active');
    });
  });

  // #1180
  describe('cross-project references', () => {
    test('a template cannot link a secret from another project', async () => {
      const secret = await authenticatedTestClient(adminToken)
        .post('/api/v1/secrets')
        .send({
          project_id: otherProjectId,
          name: 'fra-other-project-secret',
          value: 'sk-other-project',
        });
      expect(secret.status).toBe(201);

      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: 'cross-project-secret-stack',
          template: {
            resources: {
              Borrowed: {
                type: 'ai_provider',
                properties: {
                  name: 'fra-borrowed-provider',
                  provider: 'openai',
                  default_model: 'gpt-4o',
                  secret_id: secret.body.id,
                },
              },
            },
          },
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('failed');
      expect(res.body.error.message).toContain(secret.body.id);

      const providers = await authenticatedTestClient(adminToken).get(
        `/api/v1/ai-providers?project_id=${projectId}`
      );
      expect(
        providers.body.data.some((provider: { name: string }) => {
          return provider.name === 'fra-borrowed-provider';
        })
      ).toBe(false);
    });

    test('a template links a secret in its own project', async () => {
      const secret = await authenticatedTestClient(adminToken)
        .post('/api/v1/secrets')
        .send({
          project_id: projectId,
          name: 'fra-own-project-secret',
          value: 'sk-own-project',
        });

      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: 'own-project-secret-stack',
          template: {
            resources: {
              Own: {
                type: 'ai_provider',
                properties: {
                  name: 'fra-own-provider',
                  provider: 'openai',
                  default_model: 'gpt-4o',
                  secret_id: secret.body.id,
                },
              },
            },
          },
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');
    });
  });
});
