import fs from 'node:fs';

import { db } from 'src/db';

import { storageDir } from '../../setupTests';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('Knowledge', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectId: string;
  let policyId: string;
  let noPermToken: string;
  let memoryStoreId: string;

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

    // Create a memory store with an entry for memory store search tests (admin has full permissions)
    const memoryStoreRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/memory-stores')
      .send({
        project_id: projectId,
        name: 'Knowledge Test MemoryStore',
        tags: { scope: 'knowledge-test' },
      });
    memoryStoreId = memoryStoreRes.body.id;
    await authenticatedTestClient(adminToken).post('/api/v1/memories').send({
      memory_store_id: memoryStoreId,
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
      // Documents persisted without a leading slash must still be reachable by
      // a leading-slash prefix, which the stored path is now normalized to.
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

    test('matches a path prefix when combined with a semantic query', async () => {
      // Regression: `document_paths` must compose with `query`. The semantic
      // path (`findChunksWithSearch`) applies a `limit` + vector `order`, which
      // must not drop the path filter — a query + prefix combination has to
      // still return the path-matched document.
      await authenticatedTestClient(userToken).post('/api/v1/documents').send({
        project_id: projectId,
        content: 'Deep diagnosis contract playbook, combined query variant.',
        filename: 'deep-diagnosis-combined.md',
        path: '/playbooks-combined/data-analyst/deep-diagnosis.md',
      });

      const shallow = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          query: 'deep diagnosis contract',
          document_paths: ['/playbooks-combined/'],
        });
      expect(shallow.status).toBe(200);
      expect(
        shallow.body.results.some((r: { path?: string }) => {
          return (
            r.path === '/playbooks-combined/data-analyst/deep-diagnosis.md'
          );
        })
      ).toBe(true);

      const exact = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          query: 'deep diagnosis contract',
          document_paths: [
            '/playbooks-combined/data-analyst/deep-diagnosis.md',
          ],
        });
      expect(exact.status).toBe(200);
      expect(
        exact.body.results.some((r: { path?: string }) => {
          return (
            r.path === '/playbooks-combined/data-analyst/deep-diagnosis.md'
          );
        })
      ).toBe(true);
    });

    test('coerces a scalar document_paths into a single-prefix filter', async () => {
      // Defensive: a client that sends `document_paths` as a bare string
      // (rather than an array) must not crash the search with a 500. The value
      // is coerced to a one-element array and matched as a prefix.
      await authenticatedTestClient(userToken).post('/api/v1/documents').send({
        project_id: projectId,
        content: 'Scalar-path coercion probe.',
        filename: 'scalar.txt',
        path: '/scalar-probe/scalar.txt',
      });

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          // Intentionally a string, not an array — mimics a non-conforming client.
          document_paths: '/scalar-probe/',
        });
      expect(response.status).toBe(200);
      expect(
        response.body.results.some((r: { path?: string }) => {
          return r.path === '/scalar-probe/scalar.txt';
        })
      ).toBe(true);
    });

    describe('tags', () => {
      beforeAll(async () => {
        for (const doc of [
          { name: 'finance-prod', tags: { team: 'finance', env: 'prod' } },
          { name: 'finance-dev', tags: { team: 'finance', env: 'dev' } },
          { name: 'sales-prod', tags: { team: 'sales', env: 'prod' } },
          { name: 'untagged', tags: undefined },
        ]) {
          const res = await authenticatedTestClient(userToken)
            .post('/api/v1/documents')
            .send({
              project_id: projectId,
              content: `Tag probe ${doc.name}.`,
              filename: `${doc.name}.txt`,
              path: `/tag-probe/${doc.name}.txt`,
              tags: doc.tags,
            });
          expect(res.status).toBe(201);
        }
      });

      const pathsOf = (results: { path?: string }[]) => {
        return results
          .map((r) => {
            return r.path;
          })
          .filter((p) => {
            return p?.startsWith('/tag-probe/');
          })
          .sort();
      };

      test('filters documents by a single tag pair', async () => {
        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/knowledge/search')
          .send({ project_id: projectId, tags: { team: 'finance' } });
        expect(response.status).toBe(200);
        expect(pathsOf(response.body.results)).toEqual([
          '/tag-probe/finance-dev.txt',
          '/tag-probe/finance-prod.txt',
        ]);
      });

      test('ANDs multiple tag pairs', async () => {
        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/knowledge/search')
          .send({
            project_id: projectId,
            tags: { team: 'finance', env: 'prod' },
          });
        expect(response.status).toBe(200);
        expect(pathsOf(response.body.results)).toEqual([
          '/tag-probe/finance-prod.txt',
        ]);
      });

      test('matches values exactly and case-sensitively', async () => {
        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/knowledge/search')
          .send({ project_id: projectId, tags: { team: 'Finance' } });
        expect(response.status).toBe(200);
        expect(pathsOf(response.body.results)).toEqual([]);
      });

      test('intersects with document_paths and query', async () => {
        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/knowledge/search')
          .send({
            project_id: projectId,
            query: 'tag probe',
            document_paths: ['/tag-probe/'],
            tags: { env: 'prod' },
          });
        expect(response.status).toBe(200);
        expect(pathsOf(response.body.results)).toEqual([
          '/tag-probe/finance-prod.txt',
          '/tag-probe/sales-prod.txt',
        ]);
      });

      test('one tags filter matches documents and memories together', async () => {
        // The point of unifying the filter: a single `tags` bag reaches both
        // stores in one search, which no pre-unification filter could do.
        const memoryStoreRes = await authenticatedTestClient(adminToken)
          .post('/api/v1/memory-stores')
          .send({
            project_id: projectId,
            name: 'Cross-source Tag MemoryStore',
            tags: { team: 'finance', env: 'prod' },
          });
        await authenticatedTestClient(adminToken)
          .post('/api/v1/memories')
          .send({
            memory_store_id: memoryStoreRes.body.id,
            content: 'Finance closes the books on the third business day.',
          });

        const response = await authenticatedTestClient(adminToken)
          .post('/api/v1/knowledge/search')
          .send({
            project_id: projectId,
            tags: { team: 'finance', env: 'prod' },
            limit: 50,
          });

        expect(response.status).toBe(200);
        const sources = new Set(
          response.body.results.map((r: { source_type: string }) => {
            return r.source_type;
          })
        );
        expect(sources.has('document')).toBe(true);
        expect(sources.has('memory')).toBe(true);
      });

      test('returns 400 when tags is not an object of strings', async () => {
        for (const bad of [
          ['team'],
          'team=finance',
          { team: 1 },
          { team: null },
        ]) {
          const response = await authenticatedTestClient(userToken)
            .post('/api/v1/knowledge/search')
            .send({ project_id: projectId, tags: bad });
          expect(response.status).toBe(400);
        }
      });

      test('ignores an empty tags object as a filter', async () => {
        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/knowledge/search')
          .send({ project_id: projectId, tags: {} });
        expect(response.status).toBe(400);
      });
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

    test('returns memories when searching by memory_store_ids', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          memory_store_ids: [memoryStoreId],
        });
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.results)).toBe(true);
      const memResult = response.body.results.find(
        (r: { source_type: string }) => {
          return r.source_type === 'memory';
        }
      );
      expect(memResult).toBeDefined();
      expect(memResult.memory_id).toBeDefined();
      expect(memResult.memory_store_id).toBe(memoryStoreId);
      expect(memResult.memory_store_name).toBe('Knowledge Test MemoryStore');
      expect(memResult.content).toBe('The sky is blue on a clear day.');
    });

    test('returns score alongside similarity_score for both source types', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          query: 'anything',
          memory_store_ids: [memoryStoreId],
        });

      expect(response.status).toBe(200);
      const doc = response.body.results.find((r: { source_type: string }) => {
        return r.source_type === 'document';
      });
      const memoryStore = response.body.results.find(
        (r: { source_type: string }) => {
          return r.source_type === 'memory';
        }
      );

      // `score` is the fused ranking the ordering is defined against;
      // `similarity_score` stays pinned to raw cosine. Since fusion they are
      // different numbers — the fused value encodes rank position, not
      // similarity — and `min_similarity` filters the cosine one.
      expect(doc.score).toBeDefined();
      expect(doc.similarity_score).toBeDefined();
      expect(doc.score).not.toBe(doc.similarity_score);
      expect(memoryStore.score).toBeDefined();
      expect(memoryStore.similarity_score).toBeDefined();
      expect(memoryStore.score).not.toBe(memoryStore.similarity_score);
    });

    test('reports which channels ranked each result', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          query: 'anything',
          memory_store_ids: [memoryStoreId],
        });

      expect(response.status).toBe(200);
      expect(response.body.results.length).toBeGreaterThan(0);

      for (const result of response.body.results) {
        // Every result of a `query` search was ranked by at least one channel,
        // or it would not be in the list at all.
        expect(result.signals).toBeDefined();
        const ranks = Object.entries(result.signals as Record<string, number>);
        expect(ranks.length).toBeGreaterThan(0);
        for (const [channel, rank] of ranks) {
          expect(['vector', 'lexical']).toContain(channel);
          expect(Number.isInteger(rank)).toBe(true);
          expect(rank).toBeGreaterThanOrEqual(1);
        }
      }
    });

    test('omits signals from a search that carries no query', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({ project_id: projectId, memory_store_ids: [memoryStoreId] });

      expect(response.status).toBe(200);
      expect(response.body.results.length).toBeGreaterThan(0);
      for (const result of response.body.results) {
        expect(result.signals).toBeUndefined();
      }
    });

    test('results are ordered by descending score', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({ project_id: projectId, query: 'anything' });

      expect(response.status).toBe(200);
      const scores = response.body.results.map((r: { score: number }) => {
        return r.score;
      });
      expect(scores.length).toBeGreaterThan(0);
      for (const score of scores) {
        expect(typeof score).toBe('number');
      }
      expect(
        [...scores].sort((a: number, b: number) => {
          return b - a;
        })
      ).toEqual(scores);
    });

    test('omits score when no query is provided', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({ project_id: projectId, memory_store_ids: [memoryStoreId] });

      expect(response.status).toBe(200);
      expect(response.body.results.length).toBeGreaterThan(0);
      // Without a query there is no ranking signal, so neither field applies.
      expect(response.body.results[0].score).toBeUndefined();
      expect(response.body.results[0].similarity_score).toBeUndefined();
    });

    test('min_score filters on score', async () => {
      const above = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({ project_id: projectId, query: 'anything', min_score: 0 });
      expect(above.status).toBe(200);
      expect(above.body.results.length).toBeGreaterThan(0);
      for (const result of above.body.results) {
        expect(result.score).toBeGreaterThanOrEqual(0);
      }

      // A threshold above any achievable score filters everything out.
      const below = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({ project_id: projectId, query: 'anything', min_score: 1.5 });
      expect(below.status).toBe(200);
      expect(below.body.results).toHaveLength(0);
    });

    test('min_similarity and the deprecated min_score are interchangeable', async () => {
      const body = {
        project_id: projectId,
        query: 'anything',
        memory_store_ids: [memoryStoreId],
      };

      const deprecated = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({ ...body, min_score: 0.5 });
      const current = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({ ...body, min_similarity: 0.5 });

      expect(deprecated.status).toBe(200);
      expect(current.status).toBe(200);
      expect(deprecated.body.results.length).toBeGreaterThan(0);
      expect(deprecated.body.results).toEqual(current.body.results);
    });

    test('min_similarity filters on similarity_score, not on score', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          query: 'anything',
          min_similarity: 0.5,
        });

      expect(response.status).toBe(200);
      expect(response.body.results.length).toBeGreaterThan(0);
      for (const result of response.body.results) {
        expect(result.similarity_score).toBeGreaterThanOrEqual(0.5);
        // Every fused score sits far below the floor the request cleared,
        // which is exactly why the floor is not applied to it.
        expect(result.score).toBeLessThan(0.5);
      }
    });

    test('recency_half_life_days decays a memoryStore result, never a document', async () => {
      const entry = await authenticatedTestClient(adminToken)
        .post('/api/v1/memories')
        .send({
          memory_store_id: memoryStoreId,
          content: 'The harbour crane is serviced every second Tuesday.',
        });
      // No product path sets `updated_at` — the column is Sequelize-managed and
      // every model-level write stamps the current time over an explicit value
      // — so the one way to give a fixture an age is raw SQL.
      await db.sequelize.query(
        'UPDATE memories SET updated_at = :updatedAt WHERE public_id = :publicId',
        {
          replacements: {
            updatedAt: new Date(Date.now() - 60 * 86400000),
            publicId: entry.body.id,
          },
        }
      );

      const body = {
        project_id: projectId,
        query: 'anything',
        memory_store_ids: [memoryStoreId],
      };
      type Result = {
        source_type: string;
        memory_id?: string;
        chunk_id?: string;
        score: number;
      };
      const scores = (results: Result[]) => {
        return new Map(
          results.map((result) => {
            return [result.memory_id ?? result.chunk_id, result.score];
          })
        );
      };

      const plain = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send(body);
      const blended = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({ ...body, recency_half_life_days: 30 });

      expect(plain.status).toBe(200);
      expect(blended.status).toBe(200);

      const before = scores(plain.body.results);
      const after = scores(blended.body.results);

      // Two half-lives: the aged fact keeps a quarter of its fused score.
      expect(after.get(entry.body.id)).toBeCloseTo(
        before.get(entry.body.id)! * 0.25,
        7
      );
      for (const result of plain.body.results as Result[]) {
        if (result.source_type !== 'document') continue;
        expect(after.get(result.chunk_id)).toBe(before.get(result.chunk_id));
      }
    });

    test('recency_half_life_days of 0 leaves the ranking exactly as it was', async () => {
      const body = {
        project_id: projectId,
        query: 'anything',
        memory_store_ids: [memoryStoreId],
      };

      const omitted = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send(body);
      const disabled = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({ ...body, recency_half_life_days: 0 });

      expect(disabled.status).toBe(200);
      expect(disabled.body.results).toEqual(omitted.body.results);
    });

    test('rrf_k changes the fused magnitudes, not the result set', async () => {
      const body = {
        project_id: projectId,
        query: 'anything',
        memory_store_ids: [memoryStoreId],
      };

      const tight = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({ ...body, rrf_k: 1 });
      const loose = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({ ...body, rrf_k: 60 });

      expect(tight.status).toBe(200);
      expect(loose.status).toBe(200);
      expect(tight.body.results[0].score).toBeGreaterThan(
        loose.body.results[0].score
      );
      expect(
        tight.body.results.map((r: { chunk_id?: string }) => {
          return r.chunk_id;
        })
      ).toEqual(
        loose.body.results.map((r: { chunk_id?: string }) => {
          return r.chunk_id;
        })
      );
    });

    test('excludes invalidated memories', async () => {
      // A memory store of its own, so invalidating an entry cannot affect any other
      // test in this file.
      const memRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/memory-stores')
        .send({
          project_id: projectId,
          name: 'Invalidation Search MemoryStore',
        });
      const isolatedMemoryStoreId = memRes.body.id;

      const entryRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/memories')
        .send({
          memory_store_id: isolatedMemoryStoreId,
          content: 'This fact was later retired.',
        });
      expect(entryRes.status).toBe(201);

      const memoryStoreResults = (body: {
        results: Array<{ source_type: string }>;
      }) => {
        return body.results.filter((r) => {
          return r.source_type === 'memory';
        });
      };

      const before = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          memory_store_ids: [isolatedMemoryStoreId],
        });
      expect(before.status).toBe(200);
      expect(memoryStoreResults(before.body)).toHaveLength(1);

      // Seeded directly: no public API sets `invalidated_at` until Memories 5a
      // ships the LLM arbitration that produces it (roadmap RC-2).
      const entry = await db.Memory.findOne({
        where: { publicId: entryRes.body.id },
      });
      entry!.invalidatedAt = new Date();
      await entry!.save();

      const after = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          memory_store_ids: [isolatedMemoryStoreId],
        });

      expect(after.status).toBe(200);
      expect(memoryStoreResults(after.body)).toHaveLength(0);
    });

    test('excludes invalidated memories from a semantic query', async () => {
      const memRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/memory-stores')
        .send({
          project_id: projectId,
          name: 'Invalidation Query MemoryStore',
        });
      const isolatedMemoryStoreId = memRes.body.id;

      const entryRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/memories')
        .send({
          memory_store_id: isolatedMemoryStoreId,
          content: 'A retired fact about billing.',
        });
      expect(entryRes.status).toBe(201);

      const entry = await db.Memory.findOne({
        where: { publicId: entryRes.body.id },
      });
      entry!.invalidatedAt = new Date();
      await entry!.save();

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          memory_store_ids: [isolatedMemoryStoreId],
          query: 'billing',
        });

      // A query also ranks documents project-wide, so assert on the memory store
      // side specifically rather than on an empty result set.
      expect(response.status).toBe(200);
      const memoryStoreHits = response.body.results.filter(
        (r: { source_type: string }) => {
          return r.source_type === 'memory';
        }
      );
      expect(memoryStoreHits).toHaveLength(0);
    });

    test('returns memories when searching by tags', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          tags: { scope: 'knowledge-test' },
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

    test('returns memories when searching by tags without a project_id (admin, cross-project)', async () => {
      // An admin JWT with no project_id resolves to `undefined`, exercising the
      // unscoped branch — every other test here passes an explicit project_id.
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/knowledge/search')
        .send({
          tags: { scope: 'knowledge-test' },
        });
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.results)).toBe(true);
      const memResult = response.body.results.find(
        (r: { source_type: string }) => {
          return r.source_type === 'memory';
        }
      );
      expect(memResult).toBeDefined();
      expect(memResult.memory_store_id).toBe(memoryStoreId);
    });

    test('tags filter at entry granularity via per-entry tags', async () => {
      // A memory store container whose OWN tags do NOT match the searched tag, but
      // holding one entry tagged with it. Entry-granularity filtering must
      // return only that entry, proving the tag match happens per entry rather
      // than only at the container level.
      const containerRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/memory-stores')
        .send({
          project_id: projectId,
          name: 'Entry-tag MemoryStore',
          tags: { container: 'unrelated' },
        });
      const containerId = containerRes.body.id;

      await authenticatedTestClient(adminToken)
        .post('/api/v1/memories')
        .send({
          memory_store_id: containerId,
          content: 'Reject refunds above $500 for the traffic-manager role',
          tags: { role: 'traffic-manager' },
        });

      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          tags: { role: 'traffic-manager' },
        });

      expect(response.status).toBe(200);
      const match = response.body.results.find(
        (r: { source_type: string; content: string }) => {
          return r.content.includes('traffic-manager role');
        }
      );
      expect(match).toBeDefined();
      expect(match.source_type).toBe('memory');
      expect(match.memory_store_id).toBe(containerId);
    });

    test('returns mixed results when searching with query, document_filters, and memory_store_ids', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          query: 'sky',
          document_paths: ['/docs/'],
          memory_store_ids: [memoryStoreId],
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
      // The constant-vector stub scores 1, and the sub-query bug collapsed it to
      // 0 — so a `min_score` between the two is what makes this genuinely
      // red/green rather than merely asserting non-null.
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

    test('applies min_score to a semantic memoryStore search', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          query: 'sky',
          memory_store_ids: [memoryStoreId],
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

    test('returns empty array when memory_store_ids has no matching entries', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/knowledge/search')
        .send({
          project_id: projectId,
          memory_store_ids: ['mstore_doesnotexist000'],
        });
      expect(response.status).toBe(200);
      expect(response.body.results).toEqual([]);
    });
  });
});
