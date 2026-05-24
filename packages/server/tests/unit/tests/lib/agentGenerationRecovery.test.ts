const loadRecoveryModule = async () => {
  return import('src/lib/agentGenerationRecovery');
};

describe('recoverPendingFromDb', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('returns undefined when generation is not found', async () => {
    jest.doMock('src/lib/generations', () => {
      return {
        getGeneration: jest.fn().mockResolvedValue(null),
        updateGenerationRecord: jest.fn(),
        createGenerationRecord: jest.fn(),
      };
    });

    const { recoverPendingFromDb } = await loadRecoveryModule();
    const result = await recoverPendingFromDb({
      generationId: 'gen_missing',
      agentId: 'agt_test',
    });

    expect(result).toBeUndefined();
  });

  test('returns undefined when pendingState is missing from metadata', async () => {
    jest.doMock('src/lib/generations', () => {
      return {
        getGeneration: jest.fn().mockResolvedValue({
          publicId: 'gen_1',
          agentId: 'agt_test',
          traceId: 'trc_1',
          metadata: {},
        }),
        updateGenerationRecord: jest.fn(),
        createGenerationRecord: jest.fn(),
      };
    });

    const { recoverPendingFromDb } = await loadRecoveryModule();
    const result = await recoverPendingFromDb({
      generationId: 'gen_1',
      agentId: 'agt_test',
    });

    expect(result).toBeUndefined();
  });

  test('returns undefined when agentId does not match generation', async () => {
    jest.doMock('src/lib/generations', () => {
      return {
        getGeneration: jest.fn().mockResolvedValue({
          publicId: 'gen_1',
          agentId: 'agt_other',
          traceId: 'trc_1',
          metadata: {
            pendingState: {
              pendingToolCalls: [],
              messages: [],
              parentTraceId: null,
              rootTraceId: null,
              toolContext: null,
              remainingDepth: null,
            },
          },
        }),
        updateGenerationRecord: jest.fn(),
        createGenerationRecord: jest.fn(),
      };
    });

    const { recoverPendingFromDb } = await loadRecoveryModule();
    const result = await recoverPendingFromDb({
      generationId: 'gen_1',
      agentId: 'agt_test',
    });

    expect(result).toBeUndefined();
  });

  test('returns undefined when typedAgent is not found', async () => {
    jest.doMock('src/lib/generations', () => {
      return {
        getGeneration: jest.fn().mockResolvedValue({
          publicId: 'gen_1',
          agentId: 'agt_test',
          traceId: 'trc_1',
          metadata: {
            pendingState: {
              pendingToolCalls: [],
              messages: [{ role: 'user', content: 'hi' }],
              parentTraceId: null,
              rootTraceId: null,
              toolContext: null,
              remainingDepth: null,
            },
          },
        }),
        updateGenerationRecord: jest.fn(),
        createGenerationRecord: jest.fn(),
      };
    });
    jest.doMock('src/db', () => {
      return {
        db: {
          Agent: { findOne: jest.fn().mockResolvedValue(null) },
          Project: {},
          AiProvider: {},
        },
        models: {},
      };
    });

    const { recoverPendingFromDb } = await loadRecoveryModule();
    const result = await recoverPendingFromDb({
      generationId: 'gen_1',
      agentId: 'agt_test',
    });

    expect(result).toBeUndefined();
  });

  test('returns undefined when AI provider secret cannot be resolved', async () => {
    jest.doMock('src/lib/generations', () => {
      return {
        getGeneration: jest.fn().mockResolvedValue({
          publicId: 'gen_2',
          agentId: 'agt_test',
          traceId: 'trc_2',
          metadata: {
            pendingState: {
              pendingToolCalls: [],
              messages: [{ role: 'user', content: 'hi' }],
              parentTraceId: null,
              rootTraceId: null,
              toolContext: null,
              remainingDepth: null,
            },
          },
        }),
        updateGenerationRecord: jest.fn(),
        createGenerationRecord: jest.fn(),
      };
    });
    jest.doMock('src/db', () => {
      return {
        db: {
          Agent: {
            findOne: jest.fn().mockResolvedValue({
              publicId: 'agt_test',
              model: 'gpt-4',
              toolIds: null,
              maxSteps: 5,
              toolChoice: 'auto',
              stopConditions: null,
              activeToolIds: null,
              stepRules: null,
              temperature: null,
              boundaryPolicy: null,
              instructions: null,
              project: { id: 1, publicId: 'prj_test' },
              aiProvider: { publicId: 'aip_test' },
            }),
          },
          Project: {},
          AiProvider: {},
        },
        models: {},
      };
    });
    jest.doMock('src/lib/aiProviders', () => {
      return {
        resolveAiProviderSecret: jest.fn().mockResolvedValue(null),
      };
    });

    const { recoverPendingFromDb } = await loadRecoveryModule();
    const result = await recoverPendingFromDb({
      generationId: 'gen_2',
      agentId: 'agt_test',
    });

    expect(result).toBeUndefined();
  });

  test('returns PendingGeneration when toolIds is null', async () => {
    const pendingState = {
      pendingToolCalls: [
        { toolCallId: 'tc_1', toolName: 'myTool', args: { x: 1 } },
      ],
      messages: [{ role: 'user', content: 'hello' }],
      parentTraceId: 'trc_parent',
      rootTraceId: 'trc_root',
      toolContext: null,
      remainingDepth: null,
    };
    const mockModel = { modelId: 'mock-model' };

    jest.doMock('src/lib/generations', () => {
      return {
        getGeneration: jest.fn().mockResolvedValue({
          publicId: 'gen_3',
          agentId: 'agt_test',
          traceId: 'trc_3',
          metadata: { pendingState },
        }),
        updateGenerationRecord: jest.fn(),
        createGenerationRecord: jest.fn(),
      };
    });
    jest.doMock('src/db', () => {
      return {
        db: {
          Agent: {
            findOne: jest.fn().mockResolvedValue({
              publicId: 'agt_test',
              model: null,
              toolIds: null,
              maxSteps: 10,
              toolChoice: 'auto',
              stopConditions: null,
              activeToolIds: null,
              stepRules: null,
              temperature: null,
              boundaryPolicy: null,
              instructions: 'Be helpful',
              project: { id: 1, publicId: 'prj_test' },
              aiProvider: { publicId: 'aip_test' },
            }),
          },
          Project: {},
          AiProvider: {},
        },
        models: {},
      };
    });
    jest.doMock('src/lib/aiProviders', () => {
      return {
        resolveAiProviderSecret: jest.fn().mockResolvedValue({
          provider: 'openai',
          secretValue: 'sk-test',
          defaultModel: 'gpt-4o',
          baseUrl: undefined,
          config: undefined,
        }),
      };
    });
    jest.doMock('src/lib/agentModel', () => {
      return {
        buildModel: jest.fn().mockReturnValue(mockModel),
      };
    });

    const { recoverPendingFromDb } = await loadRecoveryModule();
    const result = await recoverPendingFromDb({
      generationId: 'gen_3',
      agentId: 'agt_test',
    });

    expect(result).toBeDefined();
    expect(result!.agentId).toBe('agt_test');
    expect(result!.traceId).toBe('trc_3');
    expect(result!.parentTraceId).toBe('trc_parent');
    expect(result!.rootTraceId).toBe('trc_root');
    expect(result!.generationId).toBe('gen_3');
    expect(result!.pendingToolCalls).toHaveLength(1);
    expect(result!.pendingToolCalls[0].toolCallId).toBe('tc_1');
    expect(result!.resolvedModel).toBe(mockModel);
    expect(result!.resolvedTools).toEqual({});
    expect(result!.agentConfig.instructions).toBe('Be helpful');
  });

  test('returns PendingGeneration with resolved tools when toolIds are set', async () => {
    const pendingState = {
      pendingToolCalls: [],
      messages: [{ role: 'user', content: 'hello' }],
      parentTraceId: null,
      rootTraceId: null,
      toolContext: { key: 'value' },
      remainingDepth: 3,
    };
    const mockModel = { modelId: 'mock-model' };
    const mockTools = { toolA: {}, toolB: {} };

    jest.doMock('src/lib/generations', () => {
      return {
        getGeneration: jest.fn().mockResolvedValue({
          publicId: 'gen_4',
          agentId: 'agt_test',
          traceId: 'trc_4',
          metadata: { pendingState },
        }),
        updateGenerationRecord: jest.fn(),
        createGenerationRecord: jest.fn(),
      };
    });
    jest.doMock('src/db', () => {
      return {
        db: {
          Agent: {
            findOne: jest.fn().mockResolvedValue({
              publicId: 'agt_test',
              model: 'claude-3',
              toolIds: ['tool-a', 'tool-b'],
              maxSteps: 5,
              toolChoice: 'required',
              stopConditions: null,
              activeToolIds: null,
              stepRules: null,
              temperature: 0.7,
              boundaryPolicy: null,
              instructions: null,
              project: { id: 2, publicId: 'prj_test2' },
              aiProvider: { publicId: 'aip_test2' },
            }),
          },
          Project: {},
          AiProvider: {},
        },
        models: {},
      };
    });
    jest.doMock('src/lib/aiProviders', () => {
      return {
        resolveAiProviderSecret: jest.fn().mockResolvedValue({
          provider: 'anthropic',
          secretValue: 'sk-ant-test',
          defaultModel: 'claude-3-opus',
          baseUrl: undefined,
          config: undefined,
        }),
      };
    });
    jest.doMock('src/lib/agentModel', () => {
      return {
        buildModel: jest.fn().mockReturnValue(mockModel),
      };
    });
    jest.doMock('src/lib/agentToolResolver', () => {
      return {
        resolveAgentTools: jest.fn().mockResolvedValue(mockTools),
      };
    });

    const { recoverPendingFromDb } = await loadRecoveryModule();
    const result = await recoverPendingFromDb({
      generationId: 'gen_4',
      agentId: 'agt_test',
      authHeader: 'Bearer token',
    });

    expect(result).toBeDefined();
    expect(result!.resolvedTools).toBe(mockTools);
    expect(result!.agentConfig.temperature).toBe(0.7);
  });
});
