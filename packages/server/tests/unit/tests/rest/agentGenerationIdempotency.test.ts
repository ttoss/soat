import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * An OpenAI-compatible provider that counts completions, so a test can prove a
 * replay never reached the model. `hold` parks the next completion until
 * released, which is how a retry is made to arrive mid-flight.
 */
const startCountingProvider = async () => {
  let completions = 0;
  let held: { reached: () => void; released: Promise<void> } | undefined;

  const readBody = async (req: IncomingMessage): Promise<string> => {
    let body = '';
    for await (const chunk of req) body += chunk;
    return body;
  };

  const answer = (res: ServerResponse, streamed: boolean) => {
    if (streamed) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (delta: object, finish: string | null) => {
        return `data: ${JSON.stringify({
          id: 'chatcmpl-stub',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'stub-model',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      };
      res.write(chunk({ role: 'assistant', content: 'streamed answer' }, null));
      res.write(chunk({}, 'stop'));
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-stub',
        object: 'chat.completion',
        created: 0,
        model: 'stub-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'final answer' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    );
  };

  const server: Server = createServer(async (req, res) => {
    const body = await readBody(req);
    completions += 1;
    const gate = held;
    held = undefined;
    if (gate) {
      gate.reached();
      await gate.released;
    }
    answer(res, body.includes('"stream":true'));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    completions: () => {
      return completions;
    },
    hold: () => {
      let release = () => {};
      let reached = () => {};
      const reachedPromise = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      held = { reached, released };
      return { reached: reachedPromise, release };
    },
    close: () => {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => {
          return err ? reject(err) : resolve();
        });
      });
    },
  };
};

type CountingProvider = Awaited<ReturnType<typeof startCountingProvider>>;

describe('POST /api/v1/agents/:agent_id/generate with an idempotency_key', () => {
  let provider: CountingProvider;
  let adminToken: string;
  let userToken: string;
  let scopedToken: string;
  let agentId: string;
  let siblingAgentId: string;
  let otherProjectAgentId: string;

  const createAgent = async (args: { projectId: string; name: string }) => {
    const aiProvider = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: args.projectId,
        name: `${args.name} Provider`,
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: provider.baseUrl,
      });
    const agent = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: args.projectId,
        ai_provider_id: aiProvider.body.id,
        name: args.name,
      });
    return agent.body.id as string;
  };

  const generate = (args: {
    key?: unknown;
    content?: string;
    query?: string;
    agent?: string;
    token?: string;
    extra?: Record<string, unknown>;
  }) => {
    return authenticatedTestClient(args.token ?? userToken)
      .post(
        `/api/v1/agents/${args.agent ?? agentId}/generate${args.query ?? ''}`
      )
      .send({
        messages: [{ role: 'user', content: args.content ?? 'File the row.' }],
        ...(args.key === undefined ? {} : { idempotency_key: args.key }),
        ...args.extra,
      });
  };

  const settle = async (generationId: string) => {
    let status = 'in_progress';
    for (let i = 0; i < 100 && status === 'in_progress'; i += 1) {
      const poll = await authenticatedTestClient(userToken).get(
        `/api/v1/generations/${generationId}`
      );
      status = poll.body.status;
    }
    return status;
  };

  let keySeq = 0;
  const newKey = () => {
    keySeq += 1;
    return `discord-msg-${Date.now()}-${keySeq}`;
  };

  beforeAll(async () => {
    provider = await startCountingProvider();
    const setup = await setupProjectWithUsers({
      prefix: 'genidem',
      policyActions: [
        'agents:CreateAgentGeneration',
        'agents:GetAgent',
        'generations:GetGeneration',
      ],
      createOtherProject: true,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    scopedToken = await createScopedPrincipal({
      adminToken,
      projectId: setup.projectId,
      username: 'genidemscoped',
      actions: ['agents:GetAgent'],
    });
    agentId = await createAgent({
      projectId: setup.projectId,
      name: 'Idem Agent',
    });
    siblingAgentId = await createAgent({
      projectId: setup.projectId,
      name: 'Idem Sibling',
    });
    otherProjectAgentId = await createAgent({
      projectId: setup.otherProjectId as string,
      name: 'Idem Other',
    });
  });

  afterAll(async () => {
    await provider.close();
  });

  test('returns 401 when unauthenticated', async () => {
    const response = await testClient
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({
        messages: [{ role: 'user', content: 'hi' }],
        idempotency_key: newKey(),
      });

    expect(response.status).toBe(401);
  });

  test('returns 403 without CreateAgentGeneration, even for a claimed key', async () => {
    const key = newKey();
    const first = await generate({ key, query: '?wait=true' });
    expect(first.status).toBe(200);

    const response = await generate({
      key,
      query: '?wait=true',
      token: scopedToken,
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  test('a waited retry answers 202 with the original generation and does not call the model again', async () => {
    const key = newKey();
    const first = await generate({ key, query: '?wait=true' });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('completed');
    const afterFirst = provider.completions();

    const retry = await generate({ key, query: '?wait=true' });

    expect(retry.status).toBe(202);
    expect(retry.body).toEqual({
      status: 'accepted',
      generation_id: first.body.id,
      trace_id: first.body.trace_id,
    });
    expect(provider.completions()).toBe(afterFirst);
  });

  test('a background retry answers the handle of the original generation', async () => {
    const key = newKey();
    const first = await generate({ key });
    expect(first.status).toBe(202);
    expect(await settle(first.body.generation_id)).toBe('completed');
    const afterFirst = provider.completions();

    const retry = await generate({ key });

    expect(retry.status).toBe(202);
    expect(retry.body.generation_id).toBe(first.body.generation_id);
    expect(retry.body.trace_id).toBe(first.body.trace_id);
    expect(provider.completions()).toBe(afterFirst);
  });

  test('wait is not part of the request a key names', async () => {
    const key = newKey();
    const first = await generate({ key });
    expect(first.status).toBe(202);
    await settle(first.body.generation_id);

    const retry = await generate({ key, query: '?wait=true' });

    expect(retry.status).toBe(202);
    expect(retry.body.generation_id).toBe(first.body.generation_id);
  });

  test('a retry arriving while the original is in flight replays it instead of running again', async () => {
    const key = newKey();
    const gate = provider.hold();
    // `.then` starts the lazy request before the gate is awaited.
    const firstPending = generate({ key, query: '?wait=true' }).then(
      (response) => {
        return response;
      }
    );
    await gate.reached;
    const afterFirst = provider.completions();

    const retry = await generate({ key, query: '?wait=true' });
    gate.release();
    const first = await firstPending;

    expect(retry.status).toBe(202);
    expect(first.status).toBe(200);
    expect(retry.body.generation_id).toBe(first.body.id);
    expect(provider.completions()).toBe(afterFirst);
  });

  test('two concurrent requests sharing a key run the model once', async () => {
    const key = newKey();
    const before = provider.completions();

    const [a, b] = await Promise.all([
      generate({ key, query: '?wait=true' }),
      generate({ key, query: '?wait=true' }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 202]);
    const fresh = a.status === 200 ? a : b;
    const replay = a.status === 200 ? b : a;
    expect(replay.body.generation_id).toBe(fresh.body.id);
    expect(provider.completions() - before).toBe(1);
  });

  test('a streamed retry answers the JSON handle instead of a second stream', async () => {
    const key = newKey();
    const first = await generate({ key, extra: { stream: true } });
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toContain('text/event-stream');
    const afterFirst = provider.completions();

    const retry = await generate({ key, extra: { stream: true } });

    expect(retry.status).toBe(202);
    expect(retry.headers['content-type']).toContain('application/json');
    expect(retry.body.generation_id).toMatch(/^gen_/);
    expect(provider.completions()).toBe(afterFirst);
  });

  test('reusing a key with different messages returns 409 and runs nothing', async () => {
    const key = newKey();
    const first = await generate({
      key,
      content: 'first',
      query: '?wait=true',
    });
    expect(first.status).toBe(200);
    const afterFirst = provider.completions();

    const reused = await generate({
      key,
      content: 'second',
      query: '?wait=true',
    });

    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(reused.body.error.meta).toEqual({ idempotency_key: key });
    expect(provider.completions()).toBe(afterFirst);
  });

  test('reusing a key with a different tool_context returns 409', async () => {
    const key = newKey();
    const first = await generate({
      key,
      query: '?wait=true',
      extra: { tool_context: { channel: 'a' } },
    });
    expect(first.status).toBe(200);

    const reused = await generate({
      key,
      query: '?wait=true',
      extra: { tool_context: { channel: 'b' } },
    });

    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  test('key order inside the body does not make a retry a different request', async () => {
    const key = newKey();
    const first = await generate({
      key,
      query: '?wait=true',
      extra: { metadata: { zz: '1', a: '2' } },
    });
    expect(first.status).toBe(200);

    const retry = await generate({
      key,
      query: '?wait=true',
      extra: { metadata: { a: '2', zz: '1' } },
    });

    expect(retry.status).toBe(202);
    expect(retry.body.generation_id).toBe(first.body.id);
  });

  test('the same key on another agent in the project returns 409', async () => {
    const key = newKey();
    const first = await generate({ key, query: '?wait=true' });
    expect(first.status).toBe(200);

    const reused = await generate({
      key,
      query: '?wait=true',
      agent: siblingAgentId,
    });

    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  test('a key claimed in another project does not collide', async () => {
    const key = newKey();
    const mine = await generate({ key, query: '?wait=true' });
    expect(mine.status).toBe(200);

    const theirs = await generate({
      key,
      query: '?wait=true',
      agent: otherProjectAgentId,
      token: adminToken,
    });

    expect(theirs.status).toBe(200);
    expect(theirs.body.id).not.toBe(mine.body.id);
  });

  test('without a key, the same request runs again', async () => {
    const before = provider.completions();

    const first = await generate({ query: '?wait=true' });
    const second = await generate({ query: '?wait=true' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.id).not.toBe(first.body.id);
    expect(provider.completions() - before).toBe(2);
  });

  test('the generation record reads back its idempotency_key', async () => {
    const key = newKey();
    const first = await generate({ key, query: '?wait=true' });

    const record = await authenticatedTestClient(userToken).get(
      `/api/v1/generations/${first.body.id}`
    );

    expect(record.status).toBe(200);
    expect(record.body.idempotency_key).toBe(key);
  });

  test('a generation started without a key reads back a null idempotency_key', async () => {
    const first = await generate({ query: '?wait=true' });

    const record = await authenticatedTestClient(userToken).get(
      `/api/v1/generations/${first.body.id}`
    );

    expect(record.body.idempotency_key).toBeNull();
  });

  test.each([
    ['a number', 42],
    ['an empty string', '   '],
    ['a string over 255 characters', 'k'.repeat(256)],
  ])('an idempotency_key that is %s returns 400', async (_label, key) => {
    const response = await generate({ key, query: '?wait=true' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });
});
