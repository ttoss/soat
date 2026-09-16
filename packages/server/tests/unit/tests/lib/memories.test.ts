import { db } from 'src/db';
import * as embeddingModule from 'src/lib/embedding';
import { createMemory, writeMemory } from 'src/lib/memories';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * The stub embedder answers every input with the same vector, so two memories
 * would always score 1.0 against each other and only the duplicate band would
 * ever be reachable. Each test therefore rewrites the *stored* vector of the
 * memory it wants matched, to a vector whose cosine against the stub's is a
 * chosen value — which is what puts a write in a chosen band without moving the
 * thresholds off their real defaults.
 *
 * Construction: the stub vector is `0.1` in every component, so negating `k` of
 * them gives `cos = (n - 2k) / n`. Nothing else about the vector matters here.
 */
const DIMENSIONS = 1024;
const STUB_COMPONENT = 0.1;

const vectorWithSimilarity = (target: number): number[] => {
  const flipped = Math.round((DIMENSIONS * (1 - target)) / 2);
  return Array.from({ length: DIMENSIONS }, (_, index) => {
    return index < flipped ? -STUB_COMPONENT : STUB_COMPONENT;
  });
};

/** What `vectorWithSimilarity` actually achieves, after integer rounding. */
const achievedSimilarity = (target: number): number => {
  const flipped = Math.round((DIMENSIONS * (1 - target)) / 2);
  return (DIMENSIONS - 2 * flipped) / DIMENSIONS;
};

const API_ASSERTION = {
  mechanism: 'api',
  principalType: 'user',
  principalId: 'user_writer',
} as const;

describe('writeMemory', () => {
  let adminToken: string;
  let projectId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'writealgoadmin', password: 'supersecret' });
    adminToken = await loginAs('writealgoadmin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Write Algorithm Project' });
    projectId = projectRes.body.id;
  });

  const createMemoryStoreId = async (
    name: string,
    thresholds?: { duplicate_threshold?: number; supersede_threshold?: number }
  ): Promise<number> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/memory-stores')
      .send({ project_id: projectId, name, ...thresholds });
    const memoryStore = await db.MemoryStore.findOne({
      where: { publicId: res.body.id },
    });
    return memoryStore!.id as number;
  };

  /** Moves a stored memory to a chosen cosine from whatever is written next. */
  const setSimilarityTo = async (args: {
    memoryId: string;
    similarity: number;
  }): Promise<void> => {
    const memory = await db.Memory.findOne({
      where: { publicId: args.memoryId },
    });
    const content = await db.MemoryContent.findByPk(memory!.contentId);
    content!.embedding = vectorWithSimilarity(args.similarity);
    await content!.save();
  };

  /** Seeds one memory and places it in the band the caller wants to exercise. */
  const seedAt = async (args: {
    memoryStoreId: number;
    content: string;
    similarity: number;
    tags?: Record<string, string>;
    metadata?: Record<string, unknown>;
  }) => {
    const seeded = await writeMemory({
      memoryStoreId: args.memoryStoreId,
      content: args.content,
      tags: args.tags,
      metadata: args.metadata,
      assertion: API_ASSERTION,
    });
    await setSimilarityTo({
      memoryId: seeded.entry.id,
      similarity: args.similarity,
    });
    return seeded;
  };

  const assertionsFor = async (memoryStoreId: number) => {
    return db.MemoryAssertion.findAll({
      where: { memoryStoreId },
      order: [['createdAt', 'ASC']],
    });
  };

  test('creates a memory below the supersede threshold', async () => {
    const memoryStoreId = await createMemoryStoreId('Create Band');
    await seedAt({
      memoryStoreId,
      content: 'Customer prefers phone calls',
      similarity: 0.5,
    });

    const result = await writeMemory({
      memoryStoreId,
      content: 'Customer fiscal year ends in December',
      assertion: API_ASSERTION,
    });

    expect(result.action).toBe('created');
    expect(result.entry.content).toBe('Customer fiscal year ends in December');
    const memories = await db.Memory.findAll({ where: { memoryStoreId } });
    expect(memories).toHaveLength(2);
  });

  // 0.89 is the safe error the design chooses: just under the supersede floor,
  // a fact that might be a restatement is kept rather than deleted.
  test('creates just below the supersede threshold rather than superseding', async () => {
    const memoryStoreId = await createMemoryStoreId('Just Below Supersede');
    const first = await seedAt({
      memoryStoreId,
      content: 'Delivery window is two weeks',
      similarity: 0.89,
    });

    const result = await writeMemory({
      memoryStoreId,
      content: 'Delivery is usually quick',
      assertion: API_ASSERTION,
    });

    expect(result.action).toBe('created');
    const retained = await db.Memory.findOne({
      where: { publicId: first.entry.id },
    });
    expect(retained!.invalidatedAt).toBeNull();
  });

  test('skips at or above the duplicate threshold and returns the match', async () => {
    const memoryStoreId = await createMemoryStoreId('Duplicate Band');
    const first = await seedAt({
      memoryStoreId,
      content: 'Customer prefers email',
      similarity: 0.97,
    });

    const result = await writeMemory({
      memoryStoreId,
      content: 'The customer would rather be emailed',
      assertion: API_ASSERTION,
    });

    expect(result.action).toBe('skipped');
    expect(result.entry.id).toBe(first.entry.id);
    expect(result.entry.content).toBe('Customer prefers email');
    const memories = await db.Memory.findAll({ where: { memoryStoreId } });
    expect(memories).toHaveLength(1);
  });

  test('supersedes the top match in the supersede band', async () => {
    const memoryStoreId = await createMemoryStoreId('Supersede Band');
    const first = await seedAt({
      memoryStoreId,
      content: 'Customer prefers phone calls',
      similarity: 0.92,
    });

    const result = await writeMemory({
      memoryStoreId,
      content: 'Customer now prefers email',
      assertion: API_ASSERTION,
    });

    expect(result.action).toBe('superseded');
    expect(result.entry.id).not.toBe(first.entry.id);
    expect(result.entry.content).toBe('Customer now prefers email');
    expect(result.entry.invalidated_at).toBeNull();

    const retired = await db.Memory.findOne({
      where: { publicId: first.entry.id },
    });
    const replacement = await db.Memory.findOne({
      where: { publicId: result.entry.id },
    });
    expect(retired!.invalidatedAt).not.toBeNull();
    expect(retired!.supersededByMemoryId).toBe(replacement!.id);
  });

  // The old text surviving is the whole point of superseding rather than
  // rewriting: a merge destroyed the original of both facts.
  test('leaves the retired memory readable with its original text', async () => {
    const memoryStoreId = await createMemoryStoreId('Supersede Lossless');
    const first = await seedAt({
      memoryStoreId,
      content: 'Delivery window is two weeks',
      similarity: 0.92,
    });

    await writeMemory({
      memoryStoreId,
      content: 'Delivery window is four weeks',
      assertion: API_ASSERTION,
    });

    const retired = await db.Memory.findOne({
      where: { publicId: first.entry.id },
      include: [{ model: db.MemoryContent, as: 'content' }],
    });
    expect(retired!.content.content).toBe('Delivery window is two weeks');
  });

  // Dropping the retired memory's tags would silently remove the replacement
  // from every tag-scoped search and policy the original satisfied.
  test('carries the retired memory tags and metadata onto the replacement', async () => {
    const memoryStoreId = await createMemoryStoreId('Supersede Tags');
    await seedAt({
      memoryStoreId,
      content: 'Refund ceiling is 500',
      similarity: 0.92,
      tags: { role: 'manager', env: 'prod' },
      metadata: { evidence: 'high', a: 1 },
    });

    const result = await writeMemory({
      memoryStoreId,
      content: 'Refund ceiling is 900',
      tags: { env: 'staging' },
      metadata: { a: 2 },
      assertion: API_ASSERTION,
    });

    expect(result.action).toBe('superseded');
    expect(result.entry.tags).toEqual({ role: 'manager', env: 'staging' });
    expect(result.entry.metadata).toEqual({ evidence: 'high', a: 2 });
  });

  test('never matches an already invalidated memory', async () => {
    const memoryStoreId = await createMemoryStoreId('Retired Not Candidate');
    const first = await seedAt({
      memoryStoreId,
      content: 'Contact is Priya',
      similarity: 0.92,
    });
    const second = await writeMemory({
      memoryStoreId,
      content: 'Contact is Sam',
      assertion: API_ASSERTION,
    });
    expect(second.action).toBe('superseded');

    const retired = await db.Memory.findOne({
      where: { publicId: first.entry.id },
    });
    const retiredAt = retired!.invalidatedAt;

    // The replacement is left at 1.0 against the next write, so the retired
    // memory is the only one that could be matched below the duplicate band —
    // and it must not be.
    await writeMemory({
      memoryStoreId,
      content: 'Contact is Wei',
      assertion: API_ASSERTION,
    });

    const stillRetired = await db.Memory.findOne({
      where: { publicId: first.entry.id },
    });
    expect(stillRetired!.invalidatedAt).toEqual(retiredAt);
    expect(stillRetired!.supersededByMemoryId).not.toBeNull();
  });

  describe('threshold resolution', () => {
    test("uses the store's supersede threshold when the call sets none", async () => {
      // A store that trusts its corpus less: 0.92 is a duplicate here, not a
      // change, so the write that would supersede by default is skipped.
      const memoryStoreId = await createMemoryStoreId('Store Thresholds', {
        duplicate_threshold: 0.9,
        supersede_threshold: 0.8,
      });
      const first = await seedAt({
        memoryStoreId,
        content: 'Store threshold first fact',
        similarity: 0.92,
      });

      const result = await writeMemory({
        memoryStoreId,
        content: 'Store threshold second fact',
        assertion: API_ASSERTION,
      });

      expect(result.action).toBe('skipped');
      expect(result.entry.id).toBe(first.entry.id);
    });

    test('a per-call threshold overrides the store default', async () => {
      const memoryStoreId = await createMemoryStoreId('Call Overrides Store', {
        duplicate_threshold: 0.9,
        supersede_threshold: 0.8,
      });
      await seedAt({
        memoryStoreId,
        content: 'Override first fact',
        similarity: 0.92,
      });

      const result = await writeMemory({
        memoryStoreId,
        content: 'Override second fact',
        // Back above the match, so the same pair supersedes instead of skipping.
        duplicateThreshold: 0.95,
        assertion: API_ASSERTION,
      });

      expect(result.action).toBe('superseded');
    });
  });

  describe('shared content rows', () => {
    // Two memories share a row through the declared door, which does not dedup.
    // `writeMemory` can never produce the pair: restating a store's own text is
    // a hash hit, and a hash hit compares the row against itself at 1.0, so it
    // always skips.
    test('stores one content row per distinct text per store', async () => {
      const memoryStoreId = await createMemoryStoreId('Shared Content');
      const first = await createMemory({
        memoryStoreId,
        content: 'A repeated sentence',
        assertion: API_ASSERTION,
      });
      const second = await createMemory({
        memoryStoreId,
        content: 'A repeated sentence',
        assertion: API_ASSERTION,
      });

      const contents = await db.MemoryContent.findAll({
        where: { memoryStoreId },
      });
      expect(contents).toHaveLength(1);
      const memories = await db.Memory.findAll({
        where: { publicId: [first.id, second.id] },
      });
      expect(memories[0].contentId).toBe(memories[1].contentId);
    });

    test('restating a store text is a skip, not a second memory', async () => {
      const memoryStoreId = await createMemoryStoreId('Restated Text');
      const first = await seedAt({
        memoryStoreId,
        content: 'A repeated sentence',
        // Far from anything else, so only the shared row itself can match.
        similarity: 0.5,
      });

      const result = await writeMemory({
        memoryStoreId,
        content: 'A repeated sentence',
        assertion: API_ASSERTION,
      });

      expect(result.action).toBe('skipped');
      expect(result.entry.id).toBe(first.entry.id);
    });

    // Normalization is what makes the hash a dedup key rather than a checksum:
    // the same sentence typed with different spacing is the same content.
    test('hashes trimmed, whitespace-collapsed content', async () => {
      const memoryStoreId = await createMemoryStoreId('Hash Normalization');
      await seedAt({
        memoryStoreId,
        content: 'Spacing  varies   here',
        similarity: 0.5,
      });

      await writeMemory({
        memoryStoreId,
        content: '  Spacing varies here  ',
        assertion: API_ASSERTION,
      });

      const contents = await db.MemoryContent.findAll({
        where: { memoryStoreId },
      });
      expect(contents).toHaveLength(1);
      // The first writer's spelling is what is stored: the hash says the two
      // are the same content, not which spelling wins.
      expect(contents[0].content).toBe('Spacing  varies   here');
    });

    test('keeps content rows per store, never across stores', async () => {
      const first = await createMemoryStoreId('Cross Store A');
      const second = await createMemoryStoreId('Cross Store B');
      await writeMemory({
        memoryStoreId: first,
        content: 'Shared across stores',
        assertion: API_ASSERTION,
      });
      await writeMemory({
        memoryStoreId: second,
        content: 'Shared across stores',
        assertion: API_ASSERTION,
      });

      expect(
        await db.MemoryContent.count({ where: { memoryStoreId: first } })
      ).toBe(1);
      expect(
        await db.MemoryContent.count({ where: { memoryStoreId: second } })
      ).toBe(1);
    });
  });

  // The embedder is external I/O the suite cannot take down, so the rejection
  // is injected to drive the `.catch()` resilience branches — the write itself,
  // and everything it touches, still runs for real against the database.
  describe('when the embedder is unavailable', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('stores the fact without a vector rather than losing it', async () => {
      const memoryStoreId = await createMemoryStoreId('Embedding Down');
      jest
        .spyOn(embeddingModule, 'getEmbedding')
        .mockRejectedValueOnce(new Error('embedding provider unavailable'));

      const result = await writeMemory({
        memoryStoreId,
        content: 'Fact written while the embedder was down',
        assertion: API_ASSERTION,
      });

      expect(result.action).toBe('created');
      const contents = await db.MemoryContent.findAll({
        where: { memoryStoreId },
      });
      expect(contents).toHaveLength(1);
      expect(contents[0].embedding).toBeNull();
    });

    test('leaves the row unembedded while the embedder is still down', async () => {
      const memoryStoreId = await createMemoryStoreId('Embedding Still Down');
      const getEmbedding = jest.spyOn(embeddingModule, 'getEmbedding');
      getEmbedding.mockRejectedValue(new Error('embedding provider unavailable'));

      await writeMemory({
        memoryStoreId,
        content: 'Fact written during an outage',
        assertion: API_ASSERTION,
      });
      const second = await writeMemory({
        memoryStoreId,
        content: 'Fact written during an outage',
        assertion: API_ASSERTION,
      });

      // Still one row, still no vector, and the write is not lost.
      expect(second.action).toBe('created');
      const contents = await db.MemoryContent.findAll({
        where: { memoryStoreId },
      });
      expect(contents).toHaveLength(1);
      expect(contents[0].embedding).toBeNull();
    });

    // Without this the row would stay unembedded forever: every later write of
    // that text is a hash hit, which never reaches the embedder again.
    test('fills in the missing vector on the next write of that text', async () => {
      const memoryStoreId = await createMemoryStoreId('Embedding Recovers');
      jest
        .spyOn(embeddingModule, 'getEmbedding')
        .mockRejectedValueOnce(new Error('embedding provider unavailable'));

      await writeMemory({
        memoryStoreId,
        content: 'Fact whose vector arrives late',
        assertion: API_ASSERTION,
      });

      await writeMemory({
        memoryStoreId,
        content: 'Fact whose vector arrives late',
        assertion: API_ASSERTION,
      });

      const contents = await db.MemoryContent.findAll({
        where: { memoryStoreId },
      });
      expect(contents).toHaveLength(1);
      expect(contents[0].embedding).not.toBeNull();
    });
  });

  // Concurrent writes of the same new text all miss the hash lookup and all
  // insert; the unique index decides between them, and the losers must read the
  // winner's row rather than failing a write whose content is already stored.
  test('keeps one content row when several writes claim the same new text at once', async () => {
    const memoryStoreId = await createMemoryStoreId('Content Race');

    const results = await Promise.all(
      Array.from({ length: 4 }, () => {
        return writeMemory({
          memoryStoreId,
          content: 'Contended sentence',
          assertion: API_ASSERTION,
        });
      })
    );

    results.forEach((result) => {
      expect(result.entry.content).toBe('Contended sentence');
    });
    const contents = await db.MemoryContent.findAll({
      where: { memoryStoreId },
    });
    expect(contents).toHaveLength(1);
  });

  describe('assertions', () => {
    test('records one assertion per write, whatever the outcome', async () => {
      const memoryStoreId = await createMemoryStoreId('Assertion Per Write');
      await seedAt({
        memoryStoreId,
        content: 'Assertion first fact',
        similarity: 0.97,
      });
      await writeMemory({
        memoryStoreId,
        content: 'Assertion duplicate fact',
        assertion: API_ASSERTION,
      });

      const assertions = await assertionsFor(memoryStoreId);
      expect(
        assertions.map((assertion) => {
          return assertion.outcome;
        })
      ).toEqual(['created', 'skipped']);
      expect(assertions[0].publicId).toMatch(/^massert_/);
    });

    // A skip is the outcome that left no record at all before this table.
    test('points a skipped assertion at the memory that matched', async () => {
      const memoryStoreId = await createMemoryStoreId('Assertion Skip Target');
      const first = await seedAt({
        memoryStoreId,
        content: 'Skip target fact',
        similarity: 0.97,
      });
      await writeMemory({
        memoryStoreId,
        content: 'Skip target restated',
        assertion: API_ASSERTION,
      });

      const assertions = await assertionsFor(memoryStoreId);
      const matched = await db.Memory.findOne({
        where: { publicId: first.entry.id },
      });
      expect(assertions[1].outcome).toBe('skipped');
      expect(assertions[1].memoryId).toBe(matched!.id);
      // The text as asserted, which is not the memory's text.
      const asserted = await db.MemoryContent.findByPk(assertions[1].contentId);
      expect(asserted!.content).toBe('Skip target restated');
    });

    test('points a superseded assertion at the replacement memory', async () => {
      const memoryStoreId = await createMemoryStoreId('Assertion Supersede');
      await seedAt({
        memoryStoreId,
        content: 'Supersede assertion first',
        similarity: 0.92,
      });
      const result = await writeMemory({
        memoryStoreId,
        content: 'Supersede assertion second',
        assertion: API_ASSERTION,
      });

      const assertions = await assertionsFor(memoryStoreId);
      const replacement = await db.Memory.findOne({
        where: { publicId: result.entry.id },
      });
      expect(assertions[1].outcome).toBe('superseded');
      expect(assertions[1].memoryId).toBe(replacement!.id);
      // The retired memory is the reverse join, not a column here.
      const retired = await db.Memory.findOne({
        where: { supersededByMemoryId: replacement!.id },
      });
      expect(retired).not.toBeNull();
    });

    test('records the mechanism, principal and deciding similarity', async () => {
      const memoryStoreId = await createMemoryStoreId('Assertion Fields');
      const ruleAssertion = {
        mechanism: 'rule',
        principalType: 'agent',
        principalId: 'agent_writer',
      } as const;

      await seedAt({
        memoryStoreId,
        content: 'Mechanism fact',
        similarity: 0.97,
      });
      await writeMemory({
        memoryStoreId,
        content: 'Mechanism fact restated',
        assertion: ruleAssertion,
      });

      const assertions = await assertionsFor(memoryStoreId);
      // Null on the first write: nothing existed to compare against.
      expect(assertions[0].similarity).toBeNull();
      expect(assertions[1].mechanism).toBe('rule');
      expect(assertions[1].principalType).toBe('agent');
      expect(assertions[1].principalId).toBe('agent_writer');
      // Null `ruleId` is the built-in extractor, which has no rule row yet.
      expect(assertions[1].ruleId).toBeNull();
      expect(assertions[1].similarity).toBeCloseTo(achievedSimilarity(0.97), 5);
    });
  });
});
