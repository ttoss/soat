import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

// The one metered LLM path with a real HTTP entry point that does not go through
// a Generation record. Driven through REST against a local stub provider; the
// per-prefix project isolates these assertions from other suites' events.

type MeterRow = {
  meter_type: string;
  provider: string;
  model: string;
  generation_id: string | null;
  agent_id: string | null;
  components: Array<{
    component: string;
    quantity: number;
    unit: string;
  }>;
};

describe('Usage — chat completion metering', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let aiProviderId: string;
  let stubServer: Server;

  const STUB_MODEL = 'stub-chat-model';

  const writeNonStreamResponse = (res: {
    writeHead: (status: number, headers: Record<string, string>) => void;
    end: (body: string) => void;
  }): void => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-usage',
        object: 'chat.completion',
        created: 0,
        model: STUB_MODEL,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'stub reply' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
      })
    );
  };

  const writeStreamResponse = (res: {
    writeHead: (status: number, headers: Record<string, string>) => void;
    write: (chunk: string) => void;
    end: () => void;
  }): void => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const chunk = (payload: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    chunk({
      id: 'chatcmpl-usage-stream',
      object: 'chat.completion.chunk',
      created: 0,
      model: STUB_MODEL,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'stub' } }],
    });
    chunk({
      id: 'chatcmpl-usage-stream',
      object: 'chat.completion.chunk',
      created: 0,
      model: STUB_MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
    });
    res.write('data: [DONE]\n\n');
    res.end();
  };

  const startStubServer = async (): Promise<string> => {
    stubServer = createServer((req, res) => {
      let raw = '';
      req.on('data', (piece) => {
        raw += piece;
      });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as { stream?: boolean };
        if (body.stream) {
          writeStreamResponse(res);
          return;
        }
        writeNonStreamResponse(res);
      });
    });
    await new Promise<void>((resolve) => {
      stubServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = stubServer.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  // The metering write is a fire-and-forget side effect of the completion, so
  // poll the observable result (the meter listing) instead of sleeping.
  const waitForMeters = async (expected: number): Promise<MeterRow[]> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/usage/meters?meter_type=llm_tokens'
      );
      expect(res.status).toBe(200);
      const rows = res.body.data as MeterRow[];
      if (rows.length >= expected) return rows;
      await new Promise((resolve) => {
        return setImmediate(resolve);
      });
    }
    throw new Error(`timed out waiting for ${expected} llm_tokens meter rows`);
  };

  const quantityOf = (row: MeterRow, component: string): number => {
    const found = row.components.find((c) => {
      return c.component === component;
    });
    return Number(found?.quantity ?? -1);
  };

  const createChat = async (): Promise<string> => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/chats')
      .send({ project_id: projectId, ai_provider_id: aiProviderId });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  // `body` names the completion target: `ai_provider_id` for a stateless call,
  // `chat_id` to run against a stored chat.
  const readStream = async (body: Record<string, unknown>): Promise<void> => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/chat/completions')
      .send({
        ...body,
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      });
    expect(res.status).toBe(200);
  };

  beforeAll(async () => {
    const stubBaseUrl = await startStubServer();

    const setup = await setupProjectWithUsers({
      prefix: 'usagecompletions',
      policyActions: [
        'chats:CreateChat',
        'chats:CreateChatCompletion',
        'usage:ListUsageMeters',
      ],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;

    const aiProvRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'UsageCompletionsProvider',
        provider: 'ollama',
        default_model: STUB_MODEL,
        base_url: stubBaseUrl,
      });
    expect(aiProvRes.status).toBe(201);
    aiProviderId = aiProvRes.body.id;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      stubServer.close((err) => {
        return err ? reject(err) : resolve();
      });
    });
  });

  test('a stateless chat completion writes one llm_tokens event with no generation', async () => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/chat/completions')
      .send({
        ai_provider_id: aiProviderId,
        messages: [{ role: 'user', content: 'Hello' }],
      });
    expect(res.status).toBe(200);

    const rows = await waitForMeters(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].meter_type).toBe('llm_tokens');
    expect(rows[0].provider).toBe('ollama');
    expect(rows[0].model).toBe(STUB_MODEL);
    // No Generation row backs a chat completion — the event stands alone.
    expect(rows[0].generation_id).toBeNull();
    expect(rows[0].agent_id).toBeNull();
    expect(quantityOf(rows[0], 'input_tokens')).toBe(11);
    expect(quantityOf(rows[0], 'output_tokens')).toBe(5);
  });

  test('a chat-scoped completion writes its own llm_tokens event', async () => {
    const chatId = await createChat();

    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/chat/completions')
      .send({
        chat_id: chatId,
        messages: [{ role: 'user', content: 'Hello' }],
      });
    expect(res.status).toBe(200);

    const rows = await waitForMeters(2);
    expect(rows).toHaveLength(2);
    expect(quantityOf(rows[0], 'input_tokens')).toBe(11);
  });

  test('a streamed stateless completion meters once the stream finishes', async () => {
    await readStream({ ai_provider_id: aiProviderId });

    const rows = await waitForMeters(3);
    expect(rows).toHaveLength(3);
    expect(quantityOf(rows[0], 'output_tokens')).toBe(5);
  });

  test('a streamed chat-scoped completion meters once the stream finishes', async () => {
    const chatId = await createChat();

    await readStream({ chat_id: chatId });

    const rows = await waitForMeters(4);
    expect(rows).toHaveLength(4);
    expect(quantityOf(rows[0], 'output_tokens')).toBe(5);
  });

  test('each completion writes a distinct event — repeated calls never collide', async () => {
    await authenticatedTestClient(userToken)
      .post('/api/v1/chat/completions')
      .send({
        ai_provider_id: aiProviderId,
        messages: [{ role: 'user', content: 'Again' }],
      });

    const rows = await waitForMeters(5);
    expect(rows).toHaveLength(5);
  });
});
