import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import { Op } from '@ttoss/postgresdb';
import { db } from 'src/db';
import { purgeTraceContent } from 'src/lib/contentPurge';
import { createGenerationRecord } from 'src/lib/generations';
import {
  replaceTraceSteps,
  type TraceStepTarget,
  writeTraceStep,
} from 'src/lib/traceStepStore';

/**
 * The step store's guarantees no entry point can order (tests.md keep-list):
 * two processes writing one trace, and a purge landing between a running
 * generation's steps. Each write here is a separate call with no shared lock,
 * as on two server processes.
 */
describe('traceStepStore', () => {
  let projectId: number;
  let projectPublicId: string;
  let agentPublicId: string;

  const startGeneration = async (traceId: string): Promise<TraceStepTarget> => {
    const generationId = generatePublicId(PUBLIC_ID_PREFIXES.generation);
    await createGenerationRecord({
      authority: null,
      actsAsAgent: null,
      clock: null,
      publicId: generationId,
      projectId,
      agentId: agentPublicId,
      traceId,
    });
    return {
      traceId,
      generationId,
      projectId,
      projectPublicId,
      agentId: agentPublicId,
    };
  };

  const stepPaths = async (traceId: string): Promise<string[]> => {
    const files = await db.File.findAll({
      where: { path: { [Op.like]: `/.system/traces/${traceId}/%` } },
      attributes: ['path'],
      order: [['path', 'ASC']],
    });
    return files.map((file) => {
      return file.path ?? '';
    });
  };

  const traceStepCount = async (traceId: string): Promise<number> => {
    const trace = await db.Trace.findOne({ where: { publicId: traceId } });
    return trace?.stepCount ?? -1;
  };

  const textStep = (args: { text: string; stepNumber: number }) => {
    return {
      stepNumber: args.stepNumber,
      content: [{ type: 'text', text: args.text }],
    };
  };

  beforeAll(async () => {
    const project = await db.Project.create({ name: 'Trace Step Store' });
    projectId = project.id;
    projectPublicId = project.publicId;

    const aiProvider = await db.AiProvider.create({
      projectId,
      name: 'Step Store Provider',
      provider: 'openai',
      defaultModel: 'gpt-4o-mini',
      baseUrl: null,
      config: null,
      secretId: null,
    });
    const agent = await db.Agent.create({
      publicId: 'agt_step_store',
      projectId,
      aiProviderId: aiProvider.id,
      name: 'Step Store Agent',
    });
    agentPublicId = agent.publicId;
  });

  test('two generations writing one trace at once lose no step', async () => {
    const traceId = generatePublicId(PUBLIC_ID_PREFIXES.trace);
    const first = await startGeneration(traceId);
    const second = await startGeneration(traceId);

    // A generation's own steps are sequential (the SDK awaits each); the two
    // generations' writes interleave freely.
    await Promise.all(
      [first, second].map(async (target) => {
        for (const stepNumber of [0, 1, 2]) {
          await writeTraceStep({
            target,
            firstIndex: 0,
            stepNumber,
            step: textStep({ text: target.generationId, stepNumber }),
          });
        }
      })
    );

    expect(await stepPaths(traceId)).toHaveLength(6);
    expect(await traceStepCount(traceId)).toBe(6);
  });

  test('a step ended after a purge writes no content', async () => {
    const traceId = generatePublicId(PUBLIC_ID_PREFIXES.trace);
    const target = await startGeneration(traceId);
    await writeTraceStep({
      target,
      firstIndex: 0,
      stepNumber: 0,
      step: textStep({ text: 'before the purge', stepNumber: 0 }),
    });

    await purgeTraceContent({
      traceId,
      principal: {
        principalType: 'system',
        principalId: 'test',
        actsFor: null,
      },
    });
    await writeTraceStep({
      target,
      firstIndex: 0,
      stepNumber: 1,
      step: textStep({ text: 'after the purge', stepNumber: 1 }),
    });

    expect(await stepPaths(traceId)).toEqual([]);
    // The counter is skeleton, kept by the purge.
    expect(await traceStepCount(traceId)).toBe(2);
  });

  test('a purge racing a step leaves no content, whichever lands first', async () => {
    const traceId = generatePublicId(PUBLIC_ID_PREFIXES.trace);
    const target = await startGeneration(traceId);

    await Promise.all([
      ...[0, 1, 2, 3].map((stepNumber) => {
        return writeTraceStep({
          target,
          firstIndex: 0,
          stepNumber,
          step: textStep({ text: 'racing', stepNumber }),
        });
      }),
      purgeTraceContent({
        traceId,
        principal: {
          principalType: 'system',
          principalId: 'test',
          actsFor: null,
        },
      }),
    ]);

    expect(await stepPaths(traceId)).toEqual([]);
  });

  test('a resumed segment writes after the steps the turn spent', async () => {
    const traceId = generatePublicId(PUBLIC_ID_PREFIXES.trace);
    const target = await startGeneration(traceId);

    await writeTraceStep({
      target,
      firstIndex: 2,
      stepNumber: 1,
      step: textStep({ text: 'resumed', stepNumber: 1 }),
    });

    expect(await stepPaths(traceId)).toEqual([
      `/.system/traces/${traceId}/${target.generationId}/000003.json`,
    ]);
    expect(await traceStepCount(traceId)).toBe(4);
  });

  test('a discarded attempt takes its steps and its count with it', async () => {
    const traceId = generatePublicId(PUBLIC_ID_PREFIXES.trace);
    const kept = await startGeneration(traceId);
    const retried = await startGeneration(traceId);
    await writeTraceStep({
      target: kept,
      firstIndex: 0,
      stepNumber: 0,
      step: textStep({ text: 'kept', stepNumber: 0 }),
    });
    for (const stepNumber of [0, 1]) {
      await writeTraceStep({
        target: retried,
        firstIndex: 0,
        stepNumber,
        step: textStep({ text: 'abandoned', stepNumber }),
      });
    }

    await replaceTraceSteps({ target: retried, firstIndex: 0, steps: [] });

    expect(await stepPaths(traceId)).toEqual([
      `/.system/traces/${traceId}/${kept.generationId}/000000.json`,
    ]);
    expect(await traceStepCount(traceId)).toBe(1);
  });
});
