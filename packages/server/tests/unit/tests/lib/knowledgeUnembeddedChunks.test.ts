import { db } from 'src/db';
import { createDocument } from 'src/lib/documents';
import * as embeddingModule from 'src/lib/embedding';
import { searchKnowledge } from 'src/lib/knowledge';
import { writeMemory } from 'src/lib/memories';
import { createMemoryStore } from 'src/lib/memoryStores';
import { createProject } from 'src/lib/projects';

import { SEED_ASSERTION } from '../../fixtures/memoryWrites';

/**
 * A conversation turn is chunked without a vector whenever the project's
 * retrieval default is `none`, so an unembedded chunk is the norm rather than
 * the exception in the reserved root. The vector channel must not rank one: a
 * NULL embedding yields a NULL distance, which sorts last and therefore still
 * fills a `limit` slot in a scope that holds fewer real candidates.
 */
const dim = Number(process.env.EMBEDDING_DIMENSIONS);

const vector = (args: { a: number; b: number }): number[] => {
  const values = new Array<number>(dim).fill(0);
  values[0] = args.a;
  values[1] = args.b;
  return values;
};

const QUERY_VECTOR = vector({ a: 1, b: 0 });

const UNEMBEDDED_CONTENT = 'The courier left a note about the loading dock.';
const UNRELATED_QUERY = 'xylophone manufacturing tolerances in humid climates';

const mockEmbedding = () => {
  return jest.spyOn(embeddingModule, 'getEmbedding').mockImplementation(() => {
    return Promise.resolve([...QUERY_VECTOR]);
  });
};

type Fixtures = {
  projectId: number;
  memoryStoreId: string;
  documentId: string;
  memoryId: string;
};

const stripEmbeddings = async (args: { documentPublicId: string }) => {
  const document = await db.Document.findOne({
    where: { publicId: args.documentPublicId },
  });
  await db.DocumentChunk.update(
    { embedding: null },
    { where: { documentId: document!.id as number } }
  );
};

const seed = async (): Promise<Fixtures> => {
  const project = await createProject({ name: 'Unembedded chunks' });
  const projectRow = await db.Project.findOne({
    where: { publicId: project.id },
  });
  const projectId = projectRow!.id as number;

  const document = await createDocument({
    createdByUserId: null,
    projectId,
    content: UNEMBEDDED_CONTENT,
    path: '/turns/unembedded.txt',
  });
  await stripEmbeddings({ documentPublicId: document.id });

  const memoryStore = await createMemoryStore({ projectId, name: 'Turns' });
  const memoryStoreRow = await db.MemoryStore.findOne({
    where: { publicId: memoryStore.id },
  });
  const memory = await writeMemory({
    memoryStoreId: memoryStoreRow!.id as number,
    content: UNEMBEDDED_CONTENT,
    assertion: SEED_ASSERTION,
  });
  const memoryRow = await db.Memory.findOne({
    where: { publicId: memory.entry.id },
  });
  await db.MemoryContent.update(
    { embedding: null },
    { where: { id: memoryRow!.contentId as number } }
  );

  return {
    projectId,
    memoryStoreId: memoryStore.id,
    documentId: document.id,
    memoryId: memory.entry.id,
  };
};

describe('chunks and memories without an embedding', () => {
  let fixtures: Fixtures;

  beforeAll(async () => {
    mockEmbedding();
    fixtures = await seed();
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    mockEmbedding();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('a document chunk with no vector is not a vector candidate', async () => {
    const results = await searchKnowledge({
      projectIds: [fixtures.projectId],
      billingProjectId: fixtures.projectId,
      query: UNRELATED_QUERY,
      paths: ['/turns/'],
    });

    expect(results).toHaveLength(0);
  });

  test('a memory with no vector is not a vector candidate', async () => {
    const results = await searchKnowledge({
      projectIds: [fixtures.projectId],
      billingProjectId: fixtures.projectId,
      query: UNRELATED_QUERY,
      memoryStoreIds: [fixtures.memoryStoreId],
      includeDocuments: false,
    });

    expect(results).toHaveLength(0);
  });

  test('the lexical channel still reaches an unembedded chunk', async () => {
    const results = await searchKnowledge({
      projectIds: [fixtures.projectId],
      billingProjectId: fixtures.projectId,
      query: 'loading dock',
      paths: ['/turns/'],
    });

    const hit = results.find((result) => {
      return (
        result.source_type === 'document' &&
        result.document_id === fixtures.documentId
      );
    });
    expect(hit).toBeDefined();
    expect(hit!.signals).toEqual({ lexical: 1 });
  });
});
