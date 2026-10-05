import { db } from 'src/db';

import { installEmbeddingStub } from '../../embeddingStub';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * An ANN index answers `ORDER BY embedding <=> $q LIMIT n` from its graph, and
 * pgvector yields those `ef_search` candidates *before* the query's own filters
 * run. All three vector queries filter after the ordering — document chunks
 * through a required join to `files.project_id`, memory search and the dedup
 * check through `memory_store_id` — so a selective enough scope drops every
 * candidate. Nothing errors: a search returns nothing, and the dedup check
 * reports no match and lets a near-duplicate be written.
 *
 * The setup forces exactly that: `hnsw.ef_search = 1` shrinks the candidate
 * list to a single row, and a wall of nearer rows in another project owns it.
 * `enable_seqscan = off` makes the index the only way to answer the ordering,
 * since at test volumes an exact scan is otherwise cheaper — and an exact scan
 * filters correctly, which would make this pass for the wrong reason.
 *
 * Both settings are a database default *and* set on the current session,
 * before the corpus is seeded: nothing here controls which pooled connection a
 * request runs on, so every connection has to carry them.
 */
const dim = Number(process.env.EMBEDDING_DIMENSIONS);
const QUERY_VECTOR = new Array(dim).fill(0.1);
/** Distance 0 from the query: a crowd row is always the nearest neighbour. */
const NEAR_VECTOR = new Array(dim).fill(0.1);
/** Orthogonal to the query, so every crowd row sorts ahead of it. */
const FAR_VECTOR = [...new Array(dim - 1).fill(0), 1];
/**
 * Cosine distance ~0.0005 from the query: inside the 0.95 duplicate band, yet
 * strictly farther than every crowd row, so the crowd owns a one-row list.
 */
const NEAR_DUPLICATE_VECTOR = [0, ...new Array(dim - 1).fill(0.1)];

/** Enough rows to own the candidate list at any `ef_search` this test sets. */
const CROWD_SIZE = 40;

/**
 * Shares no token with any fixture, so the lexical channel — which filters
 * before it ranks — finds nothing and the vector channel alone answers.
 */
const QUERY = 'zebra';

const TARGET_DOCUMENT = 'The scoped target chunk.';
const TARGET_MEMORY = 'The scoped target fact.';
const DEDUP_MEMORY = 'The customer prefers email.';

const placed = new Map<string, number[]>([
  [TARGET_DOCUMENT, FAR_VECTOR],
  [TARGET_MEMORY, FAR_VECTOR],
  [DEDUP_MEMORY, NEAR_DUPLICATE_VECTOR],
]);

installEmbeddingStub({
  embed: (input) => {
    return [
      ...(placed.get(input) ?? (input === QUERY ? QUERY_VECTOR : NEAR_VECTOR)),
    ];
  },
});

const forceIndexOnlyScans = async () => {
  const database = db.sequelize.getDatabaseName();

  for (const statement of [
    `ALTER DATABASE "${database}" SET enable_seqscan = off`,
    `ALTER DATABASE "${database}" SET hnsw.ef_search = 1`,
    'SET enable_seqscan = off',
    'SET hnsw.ef_search = 1',
  ]) {
    await db.sequelize.query(statement);
  }
};

describe('vector search under an ANN index', () => {
  let adminToken: string;
  let scopedProjectId: string;
  let targetDocumentId: string;
  let scopedMemoryStoreId: string;
  let targetMemoryId: string;
  let dedupMemoryStoreId: string;
  let dedupMemoryId: string;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const create = async (path: string, body: Record<string, unknown>) => {
    const res = await asAdmin().post(path).send(body);
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  beforeAll(async () => {
    // Before any request opens another pooled connection: the database
    // default only reaches a session established after it is set.
    await forceIndexOnlyScans();

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'annadmin', password: 'supersecret' });
    adminToken = await loginAs('annadmin', 'supersecret');

    scopedProjectId = await create('/api/v1/projects', {
      name: 'ANN scoped project',
    });
    const crowdProjectId = await create('/api/v1/projects', {
      name: 'ANN crowd project',
    });

    // The crowd: rows in the other project carrying every nearest neighbour
    // of the query, one store per memory so none of them dedups the next.
    for (let index = 0; index < CROWD_SIZE; index += 1) {
      await create('/api/v1/documents', {
        project_id: crowdProjectId,
        content: `Crowd chunk ${index}.`,
        path: `/ann/crowd-${index}.txt`,
      });
      const crowdStoreId = await create('/api/v1/memory-stores', {
        project_id: crowdProjectId,
        name: `ann-crowd-${index}`,
      });
      await create('/api/v1/memories', {
        memory_store_id: crowdStoreId,
        content: `Crowd fact ${index}.`,
      });
    }

    targetDocumentId = await create('/api/v1/documents', {
      project_id: scopedProjectId,
      content: TARGET_DOCUMENT,
      path: '/ann/target.txt',
    });
    scopedMemoryStoreId = await create('/api/v1/memory-stores', {
      project_id: scopedProjectId,
      name: 'ann-scoped',
    });
    targetMemoryId = await create('/api/v1/memories', {
      memory_store_id: scopedMemoryStoreId,
      content: TARGET_MEMORY,
    });
    dedupMemoryStoreId = await create('/api/v1/memory-stores', {
      project_id: scopedProjectId,
      name: 'ann-dedup',
    });
    dedupMemoryId = await create('/api/v1/memories', {
      memory_store_id: dedupMemoryStoreId,
      content: DEDUP_MEMORY,
    });
  });

  test('the connection under test cannot answer the ordering with a scan', async () => {
    // Guards the tests below: without these settings an exact scan satisfies
    // every filter and they pass without exercising the index at all.
    const [seqscan] = await db.sequelize.query('SHOW enable_seqscan');
    const [efSearch] = await db.sequelize.query('SHOW hnsw.ef_search');

    expect({ seqscan, efSearch }).toEqual({
      seqscan: { enable_seqscan: 'off' },
      efSearch: { 'hnsw.ef_search': '1' },
    });
  });

  describe('POST /api/v1/knowledge/search', () => {
    test('a document search returns the project’s own chunk behind a crowded index', async () => {
      const res = await asAdmin().post('/api/v1/knowledge/search').send({
        project_id: scopedProjectId,
        query: QUERY,
        include_memories: false,
        limit: 10,
      });

      expect(res.status).toBe(200);
      expect(
        res.body.results.map((result: { document_id: string }) => {
          return result.document_id;
        })
      ).toEqual([targetDocumentId]);
    });

    test('a memory search returns the store’s own memory behind a crowded index', async () => {
      const res = await asAdmin()
        .post('/api/v1/knowledge/search')
        .send({
          project_id: scopedProjectId,
          query: QUERY,
          memory_store_ids: [scopedMemoryStoreId],
          include_documents: false,
          limit: 10,
        });

      expect(res.status).toBe(200);
      expect(
        res.body.results.map((result: { memory_id: string }) => {
          return result.memory_id;
        })
      ).toEqual([targetMemoryId]);
    });
  });

  describe('POST /api/v1/memories', () => {
    // The dedup check is ordered on the same distance operator and filtered by
    // `memory_store_id` afterwards. Missing the match does not fail loudly: the
    // write falls through and creates a near-duplicate.
    test('a duplicate write finds its own store’s memory behind a crowded index', async () => {
      const res = await asAdmin().post('/api/v1/memories').send({
        memory_store_id: dedupMemoryStoreId,
        content: DEDUP_MEMORY,
      });

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('skipped');
      expect(res.body.id).toBe(dedupMemoryId);
    });
  });
});
