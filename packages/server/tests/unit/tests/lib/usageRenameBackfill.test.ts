import { db } from 'src/db';
import { backfillUsageRenames } from 'src/lib/usageRenameBackfill';

import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * The boot backfill behind #1216's renames.
 *
 * Every stored document here is written **directly**, because the authoring
 * validators (`isKnownAction`, `RUNTIME_CONTEXT_CATALOG`) reject the old names
 * — which is the point: they run at authoring time only, so a document stored
 * before the release keeps its old strings and nothing rewrites them on a
 * read. It has no entry point of its own, so it is exercised here and its
 * effect asserted through the REST surface it repairs.
 */
describe('usage rename backfill', () => {
  let adminToken: string;
  let projectId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'usagerename',
      policyActions: [
        'guardrails:CreateGuardrail',
        'guardrails:GetGuardrail',
        'guardrails:UpdateGuardrail',
      ],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
  }, 60000);

  describe('policies', () => {
    let staleToken: string;

    beforeAll(async () => {
      staleToken = await createScopedPrincipal({
        adminToken,
        projectId,
        username: 'usagerenamestale',
        actions: ['usage:GetAggregate', 'usage:ListEvents'],
      });

      // Rewind the stored document to what a tenant wrote before the release.
      const policies = await db.Policy.findAll();
      for (const policy of policies) {
        const document = policy.document as {
          statement?: Array<{ action?: string[] }>;
        };
        const statement = (document.statement ?? []).map((entry) => {
          return {
            ...entry,
            action: (entry.action ?? []).map((action) => {
              if (action === 'usage:GetAggregate') return 'usage:GetUsage';
              if (action === 'usage:ListEvents') return 'usage:ListUsageMeters';
              return action;
            }),
          };
        });
        policy.document = { ...document, statement };
        await policy.save();
      }
    });

    test('a policy stored with the old action grants nothing until the backfill runs', async () => {
      const before = await authenticatedTestClient(staleToken).get(
        `/api/v1/usage/aggregate?project_id=${projectId}&group_by=model`
      );
      expect(before.status).toBe(403);

      await backfillUsageRenames();

      const after = await authenticatedTestClient(staleToken).get(
        `/api/v1/usage/aggregate?project_id=${projectId}&group_by=model`
      );
      expect(after.status).toBe(200);

      const events = await authenticatedTestClient(staleToken).get(
        '/api/v1/usage/events'
      );
      expect(events.status).toBe(200);
    });

    test('a wildcard action is left alone', async () => {
      const policy = await db.Policy.create({
        document: { statement: [{ effect: 'Allow', action: ['usage:*'] }] },
      });
      await backfillUsageRenames();
      await policy.reload();
      expect(policy.document).toEqual({
        statement: [{ effect: 'Allow', action: ['usage:*'] }],
      });
    });
  });

  describe('guardrails', () => {
    let guardrailId: string;

    const STALE_DOCUMENT = {
      class: {
        if: [
          { '>': [{ var: 'runtime.orchestration_run.node_attempt' }, 1] },
          'C',
          'A',
        ],
      },
      guard: {
        '<': [
          { var: ['runtime.usage.run_cost_usd', 0] },
          { var: 'context.ceiling' },
        ],
      },
    };

    beforeAll(async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/guardrails')
        .send({
          project_id: projectId,
          name: 'Stale Guardrail',
          document: { class: 'A' },
        });
      expect(res.status).toBe(201);
      guardrailId = res.body.id;

      // Both forms a `var` takes, at depth inside `class` and `guard`, plus
      // the version snapshot that shares the shape.
      const guardrail = await db.Guardrail.findOne({
        where: { publicId: guardrailId },
      });
      guardrail!.document = {
        ...STALE_DOCUMENT,
        class: {
          if: [{ '>': [{ var: 'runtime.run.node_attempt' }, 1] }, 'C', 'A'],
        },
      };
      await guardrail!.save();

      await db.GuardrailVersion.create({
        guardrailId: guardrail!.id as number,
        version: 99,
        config: {
          class: 'B',
          guard: { '<': [{ var: 'runtime.usage.run_tokens' }, 100] },
        },
      });
    });

    test('the backfill rewrites both var forms in the document and its snapshots', async () => {
      const result = await backfillUsageRenames();
      expect(result.guardrails).toBe(1);
      expect(result.guardrailVersions).toBe(1);

      const guardrail = await db.Guardrail.findOne({
        where: { publicId: guardrailId },
      });
      expect(guardrail!.document).toEqual({
        class: {
          if: [
            {
              '>': [{ var: 'runtime.orchestration_run.node_attempt' }, 1],
            },
            'C',
            'A',
          ],
        },
        guard: {
          '<': [
            { var: ['runtime.usage.orchestration_run_cost_usd', 0] },
            { var: 'context.ceiling' },
          ],
        },
      });

      const version = await db.GuardrailVersion.findOne({
        where: { guardrailId: guardrail!.id as number, version: 99 },
      });
      expect(version!.config).toEqual({
        class: 'B',
        guard: {
          '<': [{ var: 'runtime.usage.orchestration_run_tokens' }, 100],
        },
      });
    });

    test('the rewritten document is what the catalog now accepts', async () => {
      const read = await authenticatedTestClient(adminToken).get(
        `/api/v1/guardrails/${guardrailId}`
      );
      expect(read.status).toBe(200);

      const rewrite = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/guardrails/${guardrailId}`)
        .send({ document: read.body.document });
      expect(rewrite.status).toBe(200);
    });
  });

  describe('formations', () => {
    let formationId: number;

    beforeAll(async () => {
      const project = await db.Project.findOne({
        where: { publicId: projectId },
      });
      const formation = await db.Formation.create({
        projectId: project!.id as number,
        name: 'stale-formation',
        status: 'created',
        template: {
          resources: {
            reader: {
              type: 'policy',
              properties: {
                document: {
                  statement: [{ effect: 'Allow', action: ['usage:GetUsage'] }],
                },
              },
            },
            ceiling: {
              type: 'guardrail',
              properties: {
                name: 'Ceiling',
                class: 'B',
                guard: {
                  '<': [{ var: 'runtime.usage.run_tokens' }, 100],
                },
              },
            },
            // A resource type the rewrite does not touch, carrying a string
            // that only looks like a renamed one.
            note: {
              type: 'secret',
              properties: { name: 'note', value: 'runtime.run.tool_calls' },
            },
          },
        },
      });
      formationId = formation.id as number;
    });

    test('rewrites policy and guardrail resources and leaves every other type alone', async () => {
      const result = await backfillUsageRenames();
      expect(result.formations).toBe(1);

      const formation = await db.Formation.findByPk(formationId);
      expect(formation!.template).toEqual({
        resources: {
          reader: {
            type: 'policy',
            properties: {
              document: {
                statement: [
                  { effect: 'Allow', action: ['usage:GetAggregate'] },
                ],
              },
            },
          },
          ceiling: {
            type: 'guardrail',
            properties: {
              name: 'Ceiling',
              class: 'B',
              guard: {
                '<': [{ var: 'runtime.usage.orchestration_run_tokens' }, 100],
              },
            },
          },
          note: {
            type: 'secret',
            properties: { name: 'note', value: 'runtime.run.tool_calls' },
          },
        },
      });
    });
  });

  test('a second run rewrites nothing', async () => {
    await backfillUsageRenames();
    expect(await backfillUsageRenames()).toEqual({
      policies: 0,
      guardrails: 0,
      guardrailVersions: 0,
      formations: 0,
    });
  });
});
