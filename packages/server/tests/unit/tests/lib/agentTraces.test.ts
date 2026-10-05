import { db } from 'src/db';
import { systemPath } from 'src/lib/filePaths';
import { upsertFileByPath } from 'src/lib/files';
import { readFileBuffer } from 'src/lib/fileStorage';
import { createGenerationRecord } from 'src/lib/generations';
import { getTrace, saveTrace } from 'src/lib/traces';

/**
 * The two `saveTrace` guarantees no entry point can drive (tests.md keep-list):
 *
 * - bytes in storage that are not a steps array come from outside the API —
 *   `/.system/` is refused to every caller path — so the object is started
 *   over rather than built on;
 * - two writes on one trace interleave only when they land in the same tick,
 *   an ordering HTTP cannot pin, and the per-trace lock must keep both.
 */
describe('saveTrace', () => {
  let projectId: number;
  let projectPublicId: string;
  let agentPublicId: string;

  const readSteps = async (traceId: string): Promise<string> => {
    const trace = await db.Trace.findOne({ where: { publicId: traceId } });
    const file = await db.File.findOne({ where: { id: trace?.fileId } });
    const buffer = await readFileBuffer({
      storagePath: file?.storagePath ?? '',
      storageType: file?.storageType ?? 'local',
    });
    return buffer?.toString('utf8') ?? '';
  };

  const generate = async (args: { traceId: string; generationId: string }) => {
    await createGenerationRecord({
      publicId: args.generationId,
      projectId,
      agentId: agentPublicId,
      traceId: args.traceId,
    });
  };

  const common = (traceId: string) => {
    return { traceId, projectId, projectPublicId, agentId: agentPublicId };
  };

  beforeAll(async () => {
    const project = await db.Project.create({ name: 'Trace Grouping' });
    projectId = project.id;
    projectPublicId = project.publicId;

    const aiProvider = await db.AiProvider.create({
      projectId,
      name: 'Grouping Provider',
      provider: 'openai',
      defaultModel: 'gpt-4o-mini',
      baseUrl: null,
      config: null,
      secretId: null,
    });

    const agent = await db.Agent.create({
      publicId: 'agt_grouping',
      projectId,
      aiProviderId: aiProvider.id,
      name: 'Grouping Agent',
    });
    agentPublicId = agent.publicId;
  });

  test('starts the object over when the stored bytes are not a steps array', async () => {
    const traceId = `trc_group_corrupt_${Date.now()}`;

    await generate({ traceId, generationId: 'gen_corrupt_a' });
    await saveTrace({
      ...common(traceId),
      generationId: 'gen_corrupt_a',
      steps: [{ content: [{ type: 'text', text: 'CORRUPT_1' }] }],
    });

    await upsertFileByPath({
      projectId,
      projectPublicId,
      path: systemPath({ module: 'traces', leaf: `${traceId}.json` }),
      fileBuffer: Buffer.from('{ not json', 'utf8'),
      contentType: 'application/json',
    });

    await generate({ traceId, generationId: 'gen_corrupt_b' });
    await saveTrace({
      ...common(traceId),
      generationId: 'gen_corrupt_b',
      steps: [{ content: [{ type: 'text', text: 'CORRUPT_2' }] }],
    });

    expect((await getTrace({ traceId })).step_count).toBe(1);
    expect(await readSteps(traceId)).toContain('CORRUPT_2');
  });

  test('concurrent saves on one trace keep both generations', async () => {
    const traceId = `trc_group_race_${Date.now()}`;

    await generate({ traceId, generationId: 'gen_race_a' });
    await generate({ traceId, generationId: 'gen_race_b' });

    await Promise.all([
      saveTrace({
        ...common(traceId),
        generationId: 'gen_race_a',
        steps: [{ content: [{ type: 'text', text: 'RACE_A' }] }],
      }),
      saveTrace({
        ...common(traceId),
        generationId: 'gen_race_b',
        steps: [{ content: [{ type: 'text', text: 'RACE_B' }] }],
      }),
    ]);

    const trace = await getTrace({ traceId });
    const content = await readSteps(traceId);

    expect(trace.step_count).toBe(2);
    expect(content).toContain('RACE_A');
    expect(content).toContain('RACE_B');
  });
});
