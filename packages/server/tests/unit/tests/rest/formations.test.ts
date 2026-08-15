import { db } from 'src/db';
import { saveTrace } from 'src/lib/traces';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('Formations', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectId: string;
  let noPermToken: string;
  let formationId: string;

  const simpleTemplate = {
    resources: {
      MyMemory: {
        type: 'memory',
        properties: {
          name: 'Formation Test Memory',
        },
      },
    },
    outputs: {
      memoryId: { ref: 'MyMemory' },
    },
  };

  const invalidTemplate = {
    resources: {
      BadAgent: {
        type: 'agent',
        properties: {
          name: 'Bad Agent',
          ai_provider_id: { ref: 'NonExistent' },
        },
      },
    },
  };

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'afadmin', password: 'supersecret' });

    adminToken = await loginAs('afadmin', 'supersecret');

    const createUserRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'afuser', password: 'afpass' });
    userId = createUserRes.body.id;
    userToken = await loginAs('afuser', 'afpass');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Formations Test Project' });
    projectId = projectRes.body.id;

    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: [
                'formations:ValidateFormation',
                'formations:PlanFormation',
                'formations:CreateFormation',
                'formations:ListFormations',
                'formations:GetFormation',
                'formations:UpdateFormation',
                'formations:DeleteFormation',
                'formations:ListFormationEvents',
                'memories:CreateMemory',
                'memories:DeleteMemory',
                'memories:CreateMemoryEntry',
                'memories:UpdateMemoryEntry',
                'memories:DeleteMemoryEntry',
                'documents:DeleteDocument',
                'quotas:CreateQuota',
                'quotas:GetQuota',
                'quotas:UpdateQuota',
                'quotas:DeleteQuota',
                'guardrails:GetGuardrail',
                'evaluations:CreateDataset',
                'evaluations:GetDataset',
                'evaluations:DeleteDataset',
                'evaluations:CreateEval',
                'evaluations:GetEval',
                'evaluations:DeleteEval',
                'evaluations:ListEvals',
                'evaluations:ListDatasets',
                'agents:CreateAgent',
                'agents:GetAgent',
                'agents:DeleteAgent',
                'memories:GetMemory',
              ],
            },
          ],
        },
      });

    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userId}/policies`)
      .send({ policy_ids: [policyRes.body.id] });

    const noPermRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'afnoperm', password: 'nopass' });
    noPermToken = await loginAs(
      'afnoperm',
      noPermRes.body.username ?? 'nopass'
    );
    await loginAs('afnoperm', 'nopass');
    noPermToken = await loginAs('afnoperm', 'nopass');
  });

  // ── Validate ──────────────────────────────────────────────────────────────

  describe('POST /api/v1/formations/validate', () => {
    test('valid template returns valid=true', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/validate')
        .send({ template: simpleTemplate });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.errors).toHaveLength(0);
    });

    test('valid YAML string template returns valid=true', async () => {
      const yamlTemplate = `
resources:
  MyMemory:
    type: memory
    properties:
      name: Formation YAML Test Memory
outputs:
  memoryId:
    ref: MyMemory
`.trim();

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/validate')
        .send({ template: yamlTemplate });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.errors).toHaveLength(0);
    });

    test('valid JSON string template returns valid=true', async () => {
      const jsonTemplate = JSON.stringify(simpleTemplate);

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/validate')
        .send({ template: jsonTemplate });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.errors).toHaveLength(0);
    });

    test('invalid ref returns valid=false', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/validate')
        .send({ template: invalidTemplate });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.errors.length).toBeGreaterThan(0);
    });

    test('unauthenticated returns 401', async () => {
      const res = await testClient
        .post('/api/v1/formations/validate')
        .send({ template: simpleTemplate });

      expect(res.status).toBe(401);
    });

    // #900: the resource-type allowlist used to be a hand-written literal that
    // had fallen behind the module registry, so `model_route` — a fully
    // implemented resource type — was unreachable through the API.
    test('a model_route resource is a declarable type', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/validate')
        .send({
          template: {
            resources: {
              PrimaryRoute: {
                type: 'model_route',
                properties: {
                  name: 'primary',
                  targets: [
                    { ai_provider_id: 'aip_placeholder000', model: 'gpt-4o' },
                  ],
                },
              },
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.errors).toEqual([]);
    });

    // #901: camelCase keys were normalized by 20 of 24 modules. `tool` was one
    // of the four that skipped it, so the same spelling that worked elsewhere
    // in a template was reported as an unknown field here.
    test('a tool resource accepts camelCase property keys', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/validate')
        .send({
          template: {
            resources: {
              CamelTool: {
                type: 'tool',
                properties: {
                  name: 'camel-tool',
                  type: 'soat',
                  deniedActions: ['list-tools'],
                },
              },
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.errors).toEqual([]);
    });

    test('policy resource with an unknown action is rejected (F-11)', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/validate')
        .send({
          template: {
            resources: {
              BadPolicy: {
                type: 'policy',
                properties: {
                  document: {
                    statement: [
                      {
                        effect: 'Deny',
                        action: ['memories:Nonexistent'],
                        resource: ['*'],
                      },
                    ],
                  },
                },
              },
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(
        res.body.errors.some((e: string | { message?: string }) => {
          return JSON.stringify(e).includes('memories:Nonexistent');
        })
      ).toBe(true);
    });

    test('policy resource with only real actions validates (F-11)', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/validate')
        .send({
          template: {
            resources: {
              GoodPolicy: {
                type: 'policy',
                properties: {
                  document: {
                    statement: [
                      {
                        effect: 'Deny',
                        action: ['memories:CreateMemoryEntry'],
                        resource: ['*'],
                      },
                    ],
                  },
                },
              },
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
    });

    test('agent boundary_policy with an unknown action is rejected (F-11)', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/validate')
        .send({
          template: {
            resources: {
              BadBoundaryAgent: {
                type: 'agent',
                properties: {
                  ai_provider_id: 'aip_placeholder000',
                  boundary_policy: {
                    statement: [
                      {
                        effect: 'Deny',
                        action: ['memories:Nonexistent'],
                        resource: ['*'],
                      },
                    ],
                  },
                },
              },
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(
        res.body.errors.some((e: string | { message?: string }) => {
          return JSON.stringify(e).includes('memories:Nonexistent');
        })
      ).toBe(true);
    });

    test('agent boundary_policy with only real actions raises no action error (F-11)', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/validate')
        .send({
          template: {
            resources: {
              GoodBoundaryAgent: {
                type: 'agent',
                properties: {
                  ai_provider_id: 'aip_placeholder000',
                  boundary_policy: {
                    statement: [
                      {
                        effect: 'Deny',
                        action: ['memories:CreateMemoryEntry'],
                        resource: ['*'],
                      },
                    ],
                  },
                },
              },
            },
          },
        });

      expect(res.status).toBe(200);
      // The boundary's action is valid, so no "not a known action" error for it.
      expect(
        res.body.errors.some((e: string | { message?: string }) => {
          return JSON.stringify(e).includes('not a known action');
        })
      ).toBe(false);
    });
  });

  // ── Plan ──────────────────────────────────────────────────────────────────

  describe('POST /api/v1/formations/plan', () => {
    test('returns plan with create actions', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/plan')
        .send({ project_id: projectId, template: simpleTemplate });

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.changes)).toBe(true);
      expect(res.body.changes[0].action).toBe('create');
      expect(res.body.changes[0].logical_id).toBe('MyMemory');
    });

    test('accepts YAML string template', async () => {
      const yamlTemplate = `
resources:
  MyMemory:
    type: memory
    properties:
      name: Plan YAML Test Memory
`.trim();

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/plan')
        .send({ project_id: projectId, template: yamlTemplate });

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.changes)).toBe(true);
      expect(res.body.changes[0].action).toBe('create');
    });

    test('unauthenticated returns 401', async () => {
      const res = await testClient
        .post('/api/v1/formations/plan')
        .send({ project_id: projectId, template: simpleTemplate });

      expect(res.status).toBe(401);
    });

    test('no permission returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .post('/api/v1/formations/plan')
        .send({ project_id: projectId, template: simpleTemplate });

      expect(res.status).toBe(403);
    });

    test('plan with a nonexistent formation_id treats every resource as create', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/plan')
        .send({
          project_id: projectId,
          formation_id: 'form_doesnotexist',
          template: simpleTemplate,
        });

      expect(res.status).toBe(200);
      expect(res.body.changes[0].action).toBe('create');
      expect(res.body.changes[0].physical_resource_id).toBeUndefined();
    });

    test('invalid template returns 400', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/plan')
        .send({ project_id: projectId, template: invalidTemplate });

      expect(res.status).toBe(400);
    });
  });

  // ── Create ────────────────────────────────────────────────────────────────

  describe('POST /api/v1/formations', () => {
    test('creates a formation and provisions resources', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: 'test-formation',
          template: simpleTemplate,
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.id).toMatch(/^form_/);
      expect(res.body.name).toBe('test-formation');
      expect(res.body.status).toBe('active');
      expect(res.body.project_id).toBe(projectId);
      expect(Array.isArray(res.body.resources)).toBe(true);
      expect(res.body.resources).toHaveLength(1);
      expect(res.body.resources[0].logical_id).toBe('MyMemory');
      expect(res.body.resources[0].status).toBe('created');
      expect(res.body.resources[0].physical_resource_id).toBeDefined();
      expect(res.body.outputs).toBeDefined();

      formationId = res.body.id;
    });

    test('duplicate name returns 409', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: 'test-formation',
          template: simpleTemplate,
        });

      expect(res.status).toBe(409);
    });

    test('invalid template returns 400', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: 'bad-formation',
          template: invalidTemplate,
        });

      expect(res.status).toBe(400);
    });

    test('unauthenticated returns 401', async () => {
      const res = await testClient
        .post('/api/v1/formations')
        .send({ project_id: projectId, name: 'x', template: simpleTemplate });

      expect(res.status).toBe(401);
    });

    test('no permission returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .post('/api/v1/formations')
        .send({ project_id: projectId, name: 'x', template: simpleTemplate });

      expect(res.status).toBe(403);
    });

    test('ai_provider resource with non-existent secret sets resource status to failed', async () => {
      const failingTemplate = {
        resources: {
          MyProvider: {
            type: 'ai_provider',
            properties: {
              name: 'test-provider',
              provider: 'openai',
              default_model: 'gpt-4o',
              secret_id: 'sec_nonexistent',
            },
          },
        },
      };

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `failing-provider-${Date.now()}`,
          template: failingTemplate,
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('failed');
      expect(Array.isArray(res.body.resources)).toBe(true);
      expect(res.body.resources).toHaveLength(1);
      const resource = res.body.resources[0];
      expect(resource.logical_id).toBe('MyProvider');
      expect(resource.status).toBe('failed');
      expect(resource.physical_resource_id).toBeNull();
    });

    // A deploy answers 2xx even when it fails — the operation ran, and partial
    // failure is state on the resource. That is only defensible if the response
    // the caller already holds says *why*; before #1028 the reason lived solely
    // on a `list-formation-events` call the caller had to know to make.
    test('a failed deploy explains itself on the response body', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `deploy-error-body-${Date.now()}`,
          template: {
            resources: {
              MyProvider: {
                type: 'ai_provider',
                properties: {
                  name: 'error-body-provider',
                  provider: 'openai',
                  default_model: 'gpt-4o',
                  secret_id: 'sec_nonexistent',
                },
              },
            },
          },
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('failed');
      // A bare `Error` from the resource handler has no code to report, so the
      // bag says so rather than inventing one.
      expect(res.body.error).toEqual({
        code: 'UNKNOWN',
        message: expect.stringContaining('sec_nonexistent'),
        meta: { logical_id: 'MyProvider', resource_type: 'ai_provider' },
      });

      // The same failure is readable later, without a second endpoint.
      const get = await authenticatedTestClient(userToken).get(
        `/api/v1/formations/${res.body.id}`
      );
      expect(get.status).toBe(200);
      expect(get.body.error).toEqual(res.body.error);

      // …and on the operation history, in the identical shape.
      const events = await authenticatedTestClient(userToken).get(
        `/api/v1/formations/${res.body.id}/events`
      );
      expect(events.status).toBe(200);
      expect(events.body.data[0].error).toEqual(res.body.error);
    });

    test('a successful deploy reports no error', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `deploy-no-error-${Date.now()}`,
          template: simpleTemplate,
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');
      expect(res.body.error).toBeNull();

      const list = await authenticatedTestClient(userToken).get(
        `/api/v1/formations?project_id=${projectId}`
      );
      const listed = list.body.data.find((f: { id: string }) => {
        return f.id === res.body.id;
      });
      expect(listed.error).toBeNull();

      await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${res.body.id}`
      );
    });

    test('a corrected re-apply clears the error it recovered from', async () => {
      const providerName = `recovered-provider-${Date.now()}`;
      const template = (secretId: string | null) => {
        return {
          resources: {
            RecoveredProvider: {
              type: 'ai_provider',
              properties: {
                name: providerName,
                provider: 'openai',
                default_model: 'gpt-4o',
                secret_id: secretId,
              },
            },
          },
        };
      };

      const failed = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `recovered-formation-${Date.now()}`,
          template: template('sec_nonexistent'),
        });
      expect(failed.status).toBe(201);
      expect(failed.body.error.code).toBe('UNKNOWN');

      const fixed = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${failed.body.id}`)
        .send({ template: template(null) });

      expect(fixed.status).toBe(200);
      expect(fixed.body.status).toBe('active');
      // `error` describes the current status, not the stack's history — the
      // operation list is what keeps the history.
      expect(fixed.body.error).toBeNull();
    });

    test('rolls back resources created earlier in the same failed apply', async () => {
      const memoryName = `rollback-mem-${Date.now()}`;
      const partiallyFailingTemplate = {
        resources: {
          RollbackMemory: {
            type: 'memory',
            properties: { name: memoryName },
          },
          RollbackProvider: {
            type: 'ai_provider',
            properties: {
              name: 'rollback-provider',
              provider: 'openai',
              default_model: 'gpt-4o',
              secret_id: 'sec_nonexistent',
            },
            depends_on: ['RollbackMemory'],
          },
        },
      };

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `rollback-formation-${Date.now()}`,
          template: partiallyFailingTemplate,
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('failed');

      const memoryResource = res.body.resources.find(
        (resource: { logical_id: string }) => {
          return resource.logical_id === 'RollbackMemory';
        }
      );
      // The memory was created before the provider failed, so the apply must
      // walk it back rather than leave it live and unmanaged.
      expect(memoryResource.status).toBe('deleted');
      expect(memoryResource.physical_resource_id).toMatch(/^mem_/);
      const memory = await db.Memory.findOne({
        where: { publicId: memoryResource.physical_resource_id },
      });
      expect(memory).toBeNull();

      const eventsRes = await authenticatedTestClient(userToken).get(
        `/api/v1/formations/${res.body.id}/events`
      );
      expect(eventsRes.status).toBe(200);
      const operation = eventsRes.body.data[0];
      expect(operation.status).toBe('failed');
      const actions = operation.events.map(
        (event: { logical_id: string; action: string; status: string }) => {
          return [event.logical_id, event.action, event.status];
        }
      );
      // The original failure stays ahead of the unwind it triggered.
      expect(actions).toEqual([
        ['RollbackMemory', 'create', 'succeeded'],
        ['RollbackProvider', 'create', 'failed'],
        ['RollbackMemory', 'rollback', 'succeeded'],
      ]);
    });

    test('a rolled-back resource is re-created by a corrected re-apply', async () => {
      const name = `rollback-retry-formation-${Date.now()}`;
      const memoryName = `rollback-retry-mem-${Date.now()}`;
      const providerName = `rollback-retry-provider-${Date.now()}`;
      const template = (secretId: string | null) => {
        return {
          resources: {
            RetryMemory: {
              type: 'memory',
              properties: { name: memoryName },
            },
            RetryProvider: {
              type: 'ai_provider',
              properties: {
                name: providerName,
                provider: 'openai',
                default_model: 'gpt-4o',
                secret_id: secretId,
              },
              depends_on: ['RetryMemory'],
            },
          },
        };
      };

      const failed = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name,
          template: template('sec_nonexistent'),
        });
      expect(failed.status).toBe(201);
      expect(failed.body.status).toBe('failed');

      const fixed = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${failed.body.id}`)
        .send({ template: template(null) });

      expect(fixed.status).toBe(200);
      expect(fixed.body.status).toBe('active');
      const retriedMemory = fixed.body.resources.find(
        (resource: { logical_id: string }) => {
          return resource.logical_id === 'RetryMemory';
        }
      );
      expect(retriedMemory.status).toBe('created');
      const memory = await db.Memory.findOne({
        where: { publicId: retriedMemory.physical_resource_id },
      });
      expect(memory).not.toBeNull();
    });

    test('a retained resource survives the rollback and stays managed', async () => {
      const memoryName = `rollback-retain-mem-${Date.now()}`;
      const retainTemplate = {
        resources: {
          RetainedMemory: {
            type: 'memory',
            properties: { name: memoryName },
            deletion_policy: 'retain',
          },
          RetainProvider: {
            type: 'ai_provider',
            properties: {
              name: 'retain-provider',
              provider: 'openai',
              default_model: 'gpt-4o',
              secret_id: 'sec_nonexistent',
            },
            depends_on: ['RetainedMemory'],
          },
        },
      };

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `rollback-retain-formation-${Date.now()}`,
          template: retainTemplate,
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('failed');

      const retained = res.body.resources.find(
        (resource: { logical_id: string }) => {
          return resource.logical_id === 'RetainedMemory';
        }
      );
      // `retain` outranks the unwind: the resource stays alive, and its row
      // keeps pointing at it so a corrected re-apply adopts it.
      expect(retained.status).toBe('created');
      const memory = await db.Memory.findOne({
        where: { publicId: retained.physical_resource_id },
      });
      expect(memory).not.toBeNull();

      const eventsRes = await authenticatedTestClient(userToken).get(
        `/api/v1/formations/${res.body.id}/events`
      );
      const skipped = eventsRes.body.data[0].events.find(
        (event: { action: string }) => {
          return event.action === 'rollback-skipped';
        }
      );
      expect(skipped.logical_id).toBe('RetainedMemory');
      expect(skipped.status).toBe('succeeded');
    });

    test('creates a formation with metadata', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `metadata-formation-${Date.now()}`,
          template: simpleTemplate,
          metadata: { env: 'test' },
        });

      expect(res.status).toBe(201);
      expect(res.body.metadata).toEqual({ env: 'test' });
    });

    test('resolves `sub` in top-level template metadata and records deploy parameters (F-16)', async () => {
      const template = {
        parameters: {
          my_version: { type: 'string', default: 'unpinned' },
          db_password: { type: 'string', default: 'hunter2', no_echo: true },
        },
        resources: {
          MyMemory: {
            type: 'memory',
            properties: { name: 'F16 Memory' },
          },
        },
        metadata: {
          my_version: { sub: '${my_version}' },
          memory_ref: { ref: 'MyMemory' },
          static: 'kept',
        },
      };

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `f16-metadata-sub-${Date.now()}`,
          template,
          parameters: { my_version: '1.2.3' },
        });

      expect(res.status).toBe(201);

      // Raw template metadata keeps the unresolved expressions (re-deploy source).
      expect(res.body.template.metadata.my_version).toEqual({
        sub: '${my_version}',
      });

      // resolved_metadata reflects the deploy-time values: param substituted,
      // resource ref resolved to a physical id, static values preserved.
      expect(res.body.resolved_metadata.my_version).toBe('1.2.3');
      expect(res.body.resolved_metadata.static).toBe('kept');
      expect(res.body.resolved_metadata.memory_ref).toBe(
        res.body.resources[0].physical_resource_id
      );

      // resolved_parameters records deploy-time values for auditability, with
      // no_echo parameters masked.
      expect(res.body.resolved_parameters.my_version).toBe('1.2.3');
      expect(res.body.resolved_parameters.db_password).toBe('***');
    });

    test('rejects substitution expressions in the formation `metadata` field (F-16)', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `f16-static-metadata-${Date.now()}`,
          template: {
            parameters: { my_version: { type: 'string', default: 'x' } },
            resources: {
              MyMemory: { type: 'memory', properties: { name: 'F16 static' } },
            },
          },
          parameters: { my_version: '1.2.3' },
          // The formation-level `metadata` field is static — a `sub` here would
          // be stored verbatim and silently never resolved, so it is rejected.
          metadata: { my_version: { sub: '${my_version}' } },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('FORMATION_INVALID_METADATA');
      // `metadata` is an author-authored, opaque annotation bag — its inner
      // keys are never rewritten (see `.claude/rules/case-convention.md`), so
      // the reported path reflects the wire key exactly as submitted.
      expect(res.body.error.meta.details[0].path).toBe('metadata.my_version');
      expect(res.body.error.meta.details[0].message).toMatch(
        /template.*top-level.*metadata/i
      );
    });

    test('rejects a nested `ref` expression in the formation `metadata` field', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `f16-static-metadata-ref-${Date.now()}`,
          template: simpleTemplate,
          metadata: { audit: { source: { ref: 'MyMemory' } } },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('FORMATION_INVALID_METADATA');
      expect(res.body.error.meta.details[0].path).toBe('metadata.audit.source');
    });

    test('accepts plain static metadata that looks structurally similar', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `f16-static-metadata-ok-${Date.now()}`,
          template: simpleTemplate,
          // No single-key sub/param/ref expression object — plain annotations.
          metadata: { env: 'prod', owner: 'team-a', tags: ['x', 'y'] },
        });

      expect(res.status).toBe(201);
      expect(res.body.metadata).toEqual({
        env: 'prod',
        owner: 'team-a',
        tags: ['x', 'y'],
      });
    });

    test('re-planning a formation with a resource that failed to create treats it as create', async () => {
      const failingTemplate = {
        resources: {
          MyProvider: {
            type: 'ai_provider',
            properties: {
              name: 'test-provider',
              provider: 'openai',
              default_model: 'gpt-4o',
              secret_id: 'sec_nonexistent',
            },
          },
        },
      };

      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `replan-failing-provider-${Date.now()}`,
          template: failingTemplate,
        });
      expect(createRes.status).toBe(201);
      expect(createRes.body.resources[0].physical_resource_id).toBeNull();

      const planRes = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/plan')
        .send({
          project_id: projectId,
          formation_id: createRes.body.id,
          template: failingTemplate,
        });

      expect(planRes.status).toBe(200);
      expect(planRes.body.changes[0].action).toBe('create');
      expect(planRes.body.changes[0].physical_resource_id).toBeUndefined();
    });
  });

  // ── List ──────────────────────────────────────────────────────────────────

  describe('GET /api/v1/formations', () => {
    test('returns list of formations', async () => {
      const res = await authenticatedTestClient(userToken)
        .get('/api/v1/formations')
        .query({ project_id: projectId });

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0].id).toBeDefined();
      expect(res.body.data[0].resources).toBeUndefined();
    });

    test('unauthenticated returns 401', async () => {
      const res = await testClient
        .get('/api/v1/formations')
        .query({ project_id: projectId });

      expect(res.status).toBe(401);
    });

    test('no permission returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .get('/api/v1/formations')
        .query({ project_id: projectId });

      expect(res.status).toBe(403);
    });

    test('admin without project scoping gets an empty list', async () => {
      const res =
        await authenticatedTestClient(adminToken).get('/api/v1/formations');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });
  });

  // ── Get ───────────────────────────────────────────────────────────────────

  describe('GET /api/v1/formations/:formation_id', () => {
    test('returns formation details', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/formations/${formationId}`
      );

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(formationId);
      expect(res.body.name).toBe('test-formation');
      expect(Array.isArray(res.body.resources)).toBe(true);
    });

    test('unknown id returns 404', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/formations/form_nonexistent'
      );

      expect(res.status).toBe(404);
    });

    test('unauthenticated returns 401', async () => {
      const res = await testClient.get(`/api/v1/formations/${formationId}`);
      expect(res.status).toBe(401);
    });

    test('no permission returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/formations/${formationId}`
      );
      expect(res.status).toBe(403);
    });
  });

  // ── Update ────────────────────────────────────────────────────────────────

  describe('PUT /api/v1/formations/:formation_id', () => {
    test('updates a formation', async () => {
      const updatedTemplate = {
        resources: {
          MyMemory: {
            type: 'memory',
            properties: {
              name: 'Updated Memory Name',
            },
          },
          MyMemory2: {
            type: 'memory',
            properties: {
              name: 'Second Memory',
            },
          },
        },
      };

      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${formationId}`)
        .send({ template: updatedTemplate });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('active');
      expect(res.body.resources).toHaveLength(2);
    });

    test('invalid template returns 400', async () => {
      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${formationId}`)
        .send({ template: invalidTemplate });

      expect(res.status).toBe(400);
    });

    test('unknown id returns 404', async () => {
      const res = await authenticatedTestClient(userToken)
        .put('/api/v1/formations/form_nonexistent')
        .send({ template: simpleTemplate });

      expect(res.status).toBe(404);
    });

    test('unauthenticated returns 401', async () => {
      const res = await testClient
        .put(`/api/v1/formations/${formationId}`)
        .send({ template: simpleTemplate });

      expect(res.status).toBe(401);
    });

    test('no permission returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .put(`/api/v1/formations/${formationId}`)
        .send({ template: simpleTemplate });

      expect(res.status).toBe(403);
    });
  });

  describe('PUT /api/v1/formations/:formation_id — metadata', () => {
    let metadataFormationId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `metadata-update-formation-${Date.now()}`,
          template: simpleTemplate,
          metadata: { env: 'initial' },
        });
      metadataFormationId = res.body.id;
    });

    test('updates metadata without changing the template', async () => {
      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${metadataFormationId}`)
        .send({ metadata: { env: 'updated' } });

      expect(res.status).toBe(200);
      expect(res.body.metadata).toEqual({ env: 'updated' });
      expect(res.body.resources).toHaveLength(1);
    });

    test('omitting metadata on update leaves existing metadata unchanged', async () => {
      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${metadataFormationId}`)
        .send({
          template: {
            resources: {
              MyMemory: {
                type: 'memory',
                properties: { name: 'Metadata Formation Memory Renamed' },
              },
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.metadata).toEqual({ env: 'updated' });
    });

    test('rejects a substitution expression in metadata on update (F-16)', async () => {
      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${metadataFormationId}`)
        .send({ metadata: { version: { param: 'my_version' } } });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('FORMATION_INVALID_METADATA');
      expect(res.body.error.meta.details[0].path).toBe('metadata.version');
    });
  });

  // ── Events ────────────────────────────────────────────────────────────────

  describe('GET /api/v1/formations/:formation_id/events', () => {
    test('returns operation events', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/formations/${formationId}/events`
      );

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0].id).toBeDefined();
      expect(res.body.data[0].operation_type).toBeDefined();
    });

    test('unknown formation returns 404', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/formations/form_nonexistent/events'
      );
      expect(res.status).toBe(404);
    });

    test('unauthenticated returns 401', async () => {
      const res = await testClient.get(
        `/api/v1/formations/${formationId}/events`
      );
      expect(res.status).toBe(401);
    });

    test('no permission returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/formations/${formationId}/events`
      );
      expect(res.status).toBe(403);
    });
  });

  // ── Delete ────────────────────────────────────────────────────────────────

  describe('DELETE /api/v1/formations/:formation_id', () => {
    test('no permission returns 403', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: 'delete-perm-check',
          template: simpleTemplate,
        });

      const res = await authenticatedTestClient(noPermToken).delete(
        `/api/v1/formations/${createRes.body.id}`
      );
      expect(res.status).toBe(403);
    });

    test('deletes the formation and returns 200 with success', async () => {
      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${formationId}`
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    test('deleted formation is no longer found', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/formations/${formationId}`
      );
      expect(res.status).toBe(404);
    });

    test('unknown id returns 404', async () => {
      const res = await authenticatedTestClient(userToken).delete(
        '/api/v1/formations/form_nonexistent'
      );
      expect(res.status).toBe(404);
    });

    test('unauthenticated returns 401', async () => {
      const res = await testClient.delete(`/api/v1/formations/${formationId}`);
      expect(res.status).toBe(401);
    });

    test('deleted formation is excluded from list results', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/formations?project_id=${projectId}`
      );
      expect(res.status).toBe(200);
      const ids = res.body.data.map((f: { id: string }) => {
        return f.id;
      });
      expect(ids).not.toContain(formationId);
    });

    test('deleting an already-deleted formation returns 404', async () => {
      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${formationId}`
      );
      expect(res.status).toBe(404);
    });

    test('can create a new formation with the same name as a deleted one', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: 'test-formation',
          template: simpleTemplate,
        });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('test-formation');
    });
  });

  describe('DELETE /api/v1/formations/:formation_id — resource deletion failure', () => {
    // A teardown that stops partway is the worst thing to report as a bare
    // boolean: the resources already deleted are gone, and the operator has no
    // way to learn which one blocked or what to do about it. The reason is
    // recorded on the operation either way — this is about handing it back.
    test('fails with the blocking resource named when one cannot be deleted', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `delete-failure-formation-${Date.now()}`,
          template: simpleTemplate,
        });
      expect(createRes.status).toBe(201);
      const deleteFailureFormationId = createRes.body.id;

      // Seed a corrupted resource row with a resource type that has no
      // registered formation module, so performResourceDeletions hits a real
      // (non "already gone") failure when trying to delete it — simulating
      // an orphaned/corrupted resource without mocking any db/lib call.
      const formationRow = await db.Formation.findOne({
        where: { publicId: deleteFailureFormationId },
      });
      await db.FormationResource.create({
        formationId: formationRow!.id,
        logicalId: 'CorruptedResource',
        resourceType: 'unsupported_resource_type',
        physicalResourceId: 'bogus_1',
        status: 'created',
        lastAppliedProperties: null,
      });

      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${deleteFailureFormationId}`
      );

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('FORMATION_DELETE_FAILED');
      // The logical id is what the operator addresses in their template, so it
      // is the half that makes the message actionable.
      expect(res.body.error.message).toMatch(/CorruptedResource/);
      expect(res.body.error.meta.failures).toEqual([
        expect.objectContaining({
          logical_id: 'CorruptedResource',
          resource_type: 'unsupported_resource_type',
          error: expect.any(String),
        }),
      ]);

      const getRes = await authenticatedTestClient(userToken).get(
        `/api/v1/formations/${deleteFailureFormationId}`
      );
      expect(getRes.status).toBe(200);
      expect(getRes.body.status).toBe('delete_failed');
      // The 409 is gone once the request is over; the wedged stack still has
      // to say why it is wedged when someone reads it back (#1028).
      expect(getRes.body.error).toEqual({
        code: 'FORMATION_DELETE_FAILED',
        message: expect.stringContaining('CorruptedResource'),
        meta: {
          failures: [
            expect.objectContaining({ logical_id: 'CorruptedResource' }),
          ],
        },
      });
    });

    // The blocker an operator actually hits: an agent that has generated. The
    // evaluations docs tell them to declare an agent and the eval that verifies
    // it in one stack, and running the suite — the whole point — gives the agent
    // history. Teardown is ordered and not transactional, so discovering the
    // refusal by attempting the delete destroyed everything ordered ahead of the
    // agent and left the stack wedged in `delete_failed` (#985). A predictable
    // refusal must be found before the first delete.
    test('an agent with generation history blocks teardown before anything is deleted', async () => {
      const aiProvRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: `preflight-provider-${Date.now()}`,
          provider: 'ollama',
          default_model: 'llama3.2',
        });
      expect(aiProvRes.status).toBe(201);

      const memoryName = `preflight-mem-${Date.now()}`;
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `preflight-formation-${Date.now()}`,
          template: {
            resources: {
              HistoricAgent: {
                type: 'agent',
                properties: {
                  name: `preflight-agent-${Date.now()}`,
                  ai_provider_id: aiProvRes.body.id,
                },
              },
              // Depends on the agent, so teardown removes this one *first* and
              // the agent last — the ordering that made the old failure
              // unrecoverable.
              CompanionMemory: {
                type: 'memory',
                properties: { name: memoryName },
                depends_on: ['HistoricAgent'],
              },
            },
            outputs: {
              agentId: { ref: 'HistoricAgent' },
              memoryId: { ref: 'CompanionMemory' },
            },
          },
        });
      expect(createRes.status).toBe(201);
      expect(createRes.body.status).toBe('active');

      const preflightFormationId = createRes.body.id as string;
      const agentId = createRes.body.outputs.agentId as string;
      const memoryId = createRes.body.outputs.memoryId as string;

      const project = await db.Project.findOne({
        where: { publicId: projectId },
      });
      // A trace is history the same way a generation is, and it is what an eval
      // run leaves behind — `saveTrace` is the real write path for it.
      await saveTrace({
        traceId: `trc_preflight_${Date.now()}`,
        projectId: project!.id as number,
        projectPublicId: projectId,
        agentId,
        generationId: 'gen_test_steps',
        steps: [{ type: 'text-delta', text: 'hello' }],
      });

      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${preflightFormationId}`
      );

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('FORMATION_DELETE_FAILED');
      expect(res.body.error.message).toMatch(/HistoricAgent/);
      expect(res.body.error.message).toMatch(/No resource was deleted/);
      expect(res.body.error.meta.failures).toEqual([
        expect.objectContaining({
          logical_id: 'HistoricAgent',
          resource_type: 'agent',
          error: expect.stringContaining('trace'),
        }),
      ]);

      // The point of the pre-flight: the stack is whole, not half torn down.
      const getRes = await authenticatedTestClient(userToken).get(
        `/api/v1/formations/${preflightFormationId}`
      );
      expect(getRes.status).toBe(200);
      expect(getRes.body.status).toBe('active');

      const memoryRes = await authenticatedTestClient(userToken).get(
        `/api/v1/memories/${memoryId}`
      );
      expect(memoryRes.status).toBe(200);
      expect(memoryRes.body.name).toBe(memoryName);

      const agentRes = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${agentId}`
      );
      expect(agentRes.status).toBe(200);

      // And it stays retryable: force-deleting the agent out of band clears the
      // blocker, and the same teardown then completes.
      const forceRes = await authenticatedTestClient(userToken).delete(
        `/api/v1/agents/${agentId}?force=true`
      );
      expect(forceRes.status).toBe(204);

      const retryRes = await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${preflightFormationId}`
      );
      expect(retryRes.body).toEqual({ success: true });
      expect(retryRes.status).toBe(200);
    });

    // `retain` is the declared escape hatch for a resource the stack should leave
    // standing, so it must not be pre-flighted — a retained resource is never
    // deleted, and blocking teardown over one would make the hatch useless.
    test('a retained agent with history does not block teardown', async () => {
      const aiProvRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: `retain-provider-${Date.now()}`,
          provider: 'ollama',
          default_model: 'llama3.2',
        });

      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `retain-formation-${Date.now()}`,
          template: {
            resources: {
              RetainedAgent: {
                type: 'agent',
                deletion_policy: 'retain',
                properties: {
                  name: `retain-agent-${Date.now()}`,
                  ai_provider_id: aiProvRes.body.id,
                },
              },
            },
            outputs: { agentId: { ref: 'RetainedAgent' } },
          },
        });
      expect(createRes.status).toBe(201);
      const retainFormationId = createRes.body.id as string;
      const retainedAgentId = createRes.body.outputs.agentId as string;

      const project = await db.Project.findOne({
        where: { publicId: projectId },
      });
      await saveTrace({
        traceId: `trc_retain_${Date.now()}`,
        projectId: project!.id as number,
        projectPublicId: projectId,
        agentId: retainedAgentId,
        generationId: 'gen_test_steps',
        steps: [{ type: 'text-delta', text: 'hello' }],
      });

      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${retainFormationId}`
      );
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Retained means still there.
      const agentRes = await authenticatedTestClient(userToken).get(
        `/api/v1/agents/${retainedAgentId}`
      );
      expect(agentRes.status).toBe(200);
    });
  });

  // ── Optional resource properties ──────────────────────────────────────────

  describe('Formation with optional resource properties', () => {
    let optionalPropsFormationId: string;

    const templateWithOptionalProps = {
      resources: {
        MemoryWithDescription: {
          type: 'memory',
          properties: {
            name: 'Memory With Metadata',
            description: 'This is a memory with description',
            tags: ['important', 'core'],
          },
        },
        ToolWithOptions: {
          type: 'tool',
          properties: {
            name: 'Tool With Full Options',
            description: 'Tool with description and parameters',
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Search query' },
              },
            },
          },
        },
        WebhookWithEvents: {
          type: 'webhook',
          properties: {
            name: 'Webhook With Events',
            url: 'https://example.com/webhook',
            events: ['memory.created', 'memory.updated'],
            description: 'Webhook with description and events',
          },
        },
      },
    };

    // `ToolResourceProperties.execute` in formations.yaml documents the inner
    // keys a tool's execute config may carry. These two assert that the
    // documented set is actually what an apply carries through to the tool, so
    // a field present in the tools REST spec but missing from the formation
    // schema shows up here rather than as a surprise at authoring time.
    test('carries execute.body_mode through an apply', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `execute-body-mode-${Date.now()}`,
          template: {
            resources: {
              MultipartTool: {
                type: 'tool',
                properties: {
                  name: 'formation-multipart-tool',
                  type: 'http',
                  execute: {
                    url: 'https://api.example.com/stt',
                    method: 'POST',
                    body_mode: 'multipart',
                  },
                },
              },
            },
          },
        });

      expect(res.status).toBe(201);
      expect(res.body.resources).toHaveLength(1);

      // Read back as admin: this file's policy grants formation actions only,
      // so `tools:GetTool` would 404 for `userToken` and mask the assertion.
      const toolRes = await authenticatedTestClient(adminToken).get(
        `/api/v1/tools/${res.body.resources[0].physical_resource_id}`
      );
      expect(toolRes.status).toBe(200);
      expect(toolRes.body.execute.body_mode).toBe('multipart');
    });

    test('carries execute.auth through an apply', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `execute-auth-${Date.now()}`,
          template: {
            resources: {
              SignedTool: {
                type: 'tool',
                properties: {
                  name: 'formation-sigv4-tool',
                  type: 'http',
                  execute: {
                    url: 'https://my-bucket.s3.us-east-1.amazonaws.com/{key}',
                    method: 'GET',
                    auth: {
                      type: 'aws_sigv4',
                      region: 'us-east-1',
                      service: 's3',
                      access_key_id: 'AKIAFORMATION',
                      secret_access_key: 'formation-secret',
                    },
                  },
                },
              },
            },
          },
        });

      expect(res.status).toBe(201);

      // Read back as admin: this file's policy grants formation actions only,
      // so `tools:GetTool` would 404 for `userToken` and mask the assertion.
      const toolRes = await authenticatedTestClient(adminToken).get(
        `/api/v1/tools/${res.body.resources[0].physical_resource_id}`
      );
      expect(toolRes.status).toBe(200);
      expect(toolRes.body.execute.auth.service).toBe('s3');
      expect(toolRes.body.execute.auth.region).toBe('us-east-1');
    });

    test('rejects a malformed execute.auth at validate time', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/validate')
        .send({
          template: {
            resources: {
              BadAuthTool: {
                type: 'tool',
                properties: {
                  name: 'formation-bad-auth-tool',
                  type: 'http',
                  execute: {
                    url: 'https://example.com',
                    auth: { type: 'aws_sigv4', region: 'us-east-1' },
                  },
                },
              },
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(
        res.body.errors.some((error: { message: string }) => {
          return error.message.includes('execute.auth.service');
        })
      ).toBe(true);
    });

    test('creates formation with resources having optional properties', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `optional-props-${Date.now()}`,
          template: templateWithOptionalProps,
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');
      expect(res.body.resources).toHaveLength(3);
      expect(res.body.resources[0].logical_id).toBe('MemoryWithDescription');
      expect(res.body.resources[1].logical_id).toBe('ToolWithOptions');
      expect(res.body.resources[2].logical_id).toBe('WebhookWithEvents');
      optionalPropsFormationId = res.body.id;
    });

    test('retrieves formation and includes the stored template', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/formations/${optionalPropsFormationId}`
      );
      expect(res.status).toBe(200);
      expect(res.body.template).toBeDefined();
      expect(res.body.template.resources).toBeDefined();
      expect(Object.keys(res.body.template.resources)).toHaveLength(3);
    });

    test('updates memory resource with modified optional properties', async () => {
      const updateTemplate = {
        resources: {
          MemoryWithDescription: {
            type: 'memory',
            properties: {
              name: 'Memory Updated',
              description: 'Updated description for memory',
              tags: ['updated', 'modified'],
            },
          },
          ToolWithOptions: templateWithOptionalProps.resources.ToolWithOptions,
          WebhookWithEvents:
            templateWithOptionalProps.resources.WebhookWithEvents,
        },
      };

      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${optionalPropsFormationId}`)
        .send({ template: updateTemplate });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('active');
      const memoryResource = res.body.resources.find(
        (r: { logical_id: string }) => {
          return r.logical_id === 'MemoryWithDescription';
        }
      );
      expect(memoryResource).toBeDefined();
      expect(memoryResource.status).toBe('updated');
    });

    test('deletes formation with optional properties', async () => {
      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${optionalPropsFormationId}`
      );
      expect(res.status).toBe(200);
    });
  });

  // ── Template case preservation ────────────────────────────────────────────

  describe('Template key casing round-trips verbatim', () => {
    let camelCaseFormationId: string;

    // A template whose logical IDs and parameter names are intentionally not
    // snake_case: a PascalCase logical ID and a camelCase parameter name. These
    // are author-chosen identifiers (the tutorial uses `poemDoc`/`stanza1Agent`,
    // the docs use `MyProvider`/`ApiSecret`) and must be stored and returned
    // exactly as written — the caseTransform middleware must not rewrite them.
    const camelCaseTemplate = {
      parameters: {
        memoryDisplayName: {
          type: 'string',
          default: 'Round Trip Memory',
        },
      },
      resources: {
        DefaultMemory: {
          type: 'memory',
          properties: {
            name: { param: 'memoryDisplayName' },
          },
        },
      },
    };

    test('validate accepts camelCase keys without warnings', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/validate')
        .send({ template: camelCaseTemplate });
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.errors).toEqual([]);
    });

    test('creates a formation with camelCase/PascalCase keys', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `camel-case-${Date.now()}`,
          template: camelCaseTemplate,
        });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');
      camelCaseFormationId = res.body.id;
    });

    test('GET returns the template with keys preserved verbatim', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/formations/${camelCaseFormationId}`
      );
      expect(res.status).toBe(200);

      // The resource map key (logical ID) must not be rewritten to
      // `_default_memory`.
      expect(Object.keys(res.body.template.resources)).toEqual([
        'DefaultMemory',
      ]);
      // The parameter name must not be rewritten to `memory_display_name`,
      // otherwise a later `--parameter memoryDisplayName=…` override would not
      // match the stored key.
      expect(Object.keys(res.body.template.parameters)).toEqual([
        'memoryDisplayName',
      ]);
      // The param expression key inside properties is likewise preserved.
      expect(res.body.template.resources.DefaultMemory.properties.name).toEqual(
        {
          param: 'memoryDisplayName',
        }
      );
    });

    test('deletes the camelCase formation', async () => {
      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${camelCaseFormationId}`
      );
      expect(res.status).toBe(200);
    });

    // Regression coverage for an ai_provider-shaped template, matching the
    // exact resource/parameter names reported as corrupted: `DefaultAiProvider`
    // must not become `_default_ai_provider`, and `aiProviderName` must not
    // become `ai_provider_name`.
    describe('ai_provider resource with camelCase/PascalCase keys', () => {
      let aiProviderCamelFormationId: string;

      const aiProviderCamelTemplate = {
        parameters: {
          aiProviderName: {
            type: 'string',
            default: 'round-trip-provider',
          },
        },
        resources: {
          DefaultAiProvider: {
            type: 'ai_provider',
            properties: {
              name: { param: 'aiProviderName' },
              provider: 'openai',
              default_model: 'gpt-4o',
            },
          },
        },
      };

      test('creates a formation with an ai_provider camelCase template', async () => {
        const res = await authenticatedTestClient(userToken)
          .post('/api/v1/formations')
          .send({
            project_id: projectId,
            name: `ai-provider-camel-${Date.now()}`,
            template: aiProviderCamelTemplate,
          });

        expect(res.status).toBe(201);
        expect(res.body.status).toBe('active');
        aiProviderCamelFormationId = res.body.id;
      });

      test('GET returns DefaultAiProvider/aiProviderName keys unchanged', async () => {
        const res = await authenticatedTestClient(userToken).get(
          `/api/v1/formations/${aiProviderCamelFormationId}`
        );
        expect(res.status).toBe(200);
        expect(Object.keys(res.body.template.resources)).toEqual([
          'DefaultAiProvider',
        ]);
        expect(Object.keys(res.body.template.parameters)).toEqual([
          'aiProviderName',
        ]);
      });

      test('a --parameter aiProviderName override matches the stored key', async () => {
        const res = await authenticatedTestClient(userToken)
          .put(`/api/v1/formations/${aiProviderCamelFormationId}`)
          .send({ parameters: { aiProviderName: 'overridden-provider' } });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('active');
      });

      test('deletes the ai_provider camelCase formation', async () => {
        const res = await authenticatedTestClient(userToken).delete(
          `/api/v1/formations/${aiProviderCamelFormationId}`
        );
        expect(res.status).toBe(200);
      });
    });
  });

  // ── Parameters support ────────────────────────────────────────────────────

  describe('Formation with parameters', () => {
    let paramFormationId: string;

    const templateWithParams = {
      parameters: {
        MemoryName: {
          type: 'string',
          default: 'Default Memory Name',
          description: 'Name for the memory resource',
        },
        ToolUrl: {
          type: 'string',
          description: 'URL for the HTTP tool endpoint',
        },
        ApiKey: {
          type: 'string',
          no_echo: true,
          description: 'API key for the tool',
        },
      },
      resources: {
        ParamMemory: {
          type: 'memory',
          properties: {
            name: { param: 'MemoryName' },
          },
        },
        ParamTool: {
          type: 'tool',
          properties: {
            name: 'param-tool',
            execute: {
              url: { sub: '${ToolUrl}/endpoint' },
              headers: { Authorization: { sub: 'Bearer ${ApiKey}' } },
            },
          },
        },
      },
      outputs: {
        memoryId: { ref: 'ParamMemory' },
      },
    };

    describe('POST /api/v1/formations/validate', () => {
      test('validates template with parameters section', async () => {
        const res = await authenticatedTestClient(userToken)
          .post('/api/v1/formations/validate')
          .send({ template: templateWithParams });

        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(true);
        expect(res.body.errors).toHaveLength(0);
        expect(res.body.warnings.length).toBeGreaterThan(0);
      });

      test('returns invalid for template with undefined param ref', async () => {
        const badTemplate = {
          parameters: { KnownParam: { type: 'string' } },
          resources: {
            MyMemory: {
              type: 'memory',
              properties: { name: { param: 'UnknownParam' } },
            },
          },
        };
        const res = await authenticatedTestClient(userToken)
          .post('/api/v1/formations/validate')
          .send({ template: badTemplate });

        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(false);
        expect(res.body.errors.length).toBeGreaterThan(0);
      });

      test('accepts a parameters field alongside the template', async () => {
        const res = await authenticatedTestClient(userToken)
          .post('/api/v1/formations/validate')
          .send({
            template: templateWithParams,
            parameters: { ToolUrl: 'https://example.com', ApiKey: 'secret' },
          });

        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(true);
        expect(res.body.errors).toHaveLength(0);
      });

      test('returns invalid when a required parameter without default is missing', async () => {
        const res = await authenticatedTestClient(userToken)
          .post('/api/v1/formations/validate')
          .send({ template: templateWithParams, parameters: {} });

        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(false);
        expect(res.body.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: 'parameters.ToolUrl' }),
            expect.objectContaining({ path: 'parameters.ApiKey' }),
          ])
        );
      });

      test('returns invalid for a tool resource with a non-secret {{...}} token in execute', async () => {
        const res = await authenticatedTestClient(userToken)
          .post('/api/v1/formations/validate')
          .send({
            template: {
              resources: {
                BadTool: {
                  type: 'tool',
                  properties: {
                    name: 'bad-token-tool',
                    execute: {
                      url: 'https://api.weather.example/v1/current?city={{city}}',
                    },
                  },
                },
              },
            },
          });

        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(false);
        expect(res.body.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: 'resources.BadTool.properties.execute',
              message: expect.stringContaining("'{{city}}'"),
            }),
          ])
        );
      });

      test('reports a non-secret {{...}} token in mcp at the mcp path, not execute', async () => {
        const res = await authenticatedTestClient(userToken)
          .post('/api/v1/formations/validate')
          .send({
            template: {
              resources: {
                BadMcpTool: {
                  type: 'tool',
                  properties: {
                    name: 'bad-mcp-token-tool',
                    mcp: {
                      url: 'https://mcp.example/sse',
                      headers: { Authorization: 'Bearer {{apiKey}}' },
                    },
                  },
                },
              },
            },
          });

        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(false);
        expect(res.body.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: 'resources.BadMcpTool.properties.mcp',
              message: expect.stringContaining("'{{apiKey}}'"),
            }),
          ])
        );
      });
    });

    describe('POST /api/v1/formations', () => {
      test('creates formation with parameters provided at deploy time', async () => {
        const res = await authenticatedTestClient(userToken)
          .post('/api/v1/formations')
          .send({
            project_id: projectId,
            name: `param-formation-${Date.now()}`,
            template: templateWithParams,
            parameters: {
              ToolUrl: 'https://api.example.com',
              ApiKey: 'secret-key-123',
            },
          });

        expect(res.status).toBe(201);
        expect(res.body.status).toBe('active');
        expect(res.body.resources).toHaveLength(2);
        paramFormationId = res.body.id;

        const memoryResource = res.body.resources.find(
          (r: { logical_id: string }) => {
            return r.logical_id === 'ParamMemory';
          }
        );
        expect(memoryResource).toBeDefined();
        expect(memoryResource.status).toBe('created');
      });

      test('returns 400 when required parameter without default is missing', async () => {
        const res = await authenticatedTestClient(userToken)
          .post('/api/v1/formations')
          .send({
            project_id: projectId,
            name: `missing-params-${Date.now()}`,
            template: templateWithParams,
            // Missing ToolUrl and ApiKey (required, no default)
          });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('FORMATION_MISSING_PARAMETERS');
        expect(Array.isArray(res.body.error.meta.details)).toBe(true);
      });

      test('returns 400 when required parameter is provided as empty string', async () => {
        const res = await authenticatedTestClient(userToken)
          .post('/api/v1/formations')
          .send({
            project_id: projectId,
            name: `empty-params-${Date.now()}`,
            template: templateWithParams,
            parameters: {
              ToolUrl: '',
              ApiKey: '',
            },
          });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('FORMATION_MISSING_PARAMETERS');
        expect(Array.isArray(res.body.error.meta.details)).toBe(true);
        expect(
          res.body.error.meta.details.some((d: { message: string }) => {
            return d.message.includes('cannot be empty');
          })
        ).toBe(true);
      });

      test('returns 400 when only some required parameters are empty strings', async () => {
        const res = await authenticatedTestClient(userToken)
          .post('/api/v1/formations')
          .send({
            project_id: projectId,
            name: `partial-empty-params-${Date.now()}`,
            template: templateWithParams,
            parameters: {
              ToolUrl: 'https://api.example.com',
              ApiKey: '',
            },
          });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('FORMATION_MISSING_PARAMETERS');
        expect(
          res.body.error.meta.details.some((d: { path: string }) => {
            return d.path === 'parameters.ApiKey';
          })
        ).toBe(true);
      });

      test('uses parameter default when no override provided', async () => {
        const templateWithDefault = {
          parameters: {
            MemName: { type: 'string', default: 'Default Param Memory' },
          },
          resources: {
            DefaultMem: {
              type: 'memory',
              properties: { name: { param: 'MemName' } },
            },
          },
          outputs: { memoryId: { ref: 'DefaultMem' } },
        };

        const res = await authenticatedTestClient(userToken)
          .post('/api/v1/formations')
          .send({
            project_id: projectId,
            name: `default-param-${Date.now()}`,
            template: templateWithDefault,
            // No parameters provided - should use default
          });

        expect(res.status).toBe(201);
        expect(res.body.status).toBe('active');

        // Clean up
        await authenticatedTestClient(userToken).delete(
          `/api/v1/formations/${res.body.id}`
        );
      });

      // A parameter name containing an underscore (e.g. `api_token`) is the
      // conventional way to name a secret-bearing parameter. The request's
      // `parameters` map must not be case-transformed independently of the
      // `template.parameters` declaration it is keyed against, or a supplied
      // value silently fails to match and the parameter is reported missing.
      test('accepts a supplied value for a required parameter whose name contains an underscore', async () => {
        const templateWithUnderscoreParam = {
          parameters: {
            api_token: { type: 'string', description: 'API token' },
          },
          resources: {
            UnderscoreParamTool: {
              type: 'tool',
              properties: {
                name: 'underscore-param-tool',
                execute: {
                  url: 'https://example.com/endpoint',
                  headers: { Authorization: { sub: 'Bearer ${api_token}' } },
                },
              },
            },
          },
        };

        const res = await authenticatedTestClient(userToken)
          .post('/api/v1/formations')
          .send({
            project_id: projectId,
            name: `underscore-param-${Date.now()}`,
            template: templateWithUnderscoreParam,
            parameters: { api_token: 'secret-value' },
          });

        expect(res.status).toBe(201);
        expect(res.body.status).toBe('active');

        await authenticatedTestClient(userToken).delete(
          `/api/v1/formations/${res.body.id}`
        );
      });
    });

    describe('PUT /api/v1/formations/:formation_id', () => {
      test('updates formation with new parameter values', async () => {
        const updatedTemplate = {
          ...templateWithParams,
          resources: {
            ParamMemory: {
              type: 'memory',
              properties: { name: { param: 'MemoryName' } },
            },
          },
        };

        const res = await authenticatedTestClient(userToken)
          .put(`/api/v1/formations/${paramFormationId}`)
          .send({
            template: updatedTemplate,
            parameters: {
              MemoryName: 'Updated Memory Name',
              ToolUrl: 'https://api2.example.com',
              ApiKey: 'new-secret-key',
            },
          });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('active');
      });

      test('returns 400 when required parameter missing on update', async () => {
        const res = await authenticatedTestClient(userToken)
          .put(`/api/v1/formations/${paramFormationId}`)
          .send({
            template: templateWithParams,
            // Missing required params ToolUrl and ApiKey
          });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('FORMATION_MISSING_PARAMETERS');
      });

      test('returns 400 when required parameter is empty string on update', async () => {
        const res = await authenticatedTestClient(userToken)
          .put(`/api/v1/formations/${paramFormationId}`)
          .send({
            template: templateWithParams,
            parameters: {
              ToolUrl: 'https://api.example.com',
              ApiKey: '',
            },
          });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('FORMATION_MISSING_PARAMETERS');
        expect(
          res.body.error.meta.details.some((d: { message: string }) => {
            return d.message.includes('cannot be empty');
          })
        ).toBe(true);
      });
    });

    test('deletes param formation', async () => {
      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${paramFormationId}`
      );
      expect(res.status).toBe(200);
    });
  });

  // ── use_previous_value for secret parameters ──────────────────────────────

  describe('Formation parameter use_previous_value', () => {
    let secretFormationId: string;

    // XaiApiKey is declared use_previous_value: omitting it on update reuses the
    // stored secret value. An explicit value still overrides (rotation).
    const secretTemplate = {
      parameters: {
        XaiApiKey: {
          type: 'string',
          no_echo: true,
          use_previous_value: true,
          description: 'X API key stored as a secret',
        },
      },
      resources: {
        XaiKey: {
          type: 'secret',
          properties: {
            name: 'xai-api-key',
            value: { param: 'XaiApiKey' },
          },
        },
        KeepMemory: {
          type: 'memory',
          properties: { name: 'keep-mem-original' },
        },
      },
    };

    test('use_previous_value does not satisfy a required param on create', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `keep-secret-create-${Date.now()}`,
          template: secretTemplate,
          // XaiApiKey omitted; on create there is no previous value to reuse.
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('FORMATION_MISSING_PARAMETERS');
    });

    test('creates the formation supplying the secret value', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `keep-secret-${Date.now()}`,
          template: secretTemplate,
          parameters: { XaiApiKey: 'sk-original-value' },
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');
      secretFormationId = res.body.id;
    });

    test('plan-formation reports no-op for an unchanged secret with use_previous_value', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/plan')
        .send({
          project_id: projectId,
          formation_id: secretFormationId,
          template: secretTemplate,
          // XaiApiKey intentionally omitted — nothing about the secret changed.
        });

      expect(res.status).toBe(200);
      const secretChange = res.body.changes.find(
        (c: { logical_id: string }) => {
          return c.logical_id === 'XaiKey';
        }
      );
      expect(secretChange).toBeDefined();
      expect(secretChange.action).toBe('no-op');
      expect(secretChange.diff.desired).toEqual({ name: 'xai-api-key' });
      expect(secretChange.diff.current).toEqual({ name: 'xai-api-key' });
    });

    test('omitting a use_previous_value param keeps the secret untouched on update', async () => {
      const updatedTemplate = {
        ...secretTemplate,
        resources: {
          ...secretTemplate.resources,
          KeepMemory: {
            type: 'memory',
            properties: { name: 'keep-mem-updated' },
          },
        },
      };

      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${secretFormationId}`)
        .send({
          template: updatedTemplate,
          // XaiApiKey intentionally omitted — reuse the stored value.
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('active');

      // The secret resource must be a no-op (its value was not re-applied),
      // while the memory resource is updated.
      const eventsRes = await authenticatedTestClient(userToken).get(
        `/api/v1/formations/${secretFormationId}/events`
      );
      expect(eventsRes.status).toBe(200);
      const updateOp = eventsRes.body.data.find(
        (op: { operation_type: string }) => {
          return op.operation_type === 'update';
        }
      );
      expect(updateOp).toBeDefined();
      const secretEvent = updateOp.events.find((e: { logical_id: string }) => {
        return e.logical_id === 'XaiKey';
      });
      expect(secretEvent.action).toBe('no-op');
      const memoryEvent = updateOp.events.find((e: { logical_id: string }) => {
        return e.logical_id === 'KeepMemory';
      });
      expect(memoryEvent.action).toBe('update');
    });

    test('supplying a value still overrides use_previous_value (rotates the secret)', async () => {
      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${secretFormationId}`)
        .send({
          template: secretTemplate,
          parameters: { XaiApiKey: 'sk-rotated-value' },
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('active');

      const eventsRes = await authenticatedTestClient(userToken).get(
        `/api/v1/formations/${secretFormationId}/events`
      );
      const updateOps = eventsRes.body.data.filter(
        (op: { operation_type: string }) => {
          return op.operation_type === 'update';
        }
      );
      const latest = updateOps[updateOps.length - 1];
      const secretEvent = latest.events.find((e: { logical_id: string }) => {
        return e.logical_id === 'XaiKey';
      });
      expect(secretEvent.action).toBe('update');
    });

    test('still returns 400 when a required param without use_previous_value is omitted on update', async () => {
      const requiredTemplate = {
        parameters: { ToolUrl: { type: 'string' } },
        resources: {
          OnlyTool: {
            type: 'tool',
            properties: {
              name: 'req-tool',
              execute: { url: { sub: '${ToolUrl}/x' } },
            },
          },
        },
      };

      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${secretFormationId}`)
        .send({
          template: requiredTemplate,
          // ToolUrl neither supplied nor declared use_previous_value.
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('FORMATION_MISSING_PARAMETERS');
    });

    test('deletes the secret formation', async () => {
      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${secretFormationId}`
      );
      expect(res.status).toBe(200);
    });
  });

  // ── tool resource type ───────────────────────────────────────────────

  describe('Formation with tool resources', () => {
    let agentToolFormationId: string;

    const agentToolTemplate = {
      resources: {
        MyTool: {
          type: 'tool',
          properties: {
            name: 'my-http-tool',
            type: 'http',
            description: 'A simple HTTP tool',
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Search query' },
              },
              required: ['query'],
            },
            execute: {
              url: 'https://api.example.com/search',
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
            },
          },
        },
      },
    };

    test('creates a formation with a tool resource', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `agent-tool-formation-${Date.now()}`,
          template: agentToolTemplate,
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');
      expect(res.body.resources).toHaveLength(1);
      expect(res.body.resources[0].logical_id).toBe('MyTool');
      expect(res.body.resources[0].status).toBe('created');
      expect(res.body.resources[0].physical_resource_id).toBeDefined();
      expect(res.body.resources[0].physical_resource_id).toMatch(/^tool_/);

      agentToolFormationId = res.body.id;
    });

    test('plan reports no-op for an unchanged tool resource', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/plan')
        .send({
          project_id: projectId,
          formation_id: agentToolFormationId,
          template: agentToolTemplate,
        });

      expect(res.status).toBe(200);
      const toolChange = res.body.changes.find((c: { logical_id: string }) => {
        return c.logical_id === 'MyTool';
      });
      expect(toolChange).toBeDefined();
      expect(toolChange.action).toBe('no-op');
      expect(toolChange.diff).toBeDefined();
      expect(toolChange.diff.desired.name).toBe('my-http-tool');
      expect(toolChange.diff.current.name).toBe('my-http-tool');
    });

    test('updates the tool resource in the formation', async () => {
      const updatedTemplate = {
        resources: {
          MyTool: {
            type: 'tool',
            properties: {
              name: 'my-http-tool-updated',
              description: 'Updated description',
              execute: {
                url: 'https://api.example.com/v2/search',
                method: 'GET',
              },
            },
          },
        },
      };

      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${agentToolFormationId}`)
        .send({ template: updatedTemplate });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('active');
      const toolResource = res.body.resources.find(
        (r: { logical_id: string }) => {
          return r.logical_id === 'MyTool';
        }
      );
      expect(toolResource).toBeDefined();
      expect(toolResource.status).toBe('updated');
    });

    // #945 item 3: a template can declare the per-tool context allowlist, and
    // the read-back view reports it (no explicit `read` — the schema field is
    // picked up from the lib mapper).
    test('applies a tool resource declaring context_keys and reads it back', async () => {
      const template = {
        resources: {
          ScopedTool: {
            type: 'tool',
            properties: {
              name: 'formation-scoped-tool',
              type: 'http',
              execute: { url: 'https://api.example.com/scoped' },
              context_keys: ['ocaToken'],
            },
          },
        },
      };

      const created = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `ctx-keys-formation-${Date.now()}`,
          template,
        });
      expect(created.status).toBe(201);
      expect(created.body.status).toBe('active');

      const plan = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/plan')
        .send({
          project_id: projectId,
          formation_id: created.body.id,
          template,
        });
      expect(plan.status).toBe(200);
      const change = plan.body.changes.find((c: { logical_id: string }) => {
        return c.logical_id === 'ScopedTool';
      });
      expect(change.action).toBe('no-op');
      expect(change.diff.current.context_keys).toEqual(['ocaToken']);
    });

    test('rejects a tool resource whose context_keys entry is not a valid key', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `ctx-keys-bad-formation-${Date.now()}`,
          template: {
            resources: {
              BadScopedTool: {
                type: 'tool',
                properties: {
                  name: 'formation-bad-scoped-tool',
                  type: 'http',
                  execute: { url: 'https://api.example.com/scoped' },
                  context_keys: ['oca Token'],
                },
              },
            },
          },
        });

      expect(res.status).toBe(400);
    });

    test('validates template with tool missing required name', async () => {
      const invalidToolTemplate = {
        resources: {
          BadTool: {
            type: 'tool',
            properties: {
              description: 'missing name',
            },
          },
        },
      };

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/validate')
        .send({ template: invalidToolTemplate });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.errors.length).toBeGreaterThan(0);
    });

    test('validate reports a pipeline step whose inline tool is missing a name', async () => {
      const template = {
        resources: {
          MyPipeline: {
            type: 'tool',
            properties: {
              name: 'pipeline-inline-no-name',
              type: 'pipeline',
              pipeline: {
                steps: [
                  {
                    id: 'strapiCreate',
                    tool: {
                      type: 'http',
                      execute: { url: 'https://example.com', method: 'POST' },
                    },
                  },
                ],
              },
            },
          },
        },
      };
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/validate')
        .send({ template });

      expect(res.status).toBe(200);
      // The missing `name` must be caught at validate time, not surface only
      // at deploy.
      expect(res.body.valid).toBe(false);
      expect(res.body.errors).toContainEqual(
        expect.objectContaining({
          path: 'resources.MyPipeline.properties.pipeline',
          message: expect.stringMatching(
            /inline tool must be an object with a name/i
          ),
        })
      );
    });

    test('creates formation with mcp tool type', async () => {
      const mcpTemplate = {
        resources: {
          MyMcpTool: {
            type: 'tool',
            properties: {
              name: 'my-mcp-tool',
              type: 'mcp',
              mcp: {
                url: 'https://mcp.example.com/sse',
                headers: { Authorization: 'Bearer token' },
              },
            },
          },
        },
      };

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `mcp-tool-formation-${Date.now()}`,
          template: mcpTemplate,
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');
      expect(res.body.resources[0].logical_id).toBe('MyMcpTool');
      expect(res.body.resources[0].status).toBe('created');

      // Clean up
      await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${res.body.id}`
      );
    });

    const pipelineRefTemplate = {
      resources: {
        GetTruth: {
          type: 'tool',
          properties: {
            name: 'get-truth',
            type: 'http',
            execute: { url: 'https://api.example.com/truth', method: 'GET' },
          },
        },
        MyPipeline: {
          type: 'tool',
          properties: {
            name: 'my-pipeline-with-ref',
            type: 'pipeline',
            pipeline: {
              steps: [{ id: 'fetchTruth', tool_id: { ref: 'GetTruth' } }],
            },
          },
        },
      },
    };

    test('validates a pipeline step tool_id that is a { ref } to another resource', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/validate')
        .send({ template: pipelineRefTemplate });

      expect(res.status).toBe(200);
      // A `{ ref: ResourceName }` tool_id is a valid formation reference, not a
      // malformed step — it is resolved to the physical tool id at deploy time.
      expect(res.body.valid).toBe(true);
      expect(res.body.errors).toEqual([]);
    });

    test('deploys a pipeline whose step tool_id is a { ref }, resolving it to the physical id', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `pipeline-ref-formation-${Date.now()}`,
          template: pipelineRefTemplate,
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');

      const truth = res.body.resources.find((r: { logical_id: string }) => {
        return r.logical_id === 'GetTruth';
      });
      const pipeline = res.body.resources.find((r: { logical_id: string }) => {
        return r.logical_id === 'MyPipeline';
      });
      // Both resources deploy successfully. The pipeline reaching `created`
      // proves the ref resolved: an unresolved `{ ref }` tool_id would make
      // `createTool` → `validatePipelineConfig` reject the step, failing the
      // resource instead.
      expect(truth.status).toBe('created');
      expect(truth.physical_resource_id).toMatch(/^tool_/);
      expect(pipeline.status).toBe('created');
      expect(pipeline.physical_resource_id).toMatch(/^tool_/);

      await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${res.body.id}`
      );
    });

    test('deletes formation and cleans up tool resource', async () => {
      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${agentToolFormationId}`
      );
      expect(res.status).toBe(200);
    });

    test('deleted tool formation no longer found', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/formations/${agentToolFormationId}`
      );
      expect(res.status).toBe(404);
    });
  });

  // ── ai_provider resource type ──────────────────────────────────────────────

  describe('Formation with ai_provider resources', () => {
    let aiProviderFormationId: string;

    const aiProviderTemplate = {
      resources: {
        MyProvider: {
          type: 'ai_provider',
          properties: {
            name: 'my-openai-provider',
            provider: 'openai',
            default_model: 'gpt-4o',
          },
        },
      },
    };

    test('creates a formation with an ai_provider resource', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `ai-provider-formation-${Date.now()}`,
          template: aiProviderTemplate,
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');
      expect(res.body.resources).toHaveLength(1);
      expect(res.body.resources[0].logical_id).toBe('MyProvider');
      expect(res.body.resources[0].status).toBe('created');
      expect(res.body.resources[0].physical_resource_id).toBeDefined();
      expect(res.body.resources[0].physical_resource_id).toMatch(/^aip_/);

      aiProviderFormationId = res.body.id;
    });

    test('updates the ai_provider resource in the formation', async () => {
      const updatedTemplate = {
        resources: {
          MyProvider: {
            type: 'ai_provider',
            properties: {
              name: 'my-openai-provider-updated',
              provider: 'openai',
              default_model: 'gpt-4o-mini',
              base_url: 'https://custom.openai.example.com/v1',
            },
          },
        },
      };

      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${aiProviderFormationId}`)
        .send({ template: updatedTemplate });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('active');
      const providerResource = res.body.resources.find(
        (r: { logical_id: string }) => {
          return r.logical_id === 'MyProvider';
        }
      );
      expect(providerResource).toBeDefined();
      expect(providerResource.status).toBe('updated');
    });

    test('validates template with ai_provider missing required fields', async () => {
      const invalidTemplate = {
        resources: {
          BadProvider: {
            type: 'ai_provider',
            properties: {
              name: 'incomplete-provider',
              // missing provider and default_model
            },
          },
        },
      };

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/validate')
        .send({ template: invalidTemplate });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.errors.length).toBeGreaterThan(0);
    });

    test('updates the ai_provider resource with an explicit null secret_id', async () => {
      const updatedTemplate = {
        resources: {
          MyProvider: {
            type: 'ai_provider',
            properties: {
              name: 'my-openai-provider-no-secret',
              provider: 'openai',
              default_model: 'gpt-4o-mini',
              secret_id: null,
            },
          },
        },
      };

      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${aiProviderFormationId}`)
        .send({ template: updatedTemplate });

      expect(res.status).toBe(200);
      const providerResource = res.body.resources.find(
        (r: { logical_id: string }) => {
          return r.logical_id === 'MyProvider';
        }
      );
      expect(providerResource).toBeDefined();
      expect(providerResource.status).toBe('updated');
    });

    test('deletes formation and cleans up ai_provider resource', async () => {
      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${aiProviderFormationId}`
      );
      expect(res.status).toBe(200);
    });

    test('deleted ai_provider formation no longer found', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/formations/${aiProviderFormationId}`
      );
      expect(res.status).toBe(404);
    });
  });

  // ── orchestration resource type (agent squad) ─────────────────────────────

  describe('Formation with orchestration resources (agent squad)', () => {
    test('deploys an agent squad: an agent + an orchestration wired by ref', async () => {
      const squadTemplate = {
        resources: {
          SquadProvider: {
            type: 'ai_provider',
            properties: {
              name: 'squad-provider',
              provider: 'openai',
              default_model: 'gpt-4o',
            },
          },
          SquadAgent: {
            type: 'agent',
            properties: {
              name: 'Squad Writer',
              ai_provider_id: { ref: 'SquadProvider' },
              instructions: 'Write a draft.',
            },
          },
          SquadFlow: {
            type: 'orchestration',
            properties: {
              name: 'squad-flow',
              input_schema: {
                type: 'object',
                properties: { topic: { type: 'string' } },
              },
              nodes: [
                {
                  id: 'write',
                  type: 'agent',
                  agent_id: { ref: 'SquadAgent' },
                  input_mapping: { prompt: { var: 'input.topic' } },
                  state_mapping: { 'state.draft': { var: 'output.content' } },
                },
              ],
              edges: [],
            },
          },
        },
        outputs: { orchestrationId: { ref: 'SquadFlow' } },
      };

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `squad-formation-${Date.now()}`,
          template: squadTemplate,
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');

      const findResource = (logicalId: string) => {
        return res.body.resources.find((r: { logical_id: string }) => {
          return r.logical_id === logicalId;
        });
      };
      const agentResource = findResource('SquadAgent');
      const orchResource = findResource('SquadFlow');

      expect(agentResource.status).toBe('created');
      expect(agentResource.physical_resource_id).toMatch(/^agent_/);
      expect(orchResource.status).toBe('created');
      expect(orchResource.physical_resource_id).toMatch(/^orch_/);

      // The `{ ref: SquadAgent }` nested inside the orchestration node must have
      // been resolved to the physical agent id and stored in camelCase form for
      // the engine to read.
      const orchRow = await db.Orchestration.findOne({
        where: { publicId: orchResource.physical_resource_id },
      });
      const nodes = orchRow?.nodes as Array<{ id: string; agentId: string }>;
      expect(nodes).toHaveLength(1);
      expect(nodes[0].agentId).toBe(agentResource.physical_resource_id);

      // Cleanup tears down all three resources in reverse dependency order.
      const del = await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${res.body.id}`
      );
      expect(del.status).toBe(200);
    });

    test('rejects a squad template whose orchestration graph is invalid', async () => {
      // A cyclic graph with no loop node must fail orchestration validation at
      // apply time, marking the orchestration resource failed.
      const badTemplate = {
        resources: {
          BadFlow: {
            type: 'orchestration',
            properties: {
              name: 'bad-flow',
              nodes: [
                { id: 'a', type: 'transform', expression: 1 },
                { id: 'b', type: 'transform', expression: 1 },
              ],
              edges: [
                { from: 'a', to: 'b' },
                { from: 'b', to: 'a' },
              ],
            },
          },
        },
      };

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `bad-squad-formation-${Date.now()}`,
          template: badTemplate,
        });

      // The formation is created but the orchestration resource fails to apply.
      expect(res.status).toBe(201);
      const badResource = res.body.resources.find(
        (r: { logical_id: string }) => {
          return r.logical_id === 'BadFlow';
        }
      );
      expect(badResource.status).toBe('failed');

      await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${res.body.id}`
      );
    });
  });

  // ── document resource type ────────────────────────────────────────────────

  describe('Formation with document resources', () => {
    let documentFormationId: string;

    const documentTemplate = {
      resources: {
        MyDoc: {
          type: 'document',
          properties: {
            content: 'Hello from formation document',
          },
        },
      },
    };

    test('creates a formation with a document resource', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `document-formation-${Date.now()}`,
          template: documentTemplate,
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');
      expect(res.body.resources).toHaveLength(1);
      expect(res.body.resources[0].logical_id).toBe('MyDoc');
      expect(res.body.resources[0].status).toBe('created');
      expect(res.body.resources[0].physical_resource_id).toBeDefined();
      expect(res.body.resources[0].physical_resource_id).toMatch(/^doc_/);

      documentFormationId = res.body.id;
    });

    test('updating a formation document with new content applies the change', async () => {
      const updatedTemplate = {
        resources: {
          MyDoc: {
            type: 'document',
            properties: {
              content: 'Updated content (now applied)',
            },
          },
        },
      };

      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${documentFormationId}`)
        .send({ template: updatedTemplate });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('active');
      const docResource = res.body.resources.find(
        (r: { logical_id: string }) => {
          return r.logical_id === 'MyDoc';
        }
      );
      expect(docResource).toBeDefined();
      // Documents are no longer immutable on update: the changed content is a
      // real diff, so the resource is updated (not a no-op).
      expect(docResource.status).toBe('updated');

      // Restore the original content so the subsequent no-op plan test — which
      // plans against `documentTemplate` — sees an unchanged resource.
      const restore = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${documentFormationId}`)
        .send({ template: documentTemplate });
      expect(restore.status).toBe(200);
      const restoredDoc = restore.body.resources.find(
        (r: { logical_id: string }) => {
          return r.logical_id === 'MyDoc';
        }
      );
      expect(restoredDoc.status).toBe('updated');
    });

    test('validates template with document missing required content', async () => {
      const invalidTemplate = {
        resources: {
          BadDoc: {
            type: 'document',
            properties: {
              title: 'Missing content field',
            },
          },
        },
      };

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/validate')
        .send({ template: invalidTemplate });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.errors.length).toBeGreaterThan(0);
    });

    test('validates template with document properties that are not an object', async () => {
      const invalidTemplate = {
        resources: {
          BadDoc: {
            type: 'document',
            properties: 'not-an-object',
          },
        },
      };

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/validate')
        .send({ template: invalidTemplate });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining(
              'Document `properties` must be an object'
            ),
          }),
        ])
      );
    });

    test('plan reports no-op for an unchanged document resource', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/plan')
        .send({
          project_id: projectId,
          formation_id: documentFormationId,
          template: documentTemplate,
        });

      expect(res.status).toBe(200);
      const docChange = res.body.changes.find((c: { logical_id: string }) => {
        return c.logical_id === 'MyDoc';
      });
      expect(docChange).toBeDefined();
      expect(docChange.action).toBe('no-op');
    });

    test('plan reports update when the underlying document was deleted externally', async () => {
      const getRes = await authenticatedTestClient(userToken).get(
        `/api/v1/formations/${documentFormationId}`
      );
      const physicalDocumentId = getRes.body.resources.find(
        (r: { logical_id: string }) => {
          return r.logical_id === 'MyDoc';
        }
      ).physical_resource_id;

      const deleteRes = await authenticatedTestClient(userToken).delete(
        `/api/v1/documents/${physicalDocumentId}`
      );
      expect(deleteRes.status).toBe(204);

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/plan')
        .send({
          project_id: projectId,
          formation_id: documentFormationId,
          template: documentTemplate,
        });

      expect(res.status).toBe(200);
      const docChange = res.body.changes.find((c: { logical_id: string }) => {
        return c.logical_id === 'MyDoc';
      });
      expect(docChange).toBeDefined();
      expect(docChange.action).toBe('update');
    });

    test('deletes formation and cleans up document resource', async () => {
      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${documentFormationId}`
      );
      expect(res.status).toBe(200);
    });

    test('deleted document formation no longer found', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/formations/${documentFormationId}`
      );
      expect(res.status).toBe(404);
    });
  });

  // ── memory_entry resource type ────────────────────────────────────────────

  describe('Formation with memory_entry resources', () => {
    let memoryEntryFormationId: string;
    let standaloneMemoryId: string;

    beforeAll(async () => {
      // Create a standalone memory to use as the container for memory entries
      const memRes = await authenticatedTestClient(userToken)
        .post('/api/v1/memories')
        .send({
          project_id: projectId,
          name: `formation-me-container-${Date.now()}`,
        });
      expect(memRes.status).toBe(201);
      standaloneMemoryId = memRes.body.id;
    });

    test('creates a formation with a memory_entry resource', async () => {
      const template = {
        resources: {
          MyEntry: {
            type: 'memory_entry',
            properties: {
              memory_id: standaloneMemoryId,
              content: 'Initial entry content from formation',
            },
          },
        },
      };

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `memory-entry-formation-${Date.now()}`,
          template,
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');
      expect(res.body.resources).toHaveLength(1);
      expect(res.body.resources[0].logical_id).toBe('MyEntry');
      expect(res.body.resources[0].status).toBe('created');
      expect(res.body.resources[0].physical_resource_id).toBeDefined();
      expect(res.body.resources[0].physical_resource_id).toMatch(/^mem_entry_/);

      memoryEntryFormationId = res.body.id;
    });

    test('creates, updates, and clears memory_entry tags/metadata via formation', async () => {
      const makeTemplate = (props: Record<string, unknown>) => {
        return {
          resources: {
            TaggedEntry: {
              type: 'memory_entry',
              properties: { memory_id: standaloneMemoryId, ...props },
            },
          },
        };
      };

      // Create with tags + metadata.
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `memory-entry-tags-formation-${Date.now()}`,
          template: makeTemplate({
            content: 'Tagged entry from formation',
            tags: ['role:pilot', 'source:formation'],
            metadata: { origin: 'formation' },
          }),
        });

      expect(createRes.status).toBe(201);
      const formationId = createRes.body.id;
      const physicalId = createRes.body.resources[0].physical_resource_id;

      const created = await db.MemoryEntry.findOne({
        where: { publicId: physicalId },
      });
      expect(created!.tags).toEqual(['role:pilot', 'source:formation']);
      expect(created!.metadata).toEqual({ origin: 'formation' });

      // Update to new tags + metadata.
      const updateRes = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${formationId}`)
        .send({
          template: makeTemplate({
            content: 'Tagged entry from formation',
            tags: ['role:copilot'],
            metadata: { origin: 'formation-update' },
          }),
        });
      expect(updateRes.status).toBe(200);
      await created!.reload();
      expect(created!.tags).toEqual(['role:copilot']);
      expect(created!.metadata).toEqual({ origin: 'formation-update' });

      // Clear both via explicit null (nullable formation properties).
      const clearRes = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${formationId}`)
        .send({
          template: makeTemplate({
            content: 'Tagged entry from formation',
            tags: null,
            metadata: null,
          }),
        });
      expect(clearRes.status).toBe(200);
      await created!.reload();
      expect(created!.tags).toBeNull();
      expect(created!.metadata).toBeNull();
    });

    test('plan reports no-op for an unchanged memory_entry resource', async () => {
      const template = {
        resources: {
          MyEntry: {
            type: 'memory_entry',
            properties: {
              memory_id: standaloneMemoryId,
              content: 'Initial entry content from formation',
            },
          },
        },
      };

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/plan')
        .send({
          project_id: projectId,
          formation_id: memoryEntryFormationId,
          template,
        });

      expect(res.status).toBe(200);
      const entryChange = res.body.changes.find((c: { logical_id: string }) => {
        return c.logical_id === 'MyEntry';
      });
      expect(entryChange).toBeDefined();
      expect(entryChange.action).toBe('no-op');
    });

    test('updates the memory_entry content in the formation', async () => {
      const updatedTemplate = {
        resources: {
          MyEntry: {
            type: 'memory_entry',
            properties: {
              memory_id: standaloneMemoryId,
              content: 'Updated entry content from formation',
            },
          },
        },
      };

      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${memoryEntryFormationId}`)
        .send({ template: updatedTemplate });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('active');
      const entryResource = res.body.resources.find(
        (r: { logical_id: string }) => {
          return r.logical_id === 'MyEntry';
        }
      );
      expect(entryResource).toBeDefined();
      expect(entryResource.status).toBe('updated');
    });

    test('plan reports update when the underlying memory_entry was deleted externally', async () => {
      const getRes = await authenticatedTestClient(userToken).get(
        `/api/v1/formations/${memoryEntryFormationId}`
      );
      const physicalEntryId = getRes.body.resources.find(
        (r: { logical_id: string }) => {
          return r.logical_id === 'MyEntry';
        }
      ).physical_resource_id;

      const deleteRes = await authenticatedTestClient(userToken).delete(
        `/api/v1/memory-entries/${physicalEntryId}`
      );
      expect(deleteRes.status).toBe(204);

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/plan')
        .send({
          project_id: projectId,
          formation_id: memoryEntryFormationId,
          template: {
            resources: {
              MyEntry: {
                type: 'memory_entry',
                properties: {
                  memory_id: standaloneMemoryId,
                  content: 'Updated entry content from formation',
                },
              },
            },
          },
        });

      expect(res.status).toBe(200);
      const entryChange = res.body.changes.find((c: { logical_id: string }) => {
        return c.logical_id === 'MyEntry';
      });
      expect(entryChange).toBeDefined();
      expect(entryChange.action).toBe('update');
    });

    test('validates template with memory_entry missing required fields', async () => {
      const invalidTemplate = {
        resources: {
          BadEntry: {
            type: 'memory_entry',
            properties: {
              // missing memory_id and content
            },
          },
        },
      };

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/validate')
        .send({ template: invalidTemplate });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.errors.length).toBeGreaterThan(0);
    });

    test('deletes formation and cleans up memory_entry resource', async () => {
      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${memoryEntryFormationId}`
      );
      expect(res.status).toBe(200);
    });

    test('deleted memory_entry formation no longer found', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/formations/${memoryEntryFormationId}`
      );
      expect(res.status).toBe(404);
    });
  });

  // ── api_key resource type ─────────────────────────────────────────────────

  describe('Formation with project_price resources', () => {
    let priceFormationId: string;
    const priceProps = {
      provider: 'openai',
      model: 'gpt-4o-formation',
      component: 'output_tokens',
      unit: 'token',
      unit_price: 0.00001,
    };

    test('deploys a project_price and seeds a project-scoped price row', async () => {
      const template = {
        resources: {
          OutputPrice: { type: 'project_price', properties: priceProps },
        },
      };

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `project-price-formation-${Date.now()}`,
          template,
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');
      expect(res.body.resources).toHaveLength(1);
      expect(res.body.resources[0].logical_id).toBe('OutputPrice');
      expect(res.body.resources[0].status).toBe('created');
      expect(res.body.resources[0].physical_resource_id).toMatch(/^price_/);

      priceFormationId = res.body.id;

      // The deployed price is queryable at the project + provider-slug tier —
      // the whole point of the resource: cost is billing-grade with no manual
      // out-of-band pricing step.
      const priceRes = await authenticatedTestClient(adminToken).get(
        `/api/v1/projects/${projectId}/prices`
      );
      expect(priceRes.status).toBe(200);
      const seeded = priceRes.body.prices.find(
        (p: { model: string; component: string }) => {
          return (
            p.model === 'gpt-4o-formation' && p.component === 'output_tokens'
          );
        }
      );
      expect(seeded).toBeDefined();
      expect(seeded.unit_price).toBe(0.00001);
      expect(seeded.project_id).toBe(projectId);
    });

    test('plan reports no-op for an unchanged project_price (drift-safe read)', async () => {
      const template = {
        resources: {
          OutputPrice: { type: 'project_price', properties: priceProps },
        },
      };

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/plan')
        .send({
          project_id: projectId,
          formation_id: priceFormationId,
          template,
        });

      expect(res.status).toBe(200);
      const change = res.body.changes.find((c: { logical_id: string }) => {
        return c.logical_id === 'OutputPrice';
      });
      expect(change).toBeDefined();
      expect(change.action).toBe('no-op');
    });

    test('updates the project_price unit_price in place', async () => {
      const template = {
        resources: {
          OutputPrice: {
            type: 'project_price',
            properties: { ...priceProps, unit_price: 0.00005 },
          },
        },
      };

      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${priceFormationId}`)
        .send({ template });

      expect(res.status).toBe(200);

      const priceRes = await authenticatedTestClient(adminToken).get(
        `/api/v1/projects/${projectId}/prices`
      );
      const updated = priceRes.body.prices.find(
        (p: { model: string; component: string }) => {
          return (
            p.model === 'gpt-4o-formation' && p.component === 'output_tokens'
          );
        }
      );
      expect(updated.unit_price).toBe(0.00005);
    });

    test('validates template with project_price missing required fields', async () => {
      const invalidTemplate = {
        resources: {
          BadPrice: {
            type: 'project_price',
            properties: { provider: 'openai' },
          },
        },
      };

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/validate')
        .send({ template: invalidTemplate });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.errors.length).toBeGreaterThan(0);
    });

    test('deletes formation and cleans up the project_price row', async () => {
      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${priceFormationId}`
      );
      expect(res.status).toBe(200);

      const priceRes = await authenticatedTestClient(adminToken).get(
        `/api/v1/projects/${projectId}/prices`
      );
      const gone = priceRes.body.prices.find((p: { model: string }) => {
        return p.model === 'gpt-4o-formation';
      });
      expect(gone).toBeUndefined();
    });
  });

  describe('Formation with api_key resources', () => {
    let apiKeyFormationId: string;

    const apiKeyTemplate = {
      resources: {
        MyKey: {
          type: 'api_key',
          properties: {
            name: 'formation-api-key',
          },
        },
      },
    };

    test('creates a formation with an api_key resource', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `api-key-formation-${Date.now()}`,
          template: apiKeyTemplate,
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');
      expect(res.body.resources).toHaveLength(1);
      expect(res.body.resources[0].logical_id).toBe('MyKey');
      expect(res.body.resources[0].status).toBe('created');
      expect(res.body.resources[0].physical_resource_id).toBeDefined();

      apiKeyFormationId = res.body.id;
    });

    test('updates the api_key name in the formation', async () => {
      const updatedTemplate = {
        resources: {
          MyKey: {
            type: 'api_key',
            properties: {
              name: 'formation-api-key-updated',
            },
          },
        },
      };

      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${apiKeyFormationId}`)
        .send({ template: updatedTemplate });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('active');
      const keyResource = res.body.resources.find(
        (r: { logical_id: string }) => {
          return r.logical_id === 'MyKey';
        }
      );
      expect(keyResource).toBeDefined();
      expect(keyResource.status).toBe('updated');
    });

    test('validates template with api_key missing required name', async () => {
      const invalidTemplate = {
        resources: {
          BadKey: {
            type: 'api_key',
            properties: {
              // missing name
            },
          },
        },
      };

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/validate')
        .send({ template: invalidTemplate });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.errors.length).toBeGreaterThan(0);
    });

    test('deletes formation and cleans up api_key resource', async () => {
      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${apiKeyFormationId}`
      );
      expect(res.status).toBe(200);
    });

    test('deleted api_key formation no longer found', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/formations/${apiKeyFormationId}`
      );
      expect(res.status).toBe(404);
    });
  });

  // ── guardrail resource type ──────────────────────────────────────────────

  describe('Formation with guardrail resources', () => {
    let guardrailFormationId: string;

    const guardrailTemplate = {
      resources: {
        ContextTool: {
          type: 'tool',
          properties: {
            name: 'guardrail-context-tool',
            type: 'soat',
            actions: ['list-tools'],
          },
        },
        BudgetGuardrail: {
          type: 'guardrail',
          properties: {
            name: 'formation-guardrail',
            class: 'B',
            default_class: 'C',
            guard: { '<': [{ var: 'soat.usage.cost_usd_24h' }, 1000] },
            context_tool_id: { ref: 'ContextTool' },
            context_mode: 'merge',
          },
        },
      },
    };

    test('validates a template declaring a guardrail resource', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/validate')
        .send({ template: guardrailTemplate });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.errors).toEqual([]);
    });

    test('rejects a guardrail with an invalid class literal', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/validate')
        .send({
          template: {
            resources: {
              BadGuardrail: {
                type: 'guardrail',
                properties: { name: 'bad-guardrail', class: 'Z' },
              },
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.errors.length).toBeGreaterThan(0);
    });

    test('creates a formation with a guardrail resource, resolving the context_tool_id ref', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `guardrail-formation-${Date.now()}`,
          template: guardrailTemplate,
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');

      const tool = res.body.resources.find((r: { logical_id: string }) => {
        return r.logical_id === 'ContextTool';
      });
      const guardrail = res.body.resources.find((r: { logical_id: string }) => {
        return r.logical_id === 'BudgetGuardrail';
      });
      expect(tool.status).toBe('created');
      expect(tool.physical_resource_id).toMatch(/^tool_/);
      expect(guardrail.status).toBe('created');
      expect(guardrail.physical_resource_id).toMatch(/^guard_/);

      const guardrailRes = await authenticatedTestClient(userToken).get(
        `/api/v1/guardrails/${guardrail.physical_resource_id}`
      );
      expect(guardrailRes.status).toBe(200);
      expect(guardrailRes.body.context_tool_id).toBe(tool.physical_resource_id);

      guardrailFormationId = res.body.id;
    });

    test('updates the guardrail class in the formation', async () => {
      const updatedTemplate = {
        resources: {
          ...guardrailTemplate.resources,
          BudgetGuardrail: {
            type: 'guardrail',
            properties: {
              name: 'formation-guardrail',
              class: 'C',
            },
          },
        },
      };

      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${guardrailFormationId}`)
        .send({ template: updatedTemplate });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('active');
      const guardrailResource = res.body.resources.find(
        (r: { logical_id: string }) => {
          return r.logical_id === 'BudgetGuardrail';
        }
      );
      expect(guardrailResource.status).toBe('updated');
    });

    test('deletes formation and cleans up guardrail resource', async () => {
      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${guardrailFormationId}`
      );
      expect(res.status).toBe(200);
    });

    test('deleted guardrail formation no longer found', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/formations/${guardrailFormationId}`
      );
      expect(res.status).toBe(404);
    });
  });

  // ── secret resource: lastAppliedProperties must not store plaintext value ──

  describe('Formation with secret resources (security: sanitize lastAppliedProperties)', () => {
    let secretFormationId: string;

    test('creates formation with a secret resource', async () => {
      const template = {
        resources: {
          MySecret: {
            type: 'secret',
            properties: {
              name: 'test-secret-sanitize',
              value: 'super-plaintext-value',
            },
          },
        },
      };

      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `secret-formation-${Date.now()}`,
          template,
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');
      secretFormationId = res.body.id;

      const secretResource = res.body.resources.find(
        (r: { logical_id: string }) => {
          return r.logical_id === 'MySecret';
        }
      );
      expect(secretResource).toBeDefined();
      expect(secretResource.status).toBe('created');
      expect(secretResource.physical_resource_id).toBeDefined();
    });

    test('lastAppliedProperties for secret resource does not contain plaintext value', async () => {
      const formationRow = await db.Formation.findOne({
        where: { publicId: secretFormationId },
      });
      expect(formationRow).not.toBeNull();

      const resourceRow = await db.FormationResource.findOne({
        where: {
          formationId: formationRow!.id,
          logicalId: 'MySecret',
        },
      });
      expect(resourceRow).not.toBeNull();

      const props = resourceRow!.lastAppliedProperties as Record<
        string,
        unknown
      >;
      expect(props).not.toHaveProperty('value');
      expect(props).toHaveProperty('name', 'test-secret-sanitize');
    });

    test('deletes secret formation', async () => {
      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${secretFormationId}`
      );
      expect(res.status).toBe(200);
    });
  });

  // ── agent knowledge_config extraction ───────────────────────────────

  describe('Formation agent with knowledge_config extraction', () => {
    let extractionFormationId: string;
    let extractionAgentId: string;
    let aiProviderId: string;
    let memoryId: string;

    beforeAll(async () => {
      const aiProvRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'FormationExtractionProvider',
          provider: 'ollama',
          default_model: 'llama3.2',
        });
      aiProviderId = aiProvRes.body.id;

      const memRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/memories')
        .send({ project_id: projectId, name: 'Formation Extraction Memory' });
      memoryId = memRes.body.id;
    });

    test('validate accepts knowledge_config with the extraction object form', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/validate')
        .send({
          template: {
            resources: {
              ExtractionAgent: {
                type: 'agent',
                properties: {
                  ai_provider_id: aiProviderId,
                  name: 'extraction-agent',
                  knowledge_config: {
                    write_memory_id: memoryId,
                    extraction: {
                      model: 'cheap-model',
                      prompt: 'Extract decisions only.',
                    },
                  },
                },
              },
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
    });

    test('creates an agent whose knowledge_config includes extraction', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `extraction-formation-${Date.now()}`,
          template: {
            resources: {
              ExtractionAgent: {
                type: 'agent',
                properties: {
                  ai_provider_id: aiProviderId,
                  name: 'extraction-agent',
                  knowledge_config: {
                    write_memory_id: memoryId,
                    extraction: {
                      model: 'cheap-model',
                      prompt: 'Extract decisions only.',
                    },
                  },
                },
              },
            },
          },
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');
      extractionFormationId = res.body.id;
      extractionAgentId = res.body.resources[0].physical_resource_id;
      expect(extractionAgentId).toMatch(/^agent_/);

      const agentRes = await authenticatedTestClient(adminToken).get(
        `/api/v1/agents/${extractionAgentId}`
      );
      expect(agentRes.status).toBe(200);
      expect(agentRes.body.knowledge_config.write_memory_id).toBe(memoryId);
      expect(agentRes.body.knowledge_config.extraction.model).toBe(
        'cheap-model'
      );
      expect(agentRes.body.knowledge_config.extraction.prompt).toBe(
        'Extract decisions only.'
      );
    });

    test('formation update can switch extraction to the boolean form', async () => {
      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${extractionFormationId}`)
        .send({
          template: {
            resources: {
              ExtractionAgent: {
                type: 'agent',
                properties: {
                  ai_provider_id: aiProviderId,
                  name: 'extraction-agent',
                  knowledge_config: {
                    write_memory_id: memoryId,
                    extraction: true,
                  },
                },
              },
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('active');

      const agentRes = await authenticatedTestClient(adminToken).get(
        `/api/v1/agents/${extractionAgentId}`
      );
      expect(agentRes.status).toBe(200);
      expect(agentRes.body.knowledge_config.extraction).toBe(true);
    });
  });

  // ── secret references via sub expressions ────────────────────────────────

  describe('Formation tool referencing a formation-created secret via sub', () => {
    let secretRefFormationId: string;

    const secretRefTemplate = {
      resources: {
        ApiSecret: {
          type: 'secret',
          properties: {
            name: 'formation-api-key',
            value: 'sk-live-formation-secret',
          },
        },
        ApiTool: {
          type: 'tool',
          properties: {
            name: 'formation-secret-ref-tool',
            type: 'http',
            execute: {
              url: 'https://api.example.com/convert',
              method: 'POST',
              headers: {
                Authorization: { sub: 'Bearer {{secret:${ApiSecret}}}' },
              },
            },
          },
        },
      },
    };

    test('validate accepts a sub expression referencing a resource logical id', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/formations/validate')
        .send({ template: secretRefTemplate });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
    });

    test('validate rejects a sub token that is neither a parameter nor a resource', async () => {
      const badTemplate = {
        resources: {
          ApiTool: {
            type: 'tool',
            properties: {
              name: 'bad-sub-tool',
              type: 'http',
              execute: {
                url: 'https://api.example.com/convert',
                headers: {
                  Authorization: { sub: 'Bearer {{secret:${Unknown}}}' },
                },
              },
            },
          },
        },
      };

      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/formations/validate')
        .send({ template: badTemplate });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
    });

    // #945 item 2: the formation validator shares the token rules with the REST
    // write path, so a template cannot author a tool the API would reject.
    test('validate accepts a {{context:...}} token in a tool header', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/formations/validate')
        .send({
          template: {
            resources: {
              ApiTool: {
                type: 'tool',
                properties: {
                  name: 'formation-context-header-tool',
                  type: 'http',
                  execute: {
                    url: 'https://api.example.com/convert',
                    headers: { Authorization: 'Bearer {{context:ocaToken}}' },
                  },
                },
              },
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
    });

    test('validate rejects a {{context:...}} token in a tool url', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/formations/validate')
        .send({
          template: {
            resources: {
              ApiTool: {
                type: 'tool',
                properties: {
                  name: 'formation-context-url-tool',
                  type: 'http',
                  execute: {
                    url: 'https://api.example.com/{{context:tenant}}/convert',
                  },
                },
              },
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(JSON.stringify(res.body.errors)).toMatch(/only in .*headers/i);
    });

    test('deploy resolves the sub to the secret physical id inside the header string', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `secret-ref-formation-${Date.now()}`,
          template: secretRefTemplate,
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');
      secretRefFormationId = res.body.id;

      const resources = res.body.resources as Array<{
        logical_id: string;
        physical_resource_id: string;
      }>;
      const secretResource = resources.find((r) => {
        return r.logical_id === 'ApiSecret';
      });
      const toolResource = resources.find((r) => {
        return r.logical_id === 'ApiTool';
      });
      expect(secretResource?.physical_resource_id).toMatch(/^sec_/);
      expect(toolResource?.physical_resource_id).toMatch(/^tool_/);

      const toolRes = await authenticatedTestClient(adminToken).get(
        `/api/v1/tools/${toolResource!.physical_resource_id}`
      );
      expect(toolRes.status).toBe(200);
      // The tool stores the {{secret:...}} reference with the physical secret
      // id substituted — never the decrypted value.
      expect(toolRes.body.execute.headers.Authorization).toBe(
        `Bearer {{secret:${secretResource!.physical_resource_id}}}`
      );
    });

    test('cleanup deletes the formation and its resources', async () => {
      const res = await authenticatedTestClient(adminToken).delete(
        `/api/v1/formations/${secretRefFormationId}`
      );
      expect(res.status).toBe(200);
    });
  });

  // ── Ledger tombstones: deleted resources must not be re-reported ─────────

  describe('Formation ledger does not re-report already-deleted resources', () => {
    let ledgerFormationId: string;

    const twoResourceTemplate = {
      resources: {
        KeepMemory: { type: 'memory', properties: { name: 'ledger-keep' } },
        RemoveMemory: {
          type: 'memory',
          properties: { name: 'ledger-remove' },
        },
      },
    };
    const reducedTemplate = {
      resources: {
        KeepMemory: { type: 'memory', properties: { name: 'ledger-keep' } },
      },
    };

    const findChange = (
      body: { changes: Array<{ logical_id: string; action: string }> },
      logicalId: string
    ) => {
      return body.changes.find((c) => {
        return c.logical_id === logicalId;
      });
    };

    test('creates a formation with two resources', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `ledger-formation-${Date.now()}`,
          template: twoResourceTemplate,
        });

      expect(res.status).toBe(201);
      ledgerFormationId = res.body.id;
    });

    test('plan reports the about-to-be-removed resource as a pending delete, matching what update will do', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/plan')
        .send({
          project_id: projectId,
          formation_id: ledgerFormationId,
          template: reducedTemplate,
        });

      expect(res.status).toBe(200);
      const removeChange = findChange(res.body, 'RemoveMemory');
      expect(removeChange).toBeDefined();
      expect(removeChange?.action).toBe('delete');
    });

    test('update actually deletes the removed resource', async () => {
      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${ledgerFormationId}`)
        .send({ template: reducedTemplate });

      expect(res.status).toBe(200);

      const eventsRes = await authenticatedTestClient(userToken).get(
        `/api/v1/formations/${ledgerFormationId}/events`
      );
      const updateOp = eventsRes.body.data[eventsRes.body.data.length - 1];
      const removeEvent = updateOp.events.find((e: { logical_id: string }) => {
        return e.logical_id === 'RemoveMemory';
      });
      expect(removeEvent).toBeDefined();
      expect(removeEvent.action).toBe('delete');
      expect(removeEvent.status).toBe('succeeded');
    });

    test('a no-op reconcile plan no longer mentions the already-deleted resource', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/plan')
        .send({
          project_id: projectId,
          formation_id: ledgerFormationId,
          template: reducedTemplate,
        });

      expect(res.status).toBe(200);
      expect(findChange(res.body, 'RemoveMemory')).toBeUndefined();
      const keepChange = findChange(res.body, 'KeepMemory');
      expect(keepChange).toBeDefined();
      expect(keepChange?.action).toBe('no-op');
    });

    test('re-running update-formation with the same template does not re-list the tombstoned resource', async () => {
      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${ledgerFormationId}`)
        .send({ template: reducedTemplate });

      expect(res.status).toBe(200);

      const eventsRes = await authenticatedTestClient(userToken).get(
        `/api/v1/formations/${ledgerFormationId}/events`
      );
      const latestUpdateOp =
        eventsRes.body.data[eventsRes.body.data.length - 1];
      const removeEvent = latestUpdateOp.events.find(
        (e: { logical_id: string }) => {
          return e.logical_id === 'RemoveMemory';
        }
      );
      expect(removeEvent).toBeUndefined();
    });

    test('cleans up the ledger formation', async () => {
      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${ledgerFormationId}`
      );
      expect(res.status).toBe(200);
    });
  });

  // ── Quota resource (Quotas Phase 3) ───────────────────────────────────────

  describe('quota formation resource', () => {
    const quotaTemplate = {
      resources: {
        MyQuota: {
          type: 'quota',
          properties: {
            scope: 'project',
            metric: 'cost_usd',
            window: 'calendar_month',
            limit: 25.5,
            mode: 'monitor',
          },
        },
      },
    };

    test('validates a quota resource template', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/validate')
        .send({ template: quotaTemplate });
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.errors).toHaveLength(0);
    });

    test('rejects an unknown quota field', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations/validate')
        .send({
          template: {
            resources: {
              BadQuota: {
                type: 'quota',
                properties: {
                  scope: 'project',
                  metric: 'cost_usd',
                  window: 'calendar_month',
                  limit: 10,
                  nonsense: true,
                },
              },
            },
          },
        });
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(
        res.body.errors.some((e: { message: string }) => {
          return /nonsense/.test(e.message);
        })
      ).toBe(true);
    });

    test('creates, updates, then deletes a quota through the formation lifecycle', async () => {
      const create = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `quota-formation-${Date.now()}`,
          template: quotaTemplate,
        });
      expect(create.status).toBe(201);
      expect(create.body.status).toBe('active');
      expect(create.body.resources).toHaveLength(1);
      const resource = create.body.resources[0];
      expect(resource.logical_id).toBe('MyQuota');
      expect(resource.status).toBe('created');
      const quotaId = resource.physical_resource_id as string;
      expect(quotaId).toMatch(/^quota_/);

      // The physical quota exists and reflects the template properties.
      const got = await authenticatedTestClient(userToken).get(
        `/api/v1/quotas/${quotaId}`
      );
      expect(got.status).toBe(200);
      expect(got.body.metric).toBe('cost_usd');
      expect(got.body.mode).toBe('monitor');
      expect(got.body.limit).toBe(25.5);

      // Updating the template's mutable fields (limit, mode) diffs the live
      // quota (module `read`) and applies the change (module `update`).
      const update = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${create.body.id}`)
        .send({
          template: {
            resources: {
              MyQuota: {
                type: 'quota',
                properties: {
                  scope: 'project',
                  metric: 'cost_usd',
                  window: 'calendar_month',
                  limit: 40,
                  mode: 'enforce',
                },
              },
            },
          },
        });
      expect(update.status).toBe(200);
      const afterUpdate = await authenticatedTestClient(userToken).get(
        `/api/v1/quotas/${quotaId}`
      );
      expect(afterUpdate.body.limit).toBe(40);
      expect(afterUpdate.body.mode).toBe('enforce');

      // Deleting the formation deletes the quota it provisioned.
      const del = await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${create.body.id}`
      );
      expect(del.status).toBe(200);
      const gone = await authenticatedTestClient(userToken).get(
        `/api/v1/quotas/${quotaId}`
      );
      expect(gone.status).toBe(404);
    });

    // `scope`, `metric`, and `window` are immutable after creation. Changing one
    // through the formation lifecycle must fail loudly: silently applying only
    // the mutable fields would leave the declared template and the enforced cap
    // divergent, so an operator tightening a cap would believe a limit is live
    // while the old one is still what enforces.
    test('fails a formation update that changes an immutable quota field, leaving the quota untouched', async () => {
      const create = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `quota-immutable-${Date.now()}`,
          template: quotaTemplate,
        });
      expect(create.status).toBe(201);
      const quotaId = create.body.resources[0].physical_resource_id as string;

      const update = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${create.body.id}`)
        .send({
          template: {
            resources: {
              MyQuota: {
                type: 'quota',
                properties: {
                  scope: 'project',
                  metric: 'tokens', // immutable — was cost_usd
                  window: 'rolling_1h', // immutable — was calendar_month
                  limit: 40,
                  mode: 'enforce',
                },
              },
            },
          },
        });

      // The operation must not be reported as a success.
      expect(update.status).toBe(200);
      expect(update.body.status).toBe('failed');
      // A coded failure keeps its code on the way out, so a caller can branch
      // on it without parsing the message.
      expect(update.body.error).toEqual({
        code: 'VALIDATION_FAILED',
        message: expect.stringMatching(/immutable/i),
        meta: { logical_id: 'MyQuota', resource_type: 'quota' },
      });

      // The physical quota keeps every one of its original values — including
      // the mutable ones, which must not be applied piecemeal on a failed op.
      const after = await authenticatedTestClient(userToken).get(
        `/api/v1/quotas/${quotaId}`
      );
      expect(after.status).toBe(200);
      expect(after.body.metric).toBe('cost_usd');
      expect(after.body.window).toBe('calendar_month');
      expect(after.body.scope).toBe('project');
      expect(after.body.limit).toBe(25.5);
      expect(after.body.mode).toBe('monitor');

      // The failure names the offending field so the operator can act on it.
      const events = await authenticatedTestClient(userToken).get(
        `/api/v1/formations/${create.body.id}/events`
      );
      expect(events.status).toBe(200);
      const failed = events.body.data.find((op: { status: string }) => {
        return op.status === 'failed';
      });
      expect(failed).toBeDefined();
      expect(failed.error.message).toMatch(/metric/);
      expect(failed.error.message).toMatch(/immutable/i);

      await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${create.body.id}`
      );
    });

    // Exercises the declared-`scope_ref` path: an explicit null is compared
    // against the stored ref (rather than skipped as "not supplied"), and
    // null-vs-null must read as unchanged so the update still applies.
    test('allows a formation update that restates an explicitly null scope_ref', async () => {
      const create = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `quota-null-ref-${Date.now()}`,
          template: {
            resources: {
              MyQuota: {
                type: 'quota',
                properties: {
                  scope: 'project',
                  scope_ref: null,
                  metric: 'cost_usd',
                  window: 'calendar_month',
                  limit: 10,
                  mode: 'monitor',
                },
              },
            },
          },
        });
      expect(create.status).toBe(201);
      const quotaId = create.body.resources[0].physical_resource_id as string;

      const update = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${create.body.id}`)
        .send({
          template: {
            resources: {
              MyQuota: {
                type: 'quota',
                properties: {
                  scope: 'project',
                  scope_ref: null,
                  metric: 'cost_usd',
                  window: 'calendar_month',
                  limit: 22,
                  mode: 'enforce',
                },
              },
            },
          },
        });
      expect(update.status).toBe(200);
      expect(update.body.status).toBe('active');

      const after = await authenticatedTestClient(userToken).get(
        `/api/v1/quotas/${quotaId}`
      );
      expect(after.body.scope_ref).toBeNull();
      expect(after.body.limit).toBe(22);
      expect(after.body.mode).toBe('enforce');

      await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${create.body.id}`
      );
    });

    test('allows a formation update that restates immutable quota fields unchanged', async () => {
      const create = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `quota-restate-${Date.now()}`,
          template: quotaTemplate,
        });
      expect(create.status).toBe(201);
      const quotaId = create.body.resources[0].physical_resource_id as string;

      // Same scope/metric/window as created — only limit and mode move. This is
      // the normal path: templates always carry the immutable fields, since
      // they are required on create.
      const update = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${create.body.id}`)
        .send({
          template: {
            resources: {
              MyQuota: {
                type: 'quota',
                properties: {
                  scope: 'project',
                  metric: 'cost_usd',
                  window: 'calendar_month',
                  limit: 99.5,
                  mode: 'enforce',
                },
              },
            },
          },
        });
      expect(update.status).toBe(200);
      expect(update.body.status).toBe('active');

      const after = await authenticatedTestClient(userToken).get(
        `/api/v1/quotas/${quotaId}`
      );
      expect(after.body.limit).toBe(99.5);
      expect(after.body.mode).toBe('enforce');

      await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${create.body.id}`
      );
    });
  });
  // ── Evaluations resources (the evaluations module doc) ──────────────

  describe('evaluation formation resources', () => {
    let evalAgentId: string;

    const evalTemplate = (passThreshold: number) => {
      return {
        resources: {
          Suite: {
            type: 'dataset',
            properties: { name: `formation-suite-${passThreshold}` },
          },
          Case: {
            type: 'dataset_item',
            properties: {
              dataset_id: { ref: 'Suite' },
              input: [{ role: 'user', content: 'capital of France?' }],
              expected_output: 'Paris',
            },
          },
          Regression: {
            type: 'eval',
            properties: {
              name: `formation-eval-${passThreshold}`,
              agent_id: evalAgentId,
              dataset_id: { ref: 'Suite' },
              scorers: [{ type: 'exact_match' }],
              pass_threshold: passThreshold,
            },
          },
        },
      };
    };

    beforeAll(async () => {
      const provider = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'Formations Eval Provider',
          provider: 'ollama',
          default_model: 'llama3.2',
        });
      evalAgentId = (
        await authenticatedTestClient(adminToken).post('/api/v1/agents').send({
          project_id: projectId,
          name: 'Formations Eval Agent',
          ai_provider_id: provider.body.id,
        })
      ).body.id;
    });

    test('a template provisions the dataset, its item, and the eval bound by ref', async () => {
      const create = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `eval-stack-${Date.now()}`,
          template: evalTemplate(0.8),
        });

      expect(create.status).toBe(201);
      const byLogicalId = Object.fromEntries(
        (
          create.body.resources as Array<{
            logical_id: string;
            physical_resource_id: string;
            status: string;
          }>
        ).map((resource) => {
          return [resource.logical_id, resource];
        })
      );
      expect(byLogicalId.Suite.physical_resource_id).toMatch(/^dset_/);
      expect(byLogicalId.Case.physical_resource_id).toMatch(/^dsit_/);
      expect(byLogicalId.Regression.physical_resource_id).toMatch(/^eval_/);

      const datasetId = byLogicalId.Suite.physical_resource_id;
      const evalId = byLogicalId.Regression.physical_resource_id;

      // The `ref` really resolved: both children point at the created dataset.
      const evaluation = await authenticatedTestClient(userToken).get(
        `/api/v1/evals/${evalId}`
      );
      expect(evaluation.body.dataset_id).toBe(datasetId);
      expect(evaluation.body.agent_id).toBe(evalAgentId);
      expect(evaluation.body.pass_threshold).toBe(0.8);

      const items = await authenticatedTestClient(userToken).get(
        `/api/v1/datasets/${datasetId}/items`
      );
      expect(items.body.total).toBe(1);
      expect(items.body.data[0].expected_output).toBe('Paris');

      // Changing the gate updates the eval in place — same physical id.
      const update = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${create.body.id}`)
        .send({
          template: {
            resources: {
              ...evalTemplate(0.8).resources,
              Regression: {
                type: 'eval',
                properties: {
                  name: 'formation-eval-0.8',
                  agent_id: evalAgentId,
                  dataset_id: { ref: 'Suite' },
                  scorers: [{ type: 'exact_match' }],
                  pass_threshold: 0.5,
                },
              },
            },
          },
        });
      expect(update.status).toBe(200);
      const updatedEval = await authenticatedTestClient(userToken).get(
        `/api/v1/evals/${evalId}`
      );
      expect(updatedEval.status).toBe(200);
      expect(updatedEval.body.pass_threshold).toBe(0.5);

      // Removing the eval from the template deletes it, leaving the fixtures.
      const removed = await authenticatedTestClient(userToken)
        .put(`/api/v1/formations/${create.body.id}`)
        .send({
          template: {
            resources: {
              Suite: evalTemplate(0.8).resources.Suite,
              Case: evalTemplate(0.8).resources.Case,
            },
          },
        });
      expect(removed.status).toBe(200);
      expect(
        (
          await authenticatedTestClient(userToken).get(
            `/api/v1/evals/${evalId}`
          )
        ).status
      ).toBe(404);
      expect(
        (
          await authenticatedTestClient(userToken).get(
            `/api/v1/datasets/${datasetId}`
          )
        ).status
      ).toBe(200);

      await authenticatedTestClient(userToken).delete(
        `/api/v1/formations/${create.body.id}`
      );
      expect(
        (
          await authenticatedTestClient(userToken).get(
            `/api/v1/datasets/${datasetId}`
          )
        ).status
      ).toBe(404);
    });
  });
});
