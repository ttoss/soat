import type { PendingGeneration } from 'src/lib/agentGenerationHelpers';

const loadAgentGenerationModule = async () => {
  return import('src/lib/agentGeneration');
};

const loadGenerationHelpersModule = async () => {
  return import('src/lib/agentGenerationHelpers');
};

describe('createGeneration', () => {
  afterEach(() => {
    jest.unmock('ai');
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('throws DomainError when agent does not exist', async () => {
    const { createGeneration } = await loadAgentGenerationModule();
    await expect(
      createGeneration({
        agentId: 'nonexistent_agent_id',
        messages: [{ role: 'user', content: 'hello' }],
      })
    ).rejects.toThrow('not found');
  });

  test('returns depth guard result when remainingDepth is 0', async () => {
    jest.doMock('src/db', () => {
      return {
        db: {
          Agent: {
            findOne: jest.fn().mockResolvedValue({
              publicId: 'agt_depth_test',
              project: { id: 42, publicId: 'proj_depth_test' },
            }),
          },
        },
        models: {},
      };
    });
    const { createGeneration } = await loadAgentGenerationModule();
    const result = await createGeneration({
      agentId: 'any_agent_id',
      messages: [{ role: 'user', content: 'hello' }],
      remainingDepth: 0,
    });

    expect(result).toMatchObject({
      status: 'completed',
      output: expect.objectContaining({
        content: 'Maximum call depth reached',
        finishReason: 'stop',
      }),
    });
  });
});

describe('submitToolOutputs', () => {
  afterEach(() => {
    jest.unmock('ai');
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('throws DomainError when generation does not exist', async () => {
    jest.doMock('src/lib/generations', () => {
      return {
        createGenerationRecord: jest.fn(),
        getGeneration: jest.fn().mockResolvedValue(null),
        updateGenerationRecord: jest.fn(),
      };
    });
    const { submitToolOutputs } = await loadAgentGenerationModule();
    await expect(
      submitToolOutputs({
        agentId: 'agent_id',
        generationId: 'gen_nonexistent_0000',
        toolOutputs: [{ toolCallId: 'tc_1', output: 'result' }],
      })
    ).rejects.toThrow('not found');
  });

  test('processes pending tool outputs and returns completed result', async () => {
    jest.doMock('ai', () => {
      const actual = jest.requireActual('ai');
      return {
        ...actual,
        generateText: jest.fn().mockResolvedValue({
          text: 'final answer',
          finishReason: 'stop',
          steps: [],
          response: { modelId: 'mock-model' },
        }),
      };
    });
    jest.doMock('src/lib/eventBus', () => {
      const actual = jest.requireActual('src/lib/eventBus');
      return {
        ...actual,
        resolveProjectPublicId: jest.fn().mockResolvedValue('prj_test'),
        emitEvent: jest.fn(),
      };
    });
    jest.doMock('src/lib/generations', () => {
      return {
        createGenerationRecord: jest.fn().mockResolvedValue(undefined),
        getGeneration: jest.fn().mockResolvedValue(null),
        updateGenerationRecord: jest.fn().mockResolvedValue(undefined),
      };
    });

    const { submitToolOutputs } = await loadAgentGenerationModule();
    const { pendingGenerations } = await loadGenerationHelpersModule();
    const eventBusModule = await import('src/lib/eventBus');
    const resolveProjectSpy =
      eventBusModule.resolveProjectPublicId as jest.Mock;
    const emitEventSpy = eventBusModule.emitEvent as jest.Mock;

    const pending: PendingGeneration = {
      agentId: 'agt_test',
      projectId: 1,
      projectPublicId: 'prj_test',
      traceId: 'trc_test',
      parentTraceId: null,
      rootTraceId: null,
      generationId: 'gen_pending_1',
      initiatorGenerationId: null,
      pendingToolCalls: [
        {
          toolCallId: 'tc_1',
          toolName: 'clientTool',
          args: { foo: 'bar' },
        },
      ],
      messages: [{ role: 'user', content: 'hello' }],
      resolvedModel: {} as never,
      agentConfig: {
        instructions: null,
        maxSteps: 5,
        toolChoice: 'auto',
        stopConditions: null,
        activeToolIds: null,
        stepRules: null,
        temperature: null,
      },
      resolvedTools: {},
    };

    pendingGenerations.set('gen_pending_1', pending);

    const result = await submitToolOutputs({
      agentId: 'agt_test',
      generationId: 'gen_pending_1',
      toolOutputs: [{ toolCallId: 'tc_1', output: 'ok' }],
    });

    expect(result).toMatchObject({
      id: 'gen_pending_1',
      traceId: 'trc_test',
      status: 'completed',
      output: {
        model: 'mock-model',
        content: 'final answer',
        finishReason: 'stop',
      },
    });
    expect(pendingGenerations.has('gen_pending_1')).toBe(false);

    await Promise.resolve();
    expect(resolveProjectSpy).toHaveBeenCalledWith({ projectId: 1 });
    expect(emitEventSpy).toHaveBeenCalled();
  });
});
