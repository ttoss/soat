import { db } from 'src/db';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A path names one file per project (`files_project_id_path_unique`). Every
 * document write that files or moves a document answers a taken path with the
 * same `409` the files API does, and a refused `PATCH` leaves the document as
 * it was.
 */
describe('Document path conflicts', () => {
  let userToken: string;
  let projectId: string;
  let seq = 0;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'docpath',
      policyActions: ['documents:*', 'files:*'],
    });
    userToken = setup.userToken;
    projectId = setup.projectId;
  }, 60_000);

  const client = () => {
    return authenticatedTestClient(userToken);
  };

  const createAt = async (path: string, content = 'Holder.') => {
    const res = await client()
      .post('/api/v1/documents')
      .send({ project_id: projectId, content, path });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const takenPath = () => {
    seq += 1;
    return `/clash-${seq}/taken.txt`;
  };

  test('POST /api/v1/documents at a taken path is 409', async () => {
    const path = takenPath();
    await createAt(path);

    const res = await client()
      .post('/api/v1/documents')
      .send({ project_id: projectId, content: 'Second.', path });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NAME_CONFLICT');
  });

  test('POST /api/v1/documents/ingest into a taken path is 409', async () => {
    const path = takenPath();
    await createAt(path);

    const upload = await client()
      .post('/api/v1/files/upload')
      .attach('file', Buffer.from('Ingested text.'), {
        filename: 'taken.txt',
        contentType: 'text/plain',
      })
      .field('project_id', projectId);
    expect(upload.status).toBe(201);

    const res = await client()
      .post('/api/v1/documents/ingest?wait=true')
      .send({
        file_id: upload.body.id,
        project_id: projectId,
        path_prefix: path.replace('/taken.txt', ''),
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NAME_CONFLICT');
  });

  describe('PATCH /api/v1/documents/:document_id onto a taken path', () => {
    test('is 409 and leaves content, chunks and version as they were', async () => {
      const path = takenPath();
      await createAt(path);
      const id = await createAt(takenPath(), 'Original.');
      const before = await client().get(`/api/v1/documents/${id}`);

      const res = await client()
        .patch(`/api/v1/documents/${id}`)
        .send({ content: 'Replaced.', path });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('NAME_CONFLICT');

      const after = await client().get(`/api/v1/documents/${id}`);
      expect(after.body).toEqual(before.body);

      const doc = await db.Document.findOne({ where: { publicId: id } });
      const chunks = await db.DocumentChunk.findAll({
        where: { documentId: doc!.id as number },
      });
      expect(
        chunks.map((chunk) => {
          return chunk.content;
        })
      ).toEqual(['Original.']);
    });

    test('its own current path is not a conflict', async () => {
      const path = takenPath();
      const id = await createAt(path);

      const res = await client()
        .patch(`/api/v1/documents/${id}`)
        .send({ content: 'Same place.', path });

      expect(res.status).toBe(200);
      expect(res.body.path).toBe(path);
    });
  });
});
