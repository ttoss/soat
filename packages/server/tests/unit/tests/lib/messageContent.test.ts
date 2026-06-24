import * as documentsModule from 'src/lib/documents';
import * as toolsModule from 'src/lib/tools';

const loadMessageContentModule = async () => {
  return import('src/lib/messageContent');
};

const createAuthUser = (overrides?: {
  isAllowed?: jest.Mock<
    Promise<boolean>,
    [
      {
        projectPublicId: string;
        action: string;
        resource?: string;
        resources?: string[];
        context?: Record<string, string>;
      },
    ]
  >;
}) => {
  return {
    id: 1,
    publicId: 'user_123',
    username: 'tester',
    role: 'user' as const,
    isAllowed: overrides?.isAllowed ?? jest.fn().mockResolvedValue(true),
    resolveProjectIds: jest.fn(),
    getPolicies: jest.fn(),
  };
};

const createDocumentResult = (overrides?: {
  id?: string;
  projectId?: string;
  path?: string;
  tags?: Record<string, string>;
  content?: string;
}) => {
  return {
    id: overrides?.id ?? 'doc_123',
    fileId: 'file_123',
    projectId: overrides?.projectId ?? 'proj_123',
    path: overrides?.path,
    filename: 'doc.txt',
    size: 123,
    title: 'Test Document',
    metadata: undefined,
    tags: overrides?.tags,
    status: 'ready' as const,
    content: overrides?.content ?? 'document content',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
};

describe('resolveMessageContent', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('returns plain string content unchanged', async () => {
    const { resolveMessageContent } = await loadMessageContentModule();

    const result = await resolveMessageContent({ content: 'hello' });

    expect(result).toEqual({ content: 'hello' });
  });

  test('resolves document content', async () => {
    jest.spyOn(documentsModule, 'getDocument').mockResolvedValue(
      createDocumentResult({
        path: '/docs/spec.md',
        tags: { environment: 'test' },
      })
    );
    const { resolveMessageContent } = await loadMessageContentModule();
    const authUser = createAuthUser();

    const result = await resolveMessageContent({
      authUser,
      content: { type: 'document', documentId: 'doc_123' },
    });

    expect(result).toEqual({
      content: 'document content',
      documentId: 'doc_123',
    });
    expect(authUser.isAllowed).toHaveBeenCalledWith({
      projectPublicId: 'proj_123',
      action: 'documents:GetDocument',
      resources: [
        'soat:proj_123:document:doc_123',
        'soat:proj_123:document:/docs/spec.md',
      ],
      context: {
        'soat:ResourceType': 'document',
        'soat:ResourceTag/environment': 'test',
      },
    });
  });

  test('resolves tool_output content with outputPath', async () => {
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
      pipeline: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    jest.spyOn(toolsModule, 'callTool').mockResolvedValue({
      data: { transcription: { text: 'hello from audio' } },
    });
    const { resolveMessageContent } = await loadMessageContentModule();
    const authUser = createAuthUser();

    const result = await resolveMessageContent({
      projectIds: [1],
      authHeader: 'Bearer token',
      authUser,
      allowedToolIds: ['tool_audio_to_text'],
      content: {
        type: 'tool_output',
        toolId: 'tool_audio_to_text',
        input: { url: 'https://example.com/audio.mp3' },
        outputPath: 'data.transcription.text',
      },
    });

    expect(result).toEqual({ content: 'hello from audio' });
    expect(authUser.isAllowed).toHaveBeenCalledWith({
      projectPublicId: 'proj_123',
      action: 'tools:CallTool',
    });
  });

  test('rejects document content when caller lacks document permission', async () => {
    jest
      .spyOn(documentsModule, 'getDocument')
      .mockResolvedValue(createDocumentResult({ path: '/docs/spec.md' }));
    const { resolveMessageContent } = await loadMessageContentModule();
    const authUser = createAuthUser({
      isAllowed: jest.fn().mockResolvedValue(false),
    });

    await expect(
      resolveMessageContent({
        authUser,
        content: { type: 'document', documentId: 'doc_123' },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('rejects document content when agent boundary denies document access', async () => {
    jest
      .spyOn(documentsModule, 'getDocument')
      .mockResolvedValue(createDocumentResult({ path: '/docs/spec.md' }));
    const { resolveMessageContent } = await loadMessageContentModule();
    const authUser = createAuthUser();

    await expect(
      resolveMessageContent({
        authUser,
        agentBoundaryPolicy: {
          statement: [
            {
              effect: 'Allow',
              action: ['tools:CallTool'],
              resource: ['*'],
            },
          ],
        },
        content: { type: 'document', documentId: 'doc_123' },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('rejects tool_output content when tool is not allowed for the agent', async () => {
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
      pipeline: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const callToolSpy = jest.spyOn(toolsModule, 'callTool');
    const { resolveMessageContent } = await loadMessageContentModule();
    const authUser = createAuthUser();

    await expect(
      resolveMessageContent({
        authUser,
        allowedToolIds: ['tool_other'],
        content: {
          type: 'tool_output',
          toolId: 'tool_audio_to_text',
        },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(callToolSpy).not.toHaveBeenCalled();
  });

  test('rejects tool_output content when caller lacks tool call permission', async () => {
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
      pipeline: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const callToolSpy = jest.spyOn(toolsModule, 'callTool');
    const { resolveMessageContent } = await loadMessageContentModule();
    const authUser = createAuthUser({
      isAllowed: jest.fn().mockResolvedValue(false),
    });

    await expect(
      resolveMessageContent({
        authUser,
        allowedToolIds: ['tool_audio_to_text'],
        content: {
          type: 'tool_output',
          toolId: 'tool_audio_to_text',
        },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(callToolSpy).not.toHaveBeenCalled();
  });

  test('rejects soat tool_output content when agent boundary denies the action', async () => {
    jest.spyOn(toolsModule, 'getTool').mockResolvedValue({
      id: 'tool_soat',
      projectId: 'proj_123',
      type: 'soat',
      name: 'soat-tool',
      description: 'SOAT tool',
      parameters: null,
      execute: null,
      mcp: null,
      actions: ['list-tools'],
      presetParameters: null,
      pipeline: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const callToolSpy = jest.spyOn(toolsModule, 'callTool');
    const { resolveMessageContent } = await loadMessageContentModule();
    const authUser = createAuthUser();

    await expect(
      resolveMessageContent({
        authUser,
        allowedToolIds: ['tool_soat'],
        agentBoundaryPolicy: {
          statement: [
            {
              effect: 'Allow',
              action: ['documents:GetDocument'],
              resource: ['*'],
            },
          ],
        },
        content: {
          type: 'tool_output',
          toolId: 'tool_soat',
          action: 'list-tools',
        },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(callToolSpy).not.toHaveBeenCalled();
  });
});
