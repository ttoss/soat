import { db } from 'src/db';
import { createDocument } from 'src/lib/documents';
import * as embeddingModule from 'src/lib/embedding';
import { searchKnowledge } from 'src/lib/knowledge';
import { resolveDocumentSearch } from 'src/lib/knowledgeDocuments';
import { resolveMemoryStoreSearch } from 'src/lib/knowledgeMemory';
import { writeMemory } from 'src/lib/memories';
import { createMemoryStore } from 'src/lib/memoryStores';
import { createProject } from 'src/lib/projects';

import { SEED_ASSERTION } from '../../fixtures/memoryWrites';

/**
 * The recency blend: after fusion, a **memory store** result's `score` is multiplied
 * by `2 ^ (−age_days / half_life_days)`, read from `updated_at`. Document
 * chunks are untouched — a fact goes stale, a paragraph of a manual does not.
 *
 * Ranking is placed by hand here for the same reason `knowledgeHybridSearch`
 * does it: the suite's embedder answers every input with one vector, so without
 * a per-fixture stub every cosine ties and no ordering is observable.
 */

const QUERY = 'depot rotation probe';

const dim = Number(process.env.EMBEDDING_DIMENSIONS);

const vector = (args: { a: number; b: number }): number[] => {
  const values = new Array<number>(dim).fill(0);
  values[0] = args.a;
  values[1] = args.b;
  return values;
};

const QUERY_VECTOR = vector({ a: 1, b: 0 });
/** Cosine ≈ 0.990 — nearest, so it takes rank 1 before any blend. */
const NEAREST = vector({ a: 0.99, b: 0.14 });
/** Cosine ≈ 0.980 — always one rank behind {@link NEAREST}. */
const SECOND = vector({ a: 0.98, b: 0.2 });
/** Cosine ≈ 0.958 — rank 3. */
const THIRD = vector({ a: 0.96, b: 0.28 });

/**
 * Two restatements of one fact, one superseded. They are near-identical on
 * purpose and therefore live in different memories: `writeMemory` dedups
 * at cosine 0.95 within a memory store, so same-container twins are impossible.
 *
 * Neither shares a token with {@link QUERY}, so the lexical channel stays empty
 * and fusion runs over the vector ranking alone — one list, so a result's fused
 * score is exactly `1 / (k + rank)` and the arithmetic the blend has to
 * overturn is legible.
 */
const CONTENT = {
  staleEntry: 'The northern yard rotates its trailers every 14 days.',
  freshEntry: 'The northern yard rotates its trailers every 21 days.',
  document: 'Yard handbook, trailer rotation appendix.',
};

const FIXTURE_VECTORS = new Map<string, number[]>([
  [CONTENT.staleEntry, NEAREST],
  [CONTENT.freshEntry, SECOND],
  [CONTENT.document, THIRD],
]);

const mockEmbedding = () => {
  return jest
    .spyOn(embeddingModule, 'getEmbedding')
    .mockImplementation(async (args: { text: string }) => {
      return [...(FIXTURE_VECTORS.get(args.text) ?? QUERY_VECTOR)];
    });
};

const MS_PER_DAY = 86400000;

/**
 * Age is what the blend reads, and no product path can set `updated_at` — the
 * column is Sequelize-managed, so every model-level write stamps the current
 * time over an explicit value (`silent`, `fields` and a forced `changed()` were
 * all measured). Raw SQL is the only way a test can place it, and a test that
 * cannot place it proves nothing.
 */
const backdate = async (args: {
  table: 'memories' | 'document_chunks';
  publicId: string;
  days: number;
}) => {
  await db.sequelize.query(
    `UPDATE ${args.table} SET updated_at = :updatedAt WHERE public_id = :publicId`,
    {
      replacements: {
        updatedAt: new Date(Date.now() - args.days * MS_PER_DAY),
        publicId: args.publicId,
      },
    }
  );
};

type Fixtures = {
  projectId: number;
  memoryStoreIds: string[];
  staleEntryId: string;
  freshEntryId: string;
  documentId: string;
};

const seed = async (): Promise<Fixtures> => {
  const project = await createProject({ name: 'Knowledge Recency Blend' });
  const projectRow = await db.Project.findOne({
    where: { publicId: project.id },
  });
  const projectId = projectRow!.id as number;

  const document = await createDocument({
    createdByUserId: null,
    projectId,
    content: CONTENT.document,
    path: '/yard/handbook.txt',
  });
  const chunk = await db.DocumentChunk.findOne({
    include: [
      {
        model: db.Document,
        as: 'document',
        where: { publicId: document.id },
        required: true,
      },
    ],
  });
  // Old enough that a blend reaching document results would visibly move this
  // one; its score staying put is what says the blend never reaches them.
  await backdate({
    table: 'document_chunks',
    publicId: chunk!.publicId,
    days: 365,
  });

  const current = await createMemoryStore({
    projectId,
    name: 'Yard — current',
  });
  const prior = await createMemoryStore({ projectId, name: 'Yard — prior' });
  const memoryStoreRow = async (publicId: string) => {
    const row = await db.MemoryStore.findOne({ where: { publicId } });
    return row!.id as number;
  };

  const fresh = await writeMemory({
    memoryStoreId: await memoryStoreRow(current.id),
    content: CONTENT.freshEntry,
    assertion: SEED_ASSERTION,
  });
  const stale = await writeMemory({
    memoryStoreId: await memoryStoreRow(prior.id),
    content: CONTENT.staleEntry,
    assertion: SEED_ASSERTION,
  });
  await backdate({
    table: 'memories',
    publicId: stale.entry.id,
    days: 60,
  });

  return {
    projectId,
    memoryStoreIds: [current.id, prior.id],
    staleEntryId: stale.entry.id,
    freshEntryId: fresh.entry.id,
    documentId: document.id,
  };
};

describe('knowledge recency blend', () => {
  let fixtures: Fixtures;

  const originalHalfLife = process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS;

  beforeAll(async () => {
    mockEmbedding();
    fixtures = await seed();
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    mockEmbedding();
    delete process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalHalfLife === undefined) {
      delete process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS;
    } else {
      process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS = originalHalfLife;
    }
  });

  const search = async (args?: { recencyHalfLifeDays?: number }) => {
    return searchKnowledge({
      projectIds: [fixtures.projectId],
      billingProjectId: fixtures.projectId,
      query: QUERY,
      memoryStoreIds: fixtures.memoryStoreIds,
      recencyHalfLifeDays: args?.recencyHalfLifeDays,
    });
  };

  /** The one thing the blend may move: which result is where, and its score. */
  const ordering = (results: Awaited<ReturnType<typeof search>>) => {
    return results.map((result) => {
      return {
        id:
          result.source_type === 'document'
            ? result.document_id
            : result.memory_id,
        score: result.score,
      };
    });
  };

  test('ranks the newer of two equivalent facts first', async () => {
    // Fusion hands the stale entry rank 1 and the fresh one rank 2 — 1/61
    // against 1/62. Sixty days is two half-lives at 30, quartering the stale
    // score, which is far more than that gap: it lands behind the document
    // chunk fusion put at rank 3 as well.
    const results = await search({ recencyHalfLifeDays: 30 });

    expect(
      ordering(results).map((result) => {
        return result.id;
      })
    ).toEqual([
      fixtures.freshEntryId,
      fixtures.documentId,
      fixtures.staleEntryId,
    ]);
  });

  test('reads the blended score off the fused value, not the cosine', async () => {
    const results = await search({ recencyHalfLifeDays: 30 });
    const stale = results.find((result) => {
      return (
        result.source_type === 'memory' &&
        result.memory_id === fixtures.staleEntryId
      );
    });

    // It entered fusion at rank 1 of the only ranked list, so its fused score
    // was 1/61; sixty days is two half-lives.
    // Not exact: the fixture is sixty days old plus however long this test
    // took to reach the search, and the decay is continuous.
    expect(stale!.score).toBeCloseTo((1 / 61) * 0.25, 7);
    // Raw cosine is pinned by the contract and never blended.
    expect(stale!.similarity_score).toBeCloseTo(0.99, 2);
  });

  test('leaves a document chunk untouched however old it is', async () => {
    const scoreOf = (results: Awaited<ReturnType<typeof search>>) => {
      return results.find((result) => {
        return (
          result.source_type === 'document' &&
          result.document_id === fixtures.documentId
        );
      })!.score;
    };

    const off = await search();
    const on = await search({ recencyHalfLifeDays: 30 });

    expect(scoreOf(on)).toBe(scoreOf(off));
  });

  test('leaves a document chunk untouched at the documents-only entry point', async () => {
    process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS = '30';
    const blended = await resolveDocumentSearch({
      projectIds: [fixtures.projectId],
      billingProjectId: fixtures.projectId,
      config: { search: QUERY },
    });

    delete process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS;
    const plain = await resolveDocumentSearch({
      projectIds: [fixtures.projectId],
      billingProjectId: fixtures.projectId,
      config: { search: QUERY },
    });

    expect(blended.length).toBeGreaterThan(0);
    expect(
      blended.map((result) => {
        return { id: result.chunk_id, score: result.score };
      })
    ).toEqual(
      plain.map((result) => {
        return { id: result.chunk_id, score: result.score };
      })
    );
  });

  test('decays the same way at the memory-only entry point', async () => {
    // `resolveMemoryStoreSearch` fuses one store's two shards rather than four, so
    // it reaches the blend by its own path — and every result it can return is
    // a fact, which is what its `isMemory` answers.
    const results = await resolveMemoryStoreSearch({
      projectIds: [fixtures.projectId],
      billingProjectId: fixtures.projectId,
      config: {
        memoryStoreIds: fixtures.memoryStoreIds,
        search: QUERY,
        recencyHalfLifeDays: 30,
        limit: 10,
      },
    });

    expect(
      results.map((result) => {
        return result.memory_id;
      })
    ).toEqual([fixtures.freshEntryId, fixtures.staleEntryId]);
  });

  test('reports signal provenance at both single-store entry points', async () => {
    // Both entry points fuse through `fuseCandidates`, so the field arrives by
    // the same path the cross-store search uses — pinned here because each
    // reaches it with its own shard shape.
    const documents = await resolveDocumentSearch({
      projectIds: [fixtures.projectId],
      billingProjectId: fixtures.projectId,
      config: { search: QUERY },
    });
    const memories = await resolveMemoryStoreSearch({
      projectIds: [fixtures.projectId],
      billingProjectId: fixtures.projectId,
      config: {
        memoryStoreIds: fixtures.memoryStoreIds,
        search: QUERY,
        limit: 10,
      },
    });

    expect(documents.length).toBeGreaterThan(0);
    expect(memories.length).toBeGreaterThan(0);
    for (const result of [...documents, ...memories]) {
      expect(Object.keys(result.signals ?? {}).length).toBeGreaterThan(0);
    }
  });

  test('changes nothing with no half-life configured anywhere', async () => {
    const results = await search();

    // The default is off, so an upgrade reorders nothing: the stale entry is
    // still nearest the query and still first.
    expect(ordering(results).slice(0, 2)).toEqual([
      { id: fixtures.staleEntryId, score: 1 / 61 },
      { id: fixtures.freshEntryId, score: 1 / 62 },
    ]);
  });

  test('a request half-life of 0 returns the pre-blend order under a deployment default', async () => {
    const off = await search();

    process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS = '30';
    const blended = await search();
    const disabled = await search({ recencyHalfLifeDays: 0 });

    expect(ordering(disabled)).toEqual(ordering(off));
    expect(ordering(blended)).not.toEqual(ordering(off));
  });

  test('takes the deployment default when the request names none', async () => {
    process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS = '30';
    const results = await search();

    expect(ordering(results)[0].id).toBe(fixtures.freshEntryId);
  });

  test('falls back to the deployment default on an invalid request value', async () => {
    process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS = '30';
    const results = await search({ recencyHalfLifeDays: -5 });

    expect(ordering(results)[0].id).toBe(fixtures.freshEntryId);
  });

  test('leaves the write path reading raw cosine', async () => {
    // The blend is a retrieval-time signal. The dedup shortlist reads the `<=>`
    // distance directly, so an entry old enough for the blend to bury is still
    // the duplicate a restatement of it merges into.
    process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS = '1';
    const priorId = await db.MemoryStore.findOne({
      where: { publicId: fixtures.memoryStoreIds[1] },
    });

    const written = await writeMemory({
      memoryStoreId: priorId!.id as number,
      content: CONTENT.staleEntry,
      assertion: SEED_ASSERTION,
    });

    expect(written.action).toBe('skipped');
    expect(written.entry.id).toBe(fixtures.staleEntryId);
  });
});
