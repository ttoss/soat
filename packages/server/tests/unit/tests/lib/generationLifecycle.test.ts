import { db } from 'src/db';
import { DomainError } from 'src/errors';
import { buildModel } from 'src/lib/agentModel';
import {
  fireCompletionSideEffects,
  recordGenerationFailure,
} from 'src/lib/generationLifecycle';
import { createGenerationRecord } from 'src/lib/generations';

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
