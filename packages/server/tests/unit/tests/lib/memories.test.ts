import { db } from 'src/db';
import { writeMemory } from 'src/lib/memories';
import * as consolidationCompletionModule from 'src/lib/memoryConsolidationCompletion';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

const mockRunConsolidationCompletion = jest.spyOn(
  consolidationCompletionModule,
  'runConsolidationCompletion'
);

// All test embeddings resolve to the same mock vector, so any second write
// scores 1.0 against the first. `duplicate_threshold > 1` keeps it out of the
// skip branch and `update_threshold = 0` forces the merge branch.
const FORCE_MERGE = { duplicateThreshold: 1.1, updateThreshold: 0 } as const;

describe('writeMemory merge consolidation', () => {
  let adminToken: string;
  let projectId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'consolidationadmin', password: 'supersecret' });
    adminToken = await loginAs('consolidationadmin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Consolidation Project' });
    projectId = projectRes.body.id;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const createMemoryStoreId = async (name: string): Promise<number> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/memory-stores')
      .send({ project_id: projectId, name });
    const memoryStore = await db.MemoryStore.findOne({
      where: { publicId: res.body.id },
    });
    return memoryStore!.id as number;
  };

  test('consolidates the merge via the LLM when a consolidation context is provided', async () => {
    const memoryStoreId = await createMemoryStoreId('Consolidate Merge');
    await writeMemory({
      memoryStoreId,
      content: 'Customer prefers phone calls',
    });

    mockRunConsolidationCompletion.mockResolvedValueOnce(
      'Customer prefers email over phone calls'
    );

    const result = await writeMemory({
      memoryStoreId,
      content: 'Actually the customer prefers email',
      consolidation: { agentId: 'agt_consolidate' },
      ...FORCE_MERGE,
    });

    expect(result.action).toBe('updated');
    // The consolidated single fact replaces the entry — not a concatenation.
    expect(result.entry.content).toBe(
      'Customer prefers email over phone calls'
    );
    expect(mockRunConsolidationCompletion).toHaveBeenCalledTimes(1);
  });

  // #1062: a failed completion must never lose the write, but it must not
  // concatenate either — concatenation is self-eroding. Create instead.
  test('creates a new entry when consolidation fails', async () => {
    const memoryStoreId = await createMemoryStoreId('Consolidate Failure');
    await writeMemory({ memoryStoreId, content: 'First fact' });

    mockRunConsolidationCompletion.mockRejectedValueOnce(
      new Error('provider unavailable')
    );

    const result = await writeMemory({
      memoryStoreId,
      content: 'Second fact',
      consolidation: { agentId: 'agt_consolidate' },
      ...FORCE_MERGE,
    });

    expect(result.action).toBe('created');
    expect(result.entry.content).toBe('Second fact');
    // The existing entry is left exactly as it was — nothing appended to it.
    const entries = await db.Memory.findAll({ where: { memoryStoreId } });
    expect(
      entries
        .map((e) => {
          return e.content;
        })
        .sort()
    ).toEqual(['First fact', 'Second fact']);
  });

  test('creates a new entry when consolidation returns blank text', async () => {
    const memoryStoreId = await createMemoryStoreId('Consolidate Blank');
    await writeMemory({ memoryStoreId, content: 'Alpha fact' });

    mockRunConsolidationCompletion.mockResolvedValueOnce('   \n  ');

    const result = await writeMemory({
      memoryStoreId,
      content: 'Beta fact',
      consolidation: { agentId: 'agt_consolidate' },
      ...FORCE_MERGE,
    });

    expect(result.action).toBe('created');
    expect(result.entry.content).toBe('Beta fact');
  });

  // No agent context (a manual REST write) means no model to consolidate
  // with, so a merge-band write creates.
  test('creates without calling the LLM when there is no consolidation context', async () => {
    const memoryStoreId = await createMemoryStoreId('Manual Merge');
    await writeMemory({ memoryStoreId, content: 'Alpha' });

    const result = await writeMemory({
      memoryStoreId,
      content: 'Beta',
      ...FORCE_MERGE,
    });

    expect(result.action).toBe('created');
    expect(result.entry.content).toBe('Beta');
    expect(mockRunConsolidationCompletion).not.toHaveBeenCalled();
  });

  test('shallow-merges tags and metadata on an LLM-consolidated merge', async () => {
    const memoryStoreId = await createMemoryStoreId('Tagged Merge');
    await writeMemory({
      memoryStoreId,
      content: 'First fact',
      tags: { role: 'manager' },
      metadata: { a: 1 },
    });

    mockRunConsolidationCompletion.mockResolvedValueOnce('First and second');

    const result = await writeMemory({
      memoryStoreId,
      content: 'Second fact',
      tags: { source: 'rejected_approval' },
      metadata: { b: 2 },
      consolidation: { agentId: 'agt_consolidate' },
      ...FORCE_MERGE,
    });

    expect(result.action).toBe('updated');
    expect(result.entry.tags).toEqual({
      role: 'manager',
      source: 'rejected_approval',
    });
    expect(result.entry.metadata).toEqual({ a: 1, b: 2 });
  });

  test('a merge-band write with no context leaves the existing entry untouched', async () => {
    const memoryStoreId = await createMemoryStoreId('No Erosion');
    const first = await writeMemory({ memoryStoreId, content: 'Atomic fact' });

    await writeMemory({
      memoryStoreId,
      content: 'Related fact',
      ...FORCE_MERGE,
    });

    const existing = await db.Memory.findOne({
      where: { publicId: first.entry.id },
    });
    expect(existing!.content).toBe('Atomic fact');
  });
});
