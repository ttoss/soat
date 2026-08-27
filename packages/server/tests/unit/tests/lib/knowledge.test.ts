import { db } from 'src/db';
import * as embeddingModule from 'src/lib/embedding';
import { resolveDocumentSearch } from 'src/lib/knowledge';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

// With Sequelize's default `subQuery: true`, the LIMIT applies to chunk rows
// before the join filter — so a path-matched document ranked past the window is
// dropped and the search returns zero despite the path existing. The
// constant-embedding tests cannot surface this (all distances equal), so the
// target gets a far-away embedding to push it to the end deterministically.
describe('resolveDocumentSearch — nested path filter with a limit', () => {
  let adminToken: string;
  let projectId: string;
  const targetPath = '/unique-target/target.md';
  const dim = Number(process.env.EMBEDDING_DIMENSIONS);
  const nearVector = new Array(dim).fill(0.1);
  const farVector = new Array(dim).fill(-0.1);

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });
    adminToken = await loginAs('admin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'resolveDocumentSearch limit Test Project' });
    projectId = projectRes.body.id;

    // 14 noise documents whose chunk embeddings sit right next to the query
    // vector, so they occupy the entire top-`limit` window.
    for (let i = 0; i < 14; i += 1) {
      await authenticatedTestClient(adminToken)
        .post('/api/v1/documents')
        .send({
          project_id: projectId,
          content: `Noise document ${i}.`,
          filename: `noise-${i}.txt`,
          path: `/noise/noise-${i}.txt`,
        });
    }

    // The lone target under a unique prefix; push its embedding far away so a
    // real vector sort ranks it last.
    const targetRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/documents')
      .send({
        project_id: projectId,
        content: 'The unique target playbook.',
        filename: 'target.md',
        path: targetPath,
      });
    const targetDoc = await db.Document.findOne({
      where: { publicId: targetRes.body.id },
    });
    await db.DocumentChunk.update(
      { embedding: farVector },
      { where: { documentId: targetDoc!.id } }
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('semantic search still returns the path-matched doc past the limit window', async () => {
    jest
      .spyOn(embeddingModule, 'getEmbedding')
      .mockResolvedValue([...nearVector]);

    const results = await resolveDocumentSearch({
      config: {
        search: 'unique target',
        paths: ['/unique-target/'],
        limit: 10,
      },
    });

    expect(
      results.some((r) => {
        return r.path === targetPath;
      })
    ).toBe(true);
  });
});

// A `$`-prefixed policyWhere key needs `subQuery: false`, and must be rewritten
// to `$document.file.<col>$` for `DocumentChunk` queries, where `file` sits a
// level deeper than on the `Document` model the alias was designed for. No
// REST-level test exercises a path-scoped policy against knowledge search.
describe('resolveDocumentSearch — policyWhere with a $-prefixed key', () => {
  let adminToken: string;
  let projectId: string;
  const documentPath = '/docs/policy-scoped-sample.txt';

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });
    adminToken = await loginAs('admin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'resolveDocumentSearch policyWhere Test Project' });
    projectId = projectRes.body.id;

    await authenticatedTestClient(adminToken).post('/api/v1/documents').send({
      project_id: projectId,
      content: 'Content scoped by a path-restricted policy.',
      filename: 'policy-scoped-sample.txt',
      path: documentPath,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('no-search branch: includes a document matching the policy-scoped path', async () => {
    const results = await resolveDocumentSearch({
      config: { paths: ['/docs/'] },
      policyWhere: { '$file.path$': documentPath },
    });

    expect(
      results.some((r) => {
        return r.path === documentPath;
      })
    ).toBe(true);
  });

  test('no-search branch: excludes documents outside the policy-scoped path', async () => {
    const results = await resolveDocumentSearch({
      config: { paths: ['/docs/'] },
      policyWhere: { '$file.path$': '/docs/some-other-file.txt' },
    });

    expect(
      results.some((r) => {
        return r.path === documentPath;
      })
    ).toBe(false);
  });

  test('search branch: does not throw when scoped by a $file.path$ policy', async () => {
    // The DocumentChunk.embedding column is a fixed-dimension pgvector;
    // match its dimension so the `<=>` distance query is valid.
    jest
      .spyOn(embeddingModule, 'getEmbedding')
      .mockResolvedValueOnce(new Array(1024).fill(0.1));

    const results = await resolveDocumentSearch({
      config: { search: 'restricted policy content' },
      policyWhere: { '$file.path$': documentPath },
    });

    expect(Array.isArray(results)).toBe(true);
  });
});
