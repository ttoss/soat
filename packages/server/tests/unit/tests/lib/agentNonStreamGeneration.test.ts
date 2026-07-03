import type { Tool } from 'ai';

const loadNonStreamModule = async () => {
  return import('src/lib/agentNonStreamGeneration');
};

const loadHelpersModule = async () => {
  return import('src/lib/agentGenerationHelpers');
};

const buildTypedAgent = () => {
  return {
    instructions: 'sys',
    model: 'mock-model',
    toolIds: null,
    maxSteps: 3,
    toolChoice: 'auto',
    stopConditions: null,
    activeToolIds: null,
    stepRules: [{ step: 1, toolChoice: { type: 'tool', toolName: 'forced' } }],
    boundaryPolicy: null,
    temperature: null,
    project: { id: 1, publicId: 'prj_test' },
    aiProvider: { publicId: 'aip_test' },
  } as never;
};

describe('agentNonStreamGeneration', () => {
  afterEach(() => {
    jest.unmock('ai');
    jest.resetModules();
    jest.restoreAllMocks();
  });

  test('buildPrepareStep returns undefined when stepRules are empty', async () => {
    const { buildPrepareStep } = await loadNonStreamModule();
    const prepareStep = buildPrepareStep({
      stepRules: [],
      logContext: 'non_stream',
    });

    expect(prepareStep).toBeUndefined();
  });

  test('buildPrepareStep returns forced tool config for matching step', async () => {
    const { buildPrepareStep } = await loadNonStreamModule();
    const prepareStep = buildPrepareStep({
      stepRules: [
        { step: 2, toolChoice: { type: 'tool', toolName: 'lookup' } },
      ],
      logContext: 'non_stream',
    });

    expect(prepareStep).toBeDefined();
    expect(prepareStep!({ stepNumber: 1 })).toEqual({
      toolChoice: { type: 'tool', toolName: 'lookup' },
      activeTools: ['lookup'],
    });
    expect(prepareStep!({ stepNumber: 0 })).toEqual({});
  });

  test('buildToolResultMessages maps string and object outputs', async () => {
    const { buildToolResultMessages } = await loadNonStreamModule();
    const messages = buildToolResultMessages({
      toolOutputs: [
        { toolCallId: 'tc_1', output: 'hello' },
        { toolCallId: 'tc_2', output: { ok: true } },
      ],
      pendingToolCalls: [
        { toolCallId: 'tc_1', toolName: 'toolOne', args: {} },
        { toolCallId: 'tc_2', toolName: 'toolTwo', args: {} },
      ],
    });

    expect(messages[0].content[0].output.value).toBe('hello');
    expect(messages[1].content[0].output.value).toBe('{"ok":true}');
    expect(messages[1].content[0].toolName).toBe('toolTwo');
  });

  test('buildToolResultMessages applies a client tool output_mapping keyed by tool name', async () => {
    const { buildToolResultMessages } = await loadNonStreamModule();
    const messages = buildToolResultMessages({
      toolOutputs: [
        { toolCallId: 'tc_1', output: { text: 'Hi!', language: 'en' } },
      ],
      pendingToolCalls: [
        { toolCallId: 'tc_1', toolName: 'transcribe', args: {} },
      ],
      outputMappingsByToolName: {
        transcribe: { var: 'output.text' },
      },
    });

    expect(messages[0].content[0].output.value).toBe('Hi!');
  });

  test('buildToolResultMessages leaves output unchanged for tools without an output_mapping', async () => {
    const { buildToolResultMessages } = await loadNonStreamModule();
    const messages = buildToolResultMessages({
      toolOutputs: [{ toolCallId: 'tc_1', output: { ok: true } }],
      pendingToolCalls: [{ toolCallId: 'tc_1', toolName: 'toolOne', args: {} }],
      outputMappingsByToolName: { otherTool: { var: 'output.text' } },
    });

    expect(messages[0].content[0].output.value).toBe('{"ok":true}');
  });

  test('runNonStreamGeneration returns requires_action result when pending client tools exist', async () => {
    jest.doMock('ai', () => {
      const actual = jest.requireActual('ai');
      return {
        ...actual,
        generateText: jest.fn().mockResolvedValue({
          steps: [
            {
              toolCalls: [
                { toolCallId: 'tc_1', toolName: 'client', input: {} },
              ],
            },
          ],
          response: { messages: [], modelId: 'model-a' },
          text: 'ignored',
          finishReason: 'tool-calls',
        }),
      };
    });

    const { runNonStreamGeneration } = await loadNonStreamModule();
    const helpersModule = await loadHelpersModule();

    const findPendingSpy = jest
      .spyOn(helpersModule, 'findPendingClientTools')
      .mockReturnValue([{ toolCallId: 'tc_1', toolName: 'client', input: {} }]);
    const savePendingSpy = jest
      .spyOn(helpersModule, 'savePendingGeneration')
      .mockReturnValue({
        id: 'gen_1',
        traceId: 'trc_1',
        status: 'requires_action',
        requiredAction: {
          type: 'submit_tool_outputs',
          toolCalls: [{ id: 'tc_1', toolName: 'client', args: {} }],
        },
      });

    const result = await runNonStreamGeneration({
      model: {} as never,
      allMessages: [{ role: 'user', content: 'hi' }],
      resolvedTools: { client: {} as Tool },
      typedAgent: buildTypedAgent(),
      generationId: 'gen_1',
      traceId: 'trc_1',
      agentId: 'agt_1',
    });

    expect(findPendingSpy).toHaveBeenCalled();
    expect(savePendingSpy).toHaveBeenCalled();
    expect(result.status).toBe('requires_action');
  });

  test('runNonStreamGeneration falls back to no-tools generation when tool call fails', async () => {
    jest.doMock('ai', () => {
      const actual = jest.requireActual('ai');
      const mockedGenerateText = jest
        .fn()
        .mockRejectedValueOnce(new Error('malformed tool xml'))
        .mockResolvedValueOnce({
          steps: [],
          response: { modelId: 'fallback-model' },
          text: 'fallback answer',
          finishReason: 'stop',
        });

      return {
        ...actual,
        generateText: mockedGenerateText,
      };
    });

    const { runNonStreamGeneration } = await loadNonStreamModule();
    const helpersModule = await loadHelpersModule();

    jest.spyOn(helpersModule, 'findPendingClientTools').mockReturnValue([]);
    const completedSpy = jest
      .spyOn(helpersModule, 'buildCompletedGenerationResult')
      .mockResolvedValue({
        id: 'gen_2',
        traceId: 'trc_2',
        status: 'completed',
        output: {
          model: 'fallback-model',
          content: 'fallback answer',
          finishReason: 'stop',
        },
      });

    const result = await runNonStreamGeneration({
      model: {} as never,
      allMessages: [{ role: 'user', content: 'hi' }],
      resolvedTools: { client: {} as Tool },
      typedAgent: buildTypedAgent(),
      generationId: 'gen_2',
      traceId: 'trc_2',
      agentId: 'agt_2',
    });

    expect(completedSpy).toHaveBeenCalled();
    expect(result.status).toBe('completed');
  });

  test('runNonStreamGeneration throws when no-tools generation fails', async () => {
    jest.doMock('ai', () => {
      const actual = jest.requireActual('ai');
      return {
        ...actual,
        generateText: jest
          .fn()
          .mockRejectedValue(new Error('provider unavailable')),
      };
    });

    const { runNonStreamGeneration } = await loadNonStreamModule();

    await expect(
      runNonStreamGeneration({
        model: {} as never,
        allMessages: [{ role: 'user', content: 'hi' }],
        resolvedTools: {},
        typedAgent: buildTypedAgent(),
        generationId: 'gen_3',
        traceId: 'trc_3',
        agentId: 'agt_3',
      })
    ).rejects.toThrow('provider unavailable');
  });
});
