/**
 * Regression tests for tool-call history preservation across conversation turns.
 *
 * Bug: tool calls and results were stripped from conversation history, causing
 * the LLM to hallucinate after 4-5 turns instead of continuing to use tools.
 *
 * Fix: responseMessages from the AI SDK are stored in ConversationMessage.metadata
 * and expanded on the next turn via buildConversationHistory.
 */

const loadConversationGenerationModule = async () => {
  return import('src/lib/conversationGeneration');
};

const toolCallMsg = {
  role: 'assistant',
  content: [
    { type: 'tool-call', toolCallId: 'tc_1', toolName: 'create-account', args: { name: 'Alice' } },
  ],
};

const toolResultMsg = {
  role: 'tool',
  content: [
    { type: 'tool-result', toolCallId: 'tc_1', toolName: 'create-account', result: 'ok' },
  ],
};

const finalTextMsg = {
  role: 'assistant',
  content: 'Account created.',
};

const makeConversation = () => ({
  id: 1,
  publicId: 'conv_test',
  projectId: 42,
});

const makeAgent = () => ({
  id: 10,
  publicId: 'agt_test',
  name: 'TestBot',
  instructions: null,
  maxContextMessages: null,
});

const makeMessage = (
  opts: {
    id?: number;
    role?: string;
    position?: number;
    storagePath?: string;
    metadata?: Record<string, unknown> | null;
    actorName?: string | null;
  } = {}
) => ({
  id: opts.id ?? 1,
  role: opts.role ?? 'user',
  position: opts.position ?? 0,
  metadata: opts.metadata ?? null,
  document: {
    file: {
      storagePath: opts.storagePath ?? '/nonexistent/path',
    },
  },
  actor: opts.actorName !== undefined ? { name: opts.actorName } : null,
});

describe('generateConversationMessage', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('stores responseMessages in metadata when LLM uses tool calls', async () => {
    const addConversationMessageMock = jest.fn().mockResolvedValue({
      documentId: 'doc_1',
    });

    jest.doMock('src/db', () => ({
      db: {
        Conversation: {
          findOne: jest.fn().mockResolvedValue(makeConversation()),
        },
        Agent: {
          findOne: jest.fn().mockResolvedValue(makeAgent()),
        },
        ConversationMessage: {
          findAll: jest.fn().mockResolvedValue([]),
        },
        Document: {},
        File: {},
        Actor: {},
      },
      models: {},
    }));

    jest.doMock('src/lib/agents', () => ({
      createGeneration: jest.fn().mockResolvedValue({
        id: 'gen_1',
        traceId: 'trc_1',
        status: 'completed',
        output: {
          model: 'gpt-4o',
          content: 'Account created.',
          finishReason: 'stop',
          responseMessages: [toolCallMsg, toolResultMsg, finalTextMsg],
        },
      }),
    }));

    jest.doMock('src/lib/conversationMessages', () => ({
      addConversationMessage: addConversationMessageMock,
    }));

    jest.doMock('src/lib/eventBus', () => ({
      resolveProjectPublicId: jest.fn().mockResolvedValue('prj_test'),
      emitEvent: jest.fn(),
    }));

    const { generateConversationMessage } =
      await loadConversationGenerationModule();

    const result = await generateConversationMessage({
      conversationId: 'conv_test',
      agentId: 'agt_test',
    });

    expect(result.status).toBe('completed');
    expect(addConversationMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          responseMessages: [toolCallMsg, toolResultMsg, finalTextMsg],
        },
      })
    );
  });

  test('does not store metadata when LLM returns plain text (no tool calls)', async () => {
    const addConversationMessageMock = jest.fn().mockResolvedValue({
      documentId: 'doc_2',
    });

    jest.doMock('src/db', () => ({
      db: {
        Conversation: {
          findOne: jest.fn().mockResolvedValue(makeConversation()),
        },
        Agent: {
          findOne: jest.fn().mockResolvedValue(makeAgent()),
        },
        ConversationMessage: {
          findAll: jest.fn().mockResolvedValue([]),
        },
        Document: {},
        File: {},
        Actor: {},
      },
      models: {},
    }));

    jest.doMock('src/lib/agents', () => ({
      createGeneration: jest.fn().mockResolvedValue({
        id: 'gen_2',
        traceId: 'trc_2',
        status: 'completed',
        output: {
          model: 'gpt-4o',
          content: 'Hello there.',
          finishReason: 'stop',
          responseMessages: undefined,
        },
      }),
    }));

    jest.doMock('src/lib/conversationMessages', () => ({
      addConversationMessage: addConversationMessageMock,
    }));

    jest.doMock('src/lib/eventBus', () => ({
      resolveProjectPublicId: jest.fn().mockResolvedValue('prj_test'),
      emitEvent: jest.fn(),
    }));

    const { generateConversationMessage } =
      await loadConversationGenerationModule();

    const result = await generateConversationMessage({
      conversationId: 'conv_test',
      agentId: 'agt_test',
    });

    expect(result.status).toBe('completed');
    expect(addConversationMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: undefined })
    );
  });

  test('expands stored responseMessages into full tool chain on next turn', async () => {
    const createGenerationMock = jest.fn().mockResolvedValue({
      id: 'gen_3',
      traceId: 'trc_3',
      status: 'completed',
      output: {
        model: 'gpt-4o',
        content: 'Done.',
        finishReason: 'stop',
        responseMessages: undefined,
      },
    });

    const previousAssistantMsg = makeMessage({
      id: 2,
      role: 'assistant',
      position: 1,
      metadata: {
        responseMessages: [toolCallMsg, toolResultMsg, finalTextMsg],
      },
    });

    jest.doMock('src/db', () => ({
      db: {
        Conversation: {
          findOne: jest.fn().mockResolvedValue(makeConversation()),
        },
        Agent: {
          findOne: jest.fn().mockResolvedValue(makeAgent()),
        },
        ConversationMessage: {
          findAll: jest.fn().mockResolvedValue([previousAssistantMsg]),
        },
        Document: {},
        File: {},
        Actor: {},
      },
      models: {},
    }));

    jest.doMock('src/lib/agents', () => ({
      createGeneration: createGenerationMock,
    }));

    jest.doMock('src/lib/conversationMessages', () => ({
      addConversationMessage: jest.fn().mockResolvedValue({ documentId: 'doc_3' }),
    }));

    jest.doMock('src/lib/eventBus', () => ({
      resolveProjectPublicId: jest.fn().mockResolvedValue('prj_test'),
      emitEvent: jest.fn(),
    }));

    const { generateConversationMessage } =
      await loadConversationGenerationModule();

    await generateConversationMessage({
      conversationId: 'conv_test',
      agentId: 'agt_test',
    });

    expect(createGenerationMock).toHaveBeenCalledTimes(1);
    const calledMessages: Array<{ role: string; content: unknown }> =
      createGenerationMock.mock.calls[0][0].messages;

    // The tool-call assistant message must be present in the LLM input
    const toolCallEntry = calledMessages.find(
      (m) => m.role === 'assistant' && Array.isArray(m.content)
    );
    expect(toolCallEntry).toBeDefined();
    expect(toolCallEntry?.content).toEqual(toolCallMsg.content);

    // The tool-result message must also be present
    const toolResultEntry = calledMessages.find((m) => m.role === 'tool');
    expect(toolResultEntry).toBeDefined();
    expect(toolResultEntry?.content).toEqual(toolResultMsg.content);

    // Must NOT collapse everything into a single plain-text assistant message
    const plainAssistant = calledMessages.filter(
      (m) => m.role === 'assistant' && typeof m.content === 'string'
    );
    // The final text from the previous turn should come from responseMessages, not as a collapsed string
    // (there may be a system message but no collapsed plain-text from the prior tool chain)
    expect(plainAssistant.every((m) => m.content === '')).toBe(true);
  });
});
