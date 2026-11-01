import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

type SearchResult = {
  source_type: 'document' | 'memory';
  document_id?: string;
  memory_id?: string;
};

/**
 * A knowledge search compiles one policy set once per store it reads; a
 * statement reaches only the store its SRN type names.
 */
describe('POST /api/v1/knowledge/search — a type-scoped policy', () => {
  const QUERY = 'type scoped probe';
  let adminToken: string;
  let projectId: string;
  let documentId: string;
  let memoryId: string;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const tokenFor = async (args: {
    username: string;
    statement: Array<Record<string, unknown>>;
  }): Promise<string> => {
    const user = await asAdmin()
      .post('/api/v1/users')
      .send({ username: args.username, password: 'scopedpass' });
    const policy = await asAdmin()
      .post('/api/v1/policies')
      .send({ document: { statement: args.statement } });
    await asAdmin()
      .put(`/api/v1/users/${user.body.id}/policies`)
      .send({ policy_ids: [policy.body.id] });
    return loginAs(args.username, 'scopedpass');
  };

  const searchAs = async (token: string): Promise<string[]> => {
    const res = await authenticatedTestClient(token)
      .post('/api/v1/knowledge/search')
      .send({ project_id: projectId, query: QUERY });
    expect(res.status).toBe(200);
    return (res.body.results as SearchResult[])
      .map((result) => {
        return result.document_id ?? result.memory_id ?? '';
      })
      .sort();
  };

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'typescopedadmin', password: 'supersecret' });
    adminToken = await loginAs('typescopedadmin', 'supersecret');

    const project = await asAdmin()
      .post('/api/v1/projects')
      .send({ name: 'Type-scoped search policy' });
    projectId = project.body.id;

    const document = await asAdmin()
      .post('/api/v1/documents')
      .send({
        project_id: projectId,
        content: `A document for the ${QUERY}.`,
        path: '/docs/type-scoped.txt',
      });
    expect(document.status).toBe(201);
    documentId = document.body.id;

    const store = await asAdmin()
      .post('/api/v1/memory-stores')
      .send({ project_id: projectId, name: 'Type-scoped store' });
    expect(store.status).toBe(201);
    const memory = await asAdmin()
      .post('/api/v1/memories')
      .send({
        memory_store_id: store.body.id,
        content: `A memory for the ${QUERY}.`,
      });
    expect(memory.status).toBe(201);
    memoryId = memory.body.id;
  });

  test('both stores answer an Allow on every type', async () => {
    const token = await tokenFor({
      username: 'typescopedall',
      statement: [
        {
          effect: 'Allow',
          action: ['knowledge:SearchKnowledge', 'embeddings:CreateEmbeddings'],
          resource: [`srn:${projectId}:*:*`],
        },
      ],
    });
    expect(await searchAs(token)).toEqual([documentId, memoryId].sort());
  });

  test('a Deny on memories leaves documents searchable', async () => {
    const token = await tokenFor({
      username: 'typescopeddenymemory',
      statement: [
        {
          effect: 'Allow',
          action: ['knowledge:SearchKnowledge', 'embeddings:CreateEmbeddings'],
          resource: [`srn:${projectId}:*:*`],
        },
        {
          effect: 'Deny',
          action: ['knowledge:SearchKnowledge'],
          resource: [`srn:${projectId}:memory:*`],
        },
      ],
    });
    expect(await searchAs(token)).toEqual([documentId]);
  });

  test('an Allow on documents alone reaches no memory', async () => {
    const token = await tokenFor({
      username: 'typescopeddocsonly',
      statement: [
        {
          effect: 'Allow',
          action: ['knowledge:SearchKnowledge'],
          resource: [`srn:${projectId}:document:*`],
        },
        {
          effect: 'Allow',
          action: ['embeddings:CreateEmbeddings'],
          resource: [`srn:${projectId}:*:*`],
        },
      ],
    });
    expect(await searchAs(token)).toEqual([documentId]);
  });

  test('an Allow on a store but not its memories reaches no memory', async () => {
    const token = await tokenFor({
      username: 'typescopedonedoc',
      statement: [
        {
          effect: 'Allow',
          action: ['knowledge:SearchKnowledge'],
          resource: [
            `srn:${projectId}:document:*`,
            `srn:${projectId}:memory_store:*`,
          ],
        },
        {
          effect: 'Allow',
          action: ['embeddings:CreateEmbeddings'],
          resource: [`srn:${projectId}:*:*`],
        },
      ],
    });
    expect(await searchAs(token)).toEqual([documentId]);
  });
});
