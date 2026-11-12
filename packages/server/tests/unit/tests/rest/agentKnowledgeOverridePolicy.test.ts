import { startChatCompletionStub } from '../../fixtures/chatCompletionStub';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * A generation's `knowledge_config` override names documents and stores on the
 * caller's behalf, so what it adds is read under the caller's
 * `knowledge:SearchKnowledge` policy and the agent's boundary. The agent's
 * stored config is the agent's own and keeps reading as the agent.
 */
const stubPromise = startChatCompletionStub({
  reply: () => {
    return { content: 'Done.' };
  },
});

const OPEN_TEXT = 'The cafeteria opens at nine.';
const SECRET_TEXT = 'The merger closes on Friday.';
const MEMORY_TEXT = 'The board prefers the second offer.';

describe('POST /api/v1/agents/:agent_id/generate — the override is read as the caller', () => {
  let adminToken: string;
  let projectId: string;
  let providerId: string;
  let secretId: string;
  let memoryStoreId: string;
  let noReadToken: string;
  let readerToken: string;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const create = async (path: string, body: Record<string, unknown>) => {
    const res = await asAdmin().post(path).send(body);
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const userWith = async (args: {
    username: string;
    actions: string[];
  }): Promise<string> => {
    const userId = await create('/api/v1/users', {
      username: args.username,
      password: 'overridepass',
    });
    const policyId = await create('/api/v1/policies', {
      document: { statement: [{ effect: 'Allow', action: args.actions }] },
    });
    await asAdmin()
      .put(`/api/v1/users/${userId}/policies`)
      .send({ policy_ids: [policyId] });
    return loginAs(args.username, 'overridepass');
  };

  const createAgent = async (args: {
    knowledgeConfig?: Record<string, unknown>;
    boundary?: Array<Record<string, unknown>>;
  }): Promise<string> => {
    return create('/api/v1/agents', {
      project_id: projectId,
      ai_provider_id: providerId,
      name: `agent-${Math.random().toString(36).slice(2)}`,
      instructions: 'Answer from what you are given.',
      max_steps: 1,
      ...(args.knowledgeConfig
        ? { knowledge_config: args.knowledgeConfig }
        : {}),
      ...(args.boundary
        ? {
            policy_ids: [
              await create('/api/v1/policies', {
                document: { statement: args.boundary },
              }),
            ],
          }
        : {}),
    });
  };

  /** The knowledge block the turn sent the model, or `''` when none. */
  const injectedAs = async (args: {
    token: string;
    agentId: string;
    knowledgeConfig?: Record<string, unknown>;
  }): Promise<string> => {
    const stub = await stubPromise;
    const before = stub.requests.length;
    const res = await authenticatedTestClient(args.token)
      .post(`/api/v1/agents/${args.agentId}/generate?wait=true`)
      .send({
        messages: [{ role: 'user', content: 'What do we know?' }],
        ...(args.knowledgeConfig
          ? { knowledge_config: args.knowledgeConfig }
          : {}),
      });
    expect(res.status).toBe(200);
    const block = stub.requests[before].messages.find((message) => {
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
      .send({ username: 'overridepolicyadmin', password: 'supersecret' });
    adminToken = await loginAs('overridepolicyadmin', 'supersecret');

    const { baseUrl } = await stubPromise;
    projectId = await create('/api/v1/projects', { name: 'Override policy' });
    providerId = await create('/api/v1/ai-providers', {
      project_id: projectId,
      name: 'Override policy provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: baseUrl,
    });

    await create('/api/v1/documents', {
      project_id: projectId,
      content: OPEN_TEXT,
      path: '/open/cafeteria.txt',
    });
    secretId = await create('/api/v1/documents', {
      project_id: projectId,
      content: SECRET_TEXT,
      path: '/secret/merger.txt',
    });
    memoryStoreId = await create('/api/v1/memory-stores', {
      project_id: projectId,
      name: 'Board notes',
    });
    await create('/api/v1/memories', {
      memory_store_id: memoryStoreId,
      content: MEMORY_TEXT,
    });

    const generate = ['agents:CreateAgentGeneration', 'agents:GetAgent'];
    noReadToken = await userWith({
      username: 'overridenoread',
      actions: generate,
    });
    readerToken = await userWith({
      username: 'overridereader',
      actions: [...generate, 'knowledge:SearchKnowledge'],
    });
  });

  afterAll(async () => {
    await (await stubPromise).close();
  });

  describe('a caller without knowledge reads', () => {
    test('gets no content of a document it names by id', async () => {
      const agentId = await createAgent({});

      const text = await injectedAs({
        token: noReadToken,
        agentId,
        knowledgeConfig: { document_ids: [secretId] },
      });

      expect(text).not.toContain(SECRET_TEXT);
    });

    test('gets no content under a path it names', async () => {
      const agentId = await createAgent({});

      const text = await injectedAs({
        token: noReadToken,
        agentId,
        knowledgeConfig: { document_paths: ['/secret/'] },
      });

      expect(text).not.toContain(SECRET_TEXT);
    });

    test('gets no memory of a store it names', async () => {
      const agentId = await createAgent({});

      const text = await injectedAs({
        token: noReadToken,
        agentId,
        knowledgeConfig: { memory_store_ids: [memoryStoreId] },
      });

      expect(text).not.toContain(MEMORY_TEXT);
    });

    test("still gets the agent's stored config", async () => {
      const agentId = await createAgent({
        knowledgeConfig: { document_paths: ['/secret/'] },
      });

      const text = await injectedAs({ token: noReadToken, agentId });

      expect(text).toContain(SECRET_TEXT);
    });

    test("gets the stored config beside an override, but not the override's additions", async () => {
      const agentId = await createAgent({
        knowledgeConfig: { document_paths: ['/open/'] },
      });

      const text = await injectedAs({
        token: noReadToken,
        agentId,
        knowledgeConfig: { document_paths: ['/secret/'] },
      });

      expect(text).toContain(OPEN_TEXT);
      expect(text).not.toContain(SECRET_TEXT);
    });
  });

  describe('a caller with knowledge reads', () => {
    test('gets the documents and memories it names', async () => {
      const agentId = await createAgent({});

      const text = await injectedAs({
        token: readerToken,
        agentId,
        knowledgeConfig: {
          document_ids: [secretId],
          memory_store_ids: [memoryStoreId],
        },
      });

      expect(text).toContain(SECRET_TEXT);
      expect(text).toContain(MEMORY_TEXT);
    });

    const deniedType = async (resourceType: string): Promise<string> => {
      const agentId = await createAgent({
        boundary: [
          { effect: 'Allow', action: ['*'], resource: ['*'] },
          {
            effect: 'Deny',
            action: ['knowledge:SearchKnowledge'],
            resource: [`srn:${projectId}:${resourceType}:*`],
          },
        ],
      });
      return injectedAs({
        token: readerToken,
        agentId,
        knowledgeConfig: {
          document_ids: [secretId],
          memory_store_ids: [memoryStoreId],
        },
      });
    };

    test("gets no memory when the agent's boundary denies memories", async () => {
      const text = await deniedType('memory');

      expect(text).toContain(SECRET_TEXT);
      expect(text).not.toContain(MEMORY_TEXT);
    });

    // As in a knowledge search, no access to documents searches nothing.
    test("gets nothing when the agent's boundary denies documents", async () => {
      const text = await deniedType('document');

      expect(text).not.toContain(SECRET_TEXT);
      expect(text).not.toContain(MEMORY_TEXT);
    });
  });
});
