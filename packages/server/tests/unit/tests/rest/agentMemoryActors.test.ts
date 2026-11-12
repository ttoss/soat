import {
  type ChatRequest,
  startChatCompletionStub,
  toolResultsOf,
} from '../../fixtures/chatCompletionStub';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * An agent's built-in memory is per person: a turn in a session of an actor
 * retrieves that actor's memories only, and `write_memory` writes memories of
 * that actor. The provider is a local chat-completions stub; retrieval and the
 * write run for real.
 */
let rememberContent: string | null = null;

const stubPromise = startChatCompletionStub({
  reply: (request) => {
    const answered = request.messages.some((message) => {
      return message.role === 'tool';
    });
    if (rememberContent && !answered) {
      return {
        toolCalls: [
          { name: 'write_memory', arguments: { content: rememberContent } },
        ],
      };
    }
    return { content: 'Done.' };
  },
});

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

  const agentWith = (knowledgeConfig: Record<string, unknown>) => {
    return create('/api/v1/agents', {
      project_id: projectId,
      ai_provider_id: providerId,
      name: `agent-${crypto.randomUUID()}`,
      instructions: 'Answer from what you are given.',
      max_steps: 3,
      knowledge_config: knowledgeConfig,
    });
  };

  /** One turn in a session of `actorId`; every request the model received. */
  const turn = async (args: {
    agentId: string;
    actorId?: string;
  }): Promise<ChatRequest[]> => {
    const stub = await stubPromise;
    const before = stub.requests.length;
    const sessionId = await create('/api/v1/sessions', {
      agent_id: args.agentId,
      ...(args.actorId ? { actor_id: args.actorId } : {}),
    });
    await asAdmin()
      .post(`/api/v1/sessions/${sessionId}/messages`)
      .send({ message: 'What do we know?' });
    const res = await asAdmin().post(
      `/api/v1/sessions/${sessionId}/generate?wait=true`
    );
    expect(res.status).toBe(200);
    return stub.requests.slice(before);
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

  afterEach(() => {
    rememberContent = null;
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
      rememberContent = 'A is vegetarian.';

      const requests = await turn({ agentId, actorId: actorA });

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
      rememberContent = 'A is vegetarian.';

      const requests = await turn({ agentId, actorId: actorA });

      expect(
        JSON.parse(toolResultsOf(requests[requests.length - 1])[0])
      ).toEqual(expect.objectContaining({ action: 'created' }));
    });

    test('a turn of no actor writes a memory of no actor', async () => {
      const storeId = await newStore();
      const agentId = await agentWith({ write_memory_store_id: storeId });
      rememberContent = 'The office is in Lisbon.';

      const requests = await turn({ agentId });

      const { memoryId } = JSON.parse(
        toolResultsOf(requests[requests.length - 1])[0]
      ) as { memoryId: string };
      const memory = await asAdmin().get(`/api/v1/memories/${memoryId}`);
      expect(memory.body.actor_id).toBeNull();
    });
  });
});
