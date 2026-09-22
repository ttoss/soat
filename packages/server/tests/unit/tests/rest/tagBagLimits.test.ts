import fs from 'node:fs';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { storageDir } from '../../setupTests';
import { authenticatedTestClient } from '../../testClient';

/**
 * Every tag a resource carries reaches the IAM evaluation context of every
 * `isAllowed` call on it, and every policy condition compiled for a listing.
 * An unbounded bag is therefore an unbounded cost on the request path, so the
 * bag is bounded where it is written rather than where it is read.
 *
 * The cap counts what a caller owns. `system.*` keys are the platform's
 * provenance, refused on a caller write and not removable by one, so counting
 * them would let a conversation's four provenance keys decide whether a caller
 * may still label their own row.
 */
describe('Tag bag limits', () => {
  let userToken: string;
  let projectId: string;

  const bagOf = (keys: number): Record<string, string> => {
    return Object.fromEntries(
      Array.from({ length: keys }, (_, index) => {
        return [`key${index}`, 'value'];
      })
    );
  };

  const createDocument = async (args: {
    filename: string;
    tags?: Record<string, string>;
  }) => {
    return authenticatedTestClient(userToken)
      .post('/api/v1/documents')
      .send({
        project_id: projectId,
        content: `Content of ${args.filename}`,
        filename: args.filename,
        tags: args.tags,
      });
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'taglimits',
      policyActions: [
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

  describe('POST /api/v1/documents', () => {
    test('a bag at the key limit is stored', async () => {
      const response = await createDocument({
        filename: 'at-the-limit.txt',
        tags: bagOf(50),
      });

      expect(response.status).toBe(201);
      expect(Object.keys(response.body.tags)).toHaveLength(50);
    });

    test('a bag over the key limit is refused, naming the limit', async () => {
      const response = await createDocument({
        filename: 'over-the-limit.txt',
        tags: bagOf(51),
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.meta.limit).toBe(50);
    });

    test('a key over the key-length limit is refused', async () => {
      const response = await createDocument({
        filename: 'long-key.txt',
        tags: { [`k${'x'.repeat(128)}`]: 'value' },
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.meta.limit).toBe(128);
    });

    test('a key at the key-length limit is stored', async () => {
      const key = 'x'.repeat(128);
      const response = await createDocument({
        filename: 'key-at-limit.txt',
        tags: { [key]: 'value' },
      });

      expect(response.status).toBe(201);
      expect(response.body.tags[key]).toBe('value');
    });

    test('a value over the value-length limit is refused', async () => {
      const response = await createDocument({
        filename: 'long-value.txt',
        tags: { team: 'v'.repeat(257) },
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.meta.limit).toBe(256);
    });
  });

  describe('PUT /api/v1/documents/:document_id/tags', () => {
    test('a replacement over the key limit is refused', async () => {
      const created = await createDocument({ filename: 'replace-over.txt' });

      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/documents/${created.body.id}/tags`)
        .send(bagOf(51));

      expect(response.status).toBe(400);
      expect(response.body.error.meta.limit).toBe(50);
    });
  });

  describe('PATCH /api/v1/documents/:document_id/tags', () => {
    test('a merge that would grow the bag past the limit is refused', async () => {
      const created = await createDocument({
        filename: 'merge-over.txt',
        tags: bagOf(50),
      });
      expect(created.status).toBe(201);

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/documents/${created.body.id}/tags`)
        .send({ oneMore: 'value' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.meta.limit).toBe(50);
    });

    test('a merge that replaces a key it already holds is stored', async () => {
      const created = await createDocument({
        filename: 'merge-replace.txt',
        tags: bagOf(50),
      });

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/documents/${created.body.id}/tags`)
        .send({ key0: 'replaced' });

      expect(response.status).toBe(200);
      expect(response.body.key0).toBe('replaced');
      expect(Object.keys(response.body)).toHaveLength(50);
    });
  });
});
