import {
  type ChatRequest,
  createTurnScript,
  requestsOfTurn,
  startChatCompletionStub,
  toolResultsOf,
} from '../../fixtures/chatCompletionStub';
import { pollUntil } from '../../fixtures/poll';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * An agent's built-in memory is per person: a turn in a session of an actor
 * retrieves that actor's memories only, and `write_memory` writes memories of
 * that actor. The provider is a local chat-completions stub; retrieval and the
 * write run for real.
 */
const script = createTurnScript();

const stubPromise = startChatCompletionStub({ reply: script.reply });

describe('Agent memory per actor', () => {
  let adminToken: string;
  let projectId: string;
  let providerId: string;
  let actorA: string;
  let actorB: string;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const create = async (path: string, body: Record<string, unknown>) => {
    const res = await asAdmin().post(path).send(body);
    expect(res.status).toBeLessThan(300);
    return res.body.id as string;
  };

  const newStore = () => {
    return create('/api/v1/memory-stores', {
      project_id: projectId,
      name: `people ${crypto.randomUUID()}`,
    });
  };

  const agentWith = (
    knowledgeConfig: Record<string, unknown>,
    extra: Record<string, unknown> = {}
  ) => {
    return create('/api/v1/agents', {
      project_id: projectId,
      ai_provider_id: providerId,
      name: `agent-${crypto.randomUUID()}`,
      instructions: 'Answer from what you are given.',
      max_steps: 3,
      knowledge_config: knowledgeConfig,
      ...extra,
    });
  };

  /**
   * One turn in a session of `actorId`, whose model asks to remember
   * `remember` when given; every request the model received.
   */
  const turn = async (args: {
    agentId: string;
    actorId?: string;
    remember?: string;
  }): Promise<ChatRequest[]> => {
    const stub = await stubPromise;
    const marker = script.arm(
      args.remember
        ? [{ name: 'write_memory', arguments: { content: args.remember } }]
        : []
    );
    const sessionId = await create('/api/v1/sessions', {
      agent_id: args.agentId,
      ...(args.actorId ? { actor_id: args.actorId } : {}),
    });
    await asAdmin()
      .post(`/api/v1/sessions/${sessionId}/messages`)
      .send({ message: `What do we know? ${marker}` });
    const res = await asAdmin().post(
      `/api/v1/sessions/${sessionId}/generate?wait=true`
    );
    expect(res.status).toBe(200);
    return requestsOfTurn({ requests: stub.requests, marker });
  };

  const injected = (requests: ChatRequest[]): string => {
    const block = requests[0].messages.find((message) => {
      return (
        typeof message.content === 'string' &&
        message.content.includes('<knowledge>')
      );
    });
    return typeof block?.content === 'string' ? block.content : '';
  };

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'agentmemoryactors', password: 'supersecret' });
    adminToken = await loginAs('agentmemoryactors', 'supersecret');
    const { baseUrl } = await stubPromise;
    projectId = await create('/api/v1/projects', { name: 'Memory actors' });
    providerId = await create('/api/v1/ai-providers', {
      project_id: projectId,
      name: 'stub',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: baseUrl,
    });
    actorA = await create('/api/v1/actors', {
      project_id: projectId,
      name: 'A',
    });
    actorB = await create('/api/v1/actors', {
      project_id: projectId,
      name: 'B',
    });
  });

  afterAll(async () => {
    await (await stubPromise).close();
  });

  describe('retrieval from memory_store_ids', () => {
    let storeId: string;
    let memoryA: string;
    let memoryB: string;
    let memoryNone: string;

    beforeAll(async () => {
      storeId = await newStore();
      const write = async (content: string, actorId?: string) => {
        return create('/api/v1/memories', {
          memory_store_id: storeId,
          content,
          ...(actorId ? { actor_id: actorId } : {}),
        });
      };
      memoryA = await write('A prefers email.', actorA);
      memoryB = await write('B prefers phone.', actorB);
      memoryNone = await write('The office is in Lisbon.');
    });

    test("a turn of an actor retrieves that actor's memories only", async () => {
      const agentId = await agentWith({ memory_store_ids: [storeId] });

      const text = injected(await turn({ agentId, actorId: actorA }));

      expect(text).toContain(memoryA);
      expect(text).not.toContain(memoryB);
      expect(text).not.toContain(memoryNone);
    });

    test('a turn of no actor retrieves every memory', async () => {
      const agentId = await agentWith({ memory_store_ids: [storeId] });

      const text = injected(await turn({ agentId }));

      expect(text).toContain(memoryA);
      expect(text).toContain(memoryB);
      expect(text).toContain(memoryNone);
    });
  });

  describe('write_memory', () => {
    test("writes a memory of the session's actor", async () => {
      const storeId = await newStore();
      const agentId = await agentWith({ write_memory_store_id: storeId });
      const requests = await turn({
        agentId,
        actorId: actorA,
        remember: 'A is vegetarian.',
      });

      const { memoryId } = JSON.parse(
        toolResultsOf(requests[requests.length - 1])[0]
      ) as { memoryId: string };
      const memory = await asAdmin().get(`/api/v1/memories/${memoryId}`);
      expect(memory.body.actor_id).toBe(actorA);
    });

    test("compares only against the session actor's memories", async () => {
      const storeId = await newStore();
      await create('/api/v1/memories', {
        memory_store_id: storeId,
        content: 'B is vegetarian.',
        actor_id: actorB,
      });
      const agentId = await agentWith({ write_memory_store_id: storeId });
      const requests = await turn({
        agentId,
        actorId: actorA,
        remember: 'A is vegetarian.',
      });

      expect(
        JSON.parse(toolResultsOf(requests[requests.length - 1])[0])
      ).toEqual(expect.objectContaining({ action: 'created' }));
    });

    test("approving one held write per actor writes each actor's memory", async () => {
      const storeId = await newStore();
      const guardrailId = await create('/api/v1/guardrails', {
        project_id: projectId,
        name: `hold-${crypto.randomUUID()}`,
        document: { class: 'C' },
      });
      const agentId = await agentWith(
        { write_memory_store_id: storeId },
        { guardrail_ids: [guardrailId] }
      );
      const approvalIds = [];
      for (const actorId of [actorA, actorB]) {
        const requests = await turn({
          agentId,
          actorId,
          remember: 'Prefers email.',
        });
        approvalIds.push(
          JSON.parse(toolResultsOf(requests[requests.length - 1])[0])
            .approval_id
        );
      }
      expect(new Set(approvalIds).size).toBe(2);

      for (const approvalId of approvalIds) {
        const res = await asAdmin()
          .post(`/api/v1/approvals/${approvalId}/approve`)
          .send({});
        expect(res.status).toBe(200);
      }

      const owners = await pollUntil({
        read: async () => {
          const res = await asAdmin().get(
            `/api/v1/memories?memory_store_id=${storeId}`
          );
          return (res.body.data as Array<{ actor_id: string }>).map(
            (memory) => {
              return memory.actor_id;
            }
          );
        },
        done: (found) => {
          return found.length >= 2;
        },
      });
      expect(owners.sort()).toEqual([actorA, actorB].sort());
    });

    test('a turn of no actor writes a memory of no actor', async () => {
      const storeId = await newStore();
      const agentId = await agentWith({ write_memory_store_id: storeId });
      const requests = await turn({
        agentId,
        remember: 'The office is in Lisbon.',
      });

      const { memoryId } = JSON.parse(
        toolResultsOf(requests[requests.length - 1])[0]
      ) as { memoryId: string };
      const memory = await asAdmin().get(`/api/v1/memories/${memoryId}`);
      expect(memory.body.actor_id).toBeNull();
    });
  });
});
