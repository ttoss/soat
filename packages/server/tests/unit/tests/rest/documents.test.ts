import fs from 'node:fs';

import * as pdfModule from 'src/lib/pdf';

import { ONE_PAGE_PDF_BUFFER, THREE_PAGE_PDF_BUFFER } from '../../fixtures/pdf';
import { storageDir } from '../../setupTests';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('Documents', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectId: string;
  let policyId: string;
  let _noPermToken: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');

    const createUserRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'docsuser', password: 'docspass' });

    userId = createUserRes.body.id;
    userToken = await loginAs('docsuser', 'docspass');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Docs Test Project' });
    projectId = projectRes.body.id;

    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: [
                'documents:ListDocuments',
                'documents:GetDocument',
                'documents:CreateDocument',
                'documents:DeleteDocument',
                'documents:UpdateDocument',
                'documents:IngestDocument',
                'files:UploadFile',
              ],
            },
          ],
        },
      });
    policyId = policyRes.body.id;

    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userId}/policies`)
      .send({ policy_ids: [policyId] });

    const noPermRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'docsnoperm', password: 'nopassword' });
    expect(noPermRes.status).toBe(201);
    _noPermToken = await loginAs('docsnoperm', 'nopassword');
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
  });

  describe('GET /api/v1/documents', () => {
    test('authenticated user with permission can list documents', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/documents?project_id=${projectId}`
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
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
      const response = await authenticatedTestClient(_noPermToken)
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

    test('wait=true returns 201 with status ready synchronously', async () => {
      const fileId = await uploadFile({
        buffer: ONE_PAGE_PDF_BUFFER,
        filename: 'sync-ingest.pdf',
        contentType: 'application/pdf',
      });

      const ingestRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/ingest')
        .send({ file_id: fileId, project_id: projectId, wait: true });

      expect(ingestRes.status).toBe(201);
      expect(ingestRes.body.status).toBe('ready');
      expect(
        (ingestRes.body.metadata as Record<string, unknown>).chunk_count
      ).toBeGreaterThan(0);
    });

    test('wait=true sets failure reason on unparseable file', async () => {
      extractPdfPagesSpy.mockResolvedValueOnce([]);

      const fileId = await uploadFile({
        buffer: ONE_PAGE_PDF_BUFFER,
        filename: 'sync-empty.pdf',
        contentType: 'application/pdf',
      });

      const ingestRes = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/ingest')
        .send({ file_id: fileId, project_id: projectId, wait: true });

      expect(ingestRes.status).toBe(201);
      expect(ingestRes.body.status).toBe('failed');
      expect(
        (ingestRes.body.metadata as Record<string, unknown>).failure_reason
      ).toBe('FILE_PARSE_FAILED');
    });
  });
});
