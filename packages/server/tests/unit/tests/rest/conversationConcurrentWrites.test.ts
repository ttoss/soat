import { db } from '../../../../src/db';
import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient } from '../../testClient';

const CONCURRENT_WRITES = 12;

/** Writes to one conversation, fired at once. */
describe('Concurrent writes to one conversation', () => {
  let token: string;
  let projectId: string;
  let agentId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'convconc',
      policyActions: [
        'agents:CreateAgent',
        'conversations:CreateConversation',
        'conversations:GetConversation',
        'conversations:UpdateConversation',
        'conversations:GenerateConversationMessage',
      ],
      createNoPermUser: false,
    });
    token = setup.userToken;
    projectId = setup.projectId;

    const provider = await authenticatedTestClient(setup.adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Concurrent Writes Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    const agent = await authenticatedTestClient(token)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: provider.body.id,
        name: 'Concurrent Writes Agent',
      });
    agentId = agent.body.id;
  });

  // `mockCreateGeneration` is shared: clearing keeps it attached.
  afterEach(() => {
    jest.clearAllMocks();
  });

  const createConversation = async () => {
    const res = await authenticatedTestClient(token)
      .post('/api/v1/conversations')
      .send({ project_id: projectId });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  // `.then` starts the request: supertest requests are lazy.
  const postMessage = (args: { conversationId: string; message: string }) => {
    return authenticatedTestClient(token)
      .post(`/api/v1/conversations/${args.conversationId}/messages`)
      .send({ message: args.message, role: 'user' })
      .then((res) => {
        return res;
      });
  };

  const storedMessages = async (conversationId: string) => {
    const res = await authenticatedTestClient(token).get(
      `/api/v1/conversations/${conversationId}/messages?limit=100`
    );
    expect(res.status).toBe(200);
    return res.body.data as Array<{
      position: number;
      role: string;
      content: string;
    }>;
  };

  const writes = Array.from({ length: CONCURRENT_WRITES }, (_, index) => {
    return `concurrent ${index}`;
  });

  describe('POST /api/v1/conversations/{conversation_id}/messages', () => {
    test('concurrent appends are all stored, at consecutive positions', async () => {
      const conversationId = await createConversation();

      const responses = await Promise.all(
        writes.map((message) => {
          return postMessage({ conversationId, message });
        })
      );

      expect(
        responses.map((res) => {
          return res.status;
        })
      ).toEqual(
        writes.map(() => {
          return 201;
        })
      );
      const stored = await storedMessages(conversationId);
      expect(
        stored.map((message) => {
          return message.position;
        })
      ).toEqual(
        writes.map((_, index) => {
          return index;
        })
      );
      expect(
        stored
          .map((message) => {
            return message.content;
          })
          .sort()
      ).toEqual([...writes].sort());
    });

    test('a position another writer holds answers 409 and stores nothing', async () => {
      const conversationId = await createConversation();
      expect(
        (await postMessage({ conversationId, message: 'first' })).status
      ).toBe(201);
      // Only a writer outside the conversation's lock can take a position
      // first, so the insert is pointed at a held one to reach the backstop.
      const create = db.ConversationMessage.create.bind(db.ConversationMessage);
      const spy = jest
        .spyOn(db.ConversationMessage, 'create')
        .mockImplementationOnce((values, options) => {
          return create({ ...values, position: 0 }, options);
        });

      try {
        const res = await postMessage({ conversationId, message: 'second' });

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('CONVERSATION_POSITION_CONFLICT');
        expect(
          (await storedMessages(conversationId)).map((message) => {
            return message.content;
          })
        ).toEqual(['first']);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('POST /api/v1/conversations/{conversation_id}/generate', () => {
    test('a reply stored while messages are appended keeps its place after the history it read', async () => {
      const conversationId = await createConversation();
      expect(
        (await postMessage({ conversationId, message: 'Hello' })).status
      ).toBe(201);
      let appends: Promise<Array<{ status: number }>> = Promise.resolve([]);
      // The turn returns as the appends start, so its reply is stored
      // while they are in flight.
      mockCreateGeneration.mockImplementationOnce(async () => {
        appends = Promise.all(
          writes.map((message) => {
            return postMessage({ conversationId, message });
          })
        );
        return {
          id: 'gen_concurrent_reply',
          traceId: 'trace_concurrent_reply',
          status: 'completed',
          output: {
            model: 'test-model',
            content: 'Hi there',
            finishReason: 'stop',
          },
        };
      });

      const generated = await authenticatedTestClient(token)
        .post(`/api/v1/conversations/${conversationId}/generate?wait=true`)
        .send({ agent_id: agentId });
      const appended = await appends;

      expect(generated.status).toBe(200);
      expect(generated.body.message.position).toBe(1);
      expect(
        appended.map((res) => {
          return res.status;
        })
      ).toEqual(
        writes.map(() => {
          return 201;
        })
      );
      const stored = await storedMessages(conversationId);
      expect(
        stored.map((message) => {
          return message.position;
        })
      ).toEqual(
        Array.from({ length: CONCURRENT_WRITES + 2 }, (_, index) => {
          return index;
        })
      );
      expect(
        stored.slice(0, 2).map((message) => {
          return [message.role, message.content];
        })
      ).toEqual([
        ['user', 'Hello'],
        ['assistant', 'Hi there'],
      ]);
    });
  });
});
