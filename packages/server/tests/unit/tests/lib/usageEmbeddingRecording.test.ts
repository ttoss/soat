import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import { db } from 'src/db';
import { createGenerationRecord } from 'src/lib/generations';
import { recordEmbeddingUsage } from 'src/lib/usageEmbeddingRecording';

// A retrieval ahead of an agent's turn embeds before the turn's record exists,
// so the event names the generation by public id until `createGenerationRecord`
// commits. The record write failing in between — its agent gone by the time
// the row is written — is an interleaving no request drives deterministically,
// so that branch is pinned here. Linking a committed record, and every pricing
// and attribution outcome, is covered through `rest/usageEmbeddings.test.ts`.
describe('an embedding whose generation record is never written', () => {
  let projectId: number;

  const MISSING_AGENT = 'agt_missing';

  const recordFor = (generationId: string) => {
    return recordEmbeddingUsage({
      projectId,
      generationId,
      subject: null,
      provider: 'openai',
      model: 'text-embedding-3-small',
      tokens: 3,
    });
  };

  const createRecord = (generationId: string) => {
    return createGenerationRecord({
      publicId: generationId,
      projectId,
      agentId: MISSING_AGENT,
      traceId: generatePublicId(PUBLIC_ID_PREFIXES.trace),
    });
  };

  const eventFor = async (generationId: string) => {
    const events = await db.UsageEvent.findAll({
      where: { projectId, generationPublicId: generationId },
    });
    expect(events).toHaveLength(1);
    return events[0];
  };

  beforeAll(async () => {
    const project = await db.Project.create({ name: 'Embedding Detach' });
    projectId = project.id;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('names no generation and stays billed to its project', async () => {
    const generationId = generatePublicId(PUBLIC_ID_PREFIXES.generation);
    await recordFor(generationId);
    const pending = await eventFor(generationId);

    await expect(createRecord(generationId)).rejects.toMatchObject({
      code: 'AGENT_NOT_FOUND',
    });

    const detached = await db.UsageEvent.findByPk(pending.id);
    expect(detached!.generationPublicId).toBeNull();
    expect(detached!.generationId).toBeNull();
    expect(detached!.projectId).toBe(projectId);
  });

  // Sanctioned force-failure: detaching is bookkeeping around the record
  // write, so its own failure must not replace the error of the write.
  test('a failed detach still surfaces the record write error', async () => {
    const generationId = generatePublicId(PUBLIC_ID_PREFIXES.generation);
    await recordFor(generationId);
    jest
      .spyOn(db.UsageEvent, 'update')
      .mockRejectedValueOnce(new Error('simulated detach failure'));

    await expect(createRecord(generationId)).rejects.toMatchObject({
      code: 'AGENT_NOT_FOUND',
    });
  });
});
