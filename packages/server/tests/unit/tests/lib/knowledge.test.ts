import * as embeddingModule from 'src/lib/embedding';
import { resolveDocumentSearch } from 'src/lib/knowledge';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

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
