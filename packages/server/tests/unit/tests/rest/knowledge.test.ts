import fs from 'node:fs';

import { storageDir } from '../../setupTests';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('Knowledge', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectId: string;
  let policyId: string;
  let noPermToken: string;
  let memoryId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');

    const createUserRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'knowledgeuser', password: 'knowledgepass' });
    userId = createUserRes.body.id;
    userToken = await loginAs('knowledgeuser', 'knowledgepass');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Knowledge Test Project' });
    projectId = projectRes.body.id;

    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: ['documents:CreateDocument', 'knowledge:SearchKnowledge'],
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
      .send({ username: 'knowledgenoperm', password: 'nopassword' });
    expect(noPermRes.status).toBe(201);
    noPermToken = await loginAs('knowledgenoperm', 'nopassword');

    // Create a document for search tests
    await authenticatedTestClient(userToken).post('/api/v1/documents').send({
      project_id: projectId,
      content: 'The quick brown fox jumps over the lazy dog.',
      filename: 'sample.txt',
      path: '/docs/sample.txt',
    });

    // Create a memory with an entry for memory search tests (admin has full permissions)
    const memoryRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/memories')
      .send({
        project_id: projectId,
        name: 'Knowledge Test Memory',
        tags: ['knowledge-test'],
      });
    memoryId = memoryRes.body.id;
    await authenticatedTestClient(adminToken)
      .post('/api/v1/memory-entries')
      .send({
        memory_id: memoryId,
        content: 'The sky is blue on a clear day.',
      });
  });

  afterAll(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  describe('POST /api/v1/knowledge/search', () => {
    test('unauthenticated request returns 401', async () => {
      const response = await testClient.post('/api/v1/knowledge/search').send({
        project_id: projectId,
        document_paths: ['/docs/'],
      });
      expect(response.status).toBe(401);
    });

    test('returns 400 when no query, paths, or documentIds provided', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({ project_id: projectId });
      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('returns results with source_type document when searching by path', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          document_paths: ['/docs/'],
        });
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.results)).toBe(true);
      expect(response.body.results.length).toBeGreaterThan(0);
      const result = response.body.results[0];
      expect(result.source_type).toBe('document');
      expect(result.document_id).toMatch(/^doc_/);
      expect(result.chunk_id).toMatch(/^dchunk_/);
      expect(result.project_id).toBe(projectId);
    });

    test('matches a document stored via a path lacking a leading slash', async () => {
      // Regression (F-10): documents whose path was persisted without a
      // leading slash (e.g. ingested with a slash-less pathPrefix) must still
      // be reachable by a leading-slash prefix. createDocument now normalizes
      // the stored path, so `no-slash/nested.txt` is keyed as
      // `/no-slash/nested.txt` and matches `document_paths: ['/no-slash/']`.
      await authenticatedTestClient(userToken).post('/api/v1/documents').send({
        project_id: projectId,
        content: 'A slash-less playbook document.',
        filename: 'nested.txt',
        path: 'no-slash/nested.txt',
      });

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          document_paths: ['/no-slash/'],
        });
      expect(response.status).toBe(200);
      const match = response.body.results.find((r: { path?: string }) => {
        return r.path === '/no-slash/nested.txt';
      });
      expect(match).toBeDefined();
      expect(match.source_type).toBe('document');
    });

    test('matches when the prefix filter itself omits the leading slash', async () => {
      // Regression (F-10): a prefix supplied without a leading slash
      // (`docs/`) is normalized on the query side so it still matches the
      // leading-slash-normalized stored path `/docs/sample.txt`.
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          document_paths: ['docs/'],
        });
      expect(response.status).toBe(200);
      const match = response.body.results.find((r: { path?: string }) => {
        return r.path === '/docs/sample.txt';
      });
      expect(match).toBeDefined();
    });

    test('matches a deeply nested path by an intermediate folder prefix', async () => {
      // Regression (F-10): a 3-level path must be reachable both by a shallow
      // folder prefix and by its exact full path.
      await authenticatedTestClient(userToken).post('/api/v1/documents').send({
        project_id: projectId,
        content: 'Deep diagnosis contract playbook.',
        filename: 'deep-diagnosis.md',
        path: '/playbooks/data-analyst/deep-diagnosis.md',
      });

      const shallow = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({ project_id: projectId, document_paths: ['/playbooks/'] });
      expect(shallow.status).toBe(200);
      expect(
        shallow.body.results.some((r: { path?: string }) => {
          return r.path === '/playbooks/data-analyst/deep-diagnosis.md';
        })
      ).toBe(true);

      const exact = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          document_paths: ['/playbooks/data-analyst/deep-diagnosis.md'],
        });
      expect(exact.status).toBe(200);
      expect(
        exact.body.results.some((r: { path?: string }) => {
          return r.path === '/playbooks/data-analyst/deep-diagnosis.md';
        })
      ).toBe(true);
    });

    test('returns 403 when user has no permission', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          document_paths: ['/docs/'],
        });
      expect(response.status).toBe(403);
    });

    test('returns results array in response body', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({ project_id: projectId, document_paths: ['/'] });
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('results');
      expect(Array.isArray(response.body.results)).toBe(true);
    });

    test('searches without an explicit project_id', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({ document_paths: ['/'] });
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.results)).toBe(true);
    });

    test('returns memory entries when searching by memory_ids', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          memory_ids: [memoryId],
        });
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.results)).toBe(true);
      const memResult = response.body.results.find(
        (r: { source_type: string }) => {
          return r.source_type === 'memory';
        }
      );
      expect(memResult).toBeDefined();
      expect(memResult.entry_id).toBeDefined();
      expect(memResult.memory_id).toBe(memoryId);
      expect(memResult.memory_name).toBe('Knowledge Test Memory');
      expect(memResult.content).toBe('The sky is blue on a clear day.');
    });

    test('returns memory entries when searching by memory_tags', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          memory_tags: ['knowledge-test'],
        });
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.results)).toBe(true);
      const memResult = response.body.results.find(
        (r: { source_type: string }) => {
          return r.source_type === 'memory';
        }
      );
      expect(memResult).toBeDefined();
      expect(memResult.source_type).toBe('memory');
    });

    test('returns memory entries when searching by memory_tags without a project_id (admin, cross-project)', async () => {
      // An admin JWT with no project_id resolves projectIds to `undefined`
      // (see createJwtResolveProjectIds), which exercises the
      // unscoped/cross-project branch of resolveMemoryIdsByGlobTags and
      // buildMemoryIncludeWhere in src/lib/knowledgeMemory.ts — every other
      // test in this file passes an explicit project_id.
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/knowledge/search')
        .send({
          memory_tags: ['knowledge-test'],
        });
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.results)).toBe(true);
      const memResult = response.body.results.find(
        (r: { source_type: string }) => {
          return r.source_type === 'memory';
        }
      );
      expect(memResult).toBeDefined();
      expect(memResult.memory_id).toBe(memoryId);
    });

    test('returns mixed results when searching with query, document_filters, and memory_ids', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          query: 'sky',
          document_paths: ['/docs/'],
          memory_ids: [memoryId],
        });
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.results)).toBe(true);
    });

    test('a document semantic search populates a numeric similarity_score', async () => {
      // Contract guard for the reported "score is null" symptom: a query-based
      // document search must return a numeric relevance score (the field was
      // renamed score -> similarity_score in a prior release). The embedding
      // stub returns a constant vector, so distance is 0 and the score is 1.
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          query: 'fox',
        });
      expect(response.status).toBe(200);
      const docResult = response.body.results.find(
        (r: { source_type: string }) => {
          return r.source_type === 'document';
        }
      );
      expect(docResult).toBeDefined();
      expect(typeof docResult.similarity_score).toBe('number');
      expect(Number.isFinite(docResult.similarity_score)).toBe(true);
      expect(docResult.similarity_score).toBeGreaterThan(0);
    });

    test('min_score keeps a document whose true score clears the threshold', async () => {
      // The constant-vector stub gives a correct document score of 1, so a
      // min_score of 0.5 must keep the result. Under the sub-query bug the
      // score collapsed to the fallback 0, which is below 0.5 and would be
      // filtered out — so this pins the score to its true value (1), not merely
      // "non-null". A threshold between the buggy 0 and the correct 1 is what
      // makes this a genuine red/green regression test.
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          query: 'fox',
          min_score: 0.5,
        });
      expect(response.status).toBe(200);
      const docResult = response.body.results.find(
        (r: { source_type: string }) => {
          return r.source_type === 'document';
        }
      );
      expect(docResult).toBeDefined();
      expect(docResult.similarity_score).toBeGreaterThanOrEqual(0.5);
    });

    test('an admin-owned, policy-less project API key gets the admin wildcard policy', async () => {
      const keyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/api-keys')
        .send({ name: 'Admin Wildcard Key', project_id: projectId });
      expect(keyRes.status).toBe(201);
      const rawKey = keyRes.body.key as string;

      const response = await authenticatedTestClient(rawKey)
        .post('/api/v1/knowledge/search')
        .send({ project_id: projectId, document_paths: ['/docs/'] });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.results)).toBe(true);
    });

    test('applies min_score to a semantic memory search', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          query: 'sky',
          memory_ids: [memoryId],
          min_score: -1,
        });
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.results)).toBe(true);
      const memResult = response.body.results.find(
        (r: { source_type: string }) => {
          return r.source_type === 'memory';
        }
      );
      expect(memResult).toBeDefined();
    });

    test('returns empty array when memory_ids has no matching entries', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          memory_ids: ['mem_doesnotexist000'],
        });
      expect(response.status).toBe(200);
      expect(response.body.results).toEqual([]);
    });
  });
});
