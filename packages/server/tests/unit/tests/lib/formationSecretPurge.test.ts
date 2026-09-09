import { db } from 'src/db';
import { purgeFormationSecretOutputs } from 'src/lib/formationSecretPurge';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';

/**
 * Outputs written before a `ref_attr` to a signing secret was refused are still
 * plaintext in the database. The read path drops them, but a database dump and
 * a direct query do not go through it — so the rows themselves are cleared by an
 * operator-run sweep (audit decision D5).
 */
describe('purgeFormationSecretOutputs', () => {
  let projectDbId: number;

  const templateWithSecretOutput = {
    resources: {
      Hook: {
        type: 'webhook',
        properties: {
          name: 'purge-hook',
          url: 'https://example.com/purge',
          events: ['*'],
        },
      },
      Mem: { type: 'memory', properties: { name: 'purge-mem' } },
    },
    outputs: {
      hookSecret: { ref_attr: 'Hook.secret' },
      memoryId: { ref: 'Mem' },
    },
  };

  const seedFormation = async (args: {
    name: string;
    template: unknown;
    outputs: Record<string, string> | null;
  }) => {
    return db.Formation.create({
      projectId: projectDbId,
      name: args.name,
      template: args.template,
      outputs: args.outputs,
      status: 'active',
      metadata: null,
    });
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'fsp',
      policyActions: ['formations:GetFormation'],
      createNoPermUser: false,
    });
    projectDbId = (
      await db.Project.findOne({ where: { publicId: setup.projectId } })
    )?.id as number;
  });

  test('removes only the outputs that resolved a credential', async () => {
    const formation = await seedFormation({
      name: 'fsp-leaky',
      template: templateWithSecretOutput,
      outputs: { hookSecret: 'whsec_leaked', memoryId: 'mem_1' },
    });

    const result = await purgeFormationSecretOutputs();
    expect(result.cleared).toBeGreaterThanOrEqual(1);

    await formation.reload();
    expect(formation.outputs).toEqual({ memoryId: 'mem_1' });
  });

  test('a second run finds nothing left to clear', async () => {
    const before = await purgeFormationSecretOutputs();
    expect(before.cleared).toBe(0);
  });

  test('leaves a formation whose outputs name no credential alone', async () => {
    const formation = await seedFormation({
      name: 'fsp-clean',
      template: {
        resources: { Mem: { type: 'memory', properties: { name: 'm' } } },
        outputs: { memoryId: { ref: 'Mem' } },
      },
      outputs: { memoryId: 'mem_2' },
    });

    await purgeFormationSecretOutputs();

    await formation.reload();
    expect(formation.outputs).toEqual({ memoryId: 'mem_2' });
  });

  test('dryRun reports what it would clear without writing', async () => {
    const formation = await seedFormation({
      name: 'fsp-dry',
      template: templateWithSecretOutput,
      outputs: { hookSecret: 'whsec_dry', memoryId: 'mem_3' },
    });

    const result = await purgeFormationSecretOutputs({ dryRun: true });
    expect(result.cleared).toBe(1);

    await formation.reload();
    expect(formation.outputs).toEqual({
      hookSecret: 'whsec_dry',
      memoryId: 'mem_3',
    });

    // Left clean for whatever runs next.
    await purgeFormationSecretOutputs();
  });

  test('skips a formation with no stored template', async () => {
    const formation = await seedFormation({
      name: 'fsp-no-template',
      template: null,
      outputs: { stray: 'value' },
    });

    await purgeFormationSecretOutputs();

    await formation.reload();
    expect(formation.outputs).toEqual({ stray: 'value' });
  });
});
