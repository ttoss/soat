import { db } from 'src/db';
import { guardrailVersionStore } from 'src/lib/guardrailVersionSnapshot';
import { toResourceRef } from 'src/lib/resourceVersions';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * The commit engine's serialization, driven at the lib level because the
 * interleaving it exists for cannot be produced deterministically over HTTP:
 * two concurrent requests may simply serialize, in which case both succeed and
 * the test proves nothing. `commitConfigChange` takes the field write as a
 * callback, so a test can hold one writer inside its own transaction — past
 * the row lock — while the other queues, and the race becomes an ordering the
 * test chooses.
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
      createdByUserId: null,
      resource: toResourceRef(args.row),
      before: { document: args.before },
      applyWrite: async ({ transaction }) => {
        await args.onWrite?.();
        await args.row.update({ document: args.document }, { transaction });
        return { row: args.row, after: { document: args.document } };
      },
    });
  };

  /**
   * Holds one writer inside its field write — past the row lock — until
   * released, and resolves `entered` once it is there, so the second writer is
   * started only after the first holds the row.
   */
  const holdWriter = () => {
    let release = (): void => {};
    const mayProceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalEntered = (): void => {};
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    return {
      release,
      entered,
      onWrite: () => {
        signalEntered();
        return mayProceed;
      },
    };
  };

  test('a writer that read a version another writer holds is refused before its write runs', async () => {
    const held = await createGuardrail('store-held');
    const queued = await db.Guardrail.findOne({ where: { id: held.id } });
    const hold = holdWriter();

    // Both writers read version 1. The held one takes the row first; the other
    // queues on the lock and, once the first commits, finds version 2.
    const heldWrite = commit({
      row: held,
      document: documentAllowing(600),
      before: documentAllowing(500),
      onWrite: hold.onWrite,
    });
    await hold.entered;

    let queuedWrote = false;
    const queuedWrite = commit({
      row: queued!,
      document: documentAllowing(700),
      before: documentAllowing(500),
      onWrite: async () => {
        queuedWrote = true;
      },
    });

    hold.release();
    await heldWrite;

    await expect(queuedWrite).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      meta: { current_version: 2 },
    });
    expect(queuedWrote).toBe(false);
  });

  test('the refused write leaves neither its field nor a version behind', async () => {
    const held = await createGuardrail('store-rollback');
    const queued = await db.Guardrail.findOne({ where: { id: held.id } });
    const hold = holdWriter();

    const heldWrite = commit({
      row: held,
      document: documentAllowing(600),
      before: documentAllowing(500),
      onWrite: hold.onWrite,
    });
    await hold.entered;

    const queuedWrite = commit({
      row: queued!,
      document: documentAllowing(700),
      before: documentAllowing(500),
    });

    hold.release();
    await heldWrite;
    await queuedWrite.catch(() => {
      return undefined;
    });

    const settled = await db.Guardrail.findOne({ where: { id: held.id } });
    expect(settled!.version).toBe(2);
    expect(settled!.document).toEqual(documentAllowing(600));

    // v1 is the create; v2 is the held writer. The refused write archives
    // nothing, so the chain has no gap and no repeat.
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
