describe('createGeneration', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('returns not_found when agent does not exist', async () => {
    const { createGeneration } = await import('src/lib/agentGeneration');
    const result = await createGeneration({
      agentId: 'nonexistent_agent_id',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(result).toBe('not_found');
  });

  test('returns depth guard result when remainingDepth is 0', async () => {
    const { createGeneration } = await import('src/lib/agentGeneration');
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
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('returns generation_not_found when generation does not exist', async () => {
    const { submitToolOutputs } = await import('src/lib/agentGeneration');
    const result = await submitToolOutputs({
      agentId: 'agent_id',
      generationId: 'gen_nonexistent_0000',
      toolOutputs: [{ toolCallId: 'tc_1', output: 'result' }],
    });

    expect(result).toBe('generation_not_found');
  });

  test('processes tool outputs and returns completed result when pending generation exists', async () => {
    jest.doMock('ai', () => {
      const actual = jest.requireActual('ai');
      return {
        ...actual,
        generateText: jest.fn().mockResolvedValue({
          text: 'final answer',
          finishReason: 'stop',
          steps: [],
          response: { modelId: 'llama3.2' },
        }),
      };
    });

    jest.doMock('src/lib/eventBus', () => {
      return {
        emitEvent: jest.fn(),
        onEvent: jest.fn(),
        resolveProjectPublicId: jest.fn().mockResolvedValue('proj_test'),
        eventBus: { on: jest.fn(), emit: jest.fn() },
      };
    });

    const { pendingGenerations } =
      await import('src/lib/agentGenerationHelpers');
    const { submitToolOutputs } = await import('src/lib/agentGeneration');

    pendingGenerations.set('gen_test_pending_001', {
      agentId: 'agent_test_1',
      projectId: 1,
      traceId: 'trace_test_1',
      generationId: 'gen_test_pending_001',
      pendingToolCalls: [{ toolCallId: 'tc_1', toolName: 'myTool', args: {} }],
      messages: [{ role: 'user', content: 'hello' }],
      resolvedModel: {} as never,
      resolvedTools: {},
      agentConfig: {
        instructions: null,
        maxSteps: 5,
        toolChoice: undefined,
        stopConditions: null,
        activeToolIds: null,
        stepRules: null,
        temperature: null,
      },
    });

    const result = await submitToolOutputs({
      agentId: 'agent_test_1',
      generationId: 'gen_test_pending_001',
      toolOutputs: [{ toolCallId: 'tc_1', output: 'tool result' }],
    });

    expect(result).toMatchObject({
      status: 'completed',
      output: expect.objectContaining({
        content: 'final answer',
        finishReason: 'stop',
      }),
    });
  });
});
