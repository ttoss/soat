import fs from 'node:fs';
import path from 'node:path';

import { db } from 'src/db';
import * as pdfModule from 'src/lib/pdf';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { ONE_PAGE_PDF_BUFFER } from '../../fixtures/pdf';
import { storageDir } from '../../setupTests';
import { authenticatedTestClient } from '../../testClient';

/**
 * A document's bytes must land under the same `{project}/{category}/` layout
 * every other writer uses. Two writers had their own flat convention, which put
 * document objects outside any project prefix and left a rewrite writing to a
 * key nothing read.
 */
describe('Document storage layout', () => {
  let userToken: string;
  let projectId: string;

  const fileRowFor = async (documentId: string) => {
    const doc = await db.Document.findOne({ where: { publicId: documentId } });
    const file = await db.File.findByPk(doc!.fileId);
    return file!;
  };

  const createDocument = async (args: {
    content: string;
    path?: string;
    filename?: string;
  }) => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/documents')
      .send({ project_id: projectId, ...args });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const updateContent = async (documentId: string, content: string) => {
    const res = await authenticatedTestClient(userToken)
      .patch(`/api/v1/documents/${documentId}`)
      .send({ content });
    expect(res.status).toBe(200);
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'doclayout',
      policyActions: [
        'documents:CreateDocument',
        'documents:UpdateDocument',
        'documents:IngestDocument',
        'files:UploadFile',
      ],
    });
    userToken = setup.userToken;
    projectId = setup.projectId;
  });

  test('a created document stores its text under the project and category', async () => {
    const documentId = await createDocument({
      content: 'first',
      path: '/reports/q1.txt',
    });
    const file = await fileRowFor(documentId);

    expect(file.storagePath).toBe(
      path.join(storageDir, projectId, 'reports', `${file.publicId}.txt`)
    );
    expect(fs.readFileSync(file.storagePath, 'utf-8')).toBe('first');
  });

  test('the object is named for the bytes, not the document filename', async () => {
    // The stored object is always UTF-8 text; naming it `.pdf` after the
    // document would describe bytes that are not there.
    const documentId = await createDocument({
      content: 'plain text',
      filename: 'report.pdf',
    });
    const file = await fileRowFor(documentId);

    expect(path.extname(file.storagePath)).toBe('.txt');
  });

  test('rewriting content overwrites the object the document already has', async () => {
    const documentId = await createDocument({
      content: 'before',
      path: '/notes/n.txt',
    });
    const before = await fileRowFor(documentId);

    await updateContent(documentId, 'after');
    const after = await fileRowFor(documentId);

    expect(after.storagePath).toBe(before.storagePath);
    expect(fs.readFileSync(after.storagePath, 'utf-8')).toBe('after');
    expect(after.size).toBe(Buffer.byteLength('after', 'utf-8'));
  });

  test('no document object is written outside the project prefix', async () => {
    const documentId = await createDocument({ content: 'scoped' });
    const file = await fileRowFor(documentId);

    expect(fs.existsSync(path.join(storageDir, `${file.publicId}.txt`))).toBe(
      false
    );
  });

  describe('an ingested source file', () => {
    let extractPdfPagesSpy: jest.SpyInstance;

    beforeAll(() => {
      // unpdf uses ESM dynamic imports that don't work in Jest's CJS VM context.
      extractPdfPagesSpy = jest
        .spyOn(pdfModule, 'extractPdfPages')
        .mockResolvedValue(['Hello World']);
    });

    afterAll(() => {
      extractPdfPagesSpy.mockRestore();
    });

    test('is not overwritten when the document content is replaced', async () => {
      const upload = await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload')
        .attach('file', ONE_PAGE_PDF_BUFFER, {
          filename: 'source.pdf',
          contentType: 'application/pdf',
        })
        .field('project_id', projectId);
      expect(upload.status).toBe(201);

      const ingest = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/ingest?wait=true')
        .send({ file_id: upload.body.id, project_id: projectId });
      expect(ingest.status).toBe(201);

      const documentId = ingest.body.id as string;
      const before = await fileRowFor(documentId);

      await updateContent(documentId, 'replacement text');
      const after = await fileRowFor(documentId);

      // The upload is still the caller's, still served by the files API.
      expect(after.storagePath).toBe(before.storagePath);
      expect(fs.readFileSync(after.storagePath)).toEqual(ONE_PAGE_PDF_BUFFER);
      // ...and the replaced text is not left behind as an unreachable object.
      expect(
        fs.existsSync(path.join(storageDir, `${after.publicId}.txt`))
      ).toBe(false);
    });
  });
});
