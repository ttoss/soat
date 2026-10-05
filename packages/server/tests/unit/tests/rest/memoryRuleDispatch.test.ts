import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { droppedEventCount } from 'src/lib/eventBus';
import * as generationsModule from 'src/lib/generations';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * Memory rules fired by the event flow: a real agent turn
 * (`POST /api/v1/agents/:agent_id/generate`, or a conversation turn) completes,
 * its event reaches the rule dispatcher on the bus, and the rule's handler
 * proposes facts that land in the store. Outcomes are read back through
 * `GET /api/v1/memories` and the `extraction` summary on
 * `GET /api/v1/generations/:generation_id`, which the dispatcher writes last.
 *
 * Every provider points at a local OpenAI-compatible stub, so the turn, the
 * built-in extractor's completion and a handler agent's own turn all run for
 * real. The stub tells them apart by the instructions each one sends.
 */

const EXTRACTOR_MARKER = 'Respond with a JSON array of strings';
const HANDLER_MARKER = 'Respond with JSON of the shape';

type StubRequest = { model: string; text: string; kind: RequestKind };
type RequestKind = 'turn' | 'extractor' | 'handler';

type Memory = {
  id: string;
  content: string;
  tags: Record<string, string> | null;
};

type Summary = Record<
  string,
  { candidates: number; created: number; superseded: number; skipped: number }
>;

describe('Memory rule dispatch', () => {
  let adminToken: string;
  let stubServer: Server;
  let stubBaseUrl: string;
  let seq = 0;

  const stub = {
    requests: [] as StubRequest[],
    /** What each kind of request is answered with; a function sees the text. */
    replies: {} as Partial<
      Record<RequestKind, string | ((text: string) => string)>
    >,
    /** Kinds the provider refuses. */
    failing: new Set<RequestKind>(),
  };

  const kindOf = (text: string): RequestKind => {
    if (text.includes(EXTRACTOR_MARKER)) return 'extractor';
    if (text.includes(HANDLER_MARKER)) return 'handler';
    return 'turn';
  };

  const requestsOf = (kind: RequestKind) => {
    return stub.requests.filter((request) => {
      return request.kind === kind;
    });
  };

  const startStub = async () => {
    stubServer = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += String(chunk);
      });
      req.on('end', () => {
        const body = JSON.parse(raw) as { model: string; messages: unknown };
        const text = JSON.stringify(body.messages);
        const kind = kindOf(text);
        stub.requests.push({ model: body.model, text, kind });
        if (stub.failing.has(kind)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'provider down' } }));
          return;
        }
        const reply = stub.replies[kind] ?? 'Noted.';
        const content = typeof reply === 'function' ? reply(text) : reply;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-stub',
            object: 'chat.completion',
            created: 0,
            model: body.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 2,
              total_tokens: 12,
            },
          })
        );
      });
    });
    await new Promise<void>((resolve) => {
      stubServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = stubServer.address() as AddressInfo;
    stubBaseUrl = `http://127.0.0.1:${port}`;
  };

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  /**
   * A project of its own per test: a rule with a `null` selector reads every
   * agent in its project, so a shared one would fire on other tests' turns.
   */
  const createProject = async () => {
    seq += 1;
    const project = await asAdmin()
      .post('/api/v1/projects')
      .send({ name: `Rule Dispatch ${seq}` });
    expect(project.status).toBe(201);
    const provider = await asAdmin()
      .post('/api/v1/ai-providers')
      .send({
        project_id: project.body.id,
        name: `rule-stub-${seq}`,
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: stubBaseUrl,
      });
    expect(provider.status).toBe(201);
    const projectId: string = project.body.id;
    const providerId: string = provider.body.id;

    return {
      projectId,
      createAgent: async (body: Record<string, unknown> = {}) => {
        seq += 1;
        const res = await asAdmin()
          .post('/api/v1/agents')
          .send({
            project_id: projectId,
            ai_provider_id: providerId,
            name: `rule-agent-${seq}`,
            ...body,
          });
        expect(res.status).toBe(201);
        return res.body.id as string;
      },
      createStore: async () => {
        seq += 1;
        const res = await asAdmin()
          .post('/api/v1/memory-stores')
          .send({ project_id: projectId, name: `rule-store-${seq}` });
        expect(res.status).toBe(201);
        return res.body.id as string;
      },
    };
  };

  const createRule = async (body: Record<string, unknown>) => {
    const res = await asAdmin()
      .post('/api/v1/memory-rules')
      .send({ on: 'agents.generation.completed', ...body });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  /** One finished turn; returns its generation id. */
  const turn = async (args: { agentId: string; message: string }) => {
    const res = await asAdmin()
      .post(`/api/v1/agents/${args.agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: args.message }] });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    return res.body.id as string;
  };

  const getGeneration = async (generationId: string) => {
    const res = await asAdmin().get(`/api/v1/generations/${generationId}`);
    expect(res.status).toBe(200);
    return res.body as {
      extraction: Summary | null;
      source: string | null;
      agent_id: string;
    };
  };

  /** The summary is the dispatcher's last write, so it marks the firing done. */
  const waitForSummary = async (generationId: string): Promise<Summary> => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const { extraction } = await getGeneration(generationId);
      if (extraction) return extraction;
      await new Promise((resolve) => {
        return setTimeout(resolve, 25);
      });
    }
    throw new Error(`generation ${generationId} never got a summary`);
  };

  const listMemories = async (storeId: string): Promise<Memory[]> => {
    const res = await asAdmin().get(
      `/api/v1/memories?memory_store_id=${storeId}`
    );
    expect(res.status).toBe(200);
    return res.body.data;
  };

  const waitForMemories = async (storeId: string): Promise<Memory[]> => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const memories = await listMemories(storeId);
      if (memories.length > 0) return memories;
      await new Promise((resolve) => {
        return setTimeout(resolve, 25);
      });
    }
    throw new Error(`store ${storeId} never got a memory`);
  };

  beforeAll(async () => {
    await startStub();
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'ruledispatchadmin', password: 'supersecret' });
    adminToken = await loginAs('ruledispatchadmin', 'supersecret');
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      stubServer.close(() => {
        resolve();
      });
    });
  });

  afterEach(() => {
    stub.requests = [];
    stub.replies = {};
    stub.failing.clear();
    jest.restoreAllMocks();
  });

  describe('agents.generation.completed → the built-in extractor', () => {
    test('writes the facts it proposes, under the rule that accepted them', async () => {
      const scope = await createProject();
      const storeId = await scope.createStore();
      const agentId = await scope.createAgent();
      const ruleId = await createRule({
        memory_store_id: storeId,
        source_agent_ids: [agentId],
      });
      stub.replies.turn = 'Noted, I will use email.';
      stub.replies.extractor = '["User prefers to be contacted by email"]';

      const generationId = await turn({
        agentId,
        message: 'I prefer to be contacted by email.',
      });

      expect(await waitForSummary(generationId)).toEqual({
        [ruleId]: { candidates: 1, created: 1, superseded: 0, skipped: 0 },
      });
      const memories = await listMemories(storeId);
      expect(memories).toHaveLength(1);
      expect(memories[0].content).toBe('User prefers to be contacted by email');

      // The transcript the rule reads is both sides of the finished turn.
      const [extraction] = requestsOf('extractor');
      expect(extraction.text).toContain('I prefer to be contacted by email.');
      expect(extraction.text).toContain('Noted, I will use email.');

      const assertions = await asAdmin().get(
        `/api/v1/memories/${memories[0].id}/assertions`
      );
      expect(assertions.status).toBe(200);
      expect(assertions.body.data).toHaveLength(1);
      expect(assertions.body.data[0]).toMatchObject({
        mechanism: 'rule',
        rule_id: ruleId,
        generation_id: generationId,
        // The source agent is the asserter; the rule decides what is accepted.
        principal_type: 'agent',
        principal_id: agentId,
        outcome: 'created',
      });
    });

    test('counts a duplicate candidate as skipped', async () => {
      const scope = await createProject();
      const storeId = await scope.createStore();
      const agentId = await scope.createAgent();
      const ruleId = await createRule({
        memory_store_id: storeId,
        source_agent_ids: null,
      });
      stub.replies.extractor =
        '["User timezone is CET", "User timezone is CET"]';

      const generationId = await turn({
        agentId,
        message: 'My timezone is CET.',
      });

      expect(await waitForSummary(generationId)).toEqual({
        [ruleId]: { candidates: 2, created: 1, superseded: 0, skipped: 1 },
      });
    });

    test('a malformed completion writes nothing', async () => {
      const scope = await createProject();
      const storeId = await scope.createStore();
      const agentId = await scope.createAgent();
      const ruleId = await createRule({
        memory_store_id: storeId,
        source_agent_ids: null,
      });
      stub.replies.extractor = 'not json at all';

      const generationId = await turn({ agentId, message: 'Anything at all.' });

      expect((await waitForSummary(generationId))[ruleId].candidates).toBe(0);
      expect(await listMemories(storeId)).toHaveLength(0);
    });

    test('a turn whose messages were never stored extracts from the reply alone', async () => {
      const scope = await createProject();
      const storeId = await scope.createStore();
      // A zero-retention agent never writes `input_messages`.
      const agentId = await scope.createAgent({ trace_content_mode: 'none' });
      await createRule({ memory_store_id: storeId, source_agent_ids: null });
      stub.replies.turn = 'The office moves in March.';
      stub.replies.extractor = '["The office moves in March"]';

      await turn({ agentId, message: 'never stored' });

      expect(await waitForMemories(storeId)).toHaveLength(1);
      const [extraction] = requestsOf('extractor');
      expect(extraction.text).toContain('The office moves in March.');
      expect(extraction.text).not.toContain('never stored');
    });
    test('a turn with an empty reply extracts from its messages alone', async () => {
      const scope = await createProject();
      const storeId = await scope.createStore();
      const agentId = await scope.createAgent();
      await createRule({ memory_store_id: storeId, source_agent_ids: null });
      stub.replies.turn = '';
      stub.replies.extractor = '["The badge code is 4417"]';

      await turn({ agentId, message: 'The badge code is 4417.' });

      expect(await waitForMemories(storeId)).toHaveLength(1);
      const [extraction] = requestsOf('extractor');
      expect(extraction.text).toContain('user: The badge code is 4417.');
      expect(extraction.text).not.toContain('assistant:');
    });
  });

  describe('agents.generation.completed → which rules fire', () => {
    test('only enabled rules whose selector names the agent', async () => {
      const scope = await createProject();
      const agentId = await scope.createAgent();
      const otherAgentId = await scope.createAgent();
      const named = await createRule({
        memory_store_id: await scope.createStore(),
        source_agent_ids: [agentId],
      });
      const unscoped = await createRule({
        memory_store_id: await scope.createStore(),
        source_agent_ids: null,
      });
      await createRule({
        memory_store_id: await scope.createStore(),
        source_agent_ids: [otherAgentId],
      });
      await createRule({
        memory_store_id: await scope.createStore(),
        source_agent_ids: [agentId],
        enabled: false,
      });
      stub.replies.extractor = '[]';

      const generationId = await turn({ agentId, message: 'Hello.' });

      // One summary per rule that ran: a flat pair of counts could not say
      // which rule produced them.
      expect(Object.keys(await waitForSummary(generationId)).sort()).toEqual(
        [named, unscoped].sort()
      );
    });

    test('two rules on one store each run their own instructions', async () => {
      const scope = await createProject();
      const storeId = await scope.createStore();
      const agentId = await scope.createAgent();
      const general = await createRule({
        memory_store_id: storeId,
        source_agent_ids: [agentId],
      });
      const billing = await createRule({
        memory_store_id: storeId,
        source_agent_ids: [agentId],
        prompt: 'Only billing facts',
      });
      stub.replies.extractor = (text) => {
        return text.includes('Only billing facts')
          ? '["The invoice is paid"]'
          : '["The cat is called Mia"]';
      };

      const generationId = await turn({
        agentId,
        message: 'The invoice is paid and my cat is called Mia.',
      });

      const summary = await waitForSummary(generationId);
      expect(summary[general].candidates).toBe(1);
      expect(summary[billing].candidates).toBe(1);
      expect(requestsOf('extractor')).toHaveLength(2);
    });
  });

  describe('agents.generation.completed → an agent handler', () => {
    test('writes the handler’s facts with their tags, and never reads its own turn back', async () => {
      const scope = await createProject();
      const storeId = await scope.createStore();
      const sourceAgentId = await scope.createAgent();
      const handlerAgentId = await scope.createAgent();
      // `null` selector: the handler's own turn is in scope too, so only the
      // loop guard keeps the rule from reading it.
      const ruleId = await createRule({
        memory_store_id: storeId,
        source_agent_ids: null,
        agent_id: handlerAgentId,
      });
      stub.replies.handler =
        '{"facts":[{"content":"The invoice is overdue","tags":{"kind":"billing"}}]}';

      const generationId = await turn({
        agentId: sourceAgentId,
        message: 'The invoice is overdue.',
      });

      expect(await waitForSummary(generationId)).toEqual({
        [ruleId]: { candidates: 1, created: 1, superseded: 0, skipped: 0 },
      });
      const memories = await listMemories(storeId);
      expect(memories).toHaveLength(1);
      expect(memories[0].content).toBe('The invoice is overdue');
      expect(memories[0].tags).toEqual({ kind: 'billing' });
      // The built-in extractor is not involved when a handler is named.
      expect(requestsOf('extractor')).toHaveLength(0);
      expect(requestsOf('handler')).toHaveLength(1);

      // The handler's turn is stamped and continues the source turn.
      const children = await asAdmin().get(
        `/api/v1/generations?initiator_generation_id=${generationId}`
      );
      expect(children.status).toBe(200);
      const [handlerTurn] = children.body.data as Array<{
        id: string;
        source: string;
      }>;
      expect(handlerTurn.source).toBe('memory_rule');

      // A turn by the handler agent itself, started by hand, carries no
      // marker and is skipped too. A later source turn's summary marks both
      // handler turns' dispatches as done.
      const direct = await turn({
        agentId: handlerAgentId,
        message: 'Test me.',
      });
      await waitForSummary(
        await turn({ agentId: sourceAgentId, message: 'Second turn.' })
      );
      expect((await getGeneration(handlerTurn.id)).extraction).toBeNull();
      expect((await getGeneration(direct)).extraction).toBeNull();
      expect(requestsOf('handler')).toHaveLength(2);
    });

    test('a failing handler writes nothing', async () => {
      const scope = await createProject();
      const storeId = await scope.createStore();
      const sourceAgentId = await scope.createAgent();
      const handlerAgentId = await scope.createAgent();
      const ruleId = await createRule({
        memory_store_id: storeId,
        source_agent_ids: [sourceAgentId],
        agent_id: handlerAgentId,
      });
      stub.failing.add('handler');

      const generationId = await turn({
        agentId: sourceAgentId,
        message: 'Anything.',
      });

      expect((await waitForSummary(generationId))[ruleId].candidates).toBe(0);
      expect(await listMemories(storeId)).toHaveLength(0);
    });
  });

  describe('agents.generation.completed → a tool handler', () => {
    let toolServer: Server;
    let toolServerUrl: string;
    let lastToolInput: Record<string, unknown> | undefined;

    beforeAll(async () => {
      toolServer = createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => {
          raw += String(chunk);
        });
        req.on('end', () => {
          lastToolInput = raw ? JSON.parse(raw) : undefined;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              facts: [{ content: 'The customer is on the annual plan' }],
            })
          );
        });
      });
      await new Promise<void>((resolve) => {
        toolServer.listen(0, '127.0.0.1', resolve);
      });
      const { port } = toolServer.address() as AddressInfo;
      toolServerUrl = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => {
        toolServer.close(() => {
          resolve();
        });
      });
    });

    test('is handed the turn, presets first, and its facts are written', async () => {
      const scope = await createProject();
      const storeId = await scope.createStore();
      const sourceAgentId = await scope.createAgent();
      const tool = await asAdmin()
        .post('/api/v1/tools')
        .send({
          project_id: scope.projectId,
          name: 'memory-rule-handler',
          type: 'http',
          execute: { url: `${toolServerUrl}/facts`, method: 'POST' },
        });
      expect(tool.status).toBe(201);
      const ruleId = await createRule({
        memory_store_id: storeId,
        source_agent_ids: [sourceAgentId],
        tool_id: tool.body.id,
        // A preset cannot rewrite the reserved turn fields.
        preset_parameters: { style: 'terse', rule_id: 'rule_forged' },
      });

      const generationId = await turn({
        agentId: sourceAgentId,
        message: 'I moved to the annual plan.',
      });

      await waitForSummary(generationId);
      const memories = await listMemories(storeId);
      expect(memories).toHaveLength(1);
      expect(memories[0].content).toBe('The customer is on the annual plan');
      expect(lastToolInput).toMatchObject({
        style: 'terse',
        event: 'agents.generation.completed',
        rule_id: ruleId,
        agent_id: sourceAgentId,
        generation_id: generationId,
        conversation_id: null,
      });
      expect(String(lastToolInput!.transcript)).toContain(
        'I moved to the annual plan.'
      );
    });
  });

  describe('POST /api/v1/conversations/:conversation_id/generate → conversations.message.generated', () => {
    test('feeds the persisted reply to the handler and stamps the conversation on each fact', async () => {
      const scope = await createProject();
      const storeId = await scope.createStore();
      const sourceAgentId = await scope.createAgent();
      const handlerAgentId = await scope.createAgent();
      await createRule({
        memory_store_id: storeId,
        on: 'conversations.message.generated',
        source_agent_ids: [sourceAgentId],
        agent_id: handlerAgentId,
      });
      const actor = await asAdmin()
        .post('/api/v1/actors')
        .send({ project_id: scope.projectId, name: 'Provenance Owner' });
      expect(actor.status).toBe(201);
      const conversation = await asAdmin()
        .post('/api/v1/conversations')
        .send({ project_id: scope.projectId, actor_id: actor.body.id });
      expect(conversation.status).toBe(201);
      const question = await asAdmin()
        .post(`/api/v1/conversations/${conversation.body.id}/messages`)
        .send({ role: 'user', message: 'Did my renewal go through?' });
      expect(question.status).toBe(201);
      stub.replies.turn = 'Your renewal is confirmed.';
      // A handler is model-authored, so a reserved key it proposes is dropped
      // and the real provenance stamped in its place.
      stub.replies.handler =
        '{"facts":[{"content":"The renewal is confirmed","tags":{"topic":"billing","system.actor":"actor_impostor"}}]}';

      const generated = await asAdmin()
        .post(
          `/api/v1/conversations/${conversation.body.id}/generate?wait=true`
        )
        .send({ agent_id: sourceAgentId });
      expect(generated.status).toBe(200);
      expect(generated.body.status).toBe('completed');

      const memories = await waitForMemories(storeId);
      expect(memories).toHaveLength(1);
      expect(memories[0].content).toBe('The renewal is confirmed');
      expect(memories[0].tags).toEqual({
        topic: 'billing',
        'system.conversation': conversation.body.id,
        'system.actor': actor.body.id,
      });

      const [handler] = requestsOf('handler');
      expect(handler.text).toContain('Did my renewal go through?');
      expect(handler.text).toContain('Your renewal is confirmed.');
    });
  });

  describe('a firing the database refuses', () => {
    test('is counted as a dropped event, and the facts already written stay', async () => {
      const scope = await createProject();
      const storeId = await scope.createStore();
      const agentId = await scope.createAgent();
      await createRule({ memory_store_id: storeId, source_agent_ids: null });
      stub.replies.extractor = '["The lock combination is 12-4-31"]';
      // Sanctioned force-failure stub for the subscriber's `.catch()`: only the
      // summary write rejects, after the turn and the candidates have
      // committed on the real database.
      const original = generationsModule.updateGenerationRecord;
      jest
        .spyOn(generationsModule, 'updateGenerationRecord')
        .mockImplementation((args) => {
          return 'extraction' in args
            ? Promise.reject(new Error('database unavailable'))
            : original(args);
        });
      const before = droppedEventCount({ stage: 'memory_rule_dispatch' });

      await turn({ agentId, message: 'The lock combination is 12-4-31.' });

      for (
        let attempt = 0;
        attempt < 400 &&
        droppedEventCount({ stage: 'memory_rule_dispatch' }) === before;
        attempt += 1
      ) {
        await new Promise((resolve) => {
          return setTimeout(resolve, 25);
        });
      }
      expect(droppedEventCount({ stage: 'memory_rule_dispatch' })).toBe(
        before + 1
      );
      expect(await listMemories(storeId)).toHaveLength(1);
    });
  });
});
