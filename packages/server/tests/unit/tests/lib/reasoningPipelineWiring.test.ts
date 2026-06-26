/**
 * Wiring tests for the reasoning pipeline: providerOptions forwarding and
 * `mode: pipeline` text replacement / fallback inside runNonStreamGeneration.
 *
 * Uses the jest.doMock('ai') + resetModules pattern (see
 * agentNonStreamGeneration.test.ts) because the 'ai' package itself is the
 * boundary under test here.
 */

const loadNonStreamModule = async () => {
  return import('src/lib/agentNonStreamGeneration');
};

const loadHelpersModule = async () => {
  return import('src/lib/agentGenerationHelpers');
};

const loadReasoningCompletionModule = async () => {
  return import('src/lib/reasoningCompletion');
};

const buildTypedAgent = (reasoningConfig: object | null) => {
  return {
    instructions: 'sys',
    model: 'mock-model',
    toolIds: null,
    maxSteps: 3,
    toolChoice: 'auto',
    stopConditions: null,
    activeToolIds: null,
    stepRules: null,
    boundaryPolicy: null,
    temperature: null,
    knowledgeConfig: null,
    reasoningConfig,
    project: { id: 1, publicId: 'prj_test' },
    aiProvider: { publicId: 'aip_test' },
  } as never;
};

// The pipeline mutates its result object, so every mock call returns a copy.
const draftResult = () => {
  return {
    steps: [],
    response: { messages: [], modelId: 'model-a' },
    text: 'draft answer',
    finishReason: 'stop',
  };
};

const PIPELINE = {
  mode: 'pipeline' as const,
  steps: [
    { name: 'critique', prompt: 'Critique: {draft}' },
    { name: 'final', prompt: 'Improve using {steps.critique}', output: true },
  ],
};

describe('reasoning pipeline wiring', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.unmock('ai');
    jest.resetModules();
    jest.restoreAllMocks();
  });

  test('forwards providerOptions and maxOutputTokens into generateText', async () => {
    const generateTextMock = jest.fn().mockImplementation(draftResult);
    jest.doMock('ai', () => {
      const actual = jest.requireActual('ai');
      return { ...actual, generateText: generateTextMock };
    });

    const { runNonStreamGeneration } = await loadNonStreamModule();
    const helpersModule = await loadHelpersModule();
    jest.spyOn(helpersModule, 'findPendingClientTools').mockReturnValue([]);
    jest
      .spyOn(helpersModule, 'buildCompletedGenerationResult')
      .mockResolvedValue({
        id: 'gen_1',
        traceId: 'trc_1',
        status: 'completed',
        output: {
          model: 'model-a',
          content: 'draft answer',
          finishReason: 'stop',
        },
      });

    await runNonStreamGeneration({
      model: {} as never,
      allMessages: [{ role: 'user', content: 'hi' }],
      resolvedTools: {},
      typedAgent: buildTypedAgent(null),
      generationId: 'gen_1',
      traceId: 'trc_1',
      agentId: 'agent_1',
      providerOptions: { openai: { reasoningEffort: 'high' } },
      maxOutputTokens: 24576,
    });

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const callArgs = generateTextMock.mock.calls[0][0];
    expect(callArgs.providerOptions).toEqual({
      openai: { reasoningEffort: 'high' },
    });
    expect(callArgs.maxOutputTokens).toBe(24576);
  });

  test('pipeline mode replaces the final text before completion', async () => {
    jest.doMock('ai', () => {
      const actual = jest.requireActual('ai');
      return {
        ...actual,
        generateText: jest.fn().mockImplementation(draftResult),
      };
    });

    const { runNonStreamGeneration } = await loadNonStreamModule();
    const helpersModule = await loadHelpersModule();
    const reasoningCompletionModule = await loadReasoningCompletionModule();

    jest
      .spyOn(reasoningCompletionModule, 'runReasoningCompletion')
      .mockResolvedValueOnce('The draft is too vague.')
      .mockResolvedValueOnce('revised answer');

    jest.spyOn(helpersModule, 'findPendingClientTools').mockReturnValue([]);
    const buildCompletedSpy = jest
      .spyOn(helpersModule, 'buildCompletedGenerationResult')
      .mockImplementation(async (args) => {
        return {
          id: args.generationId,
          traceId: args.traceId,
          status: 'completed',
          output: {
            model: 'model-a',
            content: args.result.text,
            finishReason: args.result.finishReason,
            responseMessages: args.result.response?.messages,
          },
        };
      });

    const result = await runNonStreamGeneration({
      model: {} as never,
      allMessages: [{ role: 'user', content: 'hard question' }],
      resolvedTools: {},
      typedAgent: buildTypedAgent(PIPELINE),
      generationId: 'gen_2',
      traceId: 'trc_2',
      agentId: 'agent_2',
      reasoningConfig: PIPELINE,
    });

    expect(buildCompletedSpy).toHaveBeenCalledTimes(1);
    expect(buildCompletedSpy.mock.calls[0][0].result.text).toBe(
      'revised answer'
    );
    expect(result.status).toBe('completed');
    expect(result.output?.content).toBe('revised answer');
    // The draft's responseMessages no longer match the final text.
    expect(result.output?.responseMessages).toBeUndefined();
  });

  test('pipeline failure falls back to the draft', async () => {
    jest.doMock('ai', () => {
      const actual = jest.requireActual('ai');
      return {
        ...actual,
        generateText: jest.fn().mockImplementation(draftResult),
      };
    });

    const { runNonStreamGeneration } = await loadNonStreamModule();
    const helpersModule = await loadHelpersModule();
    const reasoningCompletionModule = await loadReasoningCompletionModule();

    jest
      .spyOn(reasoningCompletionModule, 'runReasoningCompletion')
      .mockRejectedValue(new Error('provider down'));

    jest.spyOn(helpersModule, 'findPendingClientTools').mockReturnValue([]);
    jest
      .spyOn(helpersModule, 'buildCompletedGenerationResult')
      .mockImplementation(async (args) => {
        return {
          id: args.generationId,
          traceId: args.traceId,
          status: 'completed',
          output: {
            model: 'model-a',
            content: args.result.text,
            finishReason: args.result.finishReason,
          },
        };
      });

    const result = await runNonStreamGeneration({
      model: {} as never,
      allMessages: [{ role: 'user', content: 'hard question' }],
      resolvedTools: {},
      typedAgent: buildTypedAgent(PIPELINE),
      generationId: 'gen_3',
      traceId: 'trc_3',
      agentId: 'agent_3',
      reasoningConfig: PIPELINE,
    });

    expect(result.status).toBe('completed');
    expect(result.output?.content).toBe('draft answer');
  });

  test('does not throw when generateText returns a getter-only text property', async () => {
    const getterOnlyResult = () => {
      const obj: {
        steps: unknown[];
        response: { messages: unknown[]; modelId: string };
        finishReason: string;
        text?: string;
      } = {
        steps: [],
        response: { messages: [], modelId: 'model-a' },
        finishReason: 'stop',
      };
      Object.defineProperty(obj, 'text', {
        get: () => {
          return 'draft answer';
        },
        enumerable: true,
        configurable: false,
      });
      return obj;
    };

    jest.doMock('ai', () => {
      const actual = jest.requireActual('ai');
      return {
        ...actual,
        generateText: jest.fn().mockImplementation(getterOnlyResult),
      };
    });

    const { runNonStreamGeneration } = await loadNonStreamModule();
    const helpersModule = await loadHelpersModule();
    const reasoningCompletionModule = await loadReasoningCompletionModule();

    jest
      .spyOn(reasoningCompletionModule, 'runReasoningCompletion')
      .mockResolvedValueOnce('critique')
      .mockResolvedValueOnce('synthesized conclusion');

    jest.spyOn(helpersModule, 'findPendingClientTools').mockReturnValue([]);
    const buildCompletedSpy = jest
      .spyOn(helpersModule, 'buildCompletedGenerationResult')
      .mockImplementation(async (args) => {
        return {
          id: args.generationId,
          traceId: args.traceId,
          status: 'completed',
          output: {
            model: 'model-a',
            content: args.result.text,
            finishReason: args.result.finishReason,
          },
        };
      });

    const result = await runNonStreamGeneration({
      model: {} as never,
      allMessages: [{ role: 'user', content: 'philosophical question' }],
      resolvedTools: {},
      typedAgent: buildTypedAgent(PIPELINE),
      generationId: 'gen_getter',
      traceId: 'trc_getter',
      agentId: 'agent_getter',
      reasoningConfig: PIPELINE,
    });

    expect(buildCompletedSpy).toHaveBeenCalledTimes(1);
    expect(buildCompletedSpy.mock.calls[0][0].result.text).toBe(
      'synthesized conclusion'
    );
    expect(result.status).toBe('completed');
    expect(result.output?.content).toBe('synthesized conclusion');
  });
});
