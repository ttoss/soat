import { matchesContentTypeGlob } from 'src/lib/ingestionRuleMatching';
import {
  clampKnowledgeSearchLimit,
  getUploadMaxBytes,
  MAX_EMBEDDINGS_INPUTS,
} from 'src/lib/requestBounds';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

describe('Request bounds', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let toolId: string;
  const originalUploadMax = process.env.FILE_UPLOAD_MAX_BYTES;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'bounds',
      policyActions: [
        'files:UploadFile',
        'files:CreateFile',
        'knowledge:SearchKnowledge',
        'embeddings:CreateEmbeddings',
      ],
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;

    const toolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'bounds-converter',
        type: 'http',
        execute: { url: 'https://example.test/convert', method: 'POST' },
      });
    toolId = toolRes.body.id;
  });

  afterAll(() => {
    if (originalUploadMax === undefined) {
      delete process.env.FILE_UPLOAD_MAX_BYTES;
    } else {
      process.env.FILE_UPLOAD_MAX_BYTES = originalUploadMax;
    }
  });

  describe('POST /api/v1/files/upload', () => {
    beforeEach(() => {
      process.env.FILE_UPLOAD_MAX_BYTES = '1024';
    });

    test('a file over the limit is refused rather than buffered whole', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload')
        .attach('file', Buffer.alloc(4096, 'a'), {
          filename: 'big.txt',
          contentType: 'text/plain',
        })
        .field('project_id', projectId);

      expect(response.status).toBe(413);
      expect(response.body.error.code).toBe('UPLOAD_TOO_LARGE');
    });

    test('an unauthenticated upload is refused before its body is parsed', async () => {
      const response = await testClient
        .post('/api/v1/files/upload')
        .attach('file', Buffer.alloc(4096, 'a'), {
          filename: 'big.txt',
          contentType: 'text/plain',
        })
        .field('project_id', projectId);

      expect(response.status).toBe(401);
    });

    test('an unreadable ceiling falls back to the default', () => {
      process.env.FILE_UPLOAD_MAX_BYTES = 'not-a-number';
      const fallback = getUploadMaxBytes();
      process.env.FILE_UPLOAD_MAX_BYTES = '0';
      expect(getUploadMaxBytes()).toBe(fallback);
      delete process.env.FILE_UPLOAD_MAX_BYTES;
      expect(getUploadMaxBytes()).toBe(fallback);
    });

    test('a file under the limit still uploads', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload')
        .attach('file', Buffer.from('small'), {
          filename: 'small.txt',
          contentType: 'text/plain',
        })
        .field('project_id', projectId);

      expect(response.status).toBe(201);
    });
  });

  describe('content type glob matching', () => {
    test('a glob crafted to backtrack is refused at the write', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/ingestion-rules')
        .send({
          project_id: projectId,
          content_type_glob: `application/${'*a'.repeat(12)}`,
          tool_id: toolId,
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INGESTION_RULE_VALIDATION_FAILED');
      expect(response.body.error.message).toContain('wildcards');
    });

    test('a glob crafted to backtrack still matches, and settles', () => {
      const glob = `application/${'*a'.repeat(12)}`;
      const contentType = `application/${'a'.repeat(60)}b`;

      expect(matchesContentTypeGlob({ glob, contentType })).toBe(false);
      expect(
        matchesContentTypeGlob({
          glob,
          contentType: `application/${'a'.repeat(60)}`,
        })
      ).toBe(true);
    });

    test('ordinary globs keep matching as before', () => {
      expect(
        matchesContentTypeGlob({ glob: 'image/*', contentType: 'image/png' })
      ).toBe(true);
      expect(
        matchesContentTypeGlob({ glob: '*/*', contentType: 'text/plain' })
      ).toBe(true);
      expect(
        matchesContentTypeGlob({
          glob: 'application/vnd.*+json',
          contentType: 'application/vnd.api+json',
        })
      ).toBe(true);
      expect(
        matchesContentTypeGlob({ glob: 'image/png', contentType: 'image/jpeg' })
      ).toBe(false);
      expect(
        matchesContentTypeGlob({ glob: 'image/*', contentType: 'text/png' })
      ).toBe(false);
    });
  });

  describe('knowledge search top-k', () => {
    test('a caller-supplied limit is clamped to the ceiling', () => {
      expect(clampKnowledgeSearchLimit(1_000_000)).toBe(
        clampKnowledgeSearchLimit(Number.MAX_SAFE_INTEGER)
      );
      expect(clampKnowledgeSearchLimit(5)).toBe(5);
      expect(clampKnowledgeSearchLimit(undefined)).toBeGreaterThan(0);
      expect(clampKnowledgeSearchLimit(0)).toBeGreaterThan(0);
      expect(clampKnowledgeSearchLimit(-3)).toBeGreaterThan(0);
    });

    test('an absurd limit still answers rather than scanning unbounded', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({ project_id: projectId, query: 'anything', limit: 1_000_000 });

      expect(response.status).toBe(200);
    });
  });

  describe('POST /api/v1/embeddings', () => {
    test('more inputs than the cap is refused', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/embeddings')
        .send({
          project_id: projectId,
          inputs: Array.from({ length: MAX_EMBEDDINGS_INPUTS + 1 }, () => {
            return 'x';
          }),
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.message).toContain('inputs');
    });
  });
});
