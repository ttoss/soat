import { installEmbeddingStub } from '../../embeddingStub';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * `POST /knowledge/search` with an existing document or memory as the probe.
 * Each fixture text embeds to the vector its marker names, so every cosine
 * below is known in advance.
 */
const dim = Number(process.env.EMBEDDING_DIMENSIONS);

const vector = (args: { a: number; b: number }): number[] => {
  const values = new Array<number>(dim).fill(0);
  values[0] = args.a;
  values[1] = args.b;
  return values;
};

/** Checked in order, so a marker containing another comes first. */
const MARKERS: Array<[string, number[]]> = [
  // Cosine ≈ 0.90 to AXIS: below the 0.95 band where a memory write dedupes.
  ['NEARAXIS', vector({ a: 0.9, b: 0.44 })],
  ['AXIS', vector({ a: 1, b: 0 })],
  ['ORTHO', vector({ a: 0, b: 1 })],
  ['DIAGONAL', vector({ a: 1, b: 1 })],
];

let embedCalls = 0;
let embedderDown = false;

installEmbeddingStub({
  embed: (input) => {
    embedCalls += 1;
    if (embedderDown) throw new Error('embedding provider unavailable');
    const marker = MARKERS.find(([name]) => {
      return input.includes(name);
    });
    return [...(marker?.[1] ?? vector({ a: 0.5, b: -0.5 }))];
  },
});

type SearchResult = {
  source_type: 'document' | 'memory';
  document_id?: string;
  memory_id?: string;
  similarity_score?: number;
  score?: number;
  signals?: { vector?: number; lexical?: number };
};

const idOf = (result: SearchResult): string | undefined => {
  return result.document_id ?? result.memory_id;
};

describe('POST /api/v1/knowledge/search — similar_to', () => {
  let adminToken: string;
  let projectId: string;
  let memoryStoreId: string;
  /** Two chunks, AXIS and ORTHO: its mean points along DIAGONAL. */
  let sourceDocumentId: string;
  let diagonalDocumentId: string;
  let axisDocumentId: string;
  let sourceMemoryId: string;
  let nearAxisMemoryId: string;
  let hiddenDocumentId: string;
  let hiddenMemoryId: string;
  let unembeddedDocumentId: string;
  let unembeddedMemoryId: string;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const createDocument = async (args: {
    content: string;
    path: string;
    chunked?: boolean;
  }): Promise<string> => {
    const res = await asAdmin()
      .post('/api/v1/documents')
      .send({
        project_id: projectId,
        content: args.content,
        path: args.path,
        ...(args.chunked
          ? { chunk_strategy: 'size', chunk_size: 40, chunk_overlap: 0 }
          : {}),
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createMemory = async (content: string): Promise<string> => {
    const res = await asAdmin()
      .post('/api/v1/memories')
      .send({ memory_store_id: memoryStoreId, content });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const search = (body: Record<string, unknown>, token = adminToken) => {
    return authenticatedTestClient(token)
      .post('/api/v1/knowledge/search')
      .send({ project_id: projectId, ...body });
  };

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'similaradmin', password: 'supersecret' });
    adminToken = await loginAs('similaradmin', 'supersecret');

    const project = await asAdmin()
      .post('/api/v1/projects')
      .send({ name: 'Knowledge similar_to' });
    projectId = project.body.id;
    const store = await asAdmin()
      .post('/api/v1/memory-stores')
      .send({ project_id: projectId, name: 'Similar store' });
    memoryStoreId = store.body.id;

    sourceDocumentId = await createDocument({
      content: `${'AXIS '.repeat(8)}${'ORTHO '.repeat(6)}`.trim(),
      path: '/similar/source.txt',
      chunked: true,
    });
    diagonalDocumentId = await createDocument({
      content: 'DIAGONAL notes',
      path: '/similar/diagonal.txt',
    });
    axisDocumentId = await createDocument({
      content: 'AXIS notes',
      path: '/other/axis.txt',
    });
    hiddenDocumentId = await createDocument({
      content: 'AXIS hidden',
      path: '/similar/hidden.txt',
    });
    sourceMemoryId = await createMemory('The AXIS memory');
    nearAxisMemoryId = await createMemory('The NEARAXIS memory');
    hiddenMemoryId = await createMemory('The ORTHO hidden memory');

    embedderDown = true;
    try {
      unembeddedDocumentId = await createDocument({
        content: 'never embedded document',
        path: '/unembedded/doc.txt',
      });
      unembeddedMemoryId = await createMemory('never embedded memory');
    } finally {
      embedderDown = false;
    }
  });

  test('unauthenticated request returns 401', async () => {
    const res = await testClient.post('/api/v1/knowledge/search').send({
      project_id: projectId,
      similar_to_document_id: sourceDocumentId,
    });
    expect(res.status).toBe(401);
  });

  test('returns 403 for a caller without knowledge:SearchKnowledge', async () => {
    await asAdmin()
      .post('/api/v1/users')
      .send({ username: 'similarnoperm', password: 'nopermpass' });
    const token = await loginAs('similarnoperm', 'nopermpass');
    const res = await search(
      { similar_to_document_id: sourceDocumentId },
      token
    );
    expect(res.status).toBe(403);
  });

  test('ranks by the mean of the source document chunks and excludes all of them', async () => {
    const before = embedCalls;
    const res = await search({ similar_to_document_id: sourceDocumentId });
    expect(res.status).toBe(200);
    const results = res.body.results as SearchResult[];

    expect(embedCalls).toBe(before);
    expect(results.map(idOf)).not.toContain(sourceDocumentId);
    expect(idOf(results[0])).toBe(diagonalDocumentId);
    expect(results[0].similarity_score).toBeCloseTo(1, 5);
    const axis = results.find((result) => {
      return result.document_id === axisDocumentId;
    });
    expect(axis!.similarity_score).toBeCloseTo(Math.SQRT1_2, 5);
    for (const result of results) {
      expect(result.signals).not.toHaveProperty('lexical');
    }
  });

  test('a memory source excludes itself and reaches both stores', async () => {
    const res = await search({ similar_to_memory_id: sourceMemoryId });
    expect(res.status).toBe(200);
    const results = res.body.results as SearchResult[];

    expect(results.map(idOf)).not.toContain(sourceMemoryId);
    const top = results.slice(0, 3).map(idOf);
    expect(top).toEqual(
      expect.arrayContaining([axisDocumentId, hiddenDocumentId])
    );
    expect(results.map(idOf)).toContain(nearAxisMemoryId);
  });

  test('applies document_paths, min_similarity and limit', async () => {
    const res = await search({
      similar_to_memory_id: sourceMemoryId,
      document_paths: ['/other/'],
      include_memories: false,
    });
    expect((res.body.results as SearchResult[]).map(idOf)).toEqual([
      axisDocumentId,
    ]);

    const floored = await search({
      similar_to_memory_id: sourceMemoryId,
      min_similarity: 0.9,
    });
    for (const result of floored.body.results as SearchResult[]) {
      expect(result.similarity_score).toBeGreaterThanOrEqual(0.9);
    }

    const limited = await search({
      similar_to_memory_id: sourceMemoryId,
      limit: 1,
    });
    expect(limited.body.results).toHaveLength(1);
  });

  test('rrf_k does not change the scores', async () => {
    const plain = await search({ similar_to_document_id: sourceDocumentId });
    const tuned = await search({
      similar_to_document_id: sourceDocumentId,
      rrf_k: 1,
    });
    expect(tuned.body.results).toEqual(plain.body.results);
  });

  test.each([
    ['similar_to_document_id', 'doc_doesnotexist000'],
    ['similar_to_memory_id', 'mem_doesnotexist000'],
  ])('an unknown %s returns 404', async (field, id) => {
    const res = await search({ [field]: id });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  test('a source the caller cannot read returns the same 404', async () => {
    const user = await asAdmin()
      .post('/api/v1/users')
      .send({ username: 'similarscoped', password: 'scopedpass' });
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
              resource: [
                `srn:${projectId}:document:${hiddenDocumentId}`,
                `srn:${projectId}:memory:${hiddenMemoryId}`,
              ],
            },
          ],
        },
      });
    await asAdmin()
      .put(`/api/v1/users/${user.body.id}/policies`)
      .send({ policy_ids: [policy.body.id] });
    const token = await loginAs('similarscoped', 'scopedpass');

    const readable = await search(
      { similar_to_document_id: sourceDocumentId },
      token
    );
    expect(readable.status).toBe(200);

    for (const body of [
      { similar_to_document_id: hiddenDocumentId },
      { similar_to_memory_id: hiddenMemoryId },
    ]) {
      const res = await search(body, token);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    }
  });

  test.each([
    [
      'both source fields',
      () => {
        return {
          similar_to_document_id: sourceDocumentId,
          similar_to_memory_id: sourceMemoryId,
        };
      },
    ],
    [
      'a source field with query',
      () => {
        return { similar_to_document_id: sourceDocumentId, query: 'AXIS' };
      },
    ],
    [
      'a memory source with query',
      () => {
        return { similar_to_memory_id: sourceMemoryId, query: 'AXIS' };
      },
    ],
  ])('%s returns 400', async (_name, body) => {
    const res = await search(body());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  test.each([
    [
      'similar_to_document_id',
      () => {
        return unembeddedDocumentId;
      },
    ],
    [
      'similar_to_memory_id',
      () => {
        return unembeddedMemoryId;
      },
    ],
  ])('a %s with no embedding returns 409', async (field, id) => {
    const res = await search({ [field]: id() });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SIMILARITY_SOURCE_NOT_EMBEDDED');
  });
});
