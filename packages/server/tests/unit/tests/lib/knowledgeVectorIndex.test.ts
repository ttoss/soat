import { db } from 'src/db';
import * as embeddingModule from 'src/lib/embedding';
import { resolveDocumentSearch } from 'src/lib/knowledge';
import { resolveMemorySearch } from 'src/lib/knowledgeMemory';
import { writeMemoryEntry } from 'src/lib/memoryEntries';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * An ANN index answers `ORDER BY embedding <=> $q LIMIT n` from its graph, and
 * pgvector yields those `ef_search` candidates *before* the query's own filters
 * run. All three vector queries filter after the ordering — document chunks
 * through a required join to `files.project_id`, entry search and the dedup
 * check through `memory_id` — so a scope that is selective enough drops every
 * candidate. Nothing errors: a search returns nothing, and the dedup check
 * reports no match and lets a near-duplicate be written (#1220).
 *
 * The setup forces exactly that: `hnsw.ef_search = 1` shrinks the candidate
 * list to a single row, and a wall of nearer rows in another project owns it.
 * `enable_seqscan = off` is what makes the index the only way to answer the
 * ordering, since at test volumes an exact scan is otherwise cheaper — and an
 * exact scan filters correctly, which would make this pass for the wrong
 * reason.
 *
 * Both settings are applied as a database default *and* on the current session,
 * before the corpus is seeded: nothing here controls which pooled connection
 * the search runs on, so every connection has to carry them — the one already
 * open takes the `SET`, and every one opened afterwards inherits the default.
 */
const dim = Number(process.env.EMBEDDING_DIMENSIONS);
const queryVector = new Array(dim).fill(0.1);
// Distance 0 from the query: a crowd row is always the nearest neighbour.
const nearVector = new Array(dim).fill(0.1);
// Orthogonal to the query, so every `nearVector` row sorts ahead of it.
const farVector = [...new Array(dim - 1).fill(0), 1];

// Cosine-distance ~0.0005 from the query: comfortably inside the 0.95
// duplicate band, yet strictly farther than every `nearVector` row, so the
// crowd deterministically owns a one-candidate list.
const nearDuplicateVector = [0, ...new Array(dim - 1).fill(0.1)];

/** Enough rows to own the candidate list at any `ef_search` this test sets. */
const CROWD_SIZE = 40;

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

const projectInternalId = async (publicId: string): Promise<number> => {
  const project = await db.Project.findOne({ where: { publicId } });

  if (!project) {
    throw new Error(`project ${publicId} was not created`);
  }

  return project.id;
};

describe('semantic search under an ANN index', () => {
  let adminToken: string;
  let scopedProjectId: number;
  let scopedMemoryId: string;
  let targetChunkId: string;
  let targetEntryId: string;
  let dedupMemoryId: number;
  let dedupEntryId: string;

  beforeAll(async () => {
    // Before anything else opens a pooled connection: the database default
    // only reaches a session established after it is set.
    await forceIndexOnlyScans();

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });
    adminToken = await loginAs('admin', 'supersecret');

    const createProject = async (name: string) => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name });
      return res.body.id;
    };

    const scopedProjectPublicId = await createProject('ANN scoped project');
    const crowdProjectPublicId = await createProject('ANN crowd project');
    scopedProjectId = await projectInternalId(scopedProjectPublicId);

    const createDocument = async (args: {
      projectId: string;
      filename: string;
    }) => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/documents')
        .send({
          project_id: args.projectId,
          content: 'Retrieval corpus entry.',
          filename: args.filename,
          path: `/ann/${args.filename}`,
        });
      const document = await db.Document.findOne({
        where: { publicId: res.body.id },
      });

      if (!document) {
        throw new Error(`document ${res.body.id} was not created`);
      }

      return document.id;
    };

    // The crowd: one document in the other project carrying every nearest
    // neighbour of the query vector.
    const crowdDocumentId = await createDocument({
      projectId: crowdProjectPublicId,
      filename: 'crowd.txt',
    });
    await db.DocumentChunk.update(
      { embedding: nearVector },
      { where: { documentId: crowdDocumentId } }
    );
    for (let index = 0; index < CROWD_SIZE; index += 1) {
      await db.DocumentChunk.create({
        documentId: crowdDocumentId,
        content: `Crowd chunk ${index}.`,
        chunkIndex: index + 1,
        embedding: nearVector,
      });
    }

    // The one row the scoped search must still find, ranked last on distance.
    const targetDocumentId = await createDocument({
      projectId: scopedProjectPublicId,
      filename: 'target.txt',
    });
    await db.DocumentChunk.update(
      { embedding: farVector },
      { where: { documentId: targetDocumentId } }
    );
    const targetChunk = await db.DocumentChunk.findOne({
      where: { documentId: targetDocumentId },
    });
    targetChunkId = targetChunk!.publicId;

    // The same shape for memories: entries are filtered by `memory_id` after
    // the ordering, so a crowded memory hides the scoped one's entries.
    const createMemory = async (args: { projectId: string; name: string }) => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/memories')
        .send({ project_id: args.projectId, name: args.name });
      const memory = await db.Memory.findOne({
        where: { publicId: res.body.id },
      });

      if (!memory) {
        throw new Error(`memory ${res.body.id} was not created`);
      }

      return { publicId: res.body.id, id: memory.id };
    };

    const crowdMemory = await createMemory({
      projectId: crowdProjectPublicId,
      name: 'ann-crowd',
    });
    const scopedMemory = await createMemory({
      projectId: scopedProjectPublicId,
      name: 'ann-scoped',
    });
    scopedMemoryId = scopedMemory.publicId;

    for (let index = 0; index < CROWD_SIZE; index += 1) {
      await db.MemoryEntry.create({
        memoryId: crowdMemory.id,
        content: `Crowd fact ${index}.`,
        embedding: nearVector,
      });
    }
    const targetEntry = await db.MemoryEntry.create({
      memoryId: scopedMemory.id,
      content: 'The scoped fact.',
      embedding: farVector,
    });
    targetEntryId = targetEntry.publicId;

    // A separate memory for the dedup check, so the entry it must find is not
    // one of the rows the search tests rank.
    const dedupMemory = await createMemory({
      projectId: scopedProjectPublicId,
      name: 'ann-dedup',
    });
    dedupMemoryId = dedupMemory.id;
    const dedupEntry = await db.MemoryEntry.create({
      memoryId: dedupMemory.id,
      content: 'The customer prefers email.',
      embedding: nearDuplicateVector,
    });
    dedupEntryId = dedupEntry.publicId;
  });

  beforeEach(() => {
    jest
      .spyOn(embeddingModule, 'getEmbedding')
      .mockResolvedValue([...queryVector]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('the connection under test cannot answer the ordering with a scan', async () => {
    // Guards the three tests below: if these settings were not in effect, an
    // exact scan would satisfy every filter and all three would pass without
    // exercising the index at all.
    const [seqscan] = await db.sequelize.query('SHOW enable_seqscan');
    const [efSearch] = await db.sequelize.query('SHOW hnsw.ef_search');

    expect({ seqscan, efSearch }).toEqual({
      seqscan: { enable_seqscan: 'off' },
      efSearch: { 'hnsw.ef_search': '1' },
    });
  });

  test('document search returns the project’s own chunk behind a crowded index', async () => {
    const results = await resolveDocumentSearch({
      projectIds: [scopedProjectId],
      billingProjectId: null,
      config: { search: 'retrieval corpus', limit: 10 },
    });

    expect(
      results.map((result) => {
        return result.chunk_id;
      })
    ).toEqual([targetChunkId]);
  });

  test('a duplicate write finds its own memory’s entry behind a crowded index', async () => {
    // The dedup check is a `findOne` ordered on the same distance operator,
    // filtered by `memory_id` afterwards. Missing the match here does not fail
    // loudly: the write falls through and creates a near-duplicate entry, which
    // is what the consolidation band exists to prevent.
    const result = await writeMemoryEntry({
      memoryId: dedupMemoryId,
      content: 'The customer prefers email.',
    });

    expect(result).toMatchObject({
      action: 'skipped',
      entry: { id: dedupEntryId },
    });
  });

  test('memory search returns the scoped memory’s own entry behind a crowded index', async () => {
    const results = await resolveMemorySearch({
      projectIds: [scopedProjectId],
      billingProjectId: null,
      config: { memoryIds: [scopedMemoryId], search: 'scoped fact', limit: 10 },
    });

    expect(
      results.map((result) => {
        return result.entry_id;
      })
    ).toEqual([targetEntryId]);
  });
});
