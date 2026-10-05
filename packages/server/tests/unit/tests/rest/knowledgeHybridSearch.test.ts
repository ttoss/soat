import { db } from 'src/db';

import { installEmbeddingStub } from '../../embeddingStub';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * Ranking through `POST /knowledge/search` with every vector placed by hand.
 *
 * The suite-wide embedder answers one constant vector, so no ordering is
 * observable through it. This file runs its own embedding endpoint, which
 * answers each fixture text with the vector its name promises and every other
 * text — each query — with {@link QUERY_VECTOR}. Nothing in the server is
 * replaced: the documents and memories are written, embedded and searched
 * through their routes.
 */
const dim = Number(process.env.EMBEDDING_DIMENSIONS);

const vector = (args: { a: number; b: number }): number[] => {
  const values = new Array<number>(dim).fill(0);
  values[0] = args.a;
  values[1] = args.b;
  return values;
};

const QUERY_VECTOR = vector({ a: 1, b: 0 });
/** Cosine 0 against the query — unreachable through the vector channel. */
const FAR_VECTOR = vector({ a: 0, b: 1 });
/** Cosine ≈ 0.990 — the closest fixture to the query. */
const NEAR_VECTOR = vector({ a: 0.99, b: 0.14 });
/** Cosine ≈ 0.980 — close, but always one rank behind {@link NEAR_VECTOR}. */
const SECOND_VECTOR = vector({ a: 0.98, b: 0.2 });
/** Cosine ≈ 0.958 — rank 3. */
const THIRD_VECTOR = vector({ a: 0.96, b: 0.28 });

/**
 * A unit vector at the given cosine to {@link QUERY_VECTOR}, with its remainder
 * on `axis`. Two fixtures on different axes are `cosine²` similar to each
 * other, which keeps memories below the 0.95 dedup band while they all sit at
 * one cosine to the query.
 */
const atCosine = (args: { cosine: number; axis: number }): number[] => {
  const values = new Array<number>(dim).fill(0);
  values[0] = args.cosine;
  values[args.axis] = Math.sqrt(1 - args.cosine * args.cosine);
  return values;
};

const placed = new Map<string, number[]>();
let embedderDown = false;

installEmbeddingStub({
  embed: (input) => {
    if (embedderDown) throw new Error('embedding provider unavailable');
    return [...(placed.get(input) ?? QUERY_VECTOR)];
  },
});

const RARE_TOKEN = 'ZQXJ-9001';
const OTHER_TOKEN = 'WPLM-4711';

type SearchResult = {
  source_type: 'document' | 'memory';
  document_id?: string;
  memory_id?: string;
  path?: string;
  score?: number;
  similarity_score?: number;
  signals?: { vector?: number; lexical?: number };
};

const idOf = (result: SearchResult): string | undefined => {
  return result.source_type === 'document'
    ? result.document_id
    : result.memory_id;
};

describe('POST /api/v1/knowledge/search — hybrid ranking', () => {
  let adminToken: string;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const createProject = async (name: string): Promise<string> => {
    const res = await asAdmin().post('/api/v1/projects').send({ name });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createDocument = async (args: {
    projectId: string;
    content: string;
    path: string;
    vector?: number[];
  }): Promise<string> => {
    if (args.vector) placed.set(args.content, args.vector);
    const res = await asAdmin().post('/api/v1/documents').send({
      project_id: args.projectId,
      content: args.content,
      path: args.path,
    });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createMemoryStore = async (args: {
    projectId: string;
    name: string;
  }): Promise<string> => {
    const res = await asAdmin()
      .post('/api/v1/memory-stores')
      .send({ project_id: args.projectId, name: args.name });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createMemory = async (args: {
    memoryStoreId: string;
    content: string;
    vector?: number[];
  }): Promise<string> => {
    if (args.vector) placed.set(args.content, args.vector);
    const res = await asAdmin().post('/api/v1/memories').send({
      memory_store_id: args.memoryStoreId,
      content: args.content,
    });
    expect(res.status).toBe(201);
    expect(res.body.action).toBe('created');
    return res.body.id;
  };

  const search = async (body: Record<string, unknown>) => {
    const res = await asAdmin().post('/api/v1/knowledge/search').send(body);
    expect(res.status).toBe(200);
    return res.body.results as SearchResult[];
  };

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'hybridadmin', password: 'supersecret' });
    adminToken = await loginAs('hybridadmin', 'supersecret');
  });

  describe('lexical and vector channels', () => {
    let projectId: string;
    let memoryStoreId: string;
    let lexicalOnlyDocumentId: string;
    let vectorOnlyDocumentId: string;
    let bothSignalsDocumentId: string;
    let lexicalOnlyMemoryId: string;
    let vectorOnlyMemoryId: string;

    beforeAll(async () => {
      projectId = await createProject('Hybrid Knowledge Search');
      lexicalOnlyDocumentId = await createDocument({
        projectId,
        content: `Replacement part ${RARE_TOKEN} ships from the Lisbon warehouse.`,
        path: '/parts/lexical-only.txt',
        vector: FAR_VECTOR,
      });
      vectorOnlyDocumentId = await createDocument({
        projectId,
        content: 'Warehouse logistics overview with no part numbers at all.',
        path: '/parts/vector-only.txt',
        vector: NEAR_VECTOR,
      });
      bothSignalsDocumentId = await createDocument({
        projectId,
        content: `Warehouse logistics notes that also name ${OTHER_TOKEN}.`,
        path: '/parts/both-signals.txt',
        vector: SECOND_VECTOR,
      });

      memoryStoreId = await createMemoryStore({
        projectId,
        name: 'Parts desk',
      });
      lexicalOnlyMemoryId = await createMemory({
        memoryStoreId,
        content: `The customer always orders ${RARE_TOKEN} in pairs.`,
        vector: FAR_VECTOR,
      });
      vectorOnlyMemoryId = await createMemory({
        memoryStoreId,
        content: 'The customer prefers warehouse pickup over courier delivery.',
        vector: NEAR_VECTOR,
      });
    });

    test('returns a document chunk holding the exact token below the similarity floor', async () => {
      const results = await search({
        project_id: projectId,
        query: RARE_TOKEN,
        min_similarity: 0.5,
      });

      const hit = results.find((result) => {
        return result.document_id === lexicalOnlyDocumentId;
      });
      expect(hit).toBeDefined();
      // The floor governs the vector candidates; an exact token match is its
      // own evidence.
      expect(hit!.similarity_score).toBeLessThan(0.5);
    });

    test('returns a memory holding the exact token below the similarity floor', async () => {
      const results = await search({
        project_id: projectId,
        query: RARE_TOKEN,
        memory_store_ids: [memoryStoreId],
        include_documents: false,
        min_similarity: 0.5,
      });

      const hit = results.find((result) => {
        return result.memory_id === lexicalOnlyMemoryId;
      });
      expect(hit).toBeDefined();
      expect(hit!.similarity_score).toBeLessThan(0.5);
    });

    test('the similarity floor still removes a vector-only candidate', async () => {
      const results = await search({
        project_id: projectId,
        query: RARE_TOKEN,
        min_similarity: 0.999,
      });

      expect(results.map(idOf)).not.toContain(vectorOnlyDocumentId);
    });

    test('fuses four lists when both signals and both sources apply', async () => {
      const results = await search({
        project_id: projectId,
        query: RARE_TOKEN,
        memory_store_ids: [memoryStoreId],
      });

      // One contribution from each ranked list: a document and a memory only
      // the lexical query reaches, and a document and a memory only the vector
      // query reaches.
      expect(results.map(idOf)).toEqual(
        expect.arrayContaining([
          lexicalOnlyDocumentId,
          vectorOnlyDocumentId,
          lexicalOnlyMemoryId,
          vectorOnlyMemoryId,
        ])
      );
    });

    test('a result both signals rank outranks one only a single signal ranks', async () => {
      const results = await search({
        project_id: projectId,
        query: OTHER_TOKEN,
      });

      // Only *second* nearest, so a vector-only ranking puts the vector-only
      // document first; the lexical list is what overturns that.
      expect(idOf(results[0])).toBe(bothSignalsDocumentId);
    });

    test('measures the cosine of a lexical-only hit too', async () => {
      const results = await search({
        project_id: projectId,
        query: RARE_TOKEN,
        memory_store_ids: [memoryStoreId],
      });

      expect(results.length).toBeGreaterThan(0);
      for (const result of results) {
        expect(Number.isFinite(result.similarity_score)).toBe(true);
      }
    });

    test('score is the fused value, not the cosine', async () => {
      const [hit] = await search({ project_id: projectId, query: RARE_TOKEN });

      expect(hit.score).not.toBe(hit.similarity_score);
      // `1 / (60 + 1)` is the most one list contributes at `k = 60`.
      expect(hit.score).toBeLessThanOrEqual(2 / 61);
    });

    test('reports both channels for a result both of them ranked', async () => {
      const results = await search({
        project_id: projectId,
        query: OTHER_TOKEN,
      });

      const both = results.find((result) => {
        return result.document_id === bothSignalsDocumentId;
      });
      // The only fixture carrying the token, so it leads the lexical list. By
      // cosine it is third: a bare `query` reaches memories too, and both
      // `NEAR_VECTOR` fixtures — one document, one memory — are closer. The
      // two stores interleave in one channel's ranking.
      expect(both!.signals).toEqual({ vector: 3, lexical: 1 });
    });

    test('omits the channel that did not rank a result', async () => {
      const results = await search({
        project_id: projectId,
        query: OTHER_TOKEN,
      });

      const vectorOnly = results.find((result) => {
        return result.document_id === vectorOnlyDocumentId;
      });
      expect(vectorOnly!.signals?.vector).toBe(1);
      // Absent rather than `null`: the channel returned nothing, which is not
      // the same as ranking it last.
      expect(vectorOnly!.signals).not.toHaveProperty('lexical');
    });

    test('ranks within a channel across both stores, not within the fused order', async () => {
      const results = await search({
        project_id: projectId,
        query: RARE_TOKEN,
        memory_store_ids: [memoryStoreId],
      });

      const byVectorRank = results
        .filter((result) => {
          return result.signals?.vector !== undefined;
        })
        .sort((a, b) => {
          return a.signals!.vector! - b.signals!.vector!;
        });
      expect(byVectorRank.length).toBeGreaterThan(1);
      for (const [index, result] of byVectorRank.entries()) {
        expect(result.signals!.vector).toBe(index + 1);
        if (index === 0) continue;
        expect(result.similarity_score).toBeLessThanOrEqual(
          byVectorRank[index - 1].similarity_score!
        );
      }

      const lexicalRanks = results
        .map((result) => {
          return result.signals?.lexical;
        })
        .filter((rank): rank is number => {
          return rank !== undefined;
        })
        .sort((a, b) => {
          return a - b;
        });
      expect(lexicalRanks).toEqual([1, 2]);
    });

    describe('degrade paths', () => {
      const originalTextSearchConfig = process.env.KNOWLEDGE_TEXT_SEARCH_CONFIG;
      const originalProvider = process.env.EMBEDDING_PROVIDER;

      // Restored here rather than after the awaited call: a rejection there
      // would leave the setting in place for every later test in the file.
      afterEach(() => {
        embedderDown = false;
        process.env.EMBEDDING_PROVIDER = originalProvider;
        if (originalTextSearchConfig === undefined) {
          delete process.env.KNOWLEDGE_TEXT_SEARCH_CONFIG;
        } else {
          process.env.KNOWLEDGE_TEXT_SEARCH_CONFIG = originalTextSearchConfig;
        }
      });

      test('answers from the lexical channel alone when the embedding provider fails', async () => {
        embedderDown = true;

        const results = await search({
          project_id: projectId,
          query: RARE_TOKEN,
          memory_store_ids: [memoryStoreId],
        });

        const document = results.find((result) => {
          return result.document_id === lexicalOnlyDocumentId;
        });
        const memory = results.find((result) => {
          return result.memory_id === lexicalOnlyMemoryId;
        });
        // No query vector, so no cosine to report on either store.
        expect(document!.similarity_score).toBeUndefined();
        expect(memory!.similarity_score).toBeUndefined();
        for (const result of results) {
          expect(result.signals).not.toHaveProperty('vector');
        }
      });

      test('surfaces a misconfigured provider instead of degrading', async () => {
        // Degrading here would answer `200 []` forever: under the default
        // `simple` configuration a natural-language query matches nothing
        // lexically, so a server missing its provider would look like a
        // corpus with no relevant rows.
        delete process.env.EMBEDDING_PROVIDER;

        const res = await asAdmin()
          .post('/api/v1/knowledge/search')
          .send({ project_id: projectId, query: RARE_TOKEN });

        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('EMBEDDING_NOT_CONFIGURED');
      });

      test('answers from the vector channel alone when the lexical query fails', async () => {
        process.env.KNOWLEDGE_TEXT_SEARCH_CONFIG = 'not_a_real_config';

        const results = await search({
          project_id: projectId,
          query: RARE_TOKEN,
          memory_store_ids: [memoryStoreId],
        });

        // With the lexical channel gone the order is the vector one, nearest
        // cosine first.
        expect(idOf(results[0])).toBe(vectorOnlyDocumentId);
        expect(results[0].signals).toEqual({ vector: 1 });
        for (const result of results) {
          expect(result.signals).not.toHaveProperty('lexical');
        }
      });
    });
  });

  describe('rows without an embedding', () => {
    const CONTENT = 'The courier left a note about the loading dock.';
    let projectId: string;
    let memoryStoreId: string;
    let documentId: string;

    beforeAll(async () => {
      projectId = await createProject('Unembedded rows');
      memoryStoreId = await createMemoryStore({ projectId, name: 'Turns' });
      // Written while the provider is down, so both rows are stored without
      // a vector — the state a conversation turn is also chunked in whenever
      // its project's retrieval default is `none`.
      embedderDown = true;
      try {
        documentId = await createDocument({
          projectId,
          content: CONTENT,
          path: '/turns/unembedded.txt',
        });
        await createMemory({ memoryStoreId, content: CONTENT });
      } finally {
        embedderDown = false;
      }
    });

    // A NULL embedding yields a NULL distance, which sorts last and would
    // still fill a `limit` slot in a scope holding fewer real candidates.
    test('a document chunk with no vector is not a vector candidate', async () => {
      const results = await search({
        project_id: projectId,
        query: 'xylophone manufacturing tolerances',
        document_paths: ['/turns/'],
      });

      expect(results).toHaveLength(0);
    });

    test('a memory with no vector is not a vector candidate', async () => {
      const results = await search({
        project_id: projectId,
        query: 'xylophone manufacturing tolerances',
        memory_store_ids: [memoryStoreId],
        include_documents: false,
      });

      expect(results).toHaveLength(0);
    });

    test('the lexical channel still reaches an unembedded chunk, without a cosine', async () => {
      const results = await search({
        project_id: projectId,
        query: 'loading dock',
        document_paths: ['/turns/'],
      });

      const hit = results.find((result) => {
        return result.document_id === documentId;
      });
      expect(hit!.signals).toEqual({ lexical: 1 });
      expect(hit!.similarity_score).toBeUndefined();
    });
  });

  /**
   * Fusion reads rank position, so a per-store ranked list would let each store
   * claim result slots by position rather than by relevance. Here ten memories
   * sit below every document on cosine, and the document they would otherwise
   * displace is the one asserted on.
   */
  describe('result slots are not allocated by store', () => {
    const DOCUMENT_COSINES = [1, 0.98, 0.96, 0.94, 0.92, 0.9];
    const MEMORY_COUNT = 10;
    let projectId: string;
    let memoryStoreId: string;
    let lastDocumentId: string;

    beforeAll(async () => {
      projectId = await createProject('Store slot allocation');
      for (const [index, cosine] of DOCUMENT_COSINES.entries()) {
        lastDocumentId = await createDocument({
          projectId,
          content: `Throughput review, section ${index}.`,
          path: `/reviews/section-${index}.txt`,
          vector: atCosine({ cosine, axis: 1 }),
        });
      }
      memoryStoreId = await createMemoryStore({
        projectId,
        name: 'Courier notes',
      });
      for (let index = 0; index < MEMORY_COUNT; index += 1) {
        await createMemory({
          memoryStoreId,
          content: `Unrelated note number ${index} about courier scheduling.`,
          vector: atCosine({ cosine: 0.5, axis: index + 2 }),
        });
      }
    });

    test('keeps a document every memory is less similar than', async () => {
      // Shares no token with any fixture, so the vector ranking alone decides.
      const results = await search({
        project_id: projectId,
        query: 'inventory velocity',
        memory_store_ids: [memoryStoreId],
        limit: 10,
      });

      // Sixth on cosine across the whole corpus: per-store ranks would put
      // five memories ahead of it and push it out of the ten slots.
      expect(results.map(idOf)).toContain(lastDocumentId);
      expect(
        results.slice(0, DOCUMENT_COSINES.length).map((result) => {
          return result.source_type;
        })
      ).toEqual(new Array(DOCUMENT_COSINES.length).fill('document'));
    });
  });

  describe('a path filter over a crowded corpus', () => {
    const TARGET_PATH = '/unique-target/target.md';
    let projectId: string;

    beforeAll(async () => {
      projectId = await createProject('Path filter limit window');
      // Fourteen noise chunks right on the query vector own any top-`limit`
      // window an unfiltered ordering would take.
      for (let index = 0; index < 14; index += 1) {
        await createDocument({
          projectId,
          content: `Noise document ${index}.`,
          path: `/noise/noise-${index}.txt`,
        });
      }
      await createDocument({
        projectId,
        content: 'The unique target playbook.',
        path: TARGET_PATH,
        vector: FAR_VECTOR,
      });
    });

    // The limit applies to chunks that already passed the path join; applied
    // before it, the window holds only noise and the search finds nothing.
    test('returns the path-matched document ranked past the limit window', async () => {
      const results = await search({
        project_id: projectId,
        query: 'unique target',
        document_paths: ['/unique-target/'],
        limit: 10,
      });

      expect(
        results.map((result) => {
          return result.path;
        })
      ).toEqual([TARGET_PATH]);
    });
  });

  describe('a path-scoped policy', () => {
    const SCOPED_PATH = '/docs/policy-scoped.txt';
    const DENIED_PATH = '/docs/policy-denied.txt';
    let projectId: string;
    let scopedToken: string;

    beforeAll(async () => {
      projectId = await createProject('Path-scoped search policy');
      await createDocument({
        projectId,
        content: 'Content the scoped policy admits.',
        path: SCOPED_PATH,
      });
      await createDocument({
        projectId,
        content: 'Content the scoped policy leaves out.',
        path: DENIED_PATH,
      });

      const user = await asAdmin()
        .post('/api/v1/users')
        .send({ username: 'hybridscoped', password: 'scopedpass' });
      const policy = await asAdmin()
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [
              {
                effect: 'Allow',
                action: ['knowledge:SearchKnowledge'],
                resource: [`srn:${projectId}:*:*`],
              },
              {
                effect: 'Deny',
                action: ['knowledge:SearchKnowledge'],
                resource: [`srn:${projectId}:document:${DENIED_PATH}`],
              },
            ],
          },
        });
      await asAdmin()
        .put(`/api/v1/users/${user.body.id}/policies`)
        .send({ policy_ids: [policy.body.id] });
      scopedToken = await loginAs('hybridscoped', 'scopedpass');
    });

    // The compiled clause names `file.path` through an association, which both
    // ranked channels resolve only with `subQuery: false`.
    test('a semantic query leaves out the document the policy denies', async () => {
      const res = await authenticatedTestClient(scopedToken)
        .post('/api/v1/knowledge/search')
        .send({ project_id: projectId, query: 'scoped policy content' });

      expect(res.status).toBe(200);
      expect(
        (res.body.results as SearchResult[]).map((result) => {
          return result.path;
        })
      ).toEqual([SCOPED_PATH]);
    });
  });

  describe('the recency blend', () => {
    const QUERY = 'depot rotation probe';
    const MS_PER_DAY = 86400000;
    let projectId: string;
    let memoryStoreIds: string[];
    let staleMemoryId: string;
    let freshMemoryId: string;
    let documentId: string;
    const originalHalfLife = process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS;

    /**
     * No product path sets `updated_at` — the column is Sequelize-managed and
     * every model-level write stamps the current time over an explicit value —
     * so raw SQL is the one way to give a fixture an age.
     */
    const backdate = async (args: {
      table: 'memories' | 'document_chunks';
      where: string;
      publicId: string;
      days: number;
    }) => {
      await db.sequelize.query(
        `UPDATE ${args.table} SET updated_at = :updatedAt WHERE ${args.where}`,
        {
          replacements: {
            updatedAt: new Date(Date.now() - args.days * MS_PER_DAY),
            publicId: args.publicId,
          },
        }
      );
    };

    beforeAll(async () => {
      projectId = await createProject('Knowledge recency blend');
      // Old enough that a blend reaching document results would visibly move
      // it; its score staying put says the blend never reaches them.
      documentId = await createDocument({
        projectId,
        content: 'Yard handbook, trailer rotation appendix.',
        path: '/yard/handbook.txt',
        vector: THIRD_VECTOR,
      });
      await backdate({
        table: 'document_chunks',
        where:
          'document_id = (SELECT id FROM documents WHERE public_id = :publicId)',
        publicId: documentId,
        days: 365,
      });

      // Two restatements of one fact, one superseded. Near-identical, so they
      // live in different stores: a store dedups them at cosine 0.95. Neither
      // shares a token with the query, so fusion runs over the vector ranking
      // alone and a fused score is exactly `1 / (k + rank)`.
      const current = await createMemoryStore({
        projectId,
        name: 'Yard current',
      });
      const prior = await createMemoryStore({ projectId, name: 'Yard prior' });
      memoryStoreIds = [current, prior];
      freshMemoryId = await createMemory({
        memoryStoreId: current,
        content: 'The northern yard rotates its trailers every 21 days.',
        vector: SECOND_VECTOR,
      });
      staleMemoryId = await createMemory({
        memoryStoreId: prior,
        content: 'The northern yard rotates its trailers every 14 days.',
        vector: NEAR_VECTOR,
      });
      await backdate({
        table: 'memories',
        where: 'public_id = :publicId',
        publicId: staleMemoryId,
        days: 60,
      });
    });

    afterEach(() => {
      if (originalHalfLife === undefined) {
        delete process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS;
      } else {
        process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS = originalHalfLife;
      }
    });

    const ranked = async (extra?: Record<string, unknown>) => {
      const results = await search({
        project_id: projectId,
        query: QUERY,
        memory_store_ids: memoryStoreIds,
        ...extra,
      });
      return results.map((result) => {
        return { id: idOf(result), score: result.score };
      });
    };

    test('ranks the newer of two equivalent facts first', async () => {
      // Fusion hands the stale memory 1/61 and the fresh one 1/62. Sixty days
      // is two half-lives at 30, quartering the stale score: it lands behind
      // the document fusion put third as well.
      const order = await ranked({ recency_half_life_days: 30 });

      expect(
        order.map((result) => {
          return result.id;
        })
      ).toEqual([freshMemoryId, documentId, staleMemoryId]);
    });

    test('changes nothing with no half-life configured anywhere', async () => {
      delete process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS;

      const order = await ranked();

      expect(order.slice(0, 2)).toEqual([
        { id: staleMemoryId, score: 1 / 61 },
        { id: freshMemoryId, score: 1 / 62 },
      ]);
    });

    test('takes the deployment default when the request names none', async () => {
      process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS = '30';

      const order = await ranked();

      expect(order[0].id).toBe(freshMemoryId);
    });

    test('a request half-life of 0 turns a deployment default off', async () => {
      delete process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS;
      const off = await ranked();

      process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS = '30';
      const disabled = await ranked({ recency_half_life_days: 0 });

      expect(disabled).toEqual(off);
    });

    test('a negative request value falls back to the deployment default', async () => {
      process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS = '30';

      const order = await ranked({ recency_half_life_days: -5 });

      expect(order[0].id).toBe(freshMemoryId);
    });

    test('an unreadable deployment default leaves the blend off', async () => {
      process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS = 'thirty';

      const order = await ranked();

      expect(order[0]).toEqual({ id: staleMemoryId, score: 1 / 61 });
    });

    test('a negative deployment default leaves the blend off', async () => {
      process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS = '-30';

      const order = await ranked();

      expect(order[0]).toEqual({ id: staleMemoryId, score: 1 / 61 });
    });

    // The blend is a retrieval-time signal: the dedup check reads the raw
    // distance, so a memory old enough to be buried is still the duplicate a
    // restatement of it skips into.
    test('leaves the write path reading raw cosine', async () => {
      process.env.KNOWLEDGE_RECENCY_HALF_LIFE_DAYS = '1';

      const res = await asAdmin().post('/api/v1/memories').send({
        memory_store_id: memoryStoreIds[1],
        content: 'The northern yard rotates its trailers every 14 days.',
      });

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('skipped');
      expect(res.body.id).toBe(staleMemoryId);
    });
  });
});
