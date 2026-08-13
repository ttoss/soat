import { db } from 'src/db';
import { DomainError } from 'src/errors';
import * as eventBusModule from 'src/lib/eventBus';
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
    expect(updated?.stop_reason).toBe('stop');
    expect(updated?.completed_at).not.toBeNull();
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
    expect(failed?.stop_reason).toBe('error');
    expect(failed?.error?.message).toBe('provider exploded');
  });

  /**
   * A completed turn announces itself (`agents.generation.completed`); a failed
   * one has to as well, or the only way to learn a background generation died
   * is to poll the record. Webhook subscribers are the reason this matters: a
   * caller that got a `202` and went away has no other channel.
   */
  test('recordGenerationFailure announces the failure on the event bus', async () => {
    await createGenerationRecord({
      publicId: 'gen_lifecycle_fail04',
      projectId,
      agentId: agentPublicId,
      traceId: 'trc_lifecycle_fail04',
    });

    const events: eventBusModule.SoatEvent[] = [];
    const listener = (e: eventBusModule.SoatEvent) => {
      events.push(e);
    };
    eventBusModule.eventBus.on('soat:event', listener);

    try {
      await recordGenerationFailure({
        generationId: 'gen_lifecycle_fail04',
        traceId: 'trc_lifecycle_fail04',
        projectId,
        projectPublicId,
        error: new DomainError('AI_PROVIDER_ERROR', 'upstream refused'),
      });

      await waitFor(async () => {
        return events.some((e) => {
          return e.type === 'agents.generation.failed';
        });
      });
    } finally {
      // A listener left on the singleton bus leaks into every later test.
      eventBusModule.eventBus.off('soat:event', listener);
    }

    const failure = events.find((e) => {
      return e.type === 'agents.generation.failed';
    });
    expect(failure?.projectPublicId).toBe(projectPublicId);
    expect(failure?.resourceType).toBe('generation');
    // The subscriber is told which turn died and why, without a second read.
    expect(failure?.resourceId).toBe('gen_lifecycle_fail04');
    const data = failure?.data as {
      status?: string;
      trace_id?: string;
      error?: { code?: string; message?: string };
    };
    expect(data.status).toBe('failed');
    expect(data.trace_id).toBe('trc_lifecycle_fail04');
    expect(data.error?.code).toBe('AI_PROVIDER_ERROR');
    expect(data.error?.message).toBe('upstream refused');
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
