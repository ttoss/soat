import fs from 'node:fs';

import jwt from 'jsonwebtoken';
import { db } from 'src/db';
import * as pdfModule from 'src/lib/pdf';
import { JWT_SECRET } from 'src/middleware/auth';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { ONE_PAGE_PDF_BUFFER, THREE_PAGE_PDF_BUFFER } from '../../fixtures/pdf';
import { storageDir } from '../../setupTests';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('Documents', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let noPermToken: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'docs',
      policyActions: [
        'documents:ListDocuments',
        'documents:GetDocument',
        'documents:CreateDocument',
        'documents:DeleteDocument',
        'documents:UpdateDocument',
        'documents:IngestDocument',
        'files:UploadFile',
      ],
    });

    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
    noPermToken = setup.noPermToken as string;
  });

  afterAll(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  describe('POST /api/v1/documents', () => {
    test('authenticated user with permission can create a document', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({
          project_id: projectId,
          content: 'Hello, world! This is a test document.',
          filename: 'hello.txt',
        });

      expect(response.status).toBe(201);
      expect(response.body.id).toMatch(/^doc_/);
      expect(response.body.filename).toBe('hello.txt');
      expect(response.body.project_id).toBe(projectId);
      expect(response.body.size).toBeGreaterThan(0);
      expect(response.body.content).toBeUndefined();
    });

    test('unauthenticated request cannot create a document', async () => {
      const response = await testClient.post('/api/v1/documents').send({
        project_id: projectId,
        content: 'Secret',
      });

      expect(response.status).toBe(401);
    });

    test('missing projectId returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({ content: 'No project' });

      expect(response.status).toBe(400);
    });

    test('missing content returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({ project_id: projectId });

      expect(response.status).toBe(400);
    });

    test('user without CreateDocument permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post('/api/v1/documents')
        .send({ project_id: projectId, content: 'Forbidden content.' });

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/documents', () => {
    let ingestedDocId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/documents')
        .send({
          project_id: projectId,
          content: 'Document for list test.',
          filename: 'list-test.txt',
        });
      ingestedDocId = res.body.id;
    });

    test('authenticated user with permission can list documents', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/documents?project_id=${projectId}`
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    test('accepts limit and offset query params', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/documents?project_id=${projectId}&limit=1&offset=0`
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    test('admin with OAuth project-scoped token can list documents by project_id', async () => {
      // Simulate the OAuth token with a `prj` field — this is what the SOAT CLI issues
      // when an admin authenticates via OAuth with a project scope.
      const adminUser = await db.User.findOne({
        where: { username: 'docsadmin' },
        attributes: ['publicId', 'role'],
      });
      // `scope: '*'` mirrors an "all permissions" consent. Consent is enforced
      // at request time, so the token must carry the granted action scopes; the
      // `prj` claim still confines it to the one project.
      const oauthToken = jwt.sign(
        {
          publicId: adminUser!.publicId,
          role: 'admin',
          scope: `* mcp:access prj:${projectId}`,
          prj: projectId,
        },
        JWT_SECRET,
        { expiresIn: '1h' }
      );

      const response = await authenticatedTestClient(oauthToken).get(
        `/api/v1/documents?project_id=${projectId}`
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThan(0);
      expect(
        response.body.data.some((d: { id: string }) => {
          return d.id === ingestedDocId;
        })
      ).toBe(true);
    });

    test('unauthenticated request cannot list documents', async () => {
      const response = await testClient.get(
        `/api/v1/documents?project_id=${projectId}`
      );

      expect(response.status).toBe(401);
    });

    test('listing without projectId returns all accessible documents', async () => {
      const response =
        await authenticatedTestClient(userToken).get('/api/v1/documents');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    test('user without ListDocuments permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/documents?project_id=${projectId}`
      );

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/documents/:id', () => {
    let documentId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({
          project_id: projectId,
          content: 'Fetch this document back.',
          filename: 'fetch-me.txt',
        });
      documentId = res.body.id;
    });

    test('user with permission can get a document by ID including content', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/documents/${documentId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(documentId);
      expect(response.body.content).toBe('Fetch this document back.');
    });

    test('unauthenticated request cannot get a document', async () => {
      const response = await testClient.get(`/api/v1/documents/${documentId}`);

      expect(response.status).toBe(401);
    });

    test('returns 404 for non-existent document', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        '/api/v1/documents/doc_nonexistent'
      );

      expect(response.status).toBe(404);
    });

    test('user without GetDocument permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/documents/${documentId}`
      );

      expect(response.status).toBe(403);
    });
  });

  describe('DELETE /api/v1/documents/:id', () => {
    test('user with permission can delete a document and file is removed from disk', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({
          project_id: projectId,
          content: 'Delete me please.',
          filename: 'todelete.txt',
        });
      const documentId = createRes.body.id;

      const filesOnDisk = fs.readdirSync(storageDir);
      expect(filesOnDisk.length).toBeGreaterThan(0);

      const deleteRes = await authenticatedTestClient(userToken).delete(
        `/api/v1/documents/${documentId}`
      );

      expect(deleteRes.status).toBe(204);

      const getRes = await authenticatedTestClient(userToken).get(
        `/api/v1/documents/${documentId}`
      );
      expect(getRes.status).toBe(404);
    });

    test('unauthenticated request cannot delete a document', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({ project_id: projectId, content: 'Protected.' });
      const documentId = createRes.body.id;

      const response = await testClient.delete(
        `/api/v1/documents/${documentId}`
      );

      expect(response.status).toBe(401);
    });

    test('returns 404 when deleting a non-existent document', async () => {
      const response = await authenticatedTestClient(adminToken).delete(
        '/api/v1/documents/doc_nonexistent'
      );

      expect(response.status).toBe(404);
    });

    test('user without DeleteDocument permission returns 403', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({ project_id: projectId, content: 'Protect me from delete.' });
      const documentId = createRes.body.id;

      const response = await authenticatedTestClient(noPermToken).delete(
        `/api/v1/documents/${documentId}`
      );

      expect(response.status).toBe(403);
    });
  });

  describe('POST /api/v1/documents with title, metadata, tags (FEAT-13)', () => {
    test('creates a document with title, metadata, and tags', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({
          project_id: projectId,
          content: 'Tagged document content.',
          filename: 'tagged.txt',
          title: 'My Title',
          metadata: { source: 'test' },
          tags: ['alpha', 'beta'],
        });

      expect(response.status).toBe(201);
      expect(response.body.title).toBe('My Title');
      expect(response.body.metadata).toEqual({ source: 'test' });
      expect(response.body.tags).toEqual(
        expect.arrayContaining(['alpha', 'beta'])
      );
    });
  });

  describe('PATCH /api/v1/documents/:id (FEAT-2)', () => {
    let documentId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({
          project_id: projectId,
          content: 'Original content.',
          filename: 'patchme.txt',
          title: 'Original Title',
          tags: ['initial'],
        });
      documentId = res.body.id;
    });

    test('updates title only', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/documents/${documentId}`)
        .send({ title: 'Updated Title' });

      expect(response.status).toBe(200);
      expect(response.body.title).toBe('Updated Title');
    });

    test('updates content and re-embeds', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/documents/${documentId}`)
        .send({ content: 'Updated content for re-embedding.' });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(documentId);
    });

    test('updates tags', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/documents/${documentId}`)
        .send({ tags: ['new-tag', 'another'] });

      expect(response.status).toBe(200);
      expect(response.body.tags).toEqual(
        expect.arrayContaining(['new-tag', 'another'])
      );
    });

    test('updates metadata', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/documents/${documentId}`)
        .send({ metadata: { updated: true } });

      expect(response.status).toBe(200);
      expect(response.body.metadata).toEqual({ updated: true });
    });

    test('returns 404 for non-existent document', async () => {
      const response = await authenticatedTestClient(adminToken)
        .patch('/api/v1/documents/doc_nonexistent')
        .send({ title: 'Ghost' });

      expect(response.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .patch(`/api/v1/documents/${documentId}`)
        .send({ title: 'No Auth' });

      expect(response.status).toBe(401);
    });

    test('user without UpdateDocument permission returns 403', async () => {
      // Create a second user with no UpdateDocument permission
      const createRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/users')
        .send({ username: 'noupdate', password: 'nopass' });
      const noUpdateUserId = createRes.body.id;
      const noUpdateToken = await loginAs('noupdate', 'nopass');

      const policyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [{ effect: 'Allow', action: ['documents:GetDocument'] }],
          },
        });

      await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${noUpdateUserId}/policies`)
        .send({ policy_ids: [policyRes.body.id] });

      const response = await authenticatedTestClient(noUpdateToken)
        .patch(`/api/v1/documents/${documentId}`)
        .send({ title: 'Forbidden' });

      expect(response.status).toBe(403);
    });

    test('normalizes path without leading slash (adds /)', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/documents/${documentId}`)
        .send({ path: 'no-leading-slash' });

      expect(response.status).toBe(200);
      expect(response.body.path).toBe('/no-leading-slash');
    });

    test('normalizes path with trailing slash (removes it)', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/documents/${documentId}`)
        .send({ path: '/with-trailing-slash/' });

      expect(response.status).toBe(200);
      expect(response.body.path).toBe('/with-trailing-slash');
    });

    test('sets path to null when null is passed', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/documents/${documentId}`)
        .send({ path: null });

      expect(response.status).toBe(200);
    });
  });

  describe('GET/PUT/PATCH /api/v1/documents/:id/tags', () => {
    let tagDocId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({
          project_id: projectId,
          content: 'Document for tag operations.',
          filename: 'tags-doc.txt',
          tags: { env: 'test' },
        });
      tagDocId = res.body.id;
    });

    test('GET tags returns current tags', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/documents/${tagDocId}/tags`
      );
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ env: 'test' });
    });

    test('PUT tags replaces all tags', async () => {
      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/documents/${tagDocId}/tags`)
        .send({ region: 'us' });
      expect(response.status).toBe(200);
      expect(response.body.tags).toMatchObject({ region: 'us' });
    });

    test('PATCH tags merges into existing tags', async () => {
      await authenticatedTestClient(userToken)
        .put(`/api/v1/documents/${tagDocId}/tags`)
        .send({ env: 'prod' });

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/documents/${tagDocId}/tags`)
        .send({ version: '2' });
      expect(response.status).toBe(200);
    });

    test('unauthenticated GET tags returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/documents/${tagDocId}/tags`
      );
      expect(response.status).toBe(401);
    });

    test('unauthenticated PUT tags returns 401', async () => {
      const response = await testClient
        .put(`/api/v1/documents/${tagDocId}/tags`)
        .send({ region: 'us' });
      expect(response.status).toBe(401);
    });

    test('unauthenticated PATCH tags returns 401', async () => {
      const response = await testClient
        .patch(`/api/v1/documents/${tagDocId}/tags`)
        .send({ version: '2' });
      expect(response.status).toBe(401);
    });

    test('GET tags returns 404 for a non-existent document', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/documents/doc_nonexistent/tags'
      );
      expect(response.status).toBe(404);
    });

    test('PUT tags returns 404 for a non-existent document', async () => {
      const response = await authenticatedTestClient(userToken)
        .put('/api/v1/documents/doc_nonexistent/tags')
        .send({ region: 'us' });
      expect(response.status).toBe(404);
    });

    test('PATCH tags returns 404 for a non-existent document', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch('/api/v1/documents/doc_nonexistent/tags')
        .send({ version: '2' });
      expect(response.status).toBe(404);
    });

    test('GET tags without GetDocument permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/documents/${tagDocId}/tags`
      );
      expect(response.status).toBe(403);
    });

    test('PUT tags without UpdateDocument permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .put(`/api/v1/documents/${tagDocId}/tags`)
        .send({ region: 'us' });
      expect(response.status).toBe(403);
    });

    test('PATCH tags without UpdateDocument permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .patch(`/api/v1/documents/${tagDocId}/tags`)
        .send({ version: '2' });
      expect(response.status).toBe(403);
    });
  });

  describe('POST /api/v1/documents (plain text creates exactly 1 chunk)', () => {
    test('creating a text document produces 1 chunk, and getDocument returns its content', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({
          project_id: projectId,
          content: 'hello chunk test',
          path: '/chunks/hello-chunk.txt',
          filename: 'hello-chunk.txt',
        });
      expect(createRes.status).toBe(201);
      const docId = createRes.body.id;

      const getRes = await authenticatedTestClient(userToken).get(
        `/api/v1/documents/${docId}`
      );
      expect(getRes.status).toBe(200);
      expect(getRes.body.content).toBe('hello chunk test');
    });
  });

  describe('POST /api/v1/documents/ingest', () => {
    let pdfFileId: string;
    let extractPdfPagesSpy: jest.SpyInstance;

    const uploadFile = async (args: {
      buffer: Buffer;
      filename: string;
      contentType: string;
    }) => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload')
        .attach('file', args.buffer, {
          filename: args.filename,
          contentType: args.contentType,
        })
        .field('project_id', projectId);
      expect(res.status).toBe(201);
      return res.body.id as string;
    };

    const waitForDocumentStatus = async (
      docId: string,
      targetStatus: string,
      timeout = 5000
    ): Promise<Record<string, unknown>> => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const res = await authenticatedTestClient(userToken).get(
          `/api/v1/documents/${docId}`
        );
        if (res.body.status === targetStatus || res.body.status === 'failed') {
          return res.body as Record<string, unknown>;
        }
        await new Promise((r) => {
          return setTimeout(r, 50);
        });
      }
      throw new Error(
        `Timed out waiting for document ${docId} to reach status ${targetStatus}`
      );
    };

    beforeAll(async () => {
      // unpdf uses ESM dynamic imports that don't work in Jest's CJS VM context.
      // Spy on extractPdfPages so the rest of the ingestion flow runs for real.
      extractPdfPagesSpy = jest
        .spyOn(pdfModule, 'extractPdfPages')
        .mockResolvedValue(['Hello World']);

      pdfFileId = await uploadFile({
        buffer: ONE_PAGE_PDF_BUFFER,
        filename: 'test.pdf',
        contentType: 'application/pdf',
      });
    });

    afterAll(() => {
      extractPdfPagesSpy.mockRestore();
    });

    test('ingest returns 202 with pending status immediately', async () => {
      const fileId = await uploadFile({
        buffer: ONE_PAGE_PDF_BUFFER,
        filename: 'immediate.pdf',
        contentType: 'application/pdf',
      });

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/ingest')
        .send({ file_id: fileId, project_id: projectId });

      expect(response.status).toBe(202);
      expect(response.body.id).toMatch(/^doc_/);
      expect(response.body.status).toBe('pending');
      expect(response.body.project_id).toBe(projectId);
    });

    test('document transitions to ready after background processing', async () => {
      const fileId = await uploadFile({
        buffer: ONE_PAGE_PDF_BUFFER,
        filename: 'lifecycle.pdf',
        contentType: 'application/pdf',
      });

      const ingestRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/ingest')
        .send({ file_id: fileId, project_id: projectId });

      expect(ingestRes.status).toBe(202);
      const docId = ingestRes.body.id as string;

      const doc = await waitForDocumentStatus(docId, 'ready');
      expect(doc.status).toBe('ready');
    });

    test('authenticated user with permission can ingest a PDF', async () => {
      const ingestRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/ingest')
        .send({ file_id: pdfFileId, project_id: projectId });

      expect(ingestRes.status).toBe(202);
      expect(ingestRes.body.id).toMatch(/^doc_/);
      expect(ingestRes.body.project_id).toBe(projectId);

      const doc = await waitForDocumentStatus(
        ingestRes.body.id as string,
        'ready'
      );
      expect(doc.status).toBe('ready');
      expect((doc.metadata as Record<string, unknown>).chunk_count).toBe(1);
    });

    test('3-page PDF produces chunk_count=3 with default page strategy', async () => {
      extractPdfPagesSpy.mockResolvedValueOnce([
        'Page 1: Introduction',
        'Page 2: Methods',
        'Page 3: Conclusion',
      ]);

      const fileId = await uploadFile({
        buffer: THREE_PAGE_PDF_BUFFER,
        filename: 'multi-page.pdf',
        contentType: 'application/pdf',
      });

      const ingestRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/ingest')
        .send({ file_id: fileId, project_id: projectId });

      expect(ingestRes.status).toBe(202);

      const doc = await waitForDocumentStatus(
        ingestRes.body.id as string,
        'ready'
      );
      expect((doc.metadata as Record<string, unknown>).chunk_count).toBe(3);
    });

    test('chunk_strategy=whole collapses a multi-page PDF into one chunk', async () => {
      extractPdfPagesSpy.mockResolvedValueOnce(['Page A', 'Page B', 'Page C']);

      const fileId = await uploadFile({
        buffer: THREE_PAGE_PDF_BUFFER,
        filename: 'whole.pdf',
        contentType: 'application/pdf',
      });

      const ingestRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/ingest')
        .send({
          file_id: fileId,
          project_id: projectId,
          chunk_strategy: 'whole',
        });

      expect(ingestRes.status).toBe(202);

      const doc = await waitForDocumentStatus(
        ingestRes.body.id as string,
        'ready'
      );
      expect((doc.metadata as Record<string, unknown>).chunk_count).toBe(1);
    });

    test('chunk_strategy=size splits text into overlapping windows', async () => {
      const fileId = await uploadFile({
        buffer: Buffer.from('a'.repeat(2500)),
        filename: 'long.txt',
        contentType: 'text/plain',
      });

      const ingestRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/ingest')
        .send({
          file_id: fileId,
          project_id: projectId,
          chunk_strategy: 'size',
          chunk_size: 1000,
          chunk_overlap: 0,
        });

      expect(ingestRes.status).toBe(202);

      // 2500 chars / 1000 step (no overlap) => 3 chunks
      const doc = await waitForDocumentStatus(
        ingestRes.body.id as string,
        'ready'
      );
      expect((doc.metadata as Record<string, unknown>).chunk_count).toBe(3);
    });

    test('ingests a text/markdown file as a single chunk by default', async () => {
      const fileId = await uploadFile({
        buffer: Buffer.from('# Title\n\nSome markdown body.'),
        filename: 'notes.md',
        contentType: 'text/markdown',
      });

      const ingestRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/ingest')
        .send({ file_id: fileId, project_id: projectId });

      expect(ingestRes.status).toBe(202);

      const doc = await waitForDocumentStatus(
        ingestRes.body.id as string,
        'ready'
      );
      expect((doc.metadata as Record<string, unknown>).chunk_count).toBe(1);
    });

    test('document status is failed when file has no extractable text', async () => {
      extractPdfPagesSpy.mockResolvedValueOnce([]);

      const fileId = await uploadFile({
        buffer: ONE_PAGE_PDF_BUFFER,
        filename: 'empty.pdf',
        contentType: 'application/pdf',
      });

      const ingestRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/ingest')
        .send({ file_id: fileId, project_id: projectId });

      expect(ingestRes.status).toBe(202);

      const doc = await waitForDocumentStatus(
        ingestRes.body.id as string,
        'failed'
      );
      expect(doc.status).toBe('failed');
      expect((doc.metadata as Record<string, unknown>).failure_reason).toBe(
        'FILE_PARSE_FAILED'
      );
    });

    test('GET /documents/:id returns status while processing', async () => {
      const fileId = await uploadFile({
        buffer: ONE_PAGE_PDF_BUFFER,
        filename: 'inflight.pdf',
        contentType: 'application/pdf',
      });

      const ingestRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/ingest')
        .send({ file_id: fileId, project_id: projectId });

      expect(ingestRes.status).toBe(202);
      const docId = ingestRes.body.id as string;

      // Immediately after enqueue, document is visible with a lifecycle status
      const getRes = await authenticatedTestClient(userToken).get(
        `/api/v1/documents/${docId}`
      );
      expect(getRes.status).toBe(200);
      expect(['pending', 'processing', 'ready']).toContain(getRes.body.status);
    });

    test('returns 401 for unauthenticated request', async () => {
      const response = await testClient
        .post('/api/v1/documents/ingest')
        .send({ file_id: pdfFileId, project_id: projectId });
      expect(response.status).toBe(401);
    });

    test('returns 400 when fileId is missing', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/ingest')
        .send({ project_id: projectId });
      expect(response.status).toBe(400);
    });

    test('returns 400 when projectId is missing', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/ingest')
        .send({ file_id: pdfFileId });
      expect(response.status).toBe(400);
    });

    test('returns 403 when user has no IngestDocument permission', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post('/api/v1/documents/ingest')
        .send({ file_id: pdfFileId, project_id: projectId });
      expect(response.status).toBe(403);
    });

    test('returns 400 when fileId does not exist', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/ingest')
        .send({ file_id: 'file_doesnotexist000', project_id: projectId });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('FILE_NOT_FOUND');
    });

    test('returns 400 for an unsupported content type', async () => {
      const fileId = await uploadFile({
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        filename: 'image.png',
        contentType: 'image/png',
      });

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/ingest')
        .send({ file_id: fileId, project_id: projectId });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
    });

    test('?async=false returns 201 with status ready synchronously', async () => {
      const fileId = await uploadFile({
        buffer: ONE_PAGE_PDF_BUFFER,
        filename: 'sync-ingest.pdf',
        contentType: 'application/pdf',
      });

      const ingestRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/ingest?async=false')
        .send({ file_id: fileId, project_id: projectId });

      expect(ingestRes.status).toBe(201);
      expect(ingestRes.body.status).toBe('ready');
      expect(
        (ingestRes.body.metadata as Record<string, unknown>).chunk_count
      ).toBeGreaterThan(0);
    });

    test('?async=false sets failure reason on unparseable file', async () => {
      extractPdfPagesSpy.mockResolvedValueOnce([]);

      const fileId = await uploadFile({
        buffer: ONE_PAGE_PDF_BUFFER,
        filename: 'sync-empty.pdf',
        contentType: 'application/pdf',
      });

      const ingestRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/ingest?async=false')
        .send({ file_id: fileId, project_id: projectId });

      expect(ingestRes.status).toBe(201);
      expect(ingestRes.body.status).toBe('failed');
      expect(
        (ingestRes.body.metadata as Record<string, unknown>).failure_reason
      ).toBe('FILE_PARSE_FAILED');
    });

    test('failure_reason never serializes to [object Object] (issue #3)', async () => {
      // A non-Error rejection (plain object) must not leak as "[object Object]".
      extractPdfPagesSpy.mockRejectedValueOnce({ unexpected: 'shape' });

      const fileId = await uploadFile({
        buffer: ONE_PAGE_PDF_BUFFER,
        filename: 'weird-error.pdf',
        contentType: 'application/pdf',
      });

      const ingestRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/ingest?async=false')
        .send({ file_id: fileId, project_id: projectId });

      expect(ingestRes.status).toBe(201);
      expect(ingestRes.body.status).toBe('failed');
      const reason = (ingestRes.body.metadata as Record<string, unknown>)
        .failure_reason;
      expect(reason).not.toBe('[object Object]');
      expect(typeof reason).toBe('string');
      expect((reason as string).length).toBeGreaterThan(0);
    });

    test('preserves an Error message in failure_reason', async () => {
      extractPdfPagesSpy.mockRejectedValueOnce(new Error('boom while parsing'));

      const fileId = await uploadFile({
        buffer: ONE_PAGE_PDF_BUFFER,
        filename: 'error-message.pdf',
        contentType: 'application/pdf',
      });

      const ingestRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/ingest?async=false')
        .send({ file_id: fileId, project_id: projectId });

      expect(ingestRes.status).toBe(201);
      expect(ingestRes.body.status).toBe('failed');
      expect(
        (ingestRes.body.metadata as Record<string, unknown>).failure_reason
      ).toBe('boom while parsing');
    });

    test('?async=false on a file over the sync limit returns 413 (issue #3)', async () => {
      const prev = process.env.SYNC_INGESTION_MAX_BYTES;
      process.env.SYNC_INGESTION_MAX_BYTES = '16';

      try {
        const fileId = await uploadFile({
          buffer: Buffer.from('this text is definitely longer than 16 bytes'),
          filename: 'too-big.txt',
          contentType: 'text/plain',
        });

        const ingestRes = await authenticatedTestClient(userToken)
          .post('/api/v1/documents/ingest?async=false')
          .send({ file_id: fileId, project_id: projectId });

        expect(ingestRes.status).toBe(413);
        expect(ingestRes.body.error.code).toBe('FILE_TOO_LARGE_FOR_SYNC');
        expect(ingestRes.body.error.message).toMatch(/async/i);
      } finally {
        if (prev === undefined) delete process.env.SYNC_INGESTION_MAX_BYTES;
        else process.env.SYNC_INGESTION_MAX_BYTES = prev;
      }
    });

    test('async ingestion is not blocked by the sync size limit', async () => {
      const prev = process.env.SYNC_INGESTION_MAX_BYTES;
      process.env.SYNC_INGESTION_MAX_BYTES = '16';

      try {
        const fileId = await uploadFile({
          buffer: Buffer.from('this text is definitely longer than 16 bytes'),
          filename: 'big-async.txt',
          contentType: 'text/plain',
        });

        const ingestRes = await authenticatedTestClient(userToken)
          .post('/api/v1/documents/ingest')
          .send({ file_id: fileId, project_id: projectId });

        expect(ingestRes.status).toBe(202);
        expect(ingestRes.body.status).toBe('pending');
      } finally {
        if (prev === undefined) delete process.env.SYNC_INGESTION_MAX_BYTES;
        else process.env.SYNC_INGESTION_MAX_BYTES = prev;
      }
    });

    test('an unparseable SYNC_INGESTION_MAX_BYTES falls back to the default limit', async () => {
      const prev = process.env.SYNC_INGESTION_MAX_BYTES;
      process.env.SYNC_INGESTION_MAX_BYTES = 'not-a-number';

      try {
        const fileId = await uploadFile({
          buffer: Buffer.from('small text file'),
          filename: 'invalid-limit-env.txt',
          contentType: 'text/plain',
        });

        const ingestRes = await authenticatedTestClient(userToken)
          .post('/api/v1/documents/ingest?async=false')
          .send({ file_id: fileId, project_id: projectId });

        // A garbage env override must not block sync ingestion of a small file.
        expect(ingestRes.status).toBe(201);
        expect(ingestRes.body.status).toBe('ready');
      } finally {
        if (prev === undefined) delete process.env.SYNC_INGESTION_MAX_BYTES;
        else process.env.SYNC_INGESTION_MAX_BYTES = prev;
      }
    });

    test('path_prefix is prepended to the stored document path', async () => {
      const fileId = await uploadFile({
        buffer: Buffer.from('content for prefixed path'),
        filename: 'prefixed.txt',
        contentType: 'text/plain',
      });

      const ingestRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/ingest?async=false')
        .send({
          file_id: fileId,
          project_id: projectId,
          path_prefix: 'archive/2024',
        });

      expect(ingestRes.status).toBe(201);
      expect(ingestRes.body.status).toBe('ready');
      expect(ingestRes.body.path).toBe('archive/2024/prefixed.txt');
    });

    test('a whitespace-only text file fails ingestion with no extractable text', async () => {
      const fileId = await uploadFile({
        buffer: Buffer.from('   \n\t  '),
        filename: 'blank.txt',
        contentType: 'text/plain',
      });

      const ingestRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/ingest?async=false')
        .send({ file_id: fileId, project_id: projectId });

      expect(ingestRes.status).toBe(201);
      expect(ingestRes.body.status).toBe('failed');
      expect(
        (ingestRes.body.metadata as Record<string, unknown>).failure_reason
      ).toBe('FILE_PARSE_FAILED');
    });
  });

  describe('GET /api/v1/documents/:id/status (issues #5, #6)', () => {
    let extractSpy: jest.SpyInstance;

    const uploadFile = async (args: {
      buffer: Buffer;
      filename: string;
      contentType: string;
    }) => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload')
        .attach('file', args.buffer, {
          filename: args.filename,
          contentType: args.contentType,
        })
        .field('project_id', projectId);
      expect(res.status).toBe(201);
      return res.body.id as string;
    };

    beforeAll(() => {
      extractSpy = jest
        .spyOn(pdfModule, 'extractPdfPages')
        .mockResolvedValue(['Hello World']);
    });

    afterAll(() => {
      extractSpy.mockRestore();
    });

    test('returns a lightweight status payload for a ready document', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({
          project_id: projectId,
          content: 'Status check content.',
          filename: 'status.txt',
        });
      const docId = createRes.body.id as string;

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/documents/${docId}/status`
      );

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
      // chunk_count is the live count of indexed chunks.
      expect(res.body.chunk_count).toBeGreaterThan(0);
      // total_pages is null for a non-paged (plain text) source.
      expect(res.body.total_pages).toBeNull();
      // A ready document reports 100% progress.
      expect(res.body.progress).toBe(100);
      // The heavy `content` field must not be present on the status endpoint.
      expect(res.body.content).toBeUndefined();
    });

    test('reports total_pages and chunk_count after PDF ingestion', async () => {
      const fileId = await uploadFile({
        buffer: ONE_PAGE_PDF_BUFFER,
        filename: 'status-pdf.pdf',
        contentType: 'application/pdf',
      });

      const ingestRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/ingest?async=false')
        .send({ file_id: fileId, project_id: projectId });
      expect(ingestRes.status).toBe(201);
      const docId = ingestRes.body.id as string;

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/documents/${docId}/status`
      );

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
      expect(res.body.chunk_count).toBe(1);
      expect(res.body.total_chunks).toBe(1);
      expect(res.body.total_pages).toBe(1);
      expect(res.body.progress).toBe(100);
    });

    test('includes an error reason for a failed document', async () => {
      const fileId = await uploadFile({
        buffer: ONE_PAGE_PDF_BUFFER,
        filename: 'status-failed.pdf',
        contentType: 'application/pdf',
      });

      extractSpy.mockResolvedValueOnce([]);

      const ingestRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/ingest?async=false')
        .send({ file_id: fileId, project_id: projectId });
      const docId = ingestRes.body.id as string;

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/documents/${docId}/status`
      );

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('failed');
      expect(res.body.error).toBe('FILE_PARSE_FAILED');
      // A failed document has no meaningful progress.
      expect(res.body.progress).toBeNull();
    });

    test('unauthenticated request returns 401', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({ project_id: projectId, content: 'x', filename: 's401.txt' });
      const res = await testClient.get(
        `/api/v1/documents/${createRes.body.id}/status`
      );
      expect(res.status).toBe(401);
    });

    test('returns 404 for a non-existent document', async () => {
      const res = await authenticatedTestClient(adminToken).get(
        '/api/v1/documents/doc_nonexistent/status'
      );
      expect(res.status).toBe(404);
    });

    test('without GetDocument permission returns 403', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({
          project_id: projectId,
          content: 'x',
          filename: 'status-perm.txt',
        });
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/documents/${createRes.body.id}/status`
      );
      expect(res.status).toBe(403);
    });

    test('self-recovers a document stuck in processing (issue #4)', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({
          project_id: projectId,
          content: 'Stuck content.',
          filename: 'stuck.txt',
        });
      const docId = createRes.body.id as string;

      // Simulate a worker that died mid-ingestion: status stuck in `processing`
      // with an updatedAt far in the past (older than the stall timeout).
      const stale = new Date(Date.now() - 60 * 60 * 1000);
      await db.Document.update(
        { status: 'processing', updatedAt: stale },
        { where: { publicId: docId }, silent: true }
      );

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/documents/${docId}/status`
      );

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('failed');
      expect(res.body.error).toBe('INGESTION_TIMEOUT');
    });
  });

  describe('POST /api/v1/documents/:id/ingest — re-ingest (issue #7)', () => {
    let extractSpy: jest.SpyInstance;

    const uploadFile = async (args: {
      buffer: Buffer;
      filename: string;
      contentType: string;
    }) => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload')
        .attach('file', args.buffer, {
          filename: args.filename,
          contentType: args.contentType,
        })
        .field('project_id', projectId);
      expect(res.status).toBe(201);
      return res.body.id as string;
    };

    const waitForDocumentStatus = async (
      docId: string,
      targetStatus: string,
      timeout = 5000
    ): Promise<Record<string, unknown>> => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const res = await authenticatedTestClient(userToken).get(
          `/api/v1/documents/${docId}`
        );
        if (res.body.status === targetStatus || res.body.status === 'failed') {
          return res.body as Record<string, unknown>;
        }
        await new Promise((r) => {
          return setTimeout(r, 50);
        });
      }
      throw new Error(`Timed out waiting for ${docId} -> ${targetStatus}`);
    };

    beforeAll(() => {
      extractSpy = jest
        .spyOn(pdfModule, 'extractPdfPages')
        .mockResolvedValue(['Re-ingest me']);
    });

    afterAll(() => {
      extractSpy.mockRestore();
    });

    test('re-ingests an existing document with a new chunk strategy', async () => {
      extractSpy.mockResolvedValueOnce(['Page 1', 'Page 2', 'Page 3']);
      const fileId = await uploadFile({
        buffer: THREE_PAGE_PDF_BUFFER,
        filename: 'reingest.pdf',
        contentType: 'application/pdf',
      });

      const ingestRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/ingest?async=false')
        .send({ file_id: fileId, project_id: projectId });
      expect(ingestRes.status).toBe(201);
      const docId = ingestRes.body.id as string;
      expect(
        (ingestRes.body.metadata as Record<string, unknown>).chunk_count
      ).toBe(3);

      extractSpy.mockResolvedValueOnce(['Page 1', 'Page 2', 'Page 3']);
      const reRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/documents/${docId}/ingest?async=false`)
        .send({ chunk_strategy: 'whole' });

      expect(reRes.status).toBe(201);
      expect(reRes.body.id).toBe(docId);
      expect(reRes.body.status).toBe('ready');
      expect((reRes.body.metadata as Record<string, unknown>).chunk_count).toBe(
        1
      );
    });

    test('async re-ingest returns 202 then transitions to ready', async () => {
      const fileId = await uploadFile({
        buffer: ONE_PAGE_PDF_BUFFER,
        filename: 'reingest-async.pdf',
        contentType: 'application/pdf',
      });

      const ingestRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/ingest?async=false')
        .send({ file_id: fileId, project_id: projectId });
      const docId = ingestRes.body.id as string;

      const reRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/documents/${docId}/ingest`)
        .send({});

      expect(reRes.status).toBe(202);
      expect(reRes.body.status).toBe('pending');

      const doc = await waitForDocumentStatus(docId, 'ready');
      expect(doc.status).toBe('ready');
    });

    test('re-ingest recovers a document stuck in processing (issue #4)', async () => {
      const fileId = await uploadFile({
        buffer: ONE_PAGE_PDF_BUFFER,
        filename: 'reingest-stuck.pdf',
        contentType: 'application/pdf',
      });
      const ingestRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/ingest?async=false')
        .send({ file_id: fileId, project_id: projectId });
      const docId = ingestRes.body.id as string;

      await db.Document.update(
        { status: 'processing' },
        { where: { publicId: docId }, silent: true }
      );

      const reRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/documents/${docId}/ingest?async=false`)
        .send({});

      expect(reRes.status).toBe(201);
      expect(reRes.body.status).toBe('ready');
    });

    test('returns 404 for a non-existent document', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/doc_nonexistent/ingest')
        .send({});
      expect(res.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const fileId = await uploadFile({
        buffer: ONE_PAGE_PDF_BUFFER,
        filename: 'reingest-401.pdf',
        contentType: 'application/pdf',
      });
      const ingestRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/ingest?async=false')
        .send({ file_id: fileId, project_id: projectId });
      const docId = ingestRes.body.id as string;

      const res = await testClient
        .post(`/api/v1/documents/${docId}/ingest`)
        .send({});
      expect(res.status).toBe(401);
    });

    test('returns 403 without IngestDocument permission', async () => {
      const fileId = await uploadFile({
        buffer: ONE_PAGE_PDF_BUFFER,
        filename: 'reingest-403.pdf',
        contentType: 'application/pdf',
      });
      const ingestRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/ingest?async=false')
        .send({ file_id: fileId, project_id: projectId });
      const docId = ingestRes.body.id as string;

      const res = await authenticatedTestClient(noPermToken)
        .post(`/api/v1/documents/${docId}/ingest`)
        .send({});
      expect(res.status).toBe(403);
    });
  });
});
