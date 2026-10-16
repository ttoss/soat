import { db } from 'src/db';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A formation is readable by anyone holding `formations:GetFormation`, which is
 * a much wider audience than `secrets:GetSecret` or `triggers:GetTriggerSecret`.
 * So neither of the two ways a formation can come to hold credential material —
 * a literal the caller declared, and a signing secret the server generated — may
 * reach that surface.
 */
describe('a formation never echoes secret material', () => {
  let adminToken: string;
  let projectId: string;

  const secretValue = 'sk-formation-echo-must-not-leak';

  const secretTemplate = (name: string) => {
    return {
      resources: {
        EchoSecret: {
          type: 'secret',
          properties: { name, value: secretValue },
        },
      },
    };
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'fse',
      policyActions: ['formations:GetFormation'],
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
  });

  describe('a declared literal', () => {
    let formationId: string;

    test('the create response masks the value it was just given', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `fse-literal-${Date.now()}`,
          template: secretTemplate('fse-literal-secret'),
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');
      expect(JSON.stringify(res.body)).not.toContain(secretValue);
      formationId = res.body.id;
    });

    test('reading the formation masks the declared value', async () => {
      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/formations/${formationId}`
      );

      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(secretValue);
      expect(res.body.template.resources.EchoSecret.properties.value).toEqual({
        no_echo: true,
      });
      // The rest of the declaration is untouched — a mask that hid the resource
      // would make the record useless.
      expect(res.body.template.resources.EchoSecret.properties.name).toBe(
        'fse-literal-secret'
      );
    });

    test('listing formations masks it too', async () => {
      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/formations?project_id=${projectId}`
      );

      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(secretValue);
    });

    test('a plan diff masks the resolved value', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/formations/plan')
        .send({
          project_id: projectId,
          template: secretTemplate('fse-plan-secret'),
        });

      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(secretValue);
      const change = res.body.changes.find((c: { logical_id: string }) => {
        return c.logical_id === 'EchoSecret';
      });
      expect(change.diff.desired.value).toEqual({ no_echo: true });
      expect(change.diff.desired.name).toBe('fse-plan-secret');
    });

    test('the deploy events carry no value', async () => {
      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/formations/${formationId}/events`
      );

      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(secretValue);
    });

    test('the stored last-applied snapshot carries no value', async () => {
      const rows = await db.FormationResource.findAll({
        where: { logicalId: 'EchoSecret' },
      });
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(JSON.stringify(row.lastAppliedProperties)).not.toContain(
          secretValue
        );
      }
    });
  });

  describe('a generated signing secret', () => {
    const webhookTriggerTemplate = {
      resources: {
        EchoHook: {
          type: 'webhook',
          properties: {
            name: 'fse-hook',
            url: 'https://example.com/fse',
            events: ['*'],
          },
        },
      },
      outputs: {
        hookSecret: { ref_attr: 'EchoHook.secret' },
      },
    };

    test('validation refuses an output resolving a signing secret', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/formations/validate')
        .send({ template: webhookTriggerTemplate });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(
        res.body.errors.some((e: { path: string; message: string }) => {
          return (
            e.path === 'outputs.hookSecret' && e.message.includes("'secret'")
          );
        })
      ).toBe(true);
    });

    test('creating such a formation is refused', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `fse-hook-${Date.now()}`,
          template: webhookTriggerTemplate,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a trigger signing secret is refused the same way', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/formations/validate')
        .send({
          template: {
            resources: {
              EchoAgent: {
                type: 'memory_store',
                properties: { name: 'fse-mem' },
              },
              EchoTrigger: {
                type: 'trigger',
                properties: {
                  name: 'fse-trigger',
                  type: 'webhook',
                  target_type: 'tool',
                  target_id: 'tol_placeholder00000',
                },
              },
            },
            outputs: { triggerSecret: { ref_attr: 'EchoTrigger.secret' } },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(
        res.body.errors.some((e: { path: string }) => {
          return e.path === 'outputs.triggerSecret';
        })
      ).toBe(true);
    });
  });

  describe('a literal credential in a tool resource', () => {
    const client = () => {
      return authenticatedTestClient(adminToken);
    };
    const mcpUrl = 'https://mcp.example.com/mcp';

    test('validate-formation refuses it, naming the field', async () => {
      const res = await client()
        .post('/api/v1/formations/validate')
        .send({
          template: {
            resources: {
              LiteralTool: {
                type: 'tool',
                properties: {
                  name: 'fse-literal-tool',
                  type: 'mcp',
                  mcp: { url: mcpUrl, headers: { Authorization: 'Bearer sk' } },
                },
              },
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(
        res.body.errors.map((error: { path: string }) => {
          return error.path;
        })
      ).toContain('resources.LiteralTool.properties.mcp.headers.Authorization');
    });

    test('a secret resource referenced through a sub deploys a reference', async () => {
      const res = await client()
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `fse-secret-sub-${Date.now()}`,
          parameters: { ApiKey: 'sk-from-parameter' },
          template: {
            parameters: { ApiKey: { type: 'string', no_echo: true } },
            resources: {
              ApiKeySecret: {
                type: 'secret',
                properties: {
                  name: `fse-sub-secret-${Date.now()}`,
                  value: { param: 'ApiKey' },
                },
              },
              SubTool: {
                type: 'tool',
                properties: {
                  name: 'fse-sub-tool',
                  type: 'mcp',
                  mcp: {
                    url: mcpUrl,
                    headers: {
                      Authorization: {
                        sub: 'Bearer {{secret:${ApiKeySecret}}}',
                      },
                    },
                  },
                },
              },
            },
          },
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');
      const toolId = JSON.stringify(res.body).match(
        /tool_[A-Za-z0-9]{16}/
      )?.[0];
      const tool = await client().get(`/api/v1/tools/${toolId}`);
      expect(tool.body.mcp.headers.Authorization).toMatch(
        /^Bearer \{\{secret:sec_[A-Za-z0-9]+\}\}$/
      );
    });
  });

  describe('a literal already stored in a tool or agent the formation manages', () => {
    const literal = 'Bearer fse-live-literal-must-not-leak';
    const mcpUrl = 'https://mcp.example.com/mcp';
    let formationId: string;
    let template: Record<string, unknown>;

    /** The API refuses a literal, so a stored one is planted in its column. */
    const plantLiteral = async (args: {
      row: {
        get: (field: string) => unknown;
        update: (values: object) => Promise<unknown>;
      };
      field: string;
      reference: string;
    }) => {
      const planted = JSON.parse(
        JSON.stringify(args.row.get(args.field))
          .split(args.reference)
          .join(literal)
      );
      await args.row.update({ [args.field]: planted });
    };

    beforeAll(async () => {
      const client = () => {
        return authenticatedTestClient(adminToken);
      };
      const provider = await client().post('/api/v1/ai-providers').send({
        project_id: projectId,
        name: 'fse-live-provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
      const secret = await client()
        .post('/api/v1/secrets')
        .send({ project_id: projectId, name: 'fse-live-ref', value: 'x' });
      const reference = `Bearer {{secret:${secret.body.id}}}`;
      const mcp = { url: mcpUrl, headers: { Authorization: reference } };
      template = {
        resources: {
          LiveTool: {
            type: 'tool',
            properties: { name: 'fse-live-tool', type: 'mcp', mcp },
          },
          LiveAgent: {
            type: 'agent',
            properties: {
              name: 'fse-live-agent',
              ai_provider_id: provider.body.id,
            },
          },
        },
      };
      const created = await client()
        .post('/api/v1/formations')
        .send({ project_id: projectId, name: 'fse-live', template });
      expect(created.status).toBe(201);
      formationId = created.body.id;

      const formation = JSON.stringify(
        (await client().get(`/api/v1/formations/${formationId}`)).body
      );
      const toolId = formation.match(/tool_[A-Za-z0-9]{16}/)?.[0];
      const agentId = formation.match(/agent_[A-Za-z0-9]{16}/)?.[0];
      const patched = await client()
        .patch(`/api/v1/agents/${agentId}`)
        .send({
          tool_bindings: [{ tool: { name: 'fse-inline', type: 'mcp', mcp } }],
        });
      expect(patched.status).toBe(200);

      await plantLiteral({
        row: (await db.Tool.findOne({ where: { publicId: toolId } }))!,
        field: 'mcp',
        reference,
      });
      await plantLiteral({
        row: (await db.Agent.findOne({ where: { publicId: agentId } }))!,
        field: 'toolBindings',
        reference,
      });
      await plantLiteral({
        row: (await db.Formation.findOne({
          where: { publicId: formationId },
        }))!,
        field: 'template',
        reference,
      });
    });

    test('a plan masks it in the live side of every diff', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/formations/plan')
        .send({ project_id: projectId, formation_id: formationId, template });

      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(literal);
      const byId = Object.fromEntries(
        res.body.changes.map(
          (change: { logical_id: string; diff: unknown }) => {
            return [change.logical_id, change.diff];
          }
        )
      );
      expect(byId.LiveTool.current.mcp.headers.Authorization).toEqual({
        no_echo: true,
      });
      expect(
        byId.LiveAgent.current.tool_bindings[0].tool.mcp.headers.Authorization
      ).toEqual({ no_echo: true });
    });

    test('reading the formation masks it in the stored template', async () => {
      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/formations/${formationId}`
      );

      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(literal);
      expect(
        res.body.template.resources.LiveTool.properties.mcp.headers
          .Authorization
      ).toEqual({ no_echo: true });
    });
  });
});
