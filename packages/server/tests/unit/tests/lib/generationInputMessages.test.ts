const loadGenerationInputMessagesModule = async () => {
  return import('src/lib/generationInputMessages');
};

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

  test('passes array content through unchanged (raw AI SDK tool messages)', async () => {
    const { resolveGenerationInputMessages } =
      await loadGenerationInputMessagesModule();

    const toolCallContent = [
      {
        type: 'tool-call',
        toolCallId: 'tc_1',
        toolName: 'create-account',
        args: {},
      },
    ];
    const toolResultContent = [
      {
        type: 'tool-result',
        toolCallId: 'tc_1',
        toolName: 'create-account',
        result: 'ok',
      },
    ];

    const result = await resolveGenerationInputMessages({
      messages: [
        { role: 'assistant', content: toolCallContent },
        { role: 'tool', content: toolResultContent },
      ],
    });

    expect(result).toEqual([
      { role: 'assistant', content: toolCallContent },
      { role: 'tool', content: toolResultContent },
    ]);
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
