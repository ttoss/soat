import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

const ACTIONS = [
  'documents:CreateDocument',
  'knowledge:SearchKnowledge',
  'metadata-schemas:CreateMetadataSchema',
];

/**
 * The same filter the listing reads, asked of the search: one grammar, so a
 * caller who narrowed a listing narrows a retrieval the same way.
 */
describe('Knowledge search metadata filters', () => {
  let userToken: string;
  let projectId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'knowmetafilter',
      policyActions: ACTIONS,
    });

    userToken = setup.userToken;
    projectId = setup.projectId;

    const declared = await authenticatedTestClient(userToken)
      .post('/api/v1/metadata-schemas')
      .send({
        project_id: projectId,
        resource_type: 'document',
        path_prefix: '/handbook',
        schema: {
          type: 'object',
          properties: {
            audience: { type: 'string' },
            revision: { type: 'integer' },
          },
        },
      });
    expect(declared.status).toBe(201);

    const create = async (args: { path: string; metadata: unknown }) => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({
          project_id: projectId,
          content: 'Escalate a stuck order to the duty manager.',
          filename: args.path.split('/').pop(),
          path: args.path,
          metadata: args.metadata,
        });
      expect(response.status).toBe(201);
    };

    // `pages` is in no declaration: an ordering reads the operand, not the
    // registry.
    await create({
      path: '/handbook/support.md',
      metadata: { audience: 'support', revision: 4, pages: 3 },
    });
    await create({
      path: '/handbook/legal.md',
      metadata: { audience: 'legal', revision: 12, pages: 30 },
    });
  }, 90_000);

  const search = (metadata: unknown) => {
    return authenticatedTestClient(userToken)
      .post('/api/v1/knowledge/search')
      .send({ project_id: projectId, metadata });
  };

  const pathsOf = (body: { results: { path?: string }[] }) => {
    return [
      ...new Set(
        body.results.map((result) => {
          return result.path;
        })
      ),
    ].sort();
  };

  test('a metadata filter is enough to name the document store', async () => {
    const response = await search({ audience: 'support' });

    expect(response.status).toBe(200);
    expect(pathsOf(response.body)).toEqual(['/handbook/support.md']);
  });

  test('orders a declared number', async () => {
    const response = await search({ revision: { gte: 12 } });

    expect(response.status).toBe(200);
    expect(pathsOf(response.body)).toEqual(['/handbook/legal.md']);
  });

  test('matches any of a list', async () => {
    const response = await search({ audience: { in: ['legal', 'support'] } });

    expect(response.status).toBe(200);
    expect(pathsOf(response.body)).toEqual([
      '/handbook/legal.md',
      '/handbook/support.md',
    ]);
  });

  test('refuses an unknown operator', async () => {
    const response = await search({ audience: { like: 'sup%' } });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(response.body.error.meta.field).toBe('audience');
  });

  test('orders an undeclared number numerically', async () => {
    const response = await search({ pages: { gte: 10 } });

    expect(response.status).toBe(200);
    expect(pathsOf(response.body)).toEqual(['/handbook/legal.md']);
  });

  test('narrows a query rather than replacing it', async () => {
    const response = await authenticatedTestClient(userToken)
      .post('/api/v1/knowledge/search')
      .send({
        project_id: projectId,
        query: 'escalate a stuck order',
        metadata: { audience: 'legal' },
      });

    expect(response.status).toBe(200);
    expect(pathsOf(response.body)).toEqual(['/handbook/legal.md']);
  });
});
