import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import { db } from 'src/db';
import {
  runStorageSnapshot,
  snapshotProjectStorage,
} from 'src/lib/usageStorage';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

// No HTTP entry point — the daily snapshot runs from the scheduler tick, so the
// emitter is driven directly with File rows seeded as the upload flow would. A
// fresh per-prefix project isolates these from other suites' storage events.

describe('Usage — storage metering', () => {
  let userToken: string;
  let projectId: string;
  let projectInternalId: number;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'usagestorage',
      policyActions: ['usage:ListEvents'],
    });
    userToken = setup.userToken;
    projectId = setup.projectId;

    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    projectInternalId = project!.id as number;
  });

  // Seeds a stored file of `size` bytes (well under INT4 max) for the project.
  const seedFile = async (size: number): Promise<void> => {
    await db.File.create({
      publicId: generatePublicId(PUBLIC_ID_PREFIXES.file),
      projectId: projectInternalId,
      size,
      storageType: 'local',
      storagePath: `seed/${generatePublicId(PUBLIC_ID_PREFIXES.file)}`,
      filename: 'seed.bin',
    });
  };

  // One indexed row of each kind. Embeddings are left null: the count is rows,
  // so it must not depend on whether the vector has been written yet.
  const seedOneChunkAndOneEntry = async (): Promise<void> => {
    const file = await db.File.create({
      publicId: generatePublicId(PUBLIC_ID_PREFIXES.file),
      projectId: projectInternalId,
      size: 10,
      storageType: 'local',
      storagePath: `seed/${generatePublicId(PUBLIC_ID_PREFIXES.file)}`,
      filename: 'chunked.txt',
    });
    const document = await db.Document.create({
      publicId: generatePublicId(PUBLIC_ID_PREFIXES.document),
      fileId: file.id,
      status: 'ready',
    });
    await db.DocumentChunk.create({
      publicId: generatePublicId(PUBLIC_ID_PREFIXES.documentChunk),
      documentId: document.id,
      content: 'chunk',
      chunkIndex: 0,
      embedding: null,
    });
    const memory = await db.Memory.create({
      publicId: generatePublicId(PUBLIC_ID_PREFIXES.memory),
      projectId: projectInternalId,
      name: 'storage-memory',
    });
    await db.MemoryEntry.create({
      publicId: generatePublicId(PUBLIC_ID_PREFIXES.memoryEntry),
      memoryId: memory.id,
      content: 'entry',
      embedding: null,
    });
  };

  const storageMeters = async (): Promise<
    Array<{
      meter_type: string;
      cost_usd: number | null;
      components: Array<{
        component: string;
        quantity: string;
        unit: string;
        billable: boolean;
        cost_usd: string | null;
      }>;
    }>
  > => {
    const res = await authenticatedTestClient(userToken).get(
      '/api/v1/usage/events?meter_type=storage'
    );
    expect(res.status).toBe(200);
    return res.body.data;
  };

  test('snapshots stored bytes as one gb_day storage event, idempotent per UTC day', async () => {
    await seedFile(300_000_000);
    await seedFile(100_000_000); // 400 MB total → 0.4 gb_day

    const day = new Date('2026-07-24T00:00:00.000Z');
    const created = await snapshotProjectStorage({
      projectId: projectInternalId,
      projectPublicId: projectId,
      now: day,
    });
    expect(created).toBe(true);

    const meters = await storageMeters();
    expect(meters).toHaveLength(1);
    expect(meters[0].meter_type).toBe('storage');
    const comp = meters[0].components.find((c) => {
      return c.component === 'gb_day';
    });
    expect(comp).toBeDefined();
    expect(comp!.unit).toBe('gb_day');
    expect(Number(comp!.quantity)).toBeCloseTo(0.4);

    // The count rides the same event, and is written even at zero: the daily
    // series is what a rollup sums, so a day left out reads as a day the
    // project stored nothing rather than a day nobody measured.
    const count = meters[0].components.find((c) => {
      return c.component === 'chunk_count';
    });
    expect(count).toBeDefined();
    expect(count!.unit).toBe('count');
    expect(count!.billable).toBe(true);
    expect(Number(count!.quantity)).toBe(0);

    // A second snapshot for the same UTC day writes nothing.
    const again = await snapshotProjectStorage({
      projectId: projectInternalId,
      projectPublicId: projectId,
      now: new Date('2026-07-24T18:00:00.000Z'),
    });
    expect(again).toBe(false);
    expect(await storageMeters()).toHaveLength(1);
  });

  test('runStorageSnapshot meters the project on a new UTC day', async () => {
    const before = (await storageMeters()).length;
    const metered = await runStorageSnapshot({
      now: new Date('2026-07-25T00:00:00.000Z'),
    });
    expect(metered).toBeGreaterThanOrEqual(1);
    // A new day is a distinct idempotency key → exactly one more event for this
    // project (the run also meters other suites' projects, invisible to this user).
    expect((await storageMeters()).length).toBe(before + 1);
  });

  test("counts document chunks and memory entries on the next day's snapshot", async () => {
    await seedOneChunkAndOneEntry();

    const created = await snapshotProjectStorage({
      projectId: projectInternalId,
      projectPublicId: projectId,
      now: new Date('2026-07-26T00:00:00.000Z'),
    });
    expect(created).toBe(true);

    const meters = await storageMeters();
    const day = meters.find((event) => {
      return event.components.some((c) => {
        return c.component === 'chunk_count' && Number(c.quantity) === 2;
      });
    });
    expect(day).toBeDefined();
  });

  test('prices the storage event from an effective global soat/gb-day SKU', async () => {
    // Seeded directly with a long-past effective_from so it applies to the
    // snapshot below; write-time pricing means earlier (unpriced) events keep
    // their null cost.
    await db.PriceBook.create({
      aiProviderId: null,
      projectId: null,
      meterType: 'storage',
      provider: 'soat',
      model: 'gb-day',
      component: 'gb_day',
      unit: 'gb_day',
      unitPrice: '0.5',
      effectiveFrom: new Date('2000-01-01T00:00:00.000Z'),
    });

    const created = await snapshotProjectStorage({
      projectId: projectInternalId,
      projectPublicId: projectId,
      now: new Date('2026-07-28T00:00:00.000Z'),
    });
    expect(created).toBe(true);

    const priced = (await storageMeters()).some((e) => {
      return e.components.some((c) => {
        return (
          c.component === 'gb_day' &&
          c.cost_usd != null &&
          Number(c.cost_usd) > 0
        );
      });
    });
    expect(priced).toBe(true);
  });

  test('prices chunk_count on its own row and sums both into the event cost', async () => {
    await db.PriceBook.create({
      aiProviderId: null,
      projectId: null,
      meterType: 'storage',
      provider: 'soat',
      model: 'gb-day',
      component: 'chunk_count',
      unit: 'count',
      unitPrice: '0.25',
      effectiveFrom: new Date('2000-01-01T00:00:00.000Z'),
    });

    const day = new Date('2026-07-29T00:00:00.000Z');
    const created = await snapshotProjectStorage({
      projectId: projectInternalId,
      projectPublicId: projectId,
      now: day,
    });
    expect(created).toBe(true);

    const event = (await storageMeters()).find((meter) => {
      return meter.components.every((c) => {
        return c.cost_usd != null;
      });
    });
    expect(event).toBeDefined();

    const count = event!.components.find((c) => {
      return c.component === 'chunk_count';
    });
    // The two rows seeded above, at 0.25 each.
    expect(Number(count!.quantity)).toBe(2);
    expect(Number(count!.cost_usd)).toBeCloseTo(0.5);

    // The event's cost is both components, not the one it used to carry.
    const componentSum = event!.components.reduce((total, c) => {
      return total + Number(c.cost_usd);
    }, 0);
    expect(Number(event!.cost_usd)).toBeCloseTo(componentSum);
    expect(Number(event!.cost_usd)).toBeGreaterThan(0.5);
  });

  test('snapshots with the current UTC day when no now is given', async () => {
    // Exercises the default-`now` path; the result depends on whether today was
    // already snapshotted, so only the type is asserted.
    const result = await snapshotProjectStorage({
      projectId: projectInternalId,
      projectPublicId: projectId,
    });
    expect(typeof result).toBe('boolean');
  });

  test('runStorageSnapshot uses the current UTC day by default', async () => {
    const metered = await runStorageSnapshot();
    expect(metered).toBeGreaterThanOrEqual(0);
  });

  test('unauthenticated meters request returns 401', async () => {
    const res = await testClient.get('/api/v1/usage/events?meter_type=storage');
    expect(res.status).toBe(401);
  });
});
