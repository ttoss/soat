import { db } from 'src/db';

import {
  type ChatRequest,
  startChatCompletionStub,
  toolResultsOf,
} from '../../fixtures/chatCompletionStub';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * An agent's knowledge is its own project's on every path that runs a turn:
 * the direct generate route, a session turn and a conversation turn. Two
 * projects hold knowledge; the agent lives in A, so nothing of B may reach it.
 */
type ToolCall = { name: string; arguments: Record<string, unknown> };

let toolCalls: ToolCall[] | null = null;

const stubPromise = startChatCompletionStub({
  reply: (request) => {
    const answered = request.messages.some((message) => {
      return message.role === 'tool';
    });
    if (toolCalls && !answered) return { toolCalls };
    return { content: 'Done.' };
  },
});

type Scope = { projectId: string; providerId: string };

const A_DOCUMENT = 'Project A handbook: refunds take 14 days.';
const B_DOCUMENT = 'Project B handbook: the vault code is 4242.';
const B_MEMORY = 'Project B customer prefers the vault code 4242.';

describe('Agent knowledge project scope', () => {
  let adminToken: string;
  let a: Scope;
  let b: Scope;
  let bDocumentId: string;
  let bStoreId: string;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const create = async (path: string, body: Record<string, unknown>) => {
    const res = await asAdmin().post(path).send(body);
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const createScope = async (name: string): Promise<Scope> => {
    const { baseUrl } = await stubPromise;
    const projectId = await create('/api/v1/projects', { name });
    const providerId = await create('/api/v1/ai-providers', {
      project_id: projectId,
      name: `${name} provider`,
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: baseUrl,
    });
    return { projectId, providerId };
  };

  const agentBody = (knowledgeConfig: Record<string, unknown>) => {
    return {
      project_id: a.projectId,
      ai_provider_id: a.providerId,
      name: `agent-${Math.random().toString(36).slice(2)}`,
      instructions: 'Answer from what you are given.',
      max_steps: 3,
      knowledge_config: knowledgeConfig,
    };
  };

  const createAgent = (knowledgeConfig: Record<string, unknown>) => {
    return create('/api/v1/agents', agentBody(knowledgeConfig));
  };

  /** Every request the model received while `run` ran. */
  const modelRequests = async (
    run: () => Promise<{ status: number }>
  ): Promise<ChatRequest[]> => {
    const stub = await stubPromise;
    const before = stub.requests.length;
    const res = await run();
    expect(res.status).toBe(200);
    return stub.requests.slice(before);
  };

  const sentText = (requests: ChatRequest[]): string => {
    return JSON.stringify(
      requests.map((request) => {
        return request.messages;
      })
    );
  };

  const directTurn = (args: {
    agentId: string;
    knowledgeConfig?: Record<string, unknown>;
  }) => {
    return modelRequests(() => {
      return asAdmin()
        .post(`/api/v1/agents/${args.agentId}/generate?wait=true`)
        .send({
          messages: [{ role: 'user', content: 'What is the handbook code?' }],
          ...(args.knowledgeConfig
            ? { knowledge_config: args.knowledgeConfig }
            : {}),
        });
    });
  };

  const sessionTurn = async (agentId: string) => {
    const session = await create('/api/v1/sessions', { agent_id: agentId });
    const message = await asAdmin()
      .post(`/api/v1/sessions/${session}/messages`)
      .send({ message: 'What is the handbook code?' });
    expect(message.status).toBe(201);
    return modelRequests(() => {
      return asAdmin().post(`/api/v1/sessions/${session}/generate?wait=true`);
    });
  };

  const conversationTurn = async (agentId: string) => {
    const conversation = await create('/api/v1/conversations', {
      project_id: a.projectId,
    });
    await create(`/api/v1/conversations/${conversation}/messages`, {
      message: 'What is the handbook code?',
      role: 'user',
    });
    return modelRequests(() => {
      return asAdmin()
        .post(`/api/v1/conversations/${conversation}/generate?wait=true`)
        .send({ agent_id: agentId });
    });
  };

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'knowledgescopeadmin', password: 'supersecret' });
    adminToken = await loginAs('knowledgescopeadmin', 'supersecret');

    a = await createScope('Knowledge scope A');
    b = await createScope('Knowledge scope B');
    await create('/api/v1/documents', {
      project_id: a.projectId,
      content: A_DOCUMENT,
      path: '/handbook/a.txt',
    });
    bDocumentId = await create('/api/v1/documents', {
      project_id: b.projectId,
      content: B_DOCUMENT,
      path: '/handbook/b.txt',
    });
    bStoreId = await create('/api/v1/memory-stores', {
      project_id: b.projectId,
      name: 'B preferences',
    });
    await create('/api/v1/memories', {
      memory_store_id: bStoreId,
      content: B_MEMORY,
    });
  });

  afterAll(async () => {
    await (await stubPromise).close();
  });

  afterEach(() => {
    toolCalls = null;
  });

  describe('an agent whose knowledge_config names no filter', () => {
    let agentId: string;

    beforeAll(async () => {
      agentId = await createAgent({ limit: 10 });
    });

    test.each([
      [
        'a direct generation',
        () => {
          return directTurn({ agentId });
        },
      ],
      [
        'a session turn',
        () => {
          return sessionTurn(agentId);
        },
      ],
      [
        'a conversation turn',
        () => {
          return conversationTurn(agentId);
        },
      ],
    ])('%s injects its own project only', async (_label, turn) => {
      const text = sentText(await turn());

      expect(text).toContain(A_DOCUMENT);
      expect(text).not.toContain('4242');
    });
  });

  describe('knowledge_config ids of another project', () => {
    test.each([
      [
        'document_ids',
        () => {
          return { document_ids: [bDocumentId] };
        },
      ],
      [
        'memory_store_ids',
        () => {
          return { memory_store_ids: [bStoreId] };
        },
      ],
      [
        'write_memory_store_id',
        () => {
          return { write_memory_store_id: bStoreId };
        },
      ],
    ])('are refused when an agent is created with %s', async (_label, cfg) => {
      const res = await asAdmin().post('/api/v1/agents').send(agentBody(cfg()));

      expect(res.status).toBe(400);
    });

    test('are refused when an agent is updated', async () => {
      const agentId = await createAgent({ limit: 5 });

      const res = await asAdmin()
        .patch(`/api/v1/agents/${agentId}`)
        .send({ knowledge_config: { document_ids: [bDocumentId] } });

      expect(res.status).toBe(400);
    });

    test('a per-call document_ids naming a document of B injects nothing', async () => {
      const agentId = await createAgent({ limit: 5 });

      const text = sentText(
        await directTurn({
          agentId,
          knowledgeConfig: { document_ids: [bDocumentId] },
        })
      );

      expect(text).not.toContain('4242');
    });

    test('a stored write_memory_store_id of B writes nothing there', async () => {
      const agentId = await createAgent({ limit: 5 });
      await db.Agent.update(
        { knowledgeConfig: { write_memory_store_id: bStoreId } },
        { where: { publicId: agentId } }
      );
      toolCalls = [{ name: 'write_memory', arguments: { content: 'leak' } }];

      const requests = await directTurn({ agentId });
      const [result] = toolResultsOf(requests[requests.length - 1]);
      const memories = await asAdmin().get(
        `/api/v1/memories?memory_store_id=${bStoreId}`
      );

      expect(result).toContain('not found');
      expect(
        (memories.body.data as Array<{ content: string }>).map((m) => {
          return m.content;
        })
      ).toEqual([B_MEMORY]);
    });
  });
});
