import fs from 'node:fs';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { storageDir } from '../../setupTests';
import { authenticatedTestClient } from '../../testClient';

describe('DocumentTags', () => {
  let userToken: string;
  let projectId: string;

  const createDocument = async (args: {
    filename: string;
    tags?: Record<string, string>;
  }) => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/documents')
      .send({
        project_id: projectId,
        content: `Content of ${args.filename}`,
        filename: args.filename,
        tags: args.tags,
      });
    return res.body.id as string;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'doctags',
      policyActions: [
        'documents:ListDocuments',
        'documents:GetDocument',
        'documents:CreateDocument',
        'documents:UpdateDocument',
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
    let docId: string;

    beforeAll(async () => {
      docId = await createDocument({ filename: 'tag-validation.txt' });
    });

    test('PUT tags rejects a non-string tag value', async () => {
      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/documents/${docId}/tags`)
        .send({ team: { nested: true } });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('PATCH tags rejects an array body', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/documents/${docId}/tags`)
        .send(['a']);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('POST /documents rejects a non-string tag value', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({
          project_id: projectId,
          content: 'Never stored.',
          filename: 'bad-tags.txt',
          tags: { env: 1 },
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('GET /api/v1/documents with tag filter', () => {
    let taggedId: string;
    let otherId: string;

    beforeAll(async () => {
      taggedId = await createDocument({
        filename: 'tagged-list.txt',
        tags: { domain: 'legal', lang: 'en' },
      });
      otherId = await createDocument({
        filename: 'other-list.txt',
        tags: { domain: 'sales', lang: 'en' },
      });
    });

    test('a key:value pair returns only documents carrying it', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/documents')
        .query({ project_id: projectId, tags: 'domain:legal' });

      expect(response.status).toBe(200);
      const ids = response.body.data.map((d: { id: string }) => {
        return d.id;
      });
      expect(ids).toContain(taggedId);
      expect(ids).not.toContain(otherId);
    });

    test('several pairs are ANDed', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/documents')
        .query({ project_id: projectId, tags: ['lang:en', 'domain:sales'] });

      expect(response.status).toBe(200);
      const ids = response.body.data.map((d: { id: string }) => {
        return d.id;
      });
      expect(ids).toEqual([otherId]);
    });

    test('a pair without a colon is rejected', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/documents')
        .query({ project_id: projectId, tags: 'legal' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });
  });
});
