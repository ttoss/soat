import { db } from 'src/db';
import * as consolidationCompletionModule from 'src/lib/memoryConsolidationCompletion';
import { writeMemoryEntry } from 'src/lib/memoryEntries';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

const mockRunConsolidationCompletion = jest.spyOn(
  consolidationCompletionModule,
  'runConsolidationCompletion'
);

// All test embeddings resolve to the same mock vector, so any second write
// scores 1.0 against the first. `duplicate_threshold > 1` keeps it out of the
// skip branch and `update_threshold = 0` forces the merge branch.
const FORCE_MERGE = { duplicateThreshold: 1.1, updateThreshold: 0 } as const;

describe('writeMemoryEntry merge consolidation', () => {
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

  const createMemoryId = async (name: string): Promise<number> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/memories')
      .send({ project_id: projectId, name });
    const memory = await db.Memory.findOne({
      where: { publicId: res.body.id },
    });
    return memory!.id as number;
  };

  test('consolidates the merge via the LLM when a consolidation context is provided', async () => {
    const memoryId = await createMemoryId('Consolidate Merge');
    await writeMemoryEntry({
      memoryId,
      content: 'Customer prefers phone calls',
    });

    mockRunConsolidationCompletion.mockResolvedValueOnce(
      'Customer prefers email over phone calls'
    );

    const result = await writeMemoryEntry({
      memoryId,
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

  test('falls back to concatenation when consolidation fails', async () => {
    const memoryId = await createMemoryId('Consolidate Failure');
    await writeMemoryEntry({ memoryId, content: 'First fact' });

    mockRunConsolidationCompletion.mockRejectedValueOnce(
      new Error('provider unavailable')
    );

    const result = await writeMemoryEntry({
      memoryId,
      content: 'Second fact',
      consolidation: { agentId: 'agt_consolidate' },
      ...FORCE_MERGE,
    });

    expect(result.action).toBe('updated');
    expect(result.entry.content).toBe('First fact\nSecond fact');
  });

  test('falls back to concatenation when consolidation returns blank text', async () => {
    const memoryId = await createMemoryId('Consolidate Blank');
    await writeMemoryEntry({ memoryId, content: 'Alpha fact' });

    mockRunConsolidationCompletion.mockResolvedValueOnce('   \n  ');

    const result = await writeMemoryEntry({
      memoryId,
      content: 'Beta fact',
      consolidation: { agentId: 'agt_consolidate' },
      ...FORCE_MERGE,
    });

    expect(result.entry.content).toBe('Alpha fact\nBeta fact');
  });

  test('concatenates without calling the LLM when no consolidation context', async () => {
    const memoryId = await createMemoryId('Manual Merge');
    await writeMemoryEntry({ memoryId, content: 'Alpha' });

    const result = await writeMemoryEntry({
      memoryId,
      content: 'Beta',
      ...FORCE_MERGE,
    });

    expect(result.action).toBe('updated');
    expect(result.entry.content).toBe('Alpha\nBeta');
    expect(mockRunConsolidationCompletion).not.toHaveBeenCalled();
  });

  test('persists tags and metadata on a newly created entry', async () => {
    const memoryId = await createMemoryId('Tagged Create');
    const result = await writeMemoryEntry({
      memoryId,
      content: 'Prefers async standups',
      tags: ['role:manager'],
      metadata: { source: 'interview' },
    });

    expect(result.action).toBe('created');
    expect(result.entry.tags).toEqual(['role:manager']);
    expect(result.entry.metadata).toEqual({ source: 'interview' });
  });

  test('unions tags and shallow-merges metadata on a merge write', async () => {
    const memoryId = await createMemoryId('Tagged Merge');
    await writeMemoryEntry({
      memoryId,
      content: 'First fact',
      tags: ['role:manager'],
      metadata: { a: 1 },
    });

    const result = await writeMemoryEntry({
      memoryId,
      content: 'Second fact',
      tags: ['source:rejected_approval'],
      metadata: { b: 2 },
      ...FORCE_MERGE,
    });

    expect(result.action).toBe('updated');
    expect(result.entry.tags).toEqual(
      expect.arrayContaining(['role:manager', 'source:rejected_approval'])
    );
    expect(result.entry.metadata).toEqual({ a: 1, b: 2 });
  });
});
