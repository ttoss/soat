import {
  type ChatCompletionsStub,
  providerFailure,
  type RecordedRequest,
  startChatCompletionsStub,
  type StubReply,
  systemText,
  textCompletion,
  toolCallCompletion,
} from '../../fixtures/chatCompletionsStub';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * A sub-agent generation a `builtin` call starts outlives the call's wait: the
 * parent's call answers with the running generation, and the sub-agent's
 * outcome comes back to the parent as a continuation of its session once it
 * settles.
 */

const HANDOFF_AFTER_MS = '300';

type Message = { role?: unknown; content?: unknown };

const lastMessage = (request: RecordedRequest): Message => {
  const messages = request.body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return {};
  const last: unknown = messages[messages.length - 1];
  return typeof last === 'object' && last !== null ? last : {};
};

const contentText = (message: Message): string => {
  return typeof message.content === 'string'
    ? message.content
    : JSON.stringify(message.content ?? '');
};

describe('a sub-agent generation that outlives its builtin call', () => {
  let stub: ChatCompletionsStub;
  let adminToken: string;
  let parentAgentId: string;
  let dispatchToolName: string;
  let savedTimeout: string | undefined;
  let release: (reply: StubReply) => void = () => {};

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  /** The parent asks once, waits for its call, then reports what came back. */
  const parentReply = (request: RecordedRequest): StubReply => {
    const last = lastMessage(request);
    const text = contentText(last);
    if (last.role === 'tool') return textCompletion('Dispatched; waiting.');
    if (text.includes('has completed')) {
      return textCompletion('The sub-agent finished.');
    }
    if (text.includes('has failed')) {
      return textCompletion('The sub-agent failed.');
    }
    return toolCallCompletion([
      {
        id: 'call_dispatch',
        name: dispatchToolName,
        args: { messages: [{ role: 'user', content: 'do the long work' }] },
      },
    ]);
  };

  /** Answers every request, holding the sub-agent's until `child` settles. */
  const script = (child: Promise<StubReply>) => {
    stub.reply((request) => {
      return systemText(request).includes('CHILD-AGENT')
        ? child
        : parentReply(request);
    });
  };

  const newSessionWithMessage = async (): Promise<{
    sessionId: string;
    conversationId: string;
  }> => {
    const session = await asAdmin()
      .post('/api/v1/sessions')
      .send({ agent_id: parentAgentId });
    expect(session.status).toBe(201);
    const message = await asAdmin()
      .post(`/api/v1/sessions/${session.body.id}/messages`)
      .send({ message: 'Delegate the long work' });
    expect(message.status).toBe(201);
    return {
      sessionId: session.body.id,
      conversationId: session.body.conversation_id,
    };
  };

  const conversationTexts = async (conversationId: string) => {
    const res = await asAdmin().get(
      `/api/v1/conversations/${conversationId}/messages`
    );
    expect(res.status).toBe(200);
    return res.body.data.map((message: { content: string }) => {
      return message.content;
    }) as string[];
  };

  const waitForText = async (conversationId: string, text: string) => {
    let texts: string[] = [];
    for (let attempt = 0; attempt < 120; attempt += 1) {
      texts = await conversationTexts(conversationId);
      if (texts.includes(text)) break;
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }
    return texts;
  };

  /** The call's result as the parent's model received it. */
  const dispatchResult = (): Record<string, unknown> => {
    const toolMessage = stub.completions.map(lastMessage).find((message) => {
      return message.role === 'tool';
    });
    expect(toolMessage).toBeDefined();
    const parsed: unknown = JSON.parse(contentText(toolMessage ?? {}));
    const found = JSON.stringify(parsed).match(/"generation_id":"(gen_[^"]+)"/);
    expect(found).not.toBeNull();
    return { raw: JSON.stringify(parsed), generationId: found?.[1] };
  };

  beforeAll(async () => {
    savedTimeout = process.env.SOAT_TOOL_CALL_TIMEOUT_MS;
    process.env.SOAT_TOOL_CALL_TIMEOUT_MS = HANDOFF_AFTER_MS;
    stub = await startChatCompletionsStub({});

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'handoffadmin', password: 'supersecret' });
    adminToken = await loginAs('handoffadmin', 'supersecret');

    const project = await asAdmin()
      .post('/api/v1/projects')
      .send({ name: 'Sub-agent Handoff Project' });
    const projectId = project.body.id;

    const provider = await asAdmin().post('/api/v1/ai-providers').send({
      project_id: projectId,
      name: 'Handoff Provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: stub.baseUrl,
    });
    expect(provider.status).toBe(201);

    const child = await asAdmin().post('/api/v1/agents').send({
      project_id: projectId,
      ai_provider_id: provider.body.id,
      name: 'Long Worker',
      instructions: 'CHILD-AGENT',
    });
    expect(child.status).toBe(201);

    const dispatch = await asAdmin()
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'dispatch',
        type: 'builtin',
        actions: ['create-agent-generation'],
        preset_parameters: { agent_id: child.body.id },
      });
    expect(dispatch.status).toBe(201);
    dispatchToolName = `${dispatch.body.name}_create-agent-generation`;

    const parent = await asAdmin()
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: provider.body.id,
        name: 'Coordinator',
        instructions: 'PARENT-AGENT',
        tool_bindings: [{ tool_id: dispatch.body.id }],
        max_steps: 3,
      });
    expect(parent.status).toBe(201);
    parentAgentId = parent.body.id;
  });

  afterAll(async () => {
    if (savedTimeout === undefined) {
      delete process.env.SOAT_TOOL_CALL_TIMEOUT_MS;
    } else {
      process.env.SOAT_TOOL_CALL_TIMEOUT_MS = savedTimeout;
    }
    release(textCompletion('released'));
    await stub.close();
  });

  test('the parent gets the running generation and its outcome once it completes', async () => {
    script(
      new Promise<StubReply>((resolve) => {
        release = resolve;
      })
    );
    const { sessionId, conversationId } = await newSessionWithMessage();

    const turn = await asAdmin().post(
      `/api/v1/sessions/${sessionId}/generate?wait=true`
    );
    expect(turn.status).toBe(200);
    expect(turn.body.status).toBe('completed');
    expect(turn.body.content).toBe('Dispatched; waiting.');

    const { raw, generationId } = dispatchResult();
    expect(raw).toContain('"status":"running"');
    const running = await asAdmin().get(`/api/v1/generations/${generationId}`);
    expect(running.body.status).toBe('running');

    release(textCompletion('The answer is 42.'));
    const texts = await waitForText(conversationId, 'The sub-agent finished.');

    const report = texts.find((text) => {
      return text.includes(`Generation ${generationId} `);
    });
    expect(report).toContain('has completed');
    expect(report).toContain('The answer is 42.');
    expect(texts.indexOf(report ?? '')).toBeLessThan(
      texts.indexOf('The sub-agent finished.')
    );

    const continuations = await asAdmin()
      .get('/api/v1/generations')
      .query({ initiator_generation_id: turn.body.generation_id });
    expect(continuations.status).toBe(200);
    expect(continuations.body.data).toHaveLength(1);
    expect(continuations.body.data[0].session_id).toBe(sessionId);
  });

  test('a call whose bound passes before the generation is recorded still hands it off', async () => {
    // A 1 ms bound passes while the child's record is still being written.
    process.env.SOAT_TOOL_CALL_TIMEOUT_MS = '1';
    script(
      new Promise<StubReply>((resolve) => {
        release = resolve;
      })
    );
    const { sessionId, conversationId } = await newSessionWithMessage();
    stub.completions.length = 0;

    try {
      const turn = await asAdmin().post(
        `/api/v1/sessions/${sessionId}/generate?wait=true`
      );
      expect(turn.status).toBe(200);
      const { raw, generationId } = dispatchResult();
      expect(raw).toContain('"status":"running"');

      release(textCompletion('Recorded late, reported anyway.'));
      const texts = await waitForText(
        conversationId,
        'The sub-agent finished.'
      );
      const report = texts.find((text) => {
        return text.includes(`Generation ${generationId} `);
      });
      expect(report).toContain('has completed');
    } finally {
      process.env.SOAT_TOOL_CALL_TIMEOUT_MS = HANDOFF_AFTER_MS;
    }
  });

  test('a call refused before its generation is recorded answers the refusal, not a timeout', async () => {
    process.env.SOAT_TOOL_CALL_TIMEOUT_MS = '1';
    stub.reply((request) => {
      if (lastMessage(request).role === 'tool') {
        return textCompletion('Dispatch refused.');
      }
      return toolCallCompletion([
        {
          id: 'call_refused',
          name: dispatchToolName,
          args: { messages: [{ role: 'system', content: 'not allowed' }] },
        },
      ]);
    });
    const { sessionId } = await newSessionWithMessage();
    stub.completions.length = 0;

    try {
      const turn = await asAdmin().post(
        `/api/v1/sessions/${sessionId}/generate?wait=true`
      );
      expect(turn.status).toBe(200);
      const toolMessage = stub.completions.map(lastMessage).find((message) => {
        return message.role === 'tool';
      });
      const text = contentText(toolMessage ?? {});
      expect(text).toContain('VALIDATION_FAILED');
      expect(text).not.toContain('timed out');
    } finally {
      process.env.SOAT_TOOL_CALL_TIMEOUT_MS = HANDOFF_AFTER_MS;
    }
  });

  test('a sub-agent that fails is reported to the parent as failed', async () => {
    script(
      new Promise<StubReply>((resolve) => {
        release = resolve;
      })
    );
    const { sessionId, conversationId } = await newSessionWithMessage();
    stub.completions.length = 0;

    const turn = await asAdmin().post(
      `/api/v1/sessions/${sessionId}/generate?wait=true`
    );
    expect(turn.status).toBe(200);
    const { generationId } = dispatchResult();

    release(providerFailure(400));
    const texts = await waitForText(conversationId, 'The sub-agent failed.');

    const report = texts.find((text) => {
      return text.includes(`Generation ${generationId} `);
    });
    expect(report).toContain('has failed');
  });
});
