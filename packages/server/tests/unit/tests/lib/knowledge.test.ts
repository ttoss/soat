import { db } from 'src/db';
import * as embeddingModule from 'src/lib/embedding';
import { resolveDocumentSearch } from 'src/lib/knowledge';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

// Regression: a `document_paths` / `document_ids` filter joins `File` (nested
// two levels below the `DocumentChunk` query root) and applies a `limit`. When
// Sequelize builds the query with its default `subQuery: true`, the LIMIT is
// applied to the chunk rows *before* the join filter, so in a project holding
// more matching-by-distance chunks than the limit, the single path-matched
// document is ranked past the window and dropped — the search returns zero
// even though the exact path exists. The REST/constant-embedding tests can't
// surface this because every chunk shares one vector (all distances equal);
// here we hand-place a far-away embedding on the target so a real vector sort
// pushes it to the end, reproducing the drop deterministically.
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

// A `$`-prefixed policyWhere key (e.g. `$file.path$`, produced by the policy
// compiler for the `document` resourceType) requires `subQuery: false` on
// the underlying Sequelize query. It also has to be rewritten from
// `$file.<col>$` to `$document.file.<col>$` before reaching `DocumentChunk`
// queries, since `file` is nested one level deeper there than on the
// `Document` model that the alias was designed for — no existing REST-level
// test exercises a path-scoped policy against knowledge search, so both the
// search and no-search branches are exercised directly here.
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

// Discussion run outputs (participant responses + synthesis) are persisted as
// documents under /discussions/ so agents that call search-knowledge to
// reason over project content don't get discussion transcripts/verdicts back
// as false matches — see discussionRuns.ts `persistRun`.
describe('resolveDocumentSearch — discussion-output documents', () => {
  let adminToken: string;
  let projectId: string;
  let projectDbId: number;
  const discussionOutputPath = '/discussions/disc_1/runs/run_1/outcome.txt';
  const normalPath = '/playbooks/normal.md';

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });
    adminToken = await loginAs('admin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'resolveDocumentSearch discussion-output Test Project' });
    projectId = projectRes.body.id;
    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    projectDbId = project!.id;

    await authenticatedTestClient(adminToken).post('/api/v1/documents').send({
      project_id: projectId,
      content: 'VEREDITO FINAL: APROVADO. JUSTIFICATIVA: ...',
      filename: 'outcome.txt',
      path: discussionOutputPath,
    });
    await authenticatedTestClient(adminToken).post('/api/v1/documents').send({
      project_id: projectId,
      content: 'Real project knowledge content.',
      filename: 'normal.md',
      path: normalPath,
    });
  });

  test('a plain search excludes documents under /discussions/ by default', async () => {
    const results = await resolveDocumentSearch({
      projectIds: [projectDbId],
      config: {},
    });

    expect(
      results.some((r) => {
        return r.path === discussionOutputPath;
      })
    ).toBe(false);
    expect(
      results.some((r) => {
        return r.path === normalPath;
      })
    ).toBe(true);
  });

  test('an explicit paths filter targeting /discussions/ still returns it', async () => {
    const results = await resolveDocumentSearch({
      projectIds: [projectDbId],
      config: { paths: ['/discussions/'] },
    });

    expect(
      results.some((r) => {
        return r.path === discussionOutputPath;
      })
    ).toBe(true);
  });
});
