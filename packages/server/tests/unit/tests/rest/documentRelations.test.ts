import fs from 'node:fs';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { storageDir } from '../../setupTests';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * A relation is an assertion one document makes about another: this report is
 * derived from that one, supersedes it, or cites it. The kinds are declared
 * rather than free text, because a reader that has to interpret
 * `"derived-from"` and `"derivedFrom"` as the same edge is a reader that will
 * eventually get it wrong.
 *
 * An edge is directed and asserted by the document it leaves: `relations` on a
 * read carries what this document claims, and `?related_to=` finds a
 * document's neighbours on either side.
 */
describe('Document relations', () => {
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let otherProjectId: string;

  const createDocument = async (args: {
    filename: string;
    projectPublicId?: string;
  }) => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/documents')
      .send({
        project_id: args.projectPublicId ?? projectId,
        content: `Content of ${args.filename}`,
        filename: args.filename,
      });
    return res.body.id as string;
  };

  const relate = async (args: {
    from: string;
    type: string;
    to: string;
    token?: string;
  }) => {
    return authenticatedTestClient(args.token ?? userToken)
      .post(`/api/v1/documents/${args.from}/relations`)
      .send({ type: args.type, to_document_id: args.to });
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'docrel',
      policyActions: [
        'documents:CreateDocument',
        'documents:GetDocument',
        'documents:ListDocuments',
        'documents:UpdateDocument',
      ],
      createOtherProject: true,
    });
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId as string;
  });

  afterAll(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  describe('POST /api/v1/documents/:document_id/relations', () => {
    test('asserts a typed edge between two documents', async () => {
      const from = await createDocument({ filename: 'derived.txt' });
      const to = await createDocument({ filename: 'source.txt' });

      const response = await relate({ from, type: 'derived_from', to });

      expect(response.status).toBe(201);
      expect(response.body.id).toEqual(expect.stringMatching(/^doc_rel_/));
      expect(response.body.type).toBe('derived_from');
      expect(response.body.from_document_id).toBe(from);
      expect(response.body.to_document_id).toBe(to);
      expect(response.body.created_at).toBeDefined();
    });

    test('an undeclared type is refused', async () => {
      const from = await createDocument({ filename: 'bad-type-from.txt' });
      const to = await createDocument({ filename: 'bad-type-to.txt' });

      const response = await relate({ from, type: 'inspired_by', to });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a document cannot relate to itself', async () => {
      const document = await createDocument({ filename: 'self.txt' });

      const response = await relate({
        from: document,
        type: 'cites',
        to: document,
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('the same edge twice is a conflict, not a second row', async () => {
      const from = await createDocument({ filename: 'dup-from.txt' });
      const to = await createDocument({ filename: 'dup-to.txt' });
      await relate({ from, type: 'cites', to });

      const response = await relate({ from, type: 'cites', to });

      expect(response.status).toBe(409);
    });

    test('an edge may not leave the project', async () => {
      const from = await createDocument({ filename: 'cross-from.txt' });
      const to = await createDocument({
        filename: 'cross-to.txt',
        projectPublicId: otherProjectId,
      });

      const response = await relate({ from, type: 'cites', to });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('an unknown target is not found', async () => {
      const from = await createDocument({ filename: 'unknown-target.txt' });

      const response = await relate({
        from,
        type: 'cites',
        to: 'doc_doesnotexist',
      });

      expect(response.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const from = await createDocument({ filename: 'unauth.txt' });
      const to = await createDocument({ filename: 'unauth-to.txt' });

      const response = await testClient
        .post(`/api/v1/documents/${from}/relations`)
        .send({ type: 'cites', to_document_id: to });

      expect(response.status).toBe(401);
    });

    test('a caller without update permission returns 403', async () => {
      const from = await createDocument({ filename: 'forbidden.txt' });
      const to = await createDocument({ filename: 'forbidden-to.txt' });

      const response = await relate({
        from,
        type: 'cites',
        to,
        token: noPermToken,
      });

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/documents/:document_id/relations', () => {
    test('lists what the document asserts', async () => {
      const from = await createDocument({ filename: 'lists-from.txt' });
      const to = await createDocument({ filename: 'lists-to.txt' });
      await relate({ from, type: 'supersedes', to });

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/documents/${from}/relations`
      );

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].type).toBe('supersedes');
      expect(response.body.data[0].to_document_id).toBe(to);
    });

    test('unauthenticated request returns 401', async () => {
      const document = await createDocument({ filename: 'list-unauth.txt' });

      const response = await testClient.get(
        `/api/v1/documents/${document}/relations`
      );

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/v1/documents/:document_id', () => {
    test('a read carries the edges the document asserts', async () => {
      const from = await createDocument({ filename: 'read-from.txt' });
      const to = await createDocument({ filename: 'read-to.txt' });
      await relate({ from, type: 'derived_from', to });

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/documents/${from}`
      );

      expect(response.status).toBe(200);
      expect(response.body.relations).toHaveLength(1);
      expect(response.body.relations[0]).toEqual(
        expect.objectContaining({ type: 'derived_from', to_document_id: to })
      );
    });

    test('a document with no edges carries an empty list', async () => {
      const document = await createDocument({ filename: 'no-edges.txt' });

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/documents/${document}`
      );

      expect(response.status).toBe(200);
      expect(response.body.relations).toEqual([]);
    });
  });

  describe('GET /api/v1/documents?related_to=', () => {
    test('finds a neighbour on either side of the edge', async () => {
      const from = await createDocument({ filename: 'neighbour-from.txt' });
      const to = await createDocument({ filename: 'neighbour-to.txt' });
      await relate({ from, type: 'cites', to });

      const forward = await authenticatedTestClient(userToken)
        .get('/api/v1/documents')
        .query({ project_id: projectId, related_to: to });
      const backward = await authenticatedTestClient(userToken)
        .get('/api/v1/documents')
        .query({ project_id: projectId, related_to: from });

      expect(forward.status).toBe(200);
      expect(
        forward.body.data.map((document: { id: string }) => {
          return document.id;
        })
      ).toEqual([from]);
      expect(
        backward.body.data.map((document: { id: string }) => {
          return document.id;
        })
      ).toEqual([to]);
    });

    test('a document with no neighbours narrows to nothing', async () => {
      const document = await createDocument({ filename: 'lonely.txt' });

      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/documents')
        .query({ project_id: projectId, related_to: document });

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
    });
  });

  describe('DELETE /api/v1/documents/:document_id/relations/:relation_id', () => {
    test('retracts the edge, leaving both documents', async () => {
      const from = await createDocument({ filename: 'retract-from.txt' });
      const to = await createDocument({ filename: 'retract-to.txt' });
      const created = await relate({ from, type: 'cites', to });

      const response = await authenticatedTestClient(userToken).delete(
        `/api/v1/documents/${from}/relations/${created.body.id}`
      );

      expect(response.status).toBe(204);

      const read = await authenticatedTestClient(userToken).get(
        `/api/v1/documents/${from}`
      );
      expect(read.body.relations).toEqual([]);

      const target = await authenticatedTestClient(userToken).get(
        `/api/v1/documents/${to}`
      );
      expect(target.status).toBe(200);
    });

    test('an unknown relation returns 404', async () => {
      const document = await createDocument({ filename: 'delete-unknown.txt' });

      const response = await authenticatedTestClient(userToken).delete(
        `/api/v1/documents/${document}/relations/doc_rel_missing`
      );

      expect(response.status).toBe(404);
    });

    test('a caller without update permission returns 403', async () => {
      const from = await createDocument({ filename: 'delete-forbidden.txt' });
      const to = await createDocument({ filename: 'delete-forbidden-to.txt' });
      const created = await relate({ from, type: 'cites', to });

      const response = await authenticatedTestClient(noPermToken).delete(
        `/api/v1/documents/${from}/relations/${created.body.id}`
      );

      expect(response.status).toBe(403);
    });
  });
});
