import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import {
  type ChatRequest,
  startChatCompletionStub,
} from '../../fixtures/chatCompletionStub';
import { authenticatedTestClient } from '../../testClient';

/**
 * A message part naming a record resolves within the project the turn runs
 * in. A record of another project answers exactly what a made-up id answers,
 * on every path that takes one, and never reaches the model.
 */
const stubPromise = startChatCompletionStub({
  reply: () => {
    return { content: 'Done.' };
  },
});

const OTHER_TEXT = 'Other project secret: the vault code is 4242.';
const MISSING_DOCUMENT = 'doc_missing00000000000';

describe('a message part naming another project record', () => {
  let adminToken: string;
  let scopedKey: string;
  let agentId: string;
  let providerId: string;
  let otherDocumentId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'xprojmsg',
      policyActions: ['*'],
      createOtherProject: true,
    });
    adminToken = setup.adminToken;
    const admin = authenticatedTestClient(adminToken);
    const create = async (path: string, body: object) => {
      const res = await admin.post(path).send(body);
      expect(res.status).toBe(201);
      return res.body.id as string;
    };

    providerId = await create('/api/v1/ai-providers', {
      project_id: setup.projectId,
      name: 'xprojmsg provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: (await stubPromise).baseUrl,
    });
    agentId = await create('/api/v1/agents', {
      project_id: setup.projectId,
      ai_provider_id: providerId,
      name: 'xprojmsg-agent',
    });
    otherDocumentId = await create('/api/v1/documents', {
      project_id: setup.otherProjectId,
      content: OTHER_TEXT,
      path: '/secret.txt',
    });

    const keyRes = await admin
      .post('/api/v1/api-keys')
      .send({ project_id: setup.projectId, name: 'xprojmsg scoped key' });
    scopedKey = keyRes.body.key;
  });

  afterAll(async () => {
    await (await stubPromise).close();
  });

  const PATHS: {
    name: string;
    send: (args: { token: string; documentId: string }) => Promise<{
      status: number;
      body: { error?: { code?: string } };
    }>;
  }[] = [
    {
      name: 'a generation document part',
      send: ({ token, documentId }) => {
        return authenticatedTestClient(token)
          .post(`/api/v1/agents/${agentId}/generate?wait=true`)
          .send({
            messages: [
              {
                role: 'user',
                content: { type: 'document', document_id: documentId },
              },
            ],
          });
      },
    },
    {
      name: 'a session message document_id',
      send: async ({ token, documentId }) => {
        const session = await authenticatedTestClient(adminToken)
          .post('/api/v1/sessions')
          .send({ agent_id: agentId });
        expect(session.status).toBe(201);
        return authenticatedTestClient(token)
          .post(`/api/v1/sessions/${session.body.id}/messages`)
          .send({ document_id: documentId });
      },
    },
    {
      name: 'a chat completion document_id',
      send: ({ token, documentId }) => {
        return authenticatedTestClient(token)
          .post('/api/v1/chat/completions')
          .send({
            ai_provider_id: providerId,
            messages: [{ role: 'user', document_id: documentId }],
          });
      },
    },
  ];

  const callers = [
    {
      name: 'a key scoped to the turn project',
      token: () => {
        return scopedKey;
      },
    },
    {
      name: 'an admin reaching every project',
      token: () => {
        return adminToken;
      },
    },
  ];

  describe.each(callers)('$name', ({ token }) => {
    test.each(PATHS)('$name answers as a made-up id does', async ({ send }) => {
      const stub = await stubPromise;
      const before = stub.requests.length;

      const missing = await send({
        token: token(),
        documentId: MISSING_DOCUMENT,
      });
      const res = await send({ token: token(), documentId: otherDocumentId });

      expect(missing.status).toBe(404);
      expect(res.status).toBe(404);
      expect(res.body.error?.code).toBe(missing.body.error?.code);
      expect(JSON.stringify(res.body)).not.toMatch(/proj_|key_/);
      const sent = stub.requests.slice(before).map((request: ChatRequest) => {
        return request.messages;
      });
      expect(JSON.stringify(sent)).not.toContain('4242');
    });
  });
});
