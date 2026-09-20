import { db } from 'src/db';
import { SYSTEM_ROOT } from 'src/lib/filePaths';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * `/.system/` is where every module files what it writes on the caller's
 * behalf. A caller cannot write into it, and a collection read leaves it out
 * until the request asks for it by prefix — otherwise a chat turn ranks against
 * the knowledge a project deliberately uploaded.
 */
describe('the reserved system root', () => {
  let userToken: string;
  let projectId: string;

  const client = () => {
    return authenticatedTestClient(userToken);
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'sysroot',
      policyActions: [
        'documents:CreateDocument',
        'documents:GetDocument',
        'documents:ListDocuments',
        'documents:UpdateDocument',
        'files:CreateFile',
        'files:GetFile',
        'files:UploadFile',
        'conversations:CreateConversation',
        'conversations:GetConversation',
        'conversations:UpdateConversation',
        'knowledge:SearchKnowledge',
      ],
    });
    userToken = setup.userToken;
    projectId = setup.projectId;
  });

  describe('a caller cannot write into it', () => {
    test('POST /documents with a reserved path is refused', async () => {
      const res = await client()
        .post('/api/v1/documents')
        .send({
          project_id: projectId,
          content: 'x',
          path: `${SYSTEM_ROOT}/x.txt`,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('RESERVED_PATH');
    });

    test('an un-normalized spelling is refused too', async () => {
      const res = await client().post('/api/v1/documents').send({
        project_id: projectId,
        content: 'x',
        path: '/a/../.system/x.txt',
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('RESERVED_PATH');
    });

    test('POST /files with a reserved prefix is refused', async () => {
      const res = await client()
        .post('/api/v1/files')
        .send({
          project_id: projectId,
          prefix: `${SYSTEM_ROOT}/traces`,
          filename: 'mine.json',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('RESERVED_PATH');
    });

    test('a caller cannot move a document into it', async () => {
      const created = await client().post('/api/v1/documents').send({
        project_id: projectId,
        content: 'movable',
        path: '/mine/a.txt',
      });
      expect(created.status).toBe(201);

      const moved = await client()
        .patch(`/api/v1/documents/${created.body.id}`)
        .send({ path: `${SYSTEM_ROOT}/conversations/stolen.txt` });

      expect(moved.status).toBe(400);
      expect(moved.body.error.code).toBe('RESERVED_PATH');
    });
  });

  describe('a conversation message is filed under it', () => {
    let conversationId: string;
    let messageDocumentId: string;

    beforeAll(async () => {
      const conversation = await client()
        .post('/api/v1/conversations')
        .send({ project_id: projectId, name: 'sysroot conversation' });
      expect(conversation.status).toBe(201);
      conversationId = conversation.body.id;

      const message = await client()
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .send({ role: 'user', message: 'zubrowka pineapple ledger' });
      expect(message.status).toBe(201);
      messageDocumentId = message.body.document_id;
    });

    test('its key names the module, the conversation and the document', async () => {
      const doc = await db.Document.findOne({
        where: { publicId: messageDocumentId },
      });
      const file = await db.File.findByPk(doc!.fileId);

      expect(file!.path).toBe(
        `${SYSTEM_ROOT}/conversations/${conversationId}/${messageDocumentId}.txt`
      );
    });

    test('an unfiltered document list leaves it out', async () => {
      const res = await client().get(
        `/api/v1/documents?project_id=${projectId}&limit=100`
      );

      expect(res.status).toBe(200);
      expect(
        res.body.data.map((d: { id: string }) => {
          return d.id;
        })
      ).not.toContain(messageDocumentId);
    });

    test('a path_prefix naming the root returns it', async () => {
      const res = await client().get(
        `/api/v1/documents?project_id=${projectId}&path_prefix=${SYSTEM_ROOT}/conversations&limit=100`
      );

      expect(res.status).toBe(200);
      expect(
        res.body.data.map((d: { id: string }) => {
          return d.id;
        })
      ).toContain(messageDocumentId);
    });

    test('a read by id still returns it', async () => {
      const res = await client().get(`/api/v1/documents/${messageDocumentId}`);

      expect(res.status).toBe(200);
      expect(res.body.content).toBe('zubrowka pineapple ledger');
    });

    test('a bare knowledge query does not rank it', async () => {
      const res = await client()
        .post('/api/v1/knowledge/search')
        .send({ project_id: projectId, query: 'zubrowka pineapple ledger' });

      expect(res.status).toBe(200);
      expect(
        res.body.results.map((r: { document_id?: string }) => {
          return r.document_id;
        })
      ).not.toContain(messageDocumentId);
    });

    test('a knowledge query naming the root does rank it', async () => {
      const res = await client()
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          query: 'zubrowka pineapple ledger',
          document_paths: [`${SYSTEM_ROOT}/conversations/`],
        });

      expect(res.status).toBe(200);
      expect(
        res.body.results.map((r: { document_id?: string }) => {
          return r.document_id;
        })
      ).toContain(messageDocumentId);
    });

    test('its tags are the runtime’s, not the caller’s', async () => {
      const res = await client()
        .put(`/api/v1/documents/${messageDocumentId}/tags`)
        .send({ mine: 'yes' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('RESERVED_PATH');
    });
  });

  describe('a trace file is filed under it', () => {
    test('an unfiltered file list leaves trace objects out', async () => {
      const res = await client().get(
        `/api/v1/files?project_id=${projectId}&limit=100`
      );

      expect(res.status).toBe(200);
      for (const file of res.body.data as Array<{ path: string | null }>) {
        expect(file.path ?? '').not.toContain(SYSTEM_ROOT);
      }
    });
  });
});
