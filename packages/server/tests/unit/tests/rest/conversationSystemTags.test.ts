import { db } from 'src/db';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A conversation turn is stamped with where it came from, so one filter
 * reaches an actor's turns — and only that actor's. The caller reads those
 * keys and never writes them: a caller who could set `system.actor` could make
 * their own rows answer to someone else's filter.
 */
describe('conversation system tags', () => {
  let userToken: string;
  let projectId: string;

  const client = () => {
    return authenticatedTestClient(userToken);
  };

  const createActor = async (externalId: string) => {
    const res = await client().post('/api/v1/actors').send({
      project_id: projectId,
      name: externalId,
      external_id: externalId,
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const createConversation = async (actorId?: string) => {
    const res = await client()
      .post('/api/v1/conversations')
      .send({ project_id: projectId, actor_id: actorId, retrieval: 'embed' });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const addMessage = async (args: {
    conversationId: string;
    message: string;
    role?: string;
  }) => {
    const res = await client()
      .post(`/api/v1/conversations/${args.conversationId}/messages`)
      .send({ role: args.role ?? 'user', message: args.message });
    expect(res.status).toBe(201);
    return res.body.document_id as string;
  };

  const tagsOf = async (documentId: string) => {
    const doc = await db.Document.findOne({ where: { publicId: documentId } });
    return doc!.tags;
  };

  const searchDocumentIds = async (body: Record<string, unknown>) => {
    const res = await client()
      .post('/api/v1/knowledge/search')
      .send({ project_id: projectId, ...body });
    expect(res.status).toBe(200);
    return (res.body.results as Array<{ document_id?: string }>).map((r) => {
      return r.document_id;
    });
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'systags',
      policyActions: [
        'actors:CreateActor',
        'conversations:CreateConversation',
        'conversations:GetConversation',
        'conversations:UpdateConversation',
        'documents:CreateDocument',
        'documents:GetDocument',
        'documents:ListDocuments',
        'documents:UpdateDocument',
        'knowledge:SearchKnowledge',
      ],
    });
    userToken = setup.userToken;
    projectId = setup.projectId;
  });

  describe('the runtime stamps a turn with where it came from', () => {
    test('a user turn carries the conversation, owner and role', async () => {
      const actorId = await createActor('systags-owner');
      const conversationId = await createConversation(actorId);
      const documentId = await addMessage({
        conversationId,
        message: 'tamarind ledger question',
      });

      expect(await tagsOf(documentId)).toEqual({
        'system.conversation': conversationId,
        'system.actor': actorId,
        'system.role': 'user',
      });
    });

    test('a conversation with no owner is stamped without an actor', async () => {
      const conversationId = await createConversation();
      const documentId = await addMessage({
        conversationId,
        message: 'ownerless turn',
      });

      const tags = await tagsOf(documentId);
      expect(tags).toMatchObject({ 'system.conversation': conversationId });
      expect(tags).not.toHaveProperty('system.actor');
    });
  });

  describe('a caller cannot write a reserved key', () => {
    test('a tag sub-endpoint write is refused', async () => {
      const created = await client()
        .post('/api/v1/documents')
        .send({ project_id: projectId, content: 'mine', path: '/mine/a.txt' });
      expect(created.status).toBe(201);

      const res = await client()
        .put(`/api/v1/documents/${created.body.id}/tags`)
        .send({ 'system.actor': 'actor_impostor' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('RESERVED_TAG_KEY');
    });

    test('a document create carrying one is refused', async () => {
      const res = await client()
        .post('/api/v1/documents')
        .send({
          project_id: projectId,
          content: 'mine',
          path: '/mine/b.txt',
          tags: { 'system.conversation': 'conv_impostor' },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('RESERVED_TAG_KEY');
    });

    test('a caller tag write on a caller document still works', async () => {
      const created = await client()
        .post('/api/v1/documents')
        .send({ project_id: projectId, content: 'mine', path: '/mine/c.txt' });
      expect(created.status).toBe(201);

      const res = await client()
        .put(`/api/v1/documents/${created.body.id}/tags`)
        .send({ team: 'finance' });

      expect(res.status).toBe(200);
      expect(await tagsOf(created.body.id)).toEqual({ team: 'finance' });
    });
  });

  describe('one filter selects an actor and nothing else', () => {
    let mineId: string;
    let theirsId: string;
    let mineActorId: string;

    beforeAll(async () => {
      mineActorId = await createActor('systags-mine');
      const theirsActor = await createActor('systags-theirs');
      // Both turns say the same thing, so only the actor filter separates them.
      mineId = await addMessage({
        conversationId: await createConversation(mineActorId),
        message: 'quince invoice discrepancy',
      });
      theirsId = await addMessage({
        conversationId: await createConversation(theirsActor),
        message: 'quince invoice discrepancy',
      });
    });

    test('returns that actor’s turns', async () => {
      const ids = await searchDocumentIds({
        query: 'quince invoice discrepancy',
        tags: { 'system.actor': mineActorId },
      });

      expect(ids).toContain(mineId);
    });

    test('and never another actor’s, in the same project', async () => {
      const ids = await searchDocumentIds({
        query: 'quince invoice discrepancy',
        tags: { 'system.actor': mineActorId },
      });

      expect(ids).not.toContain(theirsId);
    });

    test('the filter reaches the reserved root without naming a path', async () => {
      // A bare query is kept out of `/.system/`; naming a `system.*` key is
      // what says the caller wants what is filed there.
      const bare = await searchDocumentIds({
        query: 'quince invoice discrepancy',
      });

      expect(bare).not.toContain(mineId);
    });

    test('a document list filtered by the key returns the turns', async () => {
      const res = await client().get(
        `/api/v1/documents?project_id=${projectId}&tags=system.actor:${mineActorId}&limit=100`
      );

      expect(res.status).toBe(200);
      expect(
        (res.body.data as Array<{ id: string }>).map((d) => {
          return d.id;
        })
      ).toContain(mineId);
    });
  });
});
