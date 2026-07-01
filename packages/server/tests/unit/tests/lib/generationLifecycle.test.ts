import { db } from 'src/db';
import { DomainError } from 'src/errors';
import { buildModel } from 'src/lib/agentModel';
import {
  fireCompletionSideEffects,
  recordGenerationFailure,
} from 'src/lib/generationLifecycle';
import { createGenerationRecord, getGeneration } from 'src/lib/generations';

const waitFor = async (predicate: () => Promise<boolean>): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => {
      return setTimeout(resolve, 50);
    });
  }
  throw new Error('waitFor: condition not met in time');
};

describe('generationLifecycle', () => {
  let projectId: number;
  let projectPublicId: string;
  let agentPublicId: string;

  const buildPending = (traceId: string) => {
    return {
      agentId: agentPublicId,
      projectId,
      traceId,
      parentTraceId: null,
      rootTraceId: null,
      generationId: 'gen_lifecycle_001',
      pendingToolCalls: [],
      messages: [],
      steps: [],
      resolvedModel: buildModel({
        provider: 'ollama',
        secretValue: null,
        model: 'test-model',
      }),
      agentConfig: {
        instructions: null,
        maxSteps: 5,
        toolChoice: null,
        stopConditions: null,
        activeToolIds: null,
        stepRules: null,
        temperature: null,
        outputSchema: null,
      },
      resolvedTools: {},
      initiatorGenerationId: null,
      projectPublicId,
    };
  };

  beforeAll(async () => {
    const project = await db.Project.create({
      name: 'GenerationLifecycle Lib Test',
    });
    projectId = project.id;
    projectPublicId = project.publicId;

    const aiProvider = await db.AiProvider.create({
      projectId,
      name: 'Lifecycle Provider',
      provider: 'ollama',
      defaultModel: 'test-model',
    });

    const agent = await db.Agent.create({
      projectId,
      aiProviderId: aiProvider.id,
      name: 'Lifecycle Agent',
    });
    agentPublicId = agent.publicId;
  });

  test('fireCompletionSideEffects marks the generation completed and saves the trace', async () => {
    const gen = await createGenerationRecord({
      publicId: 'gen_lifecycle_001',
      projectId,
      agentId: agentPublicId,
      traceId: 'trc_lifecycle_001',
    });
    expect(gen.status).toBe('in_progress');

    fireCompletionSideEffects({
      generationId: 'gen_lifecycle_001',
      pending: buildPending('trc_lifecycle_001'),
      result: { steps: [{ type: 'text', text: 'done' }], finishReason: 'stop' },
      completedResult: {
        id: 'gen_lifecycle_001',
        traceId: 'trc_lifecycle_001',
        status: 'completed',
        output: { model: 'test-model', content: 'done', finishReason: 'stop' },
      },
    });

    await waitFor(async () => {
      const updated = await getGeneration({ publicId: 'gen_lifecycle_001' });
      return updated?.status === 'completed';
    });

    const updated = await getGeneration({ publicId: 'gen_lifecycle_001' });
    expect(updated?.status).toBe('completed');
    expect(updated?.stopReason).toBe('stop');
    expect(updated?.completedAt).not.toBeNull();
  });

  test('fireCompletionSideEffects tolerates trace save failures (fire-and-forget)', async () => {
    const pending = {
      ...buildPending('trc_lifecycle_missing'),
      agentId: 'agent_does_not_exist',
      generationId: 'gen_lifecycle_missing',
    };

    expect(() => {
      fireCompletionSideEffects({
        generationId: 'gen_lifecycle_missing',
        pending,
        result: { steps: [], finishReason: 'stop' },
        completedResult: {
          id: 'gen_lifecycle_missing',
          traceId: 'trc_lifecycle_missing',
          status: 'completed',
          output: { model: 'test-model', content: '', finishReason: 'stop' },
        },
      });
    }).not.toThrow();
  });

  test('recordGenerationFailure wraps non-DomainErrors in GENERATION_FAILED with trace_id', async () => {
    await createGenerationRecord({
      publicId: 'gen_lifecycle_fail01',
      projectId,
      agentId: agentPublicId,
      traceId: 'trc_lifecycle_fail01',
    });

    const error = await recordGenerationFailure({
      generationId: 'gen_lifecycle_fail01',
      traceId: 'trc_lifecycle_fail01',
      error: new Error('provider exploded'),
    });

    expect(error).toBeInstanceOf(DomainError);
    const domainError = error as DomainError;
    expect(domainError.code).toBe('GENERATION_FAILED');
    expect(domainError.message).toBe('provider exploded');
    expect(domainError.meta?.trace_id).toBe('trc_lifecycle_fail01');
    expect(domainError.meta?.generation_id).toBe('gen_lifecycle_fail01');

    const failed = await getGeneration({ publicId: 'gen_lifecycle_fail01' });
    expect(failed?.status).toBe('failed');
    expect(failed?.stopReason).toBe('error');
    expect(failed?.error?.message).toBe('provider exploded');
  });

  test('recordGenerationFailure enriches DomainErrors with generation and trace IDs', async () => {
    await createGenerationRecord({
      publicId: 'gen_lifecycle_fail02',
      projectId,
      agentId: agentPublicId,
      traceId: 'trc_lifecycle_fail02',
    });

    const original = new DomainError('AI_PROVIDER_ERROR', 'upstream failed');
    const error = await recordGenerationFailure({
      generationId: 'gen_lifecycle_fail02',
      traceId: 'trc_lifecycle_fail02',
      error: original,
    });

    expect(error).toBeInstanceOf(DomainError);
    const domainError = error as DomainError;
    expect(domainError.code).toBe('AI_PROVIDER_ERROR');
    expect(domainError.meta?.trace_id).toBe('trc_lifecycle_fail02');
    expect(domainError.meta?.generation_id).toBe('gen_lifecycle_fail02');
  });

  test('recordGenerationFailure uses "Internal Server Error" message for non-Error thrown values', async () => {
    await createGenerationRecord({
      publicId: 'gen_lifecycle_fail03',
      projectId,
      agentId: agentPublicId,
      traceId: 'trc_lifecycle_fail03',
    });

    const error = await recordGenerationFailure({
      generationId: 'gen_lifecycle_fail03',
      traceId: 'trc_lifecycle_fail03',
      error: { code: 'SOME_OBJECT', detail: 'not an Error instance' },
    });

    expect(error).toBeInstanceOf(DomainError);
    const domainError = error as DomainError;
    expect(domainError.code).toBe('GENERATION_FAILED');
    expect(domainError.message).toBe('Internal Server Error');
    expect(domainError.meta?.trace_id).toBe('trc_lifecycle_fail03');
    expect(domainError.meta?.generation_id).toBe('gen_lifecycle_fail03');
  });
});
