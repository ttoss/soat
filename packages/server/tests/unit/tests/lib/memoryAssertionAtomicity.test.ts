import { db } from 'src/db';
import { createMemory } from 'src/lib/memories';
import { retractMemory } from 'src/lib/memoryRetraction';
import { writeMemory } from 'src/lib/memoryWrite';

import {
  SEED_ASSERTION,
  setMemorySimilarity,
} from '../../fixtures/memoryWrites';
import { pollUntil } from '../../fixtures/poll';

/**
 * A race HTTP cannot order: a reader between a memory's write and its
 * assertion. `EXCLUSIVE` admits reads but holds every `INSERT` into
 * `memory_assertions`, so the write stops exactly at its assertion.
 */

const storeRows = async (memoryStoreId: number) => {
  const rows = await db.Memory.findAll({
    where: { memoryStoreId },
    attributes: ['publicId', 'invalidatedAt'],
    order: [['id', 'ASC']],
  });
  return rows.map((row) => {
    return { id: row.publicId, invalidatedAt: row.invalidatedAt ?? null };
  });
};

const assertionInsertWaiting = async (): Promise<boolean> => {
  const [rows] = await db.sequelize.query(
    `SELECT 1 FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
     WHERE c.relname = 'memory_assertions' AND NOT l.granted`
  );
  return rows.length > 0;
};

/**
 * Runs `write` with assertion inserts held, and returns what a reader outside
 * the write sees of the store while it waits on its assertion.
 */
const readWhileAssertionHeld = async (args: {
  memoryStoreId: number;
  write: () => Promise<unknown>;
}) => {
  const lock = await db.sequelize.transaction();
  let pending: Promise<unknown> | undefined;
  try {
    await db.sequelize.query('LOCK TABLE memory_assertions IN EXCLUSIVE MODE', {
      transaction: lock,
    });
    pending = args.write();
    // Settled early only when the write fails before its assertion.
    pending.catch(() => {});

    await pollUntil({
      read: assertionInsertWaiting,
      done: (waiting) => {
        return waiting;
      },
    });

    return await storeRows(args.memoryStoreId);
  } finally {
    await lock.commit();
    await pending;
  }
};

/**
 * A store of its own per test: the stub embedder gives every text one vector,
 * so a memory left by another test would absorb the write as a skip.
 */
const createStore = async (): Promise<number> => {
  const project = await db.Project.create({ name: 'Assertion atomicity' });
  const store = await db.MemoryStore.create({
    projectId: project.id,
    name: 'Assertion atomicity',
  });
  return store.id as number;
};

describe('a memory write commits with its assertion', () => {
  test('a created memory is unreadable until its assertion commits', async () => {
    const memoryStoreId = await createStore();
    const before = await storeRows(memoryStoreId);

    const during = await readWhileAssertionHeld({
      memoryStoreId,
      write: () => {
        return writeMemory({
          memoryStoreId,
          actorId: null,
          content: `Created fact ${Date.now()}`,
          assertion: SEED_ASSERTION,
        });
      },
    });

    expect(during).toEqual(before);
    expect(await storeRows(memoryStoreId)).toHaveLength(before.length + 1);
  });

  test('a supersede retires and replaces only when its assertion commits', async () => {
    const memoryStoreId = await createStore();
    const first = await writeMemory({
      memoryStoreId,
      actorId: null,
      content: `Superseded fact ${Date.now()}`,
      assertion: SEED_ASSERTION,
    });
    await setMemorySimilarity({ memoryId: first.entry.id, similarity: 0.92 });
    const before = await storeRows(memoryStoreId);

    const during = await readWhileAssertionHeld({
      memoryStoreId,
      write: () => {
        return writeMemory({
          memoryStoreId,
          actorId: null,
          content: `Superseding fact ${Date.now()}`,
          assertion: SEED_ASSERTION,
        });
      },
    });

    expect(during).toEqual(before);
    const retired = await db.Memory.findOne({
      where: { publicId: first.entry.id },
    });
    expect(retired!.supersededByMemoryId).not.toBeNull();
  });

  test('a declared memory is unreadable until its assertion commits', async () => {
    const memoryStoreId = await createStore();
    const before = await storeRows(memoryStoreId);

    const during = await readWhileAssertionHeld({
      memoryStoreId,
      write: () => {
        return createMemory({
          memoryStoreId,
          content: `Declared fact ${Date.now()}`,
          assertion: SEED_ASSERTION,
        });
      },
    });

    expect(during).toEqual(before);
    expect(await storeRows(memoryStoreId)).toHaveLength(before.length + 1);
  });

  test('a retraction is unreadable until its assertion commits', async () => {
    const memoryStoreId = await createStore();
    const stored = await createMemory({
      memoryStoreId,
      content: `Retracted fact ${Date.now()}`,
      assertion: SEED_ASSERTION,
    });
    const before = await storeRows(memoryStoreId);

    const during = await readWhileAssertionHeld({
      memoryStoreId,
      write: () => {
        return retractMemory({ id: stored.id, assertion: SEED_ASSERTION });
      },
    });

    expect(during).toEqual(before);
    const retracted = await db.Memory.findOne({
      where: { publicId: stored.id },
    });
    expect(retracted!.invalidatedAt).not.toBeNull();
  });
});
