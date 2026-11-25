import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import { db } from 'src/db';
import { systemPath } from 'src/lib/filePaths';
import { upsertFileByPath } from 'src/lib/files';
import { createGenerationRecord } from 'src/lib/generations';
import { writeTraceStep } from 'src/lib/traceStepStore';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A trace stored as one steps object (`Trace.fileId`, divided between grouped
 * generations by `Trace.stepSegments`) reads back through the transcript and
 * is erased by a purge. No entry point writes that layout, so its rows are
 * seeded directly.
 */
describe('a trace stored as one steps object', () => {
  let userToken: string;
  let projectDbId: number;
  let projectPublicId: string;
  let agentId: string;

  const textStep = (text: string) => {
    return { content: [{ type: 'text', text }] };
  };

  const seedTrace = async (args: {
    bytes: string;
    segments: Array<{ generationId: string; stepCount: number }>;
    generationIds: string[];
    stepCount: number;
  }): Promise<string> => {
    const traceId = generatePublicId(PUBLIC_ID_PREFIXES.trace);
    for (const generationId of args.generationIds) {
      await createGenerationRecord({
        authority: null,
        actsAsAgent: null,
        clock: null,
        publicId: generationId,
        projectId: projectDbId,
        agentId,
        traceId,
      });
    }
    await db.Generation.update(
      { stepCount: null, status: 'completed' },
      { where: { publicId: args.generationIds } }
    );

    const path = systemPath({ module: 'traces', leaf: `${traceId}.json` });
    await upsertFileByPath({
      projectId: projectDbId,
      projectPublicId,
      path,
      fileBuffer: Buffer.from(args.bytes, 'utf8'),
      contentType: 'application/json',
    });
    const file = await db.File.findOne({
      where: { projectId: projectDbId, path },
    });
    await db.Trace.update(
      {
        fileId: file?.id ?? null,
        stepSegments: args.segments,
        stepCount: args.stepCount,
      },
      { where: { publicId: traceId } }
    );
    return traceId;
  };

  const transcript = (generationId: string) => {
    return authenticatedTestClient(userToken).get(
      `/api/v1/generations/${generationId}/transcript`
    );
  };

  const texts = (steps: Array<{ text: string }>) => {
    return steps.map((step) => {
      return step.text;
    });
  };

  const newGenerationId = () => {
    return generatePublicId(PUBLIC_ID_PREFIXES.generation);
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'legacy-steps',
      policyActions: [
        'generations:GetGeneration',
        'traces:GetTrace',
        'traces:PurgeTraceContent',
      ],
    });
    userToken = setup.userToken;
    projectPublicId = setup.projectId;

    const project = await db.Project.findOne({
      where: { publicId: projectPublicId },
    });
    projectDbId = project?.id as number;

    const aiProvider = await db.AiProvider.create({
      projectId: projectDbId,
      name: 'Legacy Steps Provider',
      provider: 'openai',
      defaultModel: 'gpt-4o-mini',
      baseUrl: null,
      config: null,
      secretId: null,
    });
    const agent = await db.Agent.create({
      publicId: generatePublicId(PUBLIC_ID_PREFIXES.agent),
      projectId: projectDbId,
      aiProviderId: aiProvider.id,
      name: 'Legacy Steps Agent',
    });
    agentId = agent.publicId;
  });

  test('each grouped generation reads its own segment', async () => {
    const first = newGenerationId();
    const second = newGenerationId();
    await seedTrace({
      bytes: JSON.stringify([textStep('A1'), textStep('A2'), textStep('B1')]),
      segments: [
        { generationId: first, stepCount: 2 },
        { generationId: second, stepCount: 1 },
      ],
      generationIds: [first, second],
      stepCount: 3,
    });

    const a = await transcript(first);
    const b = await transcript(second);

    expect(a.status).toBe(200);
    expect(texts(a.body.steps)).toEqual(['A1', 'A2']);
    expect(a.body.step_count).toBe(2);
    expect(texts(b.body.steps)).toEqual(['B1']);
    expect(b.body.step_count).toBe(1);
  });

  test('an unindexed object is one turn, read whole', async () => {
    const generationId = newGenerationId();
    await seedTrace({
      bytes: JSON.stringify([textStep('ONLY_1'), textStep('ONLY_2')]),
      segments: [],
      generationIds: [generationId],
      stepCount: 2,
    });

    const res = await transcript(generationId);

    expect(res.status).toBe(200);
    expect(texts(res.body.steps)).toEqual(['ONLY_1', 'ONLY_2']);
    expect(res.body.step_count).toBe(2);
  });

  test('an object that is not JSON reads as no steps', async () => {
    const generationId = newGenerationId();
    await seedTrace({
      bytes: '{ not json',
      segments: [],
      generationIds: [generationId],
      stepCount: 1,
    });

    const res = await transcript(generationId);

    expect(res.status).toBe(200);
    expect(res.body.steps).toEqual([]);
    expect(res.body.output).toBeNull();
  });

  test('a generation with step objects reads them, not the object', async () => {
    const generationId = newGenerationId();
    const traceId = await seedTrace({
      bytes: JSON.stringify([textStep('LEGACY')]),
      segments: [{ generationId, stepCount: 1 }],
      generationIds: [generationId],
      stepCount: 1,
    });
    await writeTraceStep({
      target: {
        traceId,
        generationId,
        projectId: projectDbId,
        projectPublicId,
        agentId,
      },
      firstIndex: 0,
      stepNumber: 0,
      step: textStep('STORED'),
    });

    const res = await transcript(generationId);

    expect(res.status).toBe(200);
    expect(texts(res.body.steps)).toEqual(['STORED']);
    expect(res.body.step_count).toBe(1);
  });

  test('a purge deletes the object', async () => {
    const generationId = newGenerationId();
    const traceId = await seedTrace({
      bytes: JSON.stringify([textStep('PURGED')]),
      segments: [],
      generationIds: [generationId],
      stepCount: 1,
    });
    const path = systemPath({ module: 'traces', leaf: `${traceId}.json` });

    const purge = await authenticatedTestClient(userToken).delete(
      `/api/v1/traces/${traceId}/content`
    );

    expect(purge.status).toBe(200);
    expect(purge.body.file_id).toBeNull();
    expect(
      await db.File.findOne({ where: { projectId: projectDbId, path } })
    ).toBeNull();
    expect((await transcript(generationId)).body.steps).toEqual([]);
  });
});
