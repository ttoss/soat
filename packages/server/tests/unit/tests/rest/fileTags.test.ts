import fs from 'node:fs';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { storageDir } from '../../setupTests';
import { authenticatedTestClient } from '../../testClient';

describe('FileTags', () => {
  let userToken: string;
  let projectId: string;

  const upload = async (name: string) => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/files/upload')
      .attach('file', Buffer.from(name), {
        filename: `${name}.txt`,
        contentType: 'text/plain',
      })
      .field('project_id', projectId);
    return res.body.id as string;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'filetags',
      policyActions: [
        'files:UploadFile',
        'files:GetFile',
        'files:UpdateFileMetadata',
      ],
      createNoPermUser: false,
    });
    userToken = setup.userToken;
    projectId = setup.projectId;
  });

  afterAll(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  describe('tag body validation', () => {
    let fileId: string;

    beforeAll(async () => {
      fileId = await upload('tag-validation');
    });

    test('PUT tags rejects a non-string tag value', async () => {
      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/files/${fileId}/tags`)
        .send({ team: null });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('PATCH tags rejects an array body', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/files/${fileId}/tags`)
        .send(['a']);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('GET /api/v1/files with tag filter', () => {
    let taggedId: string;
    let otherId: string;

    beforeAll(async () => {
      taggedId = await upload('tagged-list');
      await authenticatedTestClient(userToken)
        .put(`/api/v1/files/${taggedId}/tags`)
        .send({ kind: 'invoice' });

      otherId = await upload('other-list');
      await authenticatedTestClient(userToken)
        .put(`/api/v1/files/${otherId}/tags`)
        .send({ kind: 'receipt' });
    });

    test('a key:value pair returns only files carrying it', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/files')
        .query({ project_id: projectId, tags: 'kind:invoice' });

      expect(response.status).toBe(200);
      const ids = response.body.data.map((f: { id: string }) => {
        return f.id;
      });
      expect(ids).toContain(taggedId);
      expect(ids).not.toContain(otherId);
    });

    test('the filter also applies without project_id', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/files')
        .query({ tags: 'kind:receipt' });

      expect(response.status).toBe(200);
      const ids = response.body.data.map((f: { id: string }) => {
        return f.id;
      });
      expect(ids).toContain(otherId);
      expect(ids).not.toContain(taggedId);
    });

    test('a pair without a colon is rejected', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/files')
        .query({ project_id: projectId, tags: 'invoice' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });
  });
});
