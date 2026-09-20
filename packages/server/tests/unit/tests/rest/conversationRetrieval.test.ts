import { db } from 'src/db';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A turn is embedded because someone asked for the conversation to be
 * retrievable, never merely because it was said. Turns are chunked either way,
 * so `none` costs the conversation nothing but its place in the vector channel.
 */
describe('conversation retrieval', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;

  const client = () => {
    return authenticatedTestClient(userToken);
  };

  const createConversation = async (retrieval?: string | null) => {
    const res = await client()
      .post('/api/v1/conversations')
      .send({ project_id: projectId, name: 'retrieval', retrieval });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const addMessage = async (conversationId: string, message: string) => {
    const res = await client()
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .send({ role: 'user', message });
    expect(res.status).toBe(201);
    return res.body.document_id as string;
  };

  const chunksOf = async (documentId: string) => {
    const doc = await db.Document.findOne({
      where: { publicId: documentId },
    });
    return db.DocumentChunk.findAll({ where: { documentId: doc!.id } });
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'convretrieval',
      policyActions: [
        'conversations:CreateConversation',
        'conversations:GetConversation',
        'conversations:UpdateConversation',
        'documents:GetDocument',
      ],
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
  });

  test('a project embeds no conversation turn by default', async () => {
    const conversationId = await createConversation();
    const documentId = await addMessage(conversationId, 'unembedded turn');

    const chunks = await chunksOf(documentId);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].embedding).toBeNull();
  });

  test('the text is still stored and still readable', async () => {
    const conversationId = await createConversation();
    const documentId = await addMessage(conversationId, 'still readable');

    const res = await client().get(`/api/v1/documents/${documentId}`);
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('still readable');
  });

  test('retrieval embed on the conversation embeds its turns', async () => {
    const conversationId = await createConversation('embed');
    const documentId = await addMessage(conversationId, 'embedded turn');

    const chunks = await chunksOf(documentId);
    expect(chunks[0].embedding).not.toBeNull();
  });

  test('the conversation reports the mode it was created with', async () => {
    const conversationId = await createConversation('embed');
    const res = await client().get(`/api/v1/conversations/${conversationId}`);

    expect(res.status).toBe(200);
    expect(res.body.retrieval).toBe('embed');
  });

  test('an unknown mode is refused', async () => {
    const res = await client()
      .post('/api/v1/conversations')
      .send({ project_id: projectId, retrieval: 'sometimes' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  test('switching it on embeds the backlog, not just the next turn', async () => {
    const conversationId = await createConversation();
    const documentId = await addMessage(
      conversationId,
      'said before the switch'
    );
    expect((await chunksOf(documentId))[0].embedding).toBeNull();

    const patched = await client()
      .patch(`/api/v1/conversations/${conversationId}`)
      .send({ retrieval: 'embed' });
    expect(patched.status).toBe(200);

    expect((await chunksOf(documentId))[0].embedding).not.toBeNull();
  });

  test('a project default of embed applies to a conversation that names none', async () => {
    const updated = await authenticatedTestClient(adminToken)
      .patch(`/api/v1/projects/${projectId}`)
      .send({ default_conversation_retrieval: 'embed' });
    expect(updated.status).toBe(200);
    expect(updated.body.default_conversation_retrieval).toBe('embed');

    const conversationId = await createConversation();
    const documentId = await addMessage(conversationId, 'inherits the default');

    expect((await chunksOf(documentId))[0].embedding).not.toBeNull();
  });

  test('a conversation saying none overrides a project default of embed', async () => {
    const conversationId = await createConversation('none');
    const documentId = await addMessage(conversationId, 'opted out');

    expect((await chunksOf(documentId))[0].embedding).toBeNull();
  });
});
