import { db } from 'src/db';
import { guardrailVersionStore } from 'src/lib/guardrailVersionSnapshot';
import { toResourceRef } from 'src/lib/resourceVersions';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * The commit engine's conditional claim, driven at the lib level because the
 * interleaving it exists for cannot be produced deterministically over HTTP:
 * two concurrent requests may simply serialize, in which case both succeed and
 * the test proves nothing. `commitConfigChange` takes the field write as a
 * callback, so a test can hold one writer inside its own transaction while the
 * other commits, and the race becomes an ordering the test chooses.
 *
 * The guardrail store is used because its config is one field, so "did this
 * write take a version" has one answer. The engine is shared, so what holds
 * here holds for every versioned resource.
 */
describe('resource version store', () => {
  let userToken: string;
  let projectId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'versionstore',
      policyActions: ['guardrails:CreateGuardrail'],
      createNoPermUser: false,
    });

    userToken = setup.userToken;
    projectId = setup.projectId;
  });

  const documentAllowing = (limit: number) => {
    return {
      default_class: 'C',
      class: { if: [{ '<': [{ var: 'args.amount' }, limit] }, 'B', 'C'] },
    };
  };

  /** A guardrail at version 1, loaded as the row the engine commits against. */
  const createGuardrail = async (name: string) => {
    const created = await authenticatedTestClient(userToken)
      .post('/api/v1/guardrails')
      .send({ project_id: projectId, name, document: documentAllowing(500) });

    expect(created.status).toBe(201);

    const row = await db.Guardrail.findOne({
      where: { publicId: created.body.id },
    });

    return row!;
  };

  const commit = (args: {
    row: InstanceType<typeof db.Guardrail>;
    document: object;
    before: object;
    onWrite?: () => Promise<void>;
  }) => {
    return guardrailVersionStore.commitConfigChange({
      resource: toResourceRef(args.row),
      before: { document: args.before },
      applyWrite: async ({ transaction }) => {
        await args.onWrite?.();
        await args.row.update({ document: args.document }, { transaction });
        return { row: args.row, after: { document: args.document } };
      },
    });
  };

  test('a write whose version was taken while it ran is refused', async () => {
    const held = await createGuardrail('store-held');
    const winner = await db.Guardrail.findOne({ where: { id: held.id } });

    // Both writers read version 1. The held one is released only once the
    // other has committed, so it reaches its claim against a version that has
    // already moved — the interleaving the conditional update exists for.
    let releaseHeld = (): void => {};
    const heldMayProceed = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });

    const heldWrite = commit({
      row: held,
      document: documentAllowing(600),
      before: documentAllowing(500),
      onWrite: () => {
        return heldMayProceed;
      },
    });

    await commit({
      row: winner!,
      document: documentAllowing(700),
      before: documentAllowing(500),
    });

    releaseHeld();

    await expect(heldWrite).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      meta: { current_version: 2 },
    });
  });

  test('the refused write leaves neither its field nor a version behind', async () => {
    const held = await createGuardrail('store-rollback');
    const winner = await db.Guardrail.findOne({ where: { id: held.id } });

    let releaseHeld = (): void => {};
    const heldMayProceed = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });

    const heldWrite = commit({
      row: held,
      document: documentAllowing(600),
      before: documentAllowing(500),
      onWrite: () => {
        return heldMayProceed;
      },
    });

    await commit({
      row: winner!,
      document: documentAllowing(700),
      before: documentAllowing(500),
    });

    releaseHeld();
    await heldWrite.catch(() => {
      return undefined;
    });

    const settled = await db.Guardrail.findOne({ where: { id: held.id } });
    expect(settled!.version).toBe(2);
    expect(settled!.document).toEqual(documentAllowing(700));

    // v1 is the create; v2 is the winner. The refused write archives nothing,
    // so the chain has no gap and no repeat.
    const archived = await db.GuardrailVersion.findAll({
      where: { guardrailId: held.id as number },
      order: [['version', 'ASC']],
    });
    expect(
      archived.map((version) => {
        return version.version;
      })
    ).toEqual([1, 2]);
  });

  test('a write that changes nothing takes no version and cannot conflict', async () => {
    const row = await createGuardrail('store-noop');

    await commit({
      row,
      document: documentAllowing(500),
      before: documentAllowing(500),
    });

    const settled = await db.Guardrail.findOne({ where: { id: row.id } });
    expect(settled!.version).toBe(1);
  });
});
