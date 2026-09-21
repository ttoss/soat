import { db } from 'src/db';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

const DOCUMENT_ACTIONS = [
  'documents:CreateDocument',
  'documents:GetDocument',
  'documents:ListDocuments',
  'documents:UpdateDocument',
  'documents:WithdrawDocument',
  'documents:ListDocumentVersions',
  'documents:GetDocumentVersion',
  'documents:RestoreDocumentVersion',
  'knowledge:SearchKnowledge',
];

/**
 * Withdrawal is a version, not a `deleted_at`: the tombstone records that the
 * document left, the version before it is what brings it back, and no reader
 * carries a second exclusion.
 */
describe('Document withdrawal', () => {
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let seq = 0;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'docwithdraw',
      policyActions: DOCUMENT_ACTIONS,
    });

    userToken = setup.userToken;
    projectId = setup.projectId;
    noPermToken = setup.noPermToken as string;
  }, 60_000);

  const createDocument = async (content: string) => {
    seq += 1;
    const created = await authenticatedTestClient(userToken)
      .post('/api/v1/documents')
      .send({
        project_id: projectId,
        content,
        filename: `withdrawable-${seq}.txt`,
        path: `/withdrawable/${seq}.txt`,
      });

    expect(created.status).toBe(201);
    return created.body.id as string;
  };

  const withdraw = (id: string) => {
    return authenticatedTestClient(userToken)
      .post(`/api/v1/documents/${id}/withdraw`)
      .send({});
  };

  const listIds = async (query = '') => {
    const response = await authenticatedTestClient(userToken).get(
      `/api/v1/documents?project_id=${projectId}${query}`
    );
    expect(response.status).toBe(200);
    return (response.body.data as { id: string }[]).map((doc) => {
      return doc.id;
    });
  };

  const chunkCount = async (id: string) => {
    const doc = await db.Document.findOne({ where: { publicId: id } });
    return db.DocumentChunk.count({ where: { documentId: doc!.id as number } });
  };

  describe('POST /api/v1/documents/:document_id/withdraw', () => {
    test('the document leaves listings and reports its new status', async () => {
      const id = await createDocument('Withdrawable content.');
      expect(await listIds()).toContain(id);

      const response = await withdraw(id);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('withdrawn');
      expect(await listIds()).not.toContain(id);
    });

    test('it stays addressable by id, which is what makes it restorable', async () => {
      const id = await createDocument('Still readable.');
      await withdraw(id);

      const read = await authenticatedTestClient(userToken).get(
        `/api/v1/documents/${id}`
      );

      expect(read.status).toBe(200);
      expect(read.body.status).toBe('withdrawn');
    });

    test('`include_withdrawn=true` shows it again', async () => {
      const id = await createDocument('Hidden by default.');
      await withdraw(id);

      expect(await listIds('&include_withdrawn=true')).toContain(id);
    });

    /**
     * The exclusion is by construction, not by predicate: a withdrawn
     * document has no vectors for the scan to reach and discard, so a corpus
     * full of withdrawals costs a live search nothing.
     */
    test('its chunks are dropped from the index', async () => {
      const id = await createDocument('Indexed content to drop.');
      expect(await chunkCount(id)).toBeGreaterThan(0);

      await withdraw(id);

      expect(await chunkCount(id)).toBe(0);
    });

    test('knowledge search no longer answers with it', async () => {
      const id = await createDocument('Pelican migration patterns in spring.');

      const before = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({ project_id: projectId, query: 'pelican migration' });
      expect(before.status).toBe(200);
      expect(JSON.stringify(before.body)).toContain(id);

      await withdraw(id);

      const after = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({ project_id: projectId, query: 'pelican migration' });
      expect(after.status).toBe(200);
      expect(JSON.stringify(after.body)).not.toContain(id);
    }, 60_000);

    test('the withdrawal is archived as a version with no content', async () => {
      const id = await createDocument('About to go.');

      await withdraw(id);

      const versions = await authenticatedTestClient(userToken).get(
        `/api/v1/documents/${id}/versions`
      );
      const [newest] = versions.body.data as {
        version: number;
        config: Record<string, unknown>;
        label: string | null;
      }[];

      expect(newest.version).toBe(2);
      expect(newest.config).toEqual({ withdrawn: true });
      expect(newest.label).toBe('withdrawn');
    });

    test('withdrawing twice is refused', async () => {
      const id = await createDocument('Only once.');
      await withdraw(id);

      const response = await withdraw(id);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('DOCUMENT_ALREADY_WITHDRAWN');
    });

    test('user without permission returns 403', async () => {
      const id = await createDocument('Guarded.');

      const response = await authenticatedTestClient(noPermToken)
        .post(`/api/v1/documents/${id}/withdraw`)
        .send({});

      expect(response.status).toBe(403);
    });

    test('unauthenticated returns 401', async () => {
      const id = await createDocument('Guarded.');

      const response = await authenticatedTestClient('')
        .post(`/api/v1/documents/${id}/withdraw`)
        .send({});

      expect(response.status).toBe(401);
    });

    test('a document that does not exist returns 404', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/doc_nope/withdraw')
        .send({});

      expect(response.status).toBe(404);
    });
  });

  describe('restoring a withdrawn document', () => {
    test('the content comes back and so does the listing', async () => {
      const id = await createDocument('Content worth keeping.');
      await withdraw(id);

      const restored = await authenticatedTestClient(userToken)
        .post(`/api/v1/documents/${id}/versions/1/restore`)
        .send({});

      expect(restored.status).toBe(200);
      expect(restored.body.status).toBe('ready');
      expect(await listIds()).toContain(id);

      const read = await authenticatedTestClient(userToken).get(
        `/api/v1/documents/${id}`
      );
      expect(read.body.content).toBe('Content worth keeping.');
    });

    test('its chunks are rebuilt, so search reaches it again', async () => {
      const id = await createDocument('Narwhal tusks are elongated teeth.');
      await withdraw(id);
      expect(await chunkCount(id)).toBe(0);

      await authenticatedTestClient(userToken)
        .post(`/api/v1/documents/${id}/versions/1/restore`)
        .send({});

      expect(await chunkCount(id)).toBeGreaterThan(0);

      const search = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({ project_id: projectId, query: 'narwhal tusks' });
      expect(JSON.stringify(search.body)).toContain(id);
    }, 60_000);

    /**
     * The tombstone holds no content, so it is not a state to go back to. The
     * refusal names the alternative rather than restoring an empty document.
     */
    test('restoring the tombstone itself is refused', async () => {
      const id = await createDocument('Has a tombstone.');
      await withdraw(id);

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/documents/${id}/versions/2/restore`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });
  });
});
