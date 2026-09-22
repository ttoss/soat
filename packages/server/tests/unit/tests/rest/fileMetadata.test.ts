import fs from 'node:fs';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { storageDir } from '../../setupTests';
import { authenticatedTestClient } from '../../testClient';

/**
 * A file's `metadata` is a JSON object, stored as the object it was written
 * as. The types survive the round trip, which is what a filter over the fields
 * inside the bag needs and what a serialized copy of the same object cannot
 * offer: `2` and `"2"` are one string once the bag is text.
 *
 * Every surface that carries a bag is here, because the wire shape is the
 * thing under test and a multipart field is the one that can only carry text.
 */
describe('File metadata', () => {
  let userToken: string;
  let projectId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'filemeta',
      policyActions: [
        'files:UploadFile',
        'files:GetFile',
        'files:UpdateFileMetadata',
        'files:CreateFile',
      ],
    });

    userToken = setup.userToken;
    projectId = setup.projectId;
  });

  afterAll(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  const uploadWithMetadata = async (args: {
    filename: string;
    metadata: string;
  }) => {
    return authenticatedTestClient(userToken)
      .post('/api/v1/files/upload')
      .attach('file', Buffer.from('bag'), {
        filename: args.filename,
        contentType: 'text/plain',
      })
      .field('project_id', projectId)
      .field('metadata', args.metadata);
  };

  describe('POST /api/v1/files', () => {
    test('stores the bag as the object it was written as', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/files')
        .send({
          project_id: projectId,
          filename: 'created-with-bag.txt',
          metadata: {
            author: 'Alice',
            revision: 2,
            draft: false,
            reviewers: ['bob'],
            release: { channel: 'beta' },
          },
        });

      expect(response.status).toBe(201);
      expect(response.body.metadata).toEqual({
        author: 'Alice',
        revision: 2,
        draft: false,
        reviewers: ['bob'],
        release: { channel: 'beta' },
      });
    });

    test('keys are stored in the casing they were written with', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/files')
        .send({
          project_id: projectId,
          filename: 'verbatim-keys.txt',
          metadata: { cost_center: 'a', costCenter: 'b' },
        });

      expect(response.status).toBe(201);
      expect(response.body.metadata).toEqual({
        cost_center: 'a',
        costCenter: 'b',
      });
    });

    test('a bag that is not an object is refused', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/files')
        .send({
          project_id: projectId,
          filename: 'refused-bag.txt',
          metadata: '{"author":"Alice"}',
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a list is refused rather than read as an object', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/files')
        .send({
          project_id: projectId,
          filename: 'refused-list.txt',
          metadata: ['author'],
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('POST /api/v1/files/upload', () => {
    test('a multipart field carries the bag as JSON text', async () => {
      const response = await uploadWithMetadata({
        filename: 'multipart-bag.txt',
        metadata: JSON.stringify({ author: 'Alice', revision: 2 }),
      });

      expect(response.status).toBe(201);
      expect(response.body.metadata).toEqual({ author: 'Alice', revision: 2 });
    });

    test('a field that is not JSON is refused', async () => {
      const response = await uploadWithMetadata({
        filename: 'multipart-not-json.txt',
        metadata: 'author=Alice',
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a field holding JSON that is not an object is refused', async () => {
      const response = await uploadWithMetadata({
        filename: 'multipart-scalar.txt',
        metadata: '42',
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('POST /api/v1/files/upload/base64', () => {
    test('stores the bag as an object', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload/base64')
        .send({
          project_id: projectId,
          content: Buffer.from('bag').toString('base64'),
          filename: 'base64-bag.txt',
          content_type: 'text/plain',
          metadata: { source: 'base64', revision: 1 },
        });

      expect(response.status).toBe(201);
      expect(response.body.metadata).toEqual({
        source: 'base64',
        revision: 1,
      });
    });
  });

  describe('PATCH /api/v1/files/:file_id/metadata', () => {
    const createTarget = async (filename: string) => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/files')
        .send({
          project_id: projectId,
          filename,
          metadata: { author: 'Alice', revision: 1 },
        });
      return response.body.id as string;
    };

    test('replaces the stored bag', async () => {
      const fileId = await createTarget('patch-replace.txt');

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/files/${fileId}/metadata`)
        .send({ metadata: { revision: 2 } });

      expect(response.status).toBe(200);
      expect(response.body.metadata).toEqual({ revision: 2 });
    });

    test('null clears the bag', async () => {
      const fileId = await createTarget('patch-clear.txt');

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/files/${fileId}/metadata`)
        .send({ metadata: null });

      expect(response.status).toBe(200);
      expect(response.body.metadata ?? null).toBeNull();
    });

    test('a move leaves the bag alone', async () => {
      const fileId = await createTarget('patch-move.txt');

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/files/${fileId}/metadata`)
        .send({ prefix: '/reports' });

      expect(response.status).toBe(200);
      expect(response.body.path).toBe('/reports/patch-move.txt');
      expect(response.body.metadata).toEqual({ author: 'Alice', revision: 1 });
    });

    test('a bag that is not an object is refused', async () => {
      const fileId = await createTarget('patch-refused.txt');

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/files/${fileId}/metadata`)
        .send({ metadata: '{"revision":2}' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });
  });
});
