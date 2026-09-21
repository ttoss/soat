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

describe('Document versions', () => {
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let seq = 0;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'docversions',
      policyActions: DOCUMENT_ACTIONS,
    });

    userToken = setup.userToken;
    projectId = setup.projectId;
    noPermToken = setup.noPermToken as string;
  }, 60_000);

  const createDocument = async (args: {
    content: string;
    title?: string;
    metadata?: Record<string, unknown>;
  }) => {
    seq += 1;
    const created = await authenticatedTestClient(userToken)
      .post('/api/v1/documents')
      .send({
        project_id: projectId,
        content: args.content,
        filename: `versioned-${seq}.txt`,
        path: `/versioned/${seq}.txt`,
        ...(args.title ? { title: args.title } : {}),
        ...(args.metadata ? { metadata: args.metadata } : {}),
      });

    expect(created.status).toBe(201);
    return created.body.id as string;
  };

  const versionsOf = async (id: string) => {
    const response = await authenticatedTestClient(userToken).get(
      `/api/v1/documents/${id}/versions`
    );
    expect(response.status).toBe(200);
    return response.body.data as { version: number; config: unknown }[];
  };

  describe('GET /api/v1/documents/:document_id/versions', () => {
    test('a created document is at version 1, archived', async () => {
      const id = await createDocument({ content: 'First state.' });

      const versions = await versionsOf(id);

      expect(versions).toHaveLength(1);
      expect(versions[0].version).toBe(1);
      expect(versions[0].config).toMatchObject({ content: 'First state.' });
    });

    test('a content write archives the state it replaced', async () => {
      const id = await createDocument({ content: 'First state.' });

      const updated = await authenticatedTestClient(userToken)
        .patch(`/api/v1/documents/${id}`)
        .send({ content: 'Second state.' });
      expect(updated.status).toBe(200);

      const versions = await versionsOf(id);
      expect(
        versions.map((version) => {
          return version.version;
        })
      ).toEqual([2, 1]);
    });

    /**
     * A version number is what a run cites to say what it read, so two numbers
     * that denote the same content would make the citation meaningless.
     */
    test('re-writing the same content archives nothing', async () => {
      const id = await createDocument({ content: 'Unchanged.' });

      await authenticatedTestClient(userToken)
        .patch(`/api/v1/documents/${id}`)
        .send({ content: 'Unchanged.' });

      expect(await versionsOf(id)).toHaveLength(1);
    });

    test('user without permission returns 403', async () => {
      const id = await createDocument({ content: 'Guarded.' });

      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/documents/${id}/versions`
      );

      expect(response.status).toBe(403);
    });

    test('unauthenticated returns 401', async () => {
      const id = await createDocument({ content: 'Guarded.' });

      const response = await authenticatedTestClient('').get(
        `/api/v1/documents/${id}/versions`
      );

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/v1/documents/:document_id/versions/:version', () => {
    test('returns the content the document held at that version', async () => {
      const id = await createDocument({
        content: 'First state.',
        metadata: { round: 1 },
      });
      await authenticatedTestClient(userToken)
        .patch(`/api/v1/documents/${id}`)
        .send({ content: 'Second state.', metadata: { round: 2 } });

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/documents/${id}/versions/1`
      );

      expect(response.status).toBe(200);
      expect(response.body.version).toBe(1);
      expect(response.body.document_id).toBe(id);
      expect(response.body.config).toMatchObject({
        content: 'First state.',
        metadata: { round: 1 },
      });
    });

    test('a version that was never archived returns 404', async () => {
      const id = await createDocument({ content: 'Only one.' });

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/documents/${id}/versions/7`
      );

      expect(response.status).toBe(404);
    });

    test('a version that is not a number returns 400', async () => {
      const id = await createDocument({ content: 'Only one.' });

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/documents/${id}/versions/latest`
      );

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('POST /api/v1/documents/:document_id/versions/:version/restore', () => {
    test('restoring appends rather than rewinding', async () => {
      const id = await createDocument({ content: 'First state.' });
      await authenticatedTestClient(userToken)
        .patch(`/api/v1/documents/${id}`)
        .send({ content: 'Second state.' });

      const restored = await authenticatedTestClient(userToken)
        .post(`/api/v1/documents/${id}/versions/1/restore`)
        .send({});

      expect(restored.status).toBe(200);
      expect(restored.body.version).toBe(3);

      const read = await authenticatedTestClient(userToken).get(
        `/api/v1/documents/${id}`
      );
      expect(read.body.content).toBe('First state.');

      // v2 still resolves, so a run that cited it still reads what it read.
      const second = await authenticatedTestClient(userToken).get(
        `/api/v1/documents/${id}/versions/2`
      );
      expect(second.body.config).toMatchObject({ content: 'Second state.' });
    });

    test('restoring the live state is a no-op', async () => {
      const id = await createDocument({ content: 'Only one.' });

      const restored = await authenticatedTestClient(userToken)
        .post(`/api/v1/documents/${id}/versions/1/restore`)
        .send({});

      expect(restored.status).toBe(200);
      expect(restored.body.version).toBe(1);
      expect(await versionsOf(id)).toHaveLength(1);
    });

    test('user without permission returns 403', async () => {
      const id = await createDocument({ content: 'Guarded.' });

      const response = await authenticatedTestClient(noPermToken)
        .post(`/api/v1/documents/${id}/versions/1/restore`)
        .send({});

      expect(response.status).toBe(403);
    });
  });
});
