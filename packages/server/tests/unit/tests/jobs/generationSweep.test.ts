import { sweepExpiredGenerations } from 'src/lib/generationSweep';

import {
  type ChatCompletionsStub,
  type RecordedRequest,
  startChatCompletionsStub,
  type StubReply,
  systemText,
  textCompletion,
  toolCallCompletion,
} from '../../fixtures/chatCompletionsStub';
import { pollUntil } from '../../fixtures/poll';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * The generation sweep, driven as its scheduler tick with a clock past every
 * lease (unit tests never import `server.ts`). A generation whose model call is
 * held open stands for a process that stopped renewing its lease.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

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

const pastEveryLease = () => {
  return new Date(Date.now() + DAY_MS);
};

describe('generation sweep', () => {
  let stub: ChatCompletionsStub;
  let adminToken: string;
  let parentAgentId: string;
  let childAgentId: string;
  let dispatchToolName: string;
  let savedTimeout: string | undefined;
  const held: Array<(reply: StubReply) => void> = [];

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  /** Holds every child model call until the test releases it. */
  const holdChild = () => {
    stub.reply((request) => {
      if (systemText(request).includes('CHILD-AGENT')) {
        return new Promise<StubReply>((resolve) => {
          held.push(resolve);
        });
      }
      const last = lastMessage(request);
      if (last.role === 'tool') return textCompletion('Dispatched; waiting.');
      if (contentText(last).includes('has failed')) {
        return textCompletion('The sub-agent failed.');
      }
      return toolCallCompletion([
        {
          id: 'call_dispatch',
          name: dispatchToolName,
          args: { messages: [{ role: 'user', content: 'do the long work' }] },
        },
      ]);
    });
  };

  const runningChildIds = async (): Promise<string[]> => {
    const res = await asAdmin()
      .get('/api/v1/generations')
      .query({ agent_id: childAgentId, status: 'running' });
    expect(res.status).toBe(200);
    return res.body.data.map((generation: { id: string }) => {
      return generation.id;
    });
  };

  /** Polls until a child model call is held. */
  const untilChildHeld = async (count: number): Promise<void> => {
    await pollUntil({
      read: () => {
        return held.length;
      },
      done: (length) => {
        return length >= count;
      },
    });
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

  const waitForText = (conversationId: string, text: string) => {
    return pollUntil({
      read: () => {
        return conversationTexts(conversationId);
      },
      done: (texts) => {
        return texts.includes(text);
      },
    });
  };

  beforeAll(async () => {
    savedTimeout = process.env.SOAT_TOOL_CALL_TIMEOUT_MS;
    process.env.SOAT_TOOL_CALL_TIMEOUT_MS = '300';
    stub = await startChatCompletionsStub({});

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'sweepadmin', password: 'supersecret' });
    adminToken = await loginAs('sweepadmin', 'supersecret');

    const project = await asAdmin()
      .post('/api/v1/projects')
      .send({ name: 'Generation Sweep Project' });
    const projectId = project.body.id;
    const provider = await asAdmin().post('/api/v1/ai-providers').send({
      project_id: projectId,
      name: 'Sweep Provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: stub.baseUrl,
    });
    expect(provider.status).toBe(201);

    const child = await asAdmin().post('/api/v1/agents').send({
      project_id: projectId,
      ai_provider_id: provider.body.id,
      name: 'Stalled Worker',
      instructions: 'CHILD-AGENT',
    });
    expect(child.status).toBe(201);
    childAgentId = child.body.id;

    const dispatch = await asAdmin()
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'dispatch',
        type: 'builtin',
        actions: ['create-agent-generation'],
        preset_parameters: { agent_id: childAgentId },
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
    for (const release of held) release(textCompletion('released'));
    await stub.close();
  });

  test('fails a generation whose lease lapsed and tells its handed-off parent', async () => {
    holdChild();
    const session = await asAdmin()
      .post('/api/v1/sessions')
      .send({ agent_id: parentAgentId });
    expect(session.status).toBe(201);
    const message = await asAdmin()
      .post(`/api/v1/sessions/${session.body.id}/messages`)
      .send({ message: 'Delegate the long work' });
    expect(message.status).toBe(201);
    const before = held.length;

    const turn = await asAdmin().post(
      `/api/v1/sessions/${session.body.id}/generate?wait=true`
    );
    expect(turn.status).toBe(200);
    expect(turn.body.content).toBe('Dispatched; waiting.');
    await untilChildHeld(before + 1);
    const [childId] = await runningChildIds();
    expect(childId).toBeDefined();

    const swept = await sweepExpiredGenerations({ now: pastEveryLease() });

    expect(swept).toBeGreaterThanOrEqual(1);
    const child = await asAdmin().get(`/api/v1/generations/${childId}`);
    expect(child.status).toBe(200);
    expect(child.body.status).toBe('failed');
    expect(child.body.error.code).toBe('GENERATION_INTERRUPTED');

    const texts = await waitForText(
      session.body.conversation_id,
      'The sub-agent failed.'
    );
    const report = texts.find((text) => {
      return text.includes(`Generation ${childId} `);
    });
    expect(report).toContain('has failed');
    expect(report).toContain('GENERATION_INTERRUPTED');
  });

  test('a stale writer cannot overwrite a swept generation', async () => {
    holdChild();
    const before = held.length;
    const known = new Set(await runningChildIds());
    const late = asAdmin()
      .post(`/api/v1/agents/${childAgentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'take your time' }] })
      .then((res) => {
        return res;
      });
    await untilChildHeld(before + 1);
    const generationId = (await runningChildIds()).find((id) => {
      return !known.has(id);
    });
    expect(generationId).toBeDefined();

    await sweepExpiredGenerations({ now: pastEveryLease() });
    held[held.length - 1](textCompletion('A late answer.'));
    await late;

    const swept = await asAdmin().get(`/api/v1/generations/${generationId}`);
    expect(swept.status).toBe(200);
    expect(swept.body.status).toBe('failed');
    expect(swept.body.error.code).toBe('GENERATION_INTERRUPTED');
  });

  test('leaves a generation whose lease still holds', async () => {
    holdChild();
    const before = held.length;
    const known = new Set(await runningChildIds());
    const live = asAdmin()
      .post(`/api/v1/agents/${childAgentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'still working' }] })
      .then((res) => {
        return res;
      });
    await untilChildHeld(before + 1);
    const generationId = (await runningChildIds()).find((id) => {
      return !known.has(id);
    });

    await sweepExpiredGenerations();
    const running = await asAdmin().get(`/api/v1/generations/${generationId}`);
    expect(running.body.status).toBe('running');

    held[held.length - 1](textCompletion('Done in time.'));
    const res = await live;
    expect(res.status).toBe(200);
    const settled = await asAdmin().get(`/api/v1/generations/${generationId}`);
    expect(settled.body.status).toBe('completed');
  });

  test('a live writer whose generation was swept cancels itself at its next renewal', async () => {
    const savedTtl = process.env.GENERATION_LEASE_TTL_MS;
    process.env.GENERATION_LEASE_TTL_MS = '150';
    try {
      holdChild();
      const before = held.length;
      const known = new Set(await runningChildIds());
      const live = asAdmin()
        .post(`/api/v1/agents/${childAgentId}/generate?wait=true`)
        .send({ messages: [{ role: 'user', content: 'never answered' }] })
        .then((res) => {
          return res;
        });
      await untilChildHeld(before + 1);
      const generationId = (await runningChildIds()).find((id) => {
        return !known.has(id);
      });

      await sweepExpiredGenerations({ now: pastEveryLease() });
      const res = await live;

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('GENERATION_INTERRUPTED');
      const swept = await asAdmin().get(`/api/v1/generations/${generationId}`);
      expect(swept.body.status).toBe('failed');
      expect(swept.body.error.code).toBe('GENERATION_INTERRUPTED');
    } finally {
      if (savedTtl === undefined) delete process.env.GENERATION_LEASE_TTL_MS;
      else process.env.GENERATION_LEASE_TTL_MS = savedTtl;
    }
  });
});
