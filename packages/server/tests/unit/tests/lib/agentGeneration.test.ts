import type { PendingGeneration } from 'src/lib/agentGenerationHelpers';

const loadAgentGenerationModule = async () => {
  return import('src/lib/agentGeneration');
};

const loadGenerationHelpersModule = async () => {
  return import('src/lib/agentGenerationHelpers');
};

const loadGenerationInputMessagesModule = async () => {
  return import('src/lib/generationInputMessages');
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
    const eventBusModule = jest.requireMock('src/lib/eventBus') as {
      resolveProjectPublicId: jest.Mock;
      emitEvent: jest.Mock;
    };
    const resolveProjectSpy = eventBusModule.resolveProjectPublicId;
    const emitEventSpy = eventBusModule.emitEvent;

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
      allMessagesCount: 1,
      steps: [],
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

describe('resolveGenerationInputMessages', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  const authUser = {
    id: 1,
    publicId: 'user_123',
    username: 'tester',
    role: 'user' as const,
    isAllowed: jest.fn().mockResolvedValue(true),
    resolveProjectIds: jest.fn(),
    getPolicies: jest.fn(),
  };

  test('resolves document content from document message content', async () => {
    const documentsModule = jest.requireActual('src/lib/documents') as {
      getDocument: (...args: unknown[]) => Promise<unknown>;
    };
    jest.spyOn(documentsModule, 'getDocument').mockResolvedValue({
      id: 'doc_123',
      projectId: 'proj_123',
      content: 'document-based prompt',
    });
    const { resolveGenerationInputMessages } =
      await loadGenerationInputMessagesModule();

    const result = await resolveGenerationInputMessages({
      authUser,
      messages: [
        {
          role: 'user',
          content: { type: 'document', documentId: 'doc_123' },
        },
      ],
    });

    expect(result).toEqual([
      { role: 'user', content: 'document-based prompt' },
    ]);
  });

  test('throws when content.type=document document does not exist', async () => {
    const documentsModule = jest.requireActual('src/lib/documents') as {
      getDocument: (...args: unknown[]) => Promise<unknown>;
    };
    jest.spyOn(documentsModule, 'getDocument').mockResolvedValue(null);
    const { resolveGenerationInputMessages } =
      await loadGenerationInputMessagesModule();

    await expect(
      resolveGenerationInputMessages({
        authUser,
        messages: [
          {
            role: 'user',
            content: { type: 'document', documentId: 'doc_missing' },
          },
        ],
      })
    ).rejects.toThrow("Document 'doc_missing' not found");
  });

  test('keeps string message content unchanged', async () => {
    const { resolveGenerationInputMessages } =
      await loadGenerationInputMessagesModule();

    const result = await resolveGenerationInputMessages({
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result).toEqual([{ role: 'user', content: 'hello' }]);
  });

  test('executes tool_output content and resolves output_path', async () => {
    const toolsModule = jest.requireActual('src/lib/tools') as {
      getTool: (...args: unknown[]) => Promise<unknown>;
      callTool: (...args: unknown[]) => Promise<unknown>;
    };
    jest.spyOn(toolsModule, 'getTool').mockResolvedValue({
      id: 'tool_audio_to_text',
      projectId: 'proj_123',
      type: 'http',
      name: 'audio-to-text',
      description: 'Audio to text',
      parameters: null,
      execute: null,
      mcp: null,
      actions: null,
      presetParameters: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const callToolSpy = jest.spyOn(toolsModule, 'callTool').mockResolvedValue({
      data: { transcription: { text: 'hello from audio' } },
    });
    const { resolveGenerationInputMessages } =
      await loadGenerationInputMessagesModule();

    const result = await resolveGenerationInputMessages({
      projectIds: [1],
      authHeader: 'Bearer token',
      authUser,
      allowedToolIds: ['tool_audio_to_text'],
      messages: [
        {
          role: 'user',
          content: {
            type: 'tool_output',
            toolId: 'tool_audio_to_text',
            input: { url: 'https://example.com/audio.mp3' },
            outputPath: 'data.transcription.text',
          },
        },
      ],
    });

    expect(callToolSpy).toHaveBeenCalledWith({
      projectIds: [1],
      id: 'tool_audio_to_text',
      action: undefined,
      input: { url: 'https://example.com/audio.mp3' },
      authHeader: 'Bearer token',
    });
    expect(result).toEqual([{ role: 'user', content: 'hello from audio' }]);
  });

  test('throws when output_path cannot be resolved', async () => {
    const toolsModule = jest.requireActual('src/lib/tools') as {
      getTool: (...args: unknown[]) => Promise<unknown>;
      callTool: (...args: unknown[]) => Promise<unknown>;
    };
    jest.spyOn(toolsModule, 'getTool').mockResolvedValue({
      id: 'tool_audio_to_text',
      projectId: 'proj_123',
      type: 'http',
      name: 'audio-to-text',
      description: 'Audio to text',
      parameters: null,
      execute: null,
      mcp: null,
      actions: null,
      presetParameters: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    jest.spyOn(toolsModule, 'callTool').mockResolvedValue({ data: {} });
    const { resolveGenerationInputMessages } =
      await loadGenerationInputMessagesModule();

    await expect(
      resolveGenerationInputMessages({
        authUser,
        allowedToolIds: ['tool_audio_to_text'],
        messages: [
          {
            role: 'user',
            content: {
              type: 'tool_output',
              toolId: 'tool_audio_to_text',
              outputPath: 'data.missing',
            },
          },
        ],
      })
    ).rejects.toThrow("outputPath 'data.missing' could not be resolved");
  });
});
