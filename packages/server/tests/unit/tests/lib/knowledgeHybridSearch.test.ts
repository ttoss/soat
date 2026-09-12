import { db } from 'src/db';
import { createDocument } from 'src/lib/documents';
import * as embeddingModule from 'src/lib/embedding';
import { searchKnowledge } from 'src/lib/knowledge';
import { createMemory } from 'src/lib/memories';
import { writeMemoryEntry } from 'src/lib/memoryEntries';
import { createProject } from 'src/lib/projects';

/**
 * The defect this covers: a chunk that literally contains the searched token is
 * dropped because its embedding sits far from the query, so a vector-only
 * search under a `min_similarity` floor can only ever find the wrong rows.
 */
const RARE_TOKEN = 'ZQXJ-9001';
const OTHER_TOKEN = 'WPLM-4711';

const dim = Number(process.env.EMBEDDING_DIMENSIONS);

const vector = (args: { a: number; b: number }): number[] => {
  const values = new Array<number>(dim).fill(0);
  values[0] = args.a;
  values[1] = args.b;
  return values;
};

/** Every query embeds here; the fixtures place themselves around it. */
const QUERY_VECTOR = vector({ a: 1, b: 0 });
/** Cosine 0 against the query — unreachable through the vector channel. */
const FAR_VECTOR = vector({ a: 0, b: 1 });
/** Cosine ≈ 0.990 — the closest fixture to the query. */
const NEAR_VECTOR = vector({ a: 0.99, b: 0.14 });
/** Cosine ≈ 0.980 — close, but always one rank behind {@link NEAR_VECTOR}. */
const SECOND_NEAREST_VECTOR = vector({ a: 0.98, b: 0.2 });

const CONTENT = {
  lexicalOnlyDocument: `Replacement part ${RARE_TOKEN} ships from the Lisbon warehouse.`,
  vectorOnlyDocument:
    'Warehouse logistics overview with no part numbers at all.',
  bothSignalsDocument: `Warehouse logistics notes that also name ${OTHER_TOKEN}.`,
  lexicalOnlyEntry: `The customer always orders ${RARE_TOKEN} in pairs.`,
  vectorOnlyEntry:
    'The customer prefers warehouse pickup over courier delivery.',
};

const FIXTURE_VECTORS = new Map<string, number[]>([
  [CONTENT.lexicalOnlyDocument, FAR_VECTOR],
  [CONTENT.lexicalOnlyEntry, FAR_VECTOR],
  [CONTENT.vectorOnlyDocument, NEAR_VECTOR],
  [CONTENT.vectorOnlyEntry, NEAR_VECTOR],
  [CONTENT.bothSignalsDocument, SECOND_NEAREST_VECTOR],
]);

/**
 * The unit suite's embedder returns one constant vector, so ranking has to be
 * placed by hand: a fixture gets the vector its name promises, and anything
 * else — every query text — gets {@link QUERY_VECTOR}.
 */
const embedFixture = (text: string): number[] => {
  return [...(FIXTURE_VECTORS.get(text) ?? QUERY_VECTOR)];
};

const mockEmbedding = () => {
  return jest
    .spyOn(embeddingModule, 'getEmbedding')
    .mockImplementation(async (args: { text: string }) => {
      return embedFixture(args.text);
    });
};

type Fixtures = {
  projectId: number;
  memoryId: string;
  lexicalOnlyDocumentId: string;
  vectorOnlyDocumentId: string;
  lexicalOnlyEntryId: string;
  vectorOnlyEntryId: string;
  bothSignalsDocumentId: string;
};

const seed = async (): Promise<Fixtures> => {
  const project = await createProject({ name: 'Hybrid Knowledge Search' });
  const projectRow = await db.Project.findOne({
    where: { publicId: project.id },
  });
  const projectId = projectRow!.id as number;

  const lexicalOnly = await createDocument({
    projectId,
    content: CONTENT.lexicalOnlyDocument,
    path: '/parts/lexical-only.txt',
  });
  const vectorOnly = await createDocument({
    projectId,
    content: CONTENT.vectorOnlyDocument,
    path: '/parts/vector-only.txt',
  });
  const bothSignals = await createDocument({
    projectId,
    content: CONTENT.bothSignalsDocument,
    path: '/parts/both-signals.txt',
  });

  const memory = await createMemory({ projectId, name: 'Parts desk' });
  const memoryRow = await db.Memory.findOne({
    where: { publicId: memory.id },
  });
  const lexicalEntry = await writeMemoryEntry({
    memoryId: memoryRow!.id as number,
    content: CONTENT.lexicalOnlyEntry,
  });
  const vectorEntry = await writeMemoryEntry({
    memoryId: memoryRow!.id as number,
    content: CONTENT.vectorOnlyEntry,
  });

  return {
    projectId,
    memoryId: memory.id,
    lexicalOnlyDocumentId: lexicalOnly.id,
    vectorOnlyDocumentId: vectorOnly.id,
    bothSignalsDocumentId: bothSignals.id,
    lexicalOnlyEntryId: lexicalEntry.entry.id,
    vectorOnlyEntryId: vectorEntry.entry.id,
  };
};

describe('hybrid knowledge search', () => {
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

  describe('lexical recall below the similarity floor', () => {
    test('returns a document chunk containing the exact token', async () => {
      const results = await searchKnowledge({
        projectIds: [fixtures.projectId],
        billingProjectId: fixtures.projectId,
        query: RARE_TOKEN,
        minSimilarity: 0.5,
      });

      const hit = results.find((result) => {
        return (
          result.source_type === 'document' &&
          result.document_id === fixtures.lexicalOnlyDocumentId
        );
      });
      expect(hit).toBeDefined();
      // Below the floor it was asked to clear: the floor governs the vector
      // candidates, and an exact token match is its own evidence.
      expect(hit!.similarity_score).toBeLessThan(0.5);
    });

    test('returns a memory entry containing the exact token', async () => {
      const results = await searchKnowledge({
        projectIds: [fixtures.projectId],
        billingProjectId: fixtures.projectId,
        query: RARE_TOKEN,
        memoryIds: [fixtures.memoryId],
        includeDocuments: false,
        minSimilarity: 0.5,
      });

      const hit = results.find((result) => {
        return (
          result.source_type === 'memory' &&
          result.entry_id === fixtures.lexicalOnlyEntryId
        );
      });
      expect(hit).toBeDefined();
      expect(hit!.similarity_score).toBeLessThan(0.5);
    });

    test('the similarity floor still removes a vector-only candidate', async () => {
      const results = await searchKnowledge({
        projectIds: [fixtures.projectId],
        billingProjectId: fixtures.projectId,
        query: RARE_TOKEN,
        minSimilarity: 0.999,
      });

      const vectorOnly = results.find((result) => {
        return (
          result.source_type === 'document' &&
          result.document_id === fixtures.vectorOnlyDocumentId
        );
      });
      expect(vectorOnly).toBeUndefined();
    });
  });

  test('fuses four lists when both signals and both sources apply', async () => {
    const results = await searchKnowledge({
      projectIds: [fixtures.projectId],
      billingProjectId: fixtures.projectId,
      query: RARE_TOKEN,
      memoryIds: [fixtures.memoryId],
    });

    const documentIds = results
      .filter((result) => {
        return result.source_type === 'document';
      })
      .map((result) => {
        return result.source_type === 'document' ? result.document_id : '';
      });
    const entryIds = results
      .filter((result) => {
        return result.source_type === 'memory';
      })
      .map((result) => {
        return result.source_type === 'memory' ? result.entry_id : '';
      });

    // One contribution from each of the four ranked lists: a document and an
    // entry only the lexical query can reach, and a document and an entry only
    // the vector query can reach.
    expect(documentIds).toContain(fixtures.lexicalOnlyDocumentId);
    expect(documentIds).toContain(fixtures.vectorOnlyDocumentId);
    expect(entryIds).toContain(fixtures.lexicalOnlyEntryId);
    expect(entryIds).toContain(fixtures.vectorOnlyEntryId);
  });

  test('a result both signals rank outranks one only a single signal ranks', async () => {
    const results = await searchKnowledge({
      projectIds: [fixtures.projectId],
      billingProjectId: fixtures.projectId,
      query: OTHER_TOKEN,
    });

    const ranked = results.map((result) => {
      return result.source_type === 'document' ? result.document_id : '';
    });
    // It is only *second* nearest, so a vector-only ranking puts the
    // vector-only document first; the lexical list is what overturns that.
    expect(ranked[0]).toBe(fixtures.bothSignalsDocumentId);
  });

  test('populates similarity_score on a lexical-only hit', async () => {
    const results = await searchKnowledge({
      projectIds: [fixtures.projectId],
      billingProjectId: fixtures.projectId,
      query: RARE_TOKEN,
      memoryIds: [fixtures.memoryId],
    });

    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(typeof result.similarity_score).toBe('number');
      expect(Number.isFinite(result.similarity_score)).toBe(true);
    }
  });

  test('score is the fused value, not the cosine', async () => {
    const results = await searchKnowledge({
      projectIds: [fixtures.projectId],
      billingProjectId: fixtures.projectId,
      query: RARE_TOKEN,
    });

    const hit = results[0];
    expect(hit.score).not.toBe(hit.similarity_score);
    // `1 / (60 + 1)` is the most one list can contribute at `k = 60`.
    expect(hit.score).toBeLessThanOrEqual(2 / 61);
  });

  test('rrf_k changes the fused magnitudes without changing the contract', async () => {
    const tight = await searchKnowledge({
      projectIds: [fixtures.projectId],
      billingProjectId: fixtures.projectId,
      query: RARE_TOKEN,
      rrfK: 1,
    });
    const loose = await searchKnowledge({
      projectIds: [fixtures.projectId],
      billingProjectId: fixtures.projectId,
      query: RARE_TOKEN,
      rrfK: 60,
    });

    expect(tight[0].score).toBeGreaterThan(loose[0].score!);
  });

  describe('degrade paths', () => {
    test('falls back to lexical-only when the embedding provider fails', async () => {
      jest
        .spyOn(embeddingModule, 'getEmbedding')
        .mockRejectedValue(new Error('embedding provider unavailable'));

      const results = await searchKnowledge({
        projectIds: [fixtures.projectId],
        billingProjectId: fixtures.projectId,
        query: RARE_TOKEN,
      });

      const hit = results.find((result) => {
        return (
          result.source_type === 'document' &&
          result.document_id === fixtures.lexicalOnlyDocumentId
        );
      });
      expect(hit).toBeDefined();
      // The one case the contract leaves `similarity_score` absent: there is no
      // query vector to measure against.
      expect(hit!.similarity_score).toBeUndefined();
    });

    test('falls back to vector-only when the lexical query fails', async () => {
      process.env.KNOWLEDGE_TEXT_SEARCH_CONFIG = 'not_a_real_config';

      const results = await searchKnowledge({
        projectIds: [fixtures.projectId],
        billingProjectId: fixtures.projectId,
        query: RARE_TOKEN,
      });

      delete process.env.KNOWLEDGE_TEXT_SEARCH_CONFIG;

      // With the lexical channel alive the exact-token document leads; with it
      // gone the order is the vector one, nearest cosine first.
      const ranked = results.map((result) => {
        return result.source_type === 'document' ? result.document_id : '';
      });
      expect(ranked[0]).toBe(fixtures.vectorOnlyDocumentId);
      expect(results[0].similarity_score).toBeGreaterThan(0.9);
    });
  });

  test('a search without a query keeps its deterministic order', async () => {
    const results = await searchKnowledge({
      projectIds: [fixtures.projectId],
      billingProjectId: fixtures.projectId,
      documentIds: [fixtures.lexicalOnlyDocumentId],
    });

    expect(results).toHaveLength(1);
    expect(results[0].score).toBeUndefined();
    expect(results[0].similarity_score).toBeUndefined();
  });
});

/**
 * Fusion reads rank position, so a per-store ranked list would let each store
 * claim result slots by position rather than by relevance: the best memory
 * entry and the best chunk would score identically however little the entry is
 * worth. Here ten entries sit below every document on cosine, and the document
 * they would otherwise displace is the one this asserts on.
 */
describe('ranking does not allocate result slots by store', () => {
  const MEMORY_ENTRY_COUNT = 10;
  const DOCUMENT_COSINES = [1, 0.98, 0.96, 0.94, 0.92, 0.9];
  const ENTRY_COSINE = 0.5;
  /**
   * Shares no token with any fixture, so the lexical channel contributes
   * nothing and the vector ranking alone decides — which is the arrangement
   * that exposes per-store slot allocation.
   */
  const QUERY = 'inventory velocity';

  /**
   * A unit vector at the given cosine to {@link QUERY_VECTOR}, with its
   * remainder on `axis`. Two fixtures on different axes are `cosine²` similar
   * to each other, which keeps the entries below `writeMemoryEntry`'s 0.95
   * dedup threshold while they all sit at one cosine to the query.
   */
  const atCosine = (args: { cosine: number; axis: number }): number[] => {
    const values = new Array<number>(dim).fill(0);
    values[0] = args.cosine;
    values[args.axis] = Math.sqrt(1 - args.cosine * args.cosine);
    return values;
  };

  const documentContent = (index: number): string => {
    return `Warehouse throughput review, section ${index}.`;
  };
  const entryContent = (index: number): string => {
    return `Unrelated note number ${index} about courier scheduling.`;
  };

  const placed = new Map<string, number[]>();
  for (const [index, cosine] of DOCUMENT_COSINES.entries()) {
    placed.set(documentContent(index), atCosine({ cosine, axis: 1 }));
  }
  for (let index = 0; index < MEMORY_ENTRY_COUNT; index += 1) {
    placed.set(
      entryContent(index),
      atCosine({ cosine: ENTRY_COSINE, axis: index + 2 })
    );
  }

  let projectId: number;
  let memoryId: string;
  let lastDocumentId: string;

  beforeAll(async () => {
    jest
      .spyOn(embeddingModule, 'getEmbedding')
      .mockImplementation(async (args: { text: string }) => {
        return [...(placed.get(args.text) ?? QUERY_VECTOR)];
      });

    const project = await createProject({ name: 'Store slot allocation' });
    const projectRow = await db.Project.findOne({
      where: { publicId: project.id },
    });
    projectId = projectRow!.id as number;

    for (let index = 0; index < DOCUMENT_COSINES.length; index += 1) {
      const created = await createDocument({
        projectId,
        content: documentContent(index),
        path: `/reviews/section-${index}.txt`,
      });
      lastDocumentId = created.id;
    }

    const memory = await createMemory({ projectId, name: 'Courier notes' });
    const memoryRow = await db.Memory.findOne({
      where: { publicId: memory.id },
    });
    memoryId = memory.id;
    for (let index = 0; index < MEMORY_ENTRY_COUNT; index += 1) {
      const written = await writeMemoryEntry({
        memoryId: memoryRow!.id as number,
        content: entryContent(index),
      });
      expect(written.action).toBe('created');
    }

    jest.restoreAllMocks();
  });

  test('keeps a document that every memory entry is less similar than', async () => {
    jest
      .spyOn(embeddingModule, 'getEmbedding')
      .mockImplementation(async (args: { text: string }) => {
        return [...(placed.get(args.text) ?? QUERY_VECTOR)];
      });

    const results = await searchKnowledge({
      projectIds: [projectId],
      billingProjectId: projectId,
      query: QUERY,
      memoryIds: [memoryId],
      limit: 10,
    });

    const documentIds = results.map((result) => {
      return result.source_type === 'document' ? result.document_id : '';
    });
    // Sixth on cosine across the whole corpus, and last among the documents:
    // per-store ranks would put five memory entries ahead of it and push it out
    // of the ten slots entirely.
    expect(documentIds).toContain(lastDocumentId);
    expect(
      results.slice(0, DOCUMENT_COSINES.length).map((result) => {
        return result.source_type;
      })
    ).toEqual(new Array(DOCUMENT_COSINES.length).fill('document'));

    jest.restoreAllMocks();
  });
});
