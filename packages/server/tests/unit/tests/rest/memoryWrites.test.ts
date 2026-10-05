import { db } from 'src/db';

import { installEmbeddingStub } from '../../embeddingStub';
import { setMemorySimilarity } from '../../fixtures/memoryWrites';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * The write algorithm behind `POST /api/v1/memories`: which band a write lands
 * in, what a supersede carries forward, and how the store's content rows are
 * shared.
 *
 * Every text embeds to one constant vector, so a stored memory is moved to a
 * chosen cosine with `setMemorySimilarity` to put the next write in a band
 * without moving the thresholds off their defaults. This file runs its own
 * embedding endpoint so a test can take it down: the provider is external I/O,
 * and an outage is the one thing the write must survive without losing a fact.
 */
let embedderDown = false;

installEmbeddingStub({
  embed: () => {
    if (embedderDown) throw new Error('embedding provider unavailable');
    return new Array(Number(process.env.EMBEDDING_DIMENSIONS)).fill(0.1);
  },
});

type WriteResponse = {
  status: number;
  body: {
    id: string;
    action: 'created' | 'skipped' | 'superseded';
    content: string;
    tags: Record<string, string> | null;
    metadata: Record<string, unknown> | null;
  };
};

describe('POST /api/v1/memories — the write algorithm', () => {
  let adminToken: string;
  let projectId: string;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const createMemoryStore = async (
    thresholds?: Record<string, number>
  ): Promise<string> => {
    const res = await asAdmin()
      .post('/api/v1/memory-stores')
      .send({
        project_id: projectId,
        name: `Writes ${Math.random().toString(36).slice(2)}`,
        ...thresholds,
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const write = async (
    body: Record<string, unknown>
  ): Promise<WriteResponse> => {
    return (await asAdmin()
      .post('/api/v1/memories')
      .send(body)) as WriteResponse;
  };

  /** Writes one memory and places it at a chosen cosine from the next write. */
  const seedAt = async (args: {
    memoryStoreId: string;
    content: string;
    similarity: number;
    tags?: Record<string, string>;
    metadata?: Record<string, unknown>;
  }) => {
    const seeded = await write({
      memory_store_id: args.memoryStoreId,
      content: args.content,
      tags: args.tags,
      metadata: args.metadata,
    });
    expect(seeded.status).toBe(201);
    await setMemorySimilarity({
      memoryId: seeded.body.id,
      similarity: args.similarity,
    });
    return seeded.body;
  };

  const contentRowsOf = async (memoryStoreId: string) => {
    const store = await db.MemoryStore.findOne({
      where: { publicId: memoryStoreId },
    });
    return db.MemoryContent.findAll({
      where: { memoryStoreId: store!.id as number },
    });
  };

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'writesadmin', password: 'supersecret' });
    adminToken = await loginAs('writesadmin', 'supersecret');

    const project = await asAdmin()
      .post('/api/v1/projects')
      .send({ name: 'Memory write algorithm' });
    projectId = project.body.id;
  });

  afterEach(() => {
    embedderDown = false;
  });

  describe('bands', () => {
    // 0.89 is the safe error the design chooses: just under the supersede
    // floor, a fact that might be a restatement is kept rather than retired.
    test('creates just below the supersede threshold rather than superseding', async () => {
      const memoryStoreId = await createMemoryStore();
      const first = await seedAt({
        memoryStoreId,
        content: 'Delivery window is two weeks',
        similarity: 0.89,
      });

      const res = await write({
        memory_store_id: memoryStoreId,
        content: 'Delivery is usually quick',
      });

      expect(res.status).toBe(201);
      expect(res.body.action).toBe('created');
      const retained = await asAdmin().get(`/api/v1/memories/${first.id}`);
      expect(retained.body.invalidated_at).toBeNull();
    });

    // Dropping the retired memory's bags would silently remove the replacement
    // from every tag-scoped search and policy the original satisfied.
    test('a supersede carries the retired bags forward, the incoming keys winning', async () => {
      const memoryStoreId = await createMemoryStore();
      await seedAt({
        memoryStoreId,
        content: 'Refund ceiling is 500',
        similarity: 0.92,
        tags: { role: 'manager', env: 'prod' },
        metadata: { evidence: 'high', a: 1 },
      });

      const res = await write({
        memory_store_id: memoryStoreId,
        content: 'Refund ceiling is 900',
        tags: { env: 'staging' },
        metadata: { a: 2 },
      });

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('superseded');
      expect(res.body.tags).toEqual({ role: 'manager', env: 'staging' });
      expect(res.body.metadata).toEqual({ evidence: 'high', a: 2 });
    });

    test("the store's thresholds decide a write that names none", async () => {
      // A store that trusts its corpus less: 0.92 is a duplicate here, not a
      // change, so the write that would supersede by default is skipped.
      const memoryStoreId = await createMemoryStore({
        duplicate_threshold: 0.9,
        supersede_threshold: 0.8,
      });
      const first = await seedAt({
        memoryStoreId,
        content: 'Store threshold first fact',
        similarity: 0.92,
      });

      const res = await write({
        memory_store_id: memoryStoreId,
        content: 'Store threshold second fact',
      });

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('skipped');
      expect(res.body.id).toBe(first.id);
    });

    test("a request threshold overrides the store's", async () => {
      const memoryStoreId = await createMemoryStore({
        duplicate_threshold: 0.9,
        supersede_threshold: 0.8,
      });
      await seedAt({
        memoryStoreId,
        content: 'Override first fact',
        similarity: 0.92,
      });

      const res = await write({
        memory_store_id: memoryStoreId,
        content: 'Override second fact',
        // Back above the match, so the same pair supersedes instead.
        duplicate_threshold: 0.95,
      });

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('superseded');
    });
  });

  describe('content rows', () => {
    test("restating a store's own text is a skip, however far its vector sits", async () => {
      const memoryStoreId = await createMemoryStore();
      // Far from anything else, so only the shared row itself can match.
      const first = await seedAt({
        memoryStoreId,
        content: 'A repeated sentence',
        similarity: 0.5,
      });

      const res = await write({
        memory_store_id: memoryStoreId,
        content: 'A repeated sentence',
      });

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('skipped');
      expect(res.body.id).toBe(first.id);
    });

    // Normalization is what makes the hash a dedup key rather than a checksum.
    test('the same sentence spaced differently is the same content', async () => {
      const memoryStoreId = await createMemoryStore();
      const first = await seedAt({
        memoryStoreId,
        content: 'Spacing  varies   here',
        similarity: 0.5,
      });

      const res = await write({
        memory_store_id: memoryStoreId,
        content: '  Spacing varies here  ',
      });

      expect(res.body.action).toBe('skipped');
      expect(res.body.id).toBe(first.id);
      // The first writer's spelling is what is stored.
      const rows = await contentRowsOf(memoryStoreId);
      expect(
        rows.map((row) => {
          return row.content;
        })
      ).toEqual(['Spacing  varies   here']);
    });

    test('a text known to one store is new to another', async () => {
      const first = await createMemoryStore();
      const second = await createMemoryStore();

      const inFirst = await write({
        memory_store_id: first,
        content: 'Shared across stores',
      });
      const inSecond = await write({
        memory_store_id: second,
        content: 'Shared across stores',
      });

      expect(inFirst.body.action).toBe('created');
      expect(inSecond.body.action).toBe('created');
      expect(await contentRowsOf(first)).toHaveLength(1);
      expect(await contentRowsOf(second)).toHaveLength(1);
    });

    // Concurrent writes of one new text all miss the hash lookup and all
    // insert; the unique index decides, and the losers read the winner's row
    // rather than failing a write whose content is already stored.
    test('several writes claiming one new text at once share one content row', async () => {
      const memoryStoreId = await createMemoryStore();

      const results = await Promise.all(
        Array.from({ length: 4 }, () => {
          return write({
            memory_store_id: memoryStoreId,
            content: 'Contended sentence',
          });
        })
      );

      for (const result of results) {
        expect(result.body.content).toBe('Contended sentence');
      }
      expect(await contentRowsOf(memoryStoreId)).toHaveLength(1);
    });
  });

  describe('while the embedding provider is down', () => {
    test('stores the fact without a vector rather than losing it', async () => {
      const memoryStoreId = await createMemoryStore();
      embedderDown = true;

      const res = await write({
        memory_store_id: memoryStoreId,
        content: 'Fact written while the embedder was down',
      });

      expect(res.status).toBe(201);
      expect(res.body.action).toBe('created');
      const rows = await contentRowsOf(memoryStoreId);
      expect(rows).toHaveLength(1);
      expect(rows[0].embedding).toBeNull();
    });

    // With no vector there is nothing to compare against, so a restatement
    // is a second memory over the same row rather than a lost write.
    test('a restatement during the outage creates rather than matches', async () => {
      const memoryStoreId = await createMemoryStore();
      embedderDown = true;

      await write({
        memory_store_id: memoryStoreId,
        content: 'Fact written during an outage',
      });
      const second = await write({
        memory_store_id: memoryStoreId,
        content: 'Fact written during an outage',
      });

      expect(second.body.action).toBe('created');
      const rows = await contentRowsOf(memoryStoreId);
      expect(rows).toHaveLength(1);
      expect(rows[0].embedding).toBeNull();
    });

    // Without the backfill the row stays unembedded forever: every later
    // write of that text is a hash hit, which never reaches the embedder.
    test('the next write of that text after recovery fills the vector in', async () => {
      const memoryStoreId = await createMemoryStore();
      embedderDown = true;
      const first = await write({
        memory_store_id: memoryStoreId,
        content: 'Fact whose vector arrives late',
      });
      embedderDown = false;

      const second = await write({
        memory_store_id: memoryStoreId,
        content: 'Fact whose vector arrives late',
      });

      expect(second.body.action).toBe('skipped');
      expect(second.body.id).toBe(first.body.id);
      const rows = await contentRowsOf(memoryStoreId);
      expect(rows[0].embedding).not.toBeNull();
    });
  });
});
