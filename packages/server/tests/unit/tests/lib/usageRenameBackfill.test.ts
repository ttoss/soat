import { db } from 'src/db';
import { backfillUsageRenames } from 'src/lib/usageRenameBackfill';

import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * The boot backfill that rewrites stored usage names.
 *
 * Every stored document here is written **directly**, because the authoring
 * validator (`isKnownAction`) rejects the older
 * spellings — which is the point: they run at authoring time only, so a stored
 * document keeps whatever strings it was written with and nothing rewrites
 * them on a read. The backfill has no entry point of its own, so it is
 * exercised here and its effect asserted through the REST surface it repairs.
 */
describe('usage rename backfill', () => {
  let adminToken: string;
  let projectId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'usagerename',
      policyActions: ['usage:GetAggregate'],
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

      // Write the stored document under the older spelling of the action.
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
            // A resource type the rewrite does not touch, carrying a string
            // that only looks like a renamed action.
            note: {
              type: 'secret',
              properties: { name: 'note', value: 'usage:GetUsage' },
            },
          },
        },
      });
      formationId = formation.id as number;
    });

    test('rewrites policy resources and leaves every other type alone', async () => {
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
          note: {
            type: 'secret',
            properties: { name: 'note', value: 'usage:GetUsage' },
          },
        },
      });
    });
  });

  test('a second run rewrites nothing', async () => {
    await backfillUsageRenames();
    expect(await backfillUsageRenames()).toEqual({
      policies: 0,
      formations: 0,
    });
  });
});
