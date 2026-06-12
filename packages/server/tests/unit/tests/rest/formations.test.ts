import { db } from 'src/db';

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
  });

  // ── List ──────────────────────────────────────────────────────────────────

  describe('GET /api/v1/formations', () => {
    test('returns list of formations', async () => {
      const res = await authenticatedTestClient(userToken)
        .get('/api/v1/formations')
        .query({ project_id: projectId });

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body[0].id).toBeDefined();
    });

    test('unauthenticated returns 401', async () => {
      const res = await testClient
        .get('/api/v1/formations')
        .query({ project_id: projectId });

      expect(res.status).toBe(401);
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

  // ── Events ────────────────────────────────────────────────────────────────

  describe('GET /api/v1/formations/:formation_id/events', () => {
    test('returns operation events', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/formations/${formationId}/events`
      );

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body[0].id).toBeDefined();
      expect(res.body[0].operation_type).toBeDefined();
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
  });

  // ── Delete ────────────────────────────────────────────────────────────────

  describe('DELETE /api/v1/formations/:formation_id', () => {
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
      const ids = res.body.map((f: { id: string }) => {
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
        expect(res.body.error).toBe('Missing required parameters');
        expect(Array.isArray(res.body.details)).toBe(true);
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
        expect(res.body.error).toBe('Missing required parameters');
        expect(Array.isArray(res.body.details)).toBe(true);
        expect(
          res.body.details.some((d: { message: string }) => {
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
        expect(res.body.error).toBe('Missing required parameters');
        expect(
          res.body.details.some((d: { path: string }) => {
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
        expect(res.body.error).toBe('Missing required parameters');
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
        expect(res.body.error).toBe('Missing required parameters');
        expect(
          res.body.details.some((d: { message: string }) => {
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

    test('updating a formation with a document resource is a no-op (documents are immutable)', async () => {
      const updatedTemplate = {
        resources: {
          MyDoc: {
            type: 'document',
            properties: {
              content: 'Updated content (should not change)',
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
      // update is a no-op, so status should reflect no-op/updated
      expect(['updated', 'no-op']).toContain(docResource.status);
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

    test('creates an agent with a reasoning config from a formation', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `reasoning-formation-${Date.now()}`,
          template: {
            resources: {
              ReasoningAgent: {
                type: 'agent',
                properties: {
                  ai_provider_id: aiProviderId,
                  name: 'reasoning-agent',
                  reasoning: {
                    effort: 'high',
                    mode: 'reflect',
                    critique: { model: 'tiny-critic' },
                  },
                },
              },
            },
          },
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');
      const reasoningAgentId = res.body.resources[0].physical_resource_id;

      const agentRes = await authenticatedTestClient(adminToken).get(
        `/api/v1/agents/${reasoningAgentId}`
      );
      expect(agentRes.status).toBe(200);
      expect(agentRes.body.reasoning.effort).toBe('high');
      expect(agentRes.body.reasoning.mode).toBe('reflect');
      expect(agentRes.body.reasoning.critique.model).toBe('tiny-critic');
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
});
