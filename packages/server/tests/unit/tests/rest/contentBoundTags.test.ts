import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

const ACTIONS = [
  'files:UpdateFileMetadata',
  'projects:GetProject',
  'projects:UpdateProject',
  'documents:CreateDocument',
  'documents:GetDocument',
  'documents:UpdateDocument',
  'documents:IngestDocument',
  'documents:WithdrawDocument',
  'documents:RestoreDocumentVersion',
  'memories:CreateMemoryStore',
  'memories:CreateMemory',
  'memories:GetMemory',
  'memories:UpdateMemory',
];

/**
 * A content-bound tag key states a judgment about what an agent can read, so
 * the judgment must not outlive the text it judged: a write that changes an
 * agent-readable field other than tags removes the key, unless that same write
 * sets it. A project that names no key keeps today's tag behavior.
 */
describe('Content-bound tag keys', () => {
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let plainProjectId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'cbtags',
      policyActions: ACTIONS,
      createOtherProject: true,
    });
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;
    plainProjectId = setup.otherProjectId as string;

    const response = await authenticatedTestClient(userToken)
      .patch(`/api/v1/projects/${projectId}`)
      .send({ content_bound_tag_keys: ['screened'] });
    expect(response.status).toBe(200);
  }, 60_000);

  const createDocument = async (args?: { project?: string }) => {
    const response = await authenticatedTestClient(userToken)
      .post('/api/v1/documents')
      .send({
        project_id: args?.project ?? projectId,
        content: 'The office is in Lisbon',
        title: 'Office',
        path: `/cbtags/${crypto.randomUUID()}.md`,
        tags: { screened: 'clean', team: 'ops' },
      });
    expect(response.status).toBe(201);
    return response.body.id as string;
  };

  const patchDocument = async (args: {
    id: string;
    body: Record<string, unknown>;
  }) => {
    const response = await authenticatedTestClient(userToken)
      .patch(`/api/v1/documents/${args.id}`)
      .send(args.body);
    expect(response.status).toBe(200);
    return response.body.tags as Record<string, string>;
  };

  describe('PATCH /api/v1/projects/:project_id', () => {
    test('stores and returns content_bound_tag_keys', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/projects/${projectId}`
      );
      expect(response.status).toBe(200);
      expect(response.body.content_bound_tag_keys).toEqual(['screened']);
    });

    test('a project that names none answers []', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/projects/${plainProjectId}`
      );
      expect(response.status).toBe(200);
      expect(response.body.content_bound_tag_keys).toEqual([]);
    });

    test.each([
      ['a string', 'screened'],
      ['a non-string entry', [1]],
      ['an empty key', ['']],
      ['a reserved system key', ['system.verdict']],
      ['a key over 128 characters', ['k'.repeat(129)]],
      [
        'more than 50 keys',
        Array.from({ length: 51 }, (_v, i) => {
          return `k${i}`;
        }),
      ],
    ])('400 for %s', async (_label, value) => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/projects/${projectId}`)
        .send({ content_bound_tag_keys: value });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('401 without authentication', async () => {
      const response = await testClient
        .patch(`/api/v1/projects/${projectId}`)
        .send({ content_bound_tag_keys: ['screened'] });
      expect(response.status).toBe(401);
    });

    test('403 without projects:UpdateProject', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .patch(`/api/v1/projects/${projectId}`)
        .send({ content_bound_tag_keys: [] });
      expect(response.status).toBe(403);
    });
  });

  describe('documents', () => {
    test.each([
      ['content', { content: 'The office is in Porto' }],
      ['title', { title: 'Old office' }],
      ['path', { path: `/cbtags/${crypto.randomUUID()}.md` }],
      ['metadata', { metadata: { source: 'crawler' } }],
    ])('a %s update removes the key and keeps the others', async (_f, body) => {
      const id = await createDocument();
      expect(await patchDocument({ id, body })).toEqual({ team: 'ops' });
    });

    test('a tag-only update keeps the key', async () => {
      const id = await createDocument();
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/documents/${id}/tags`)
        .send({ team: 'sales' });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ screened: 'clean', team: 'sales' });
    });

    test('a write that sets the key keeps it', async () => {
      const id = await createDocument();
      expect(
        await patchDocument({
          id,
          body: {
            content: 'The office is in Porto',
            tags: { screened: 'clean', team: 'ops' },
          },
        })
      ).toEqual({ screened: 'clean', team: 'ops' });
    });

    test('rewriting the same content keeps the key', async () => {
      const id = await createDocument();
      expect(
        await patchDocument({
          id,
          body: { content: 'The office is in Lisbon' },
        })
      ).toEqual({ screened: 'clean', team: 'ops' });
    });

    test('a re-ingest removes the key', async () => {
      const id = await createDocument();
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/documents/${id}/ingest?wait=true`)
        .send({});
      expect(response.status).toBe(201);
      const read = await authenticatedTestClient(userToken).get(
        `/api/v1/documents/${id}`
      );
      expect(read.body.tags).toEqual({ team: 'ops' });
    });

    const readTags = async (id: string) => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/documents/${id}`
      );
      expect(response.status).toBe(200);
      return response.body.tags as Record<string, string>;
    };

    test('restoring a version with other text removes the key it archived', async () => {
      const id = await createDocument();
      await patchDocument({ id, body: { content: 'The office is in Porto' } });
      const restored = await authenticatedTestClient(userToken)
        .post(`/api/v1/documents/${id}/versions/1/restore`)
        .send({});
      expect(restored.status).toBe(200);
      expect(await readTags(id)).toEqual({ team: 'ops' });
    });

    test('reviving a withdrawn document removes the key', async () => {
      const id = await createDocument();
      const withdrawn = await authenticatedTestClient(userToken)
        .post(`/api/v1/documents/${id}/withdraw`)
        .send({});
      expect(withdrawn.status).toBe(200);
      const restored = await authenticatedTestClient(userToken)
        .post(`/api/v1/documents/${id}/versions/1/restore`)
        .send({});
      expect(restored.status).toBe(200);
      expect(await readTags(id)).toEqual({ team: 'ops' });
    });

    test('moving the backing file removes the key from the document', async () => {
      const id = await createDocument();
      const doc = await authenticatedTestClient(userToken).get(
        `/api/v1/documents/${id}`
      );
      const moved = await authenticatedTestClient(userToken)
        .patch(`/api/v1/files/${doc.body.file_id}/metadata`)
        .send({ filename: `${crypto.randomUUID()}.md` });
      expect(moved.status).toBe(200);
      expect(await readTags(id)).toEqual({ team: 'ops' });
    });

    test('a file metadata write that moves nothing keeps the key', async () => {
      const id = await createDocument();
      const doc = await authenticatedTestClient(userToken).get(
        `/api/v1/documents/${id}`
      );
      const written = await authenticatedTestClient(userToken)
        .patch(`/api/v1/files/${doc.body.file_id}/metadata`)
        .send({ metadata: { source: 'crawler' } });
      expect(written.status).toBe(200);
      expect(await readTags(id)).toEqual({ screened: 'clean', team: 'ops' });
    });

    test('a project that names no key keeps tags on a content update', async () => {
      const id = await createDocument({ project: plainProjectId });
      expect(
        await patchDocument({ id, body: { content: 'The office is in Porto' } })
      ).toEqual({ screened: 'clean', team: 'ops' });
    });
  });

  describe('memories', () => {
    const createStore = async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/memory-stores')
        .send({ project_id: projectId, name: `cb ${crypto.randomUUID()}` });
      expect(response.status).toBe(201);
      return response.body.id as string;
    };

    const createMemory = async (storeId: string) => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/memories')
        .send({
          memory_store_id: storeId,
          content: 'The office is in Lisbon',
          tags: { screened: 'clean', team: 'ops' },
        });
      expect(response.status).toBe(201);
      return response.body.id as string;
    };

    const putMemory = async (id: string, body: Record<string, unknown>) => {
      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/memories/${id}`)
        .send(body);
      expect(response.status).toBe(200);
      return response.body.tags as Record<string, string>;
    };

    test('a superseding memory does not inherit the key; other tags still do', async () => {
      const storeId = await createStore();
      const original = await createMemory(storeId);
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/memories')
        .send({
          memory_store_id: storeId,
          content: 'We closed the Lisbon office',
          supersedes: original,
        });
      expect(response.status).toBe(200);
      expect(response.body.tags).toEqual({ team: 'ops' });
    });

    test('a supersede that sets the key keeps it', async () => {
      const storeId = await createStore();
      const original = await createMemory(storeId);
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/memories')
        .send({
          memory_store_id: storeId,
          content: 'We closed the Lisbon office',
          supersedes: original,
          tags: { screened: 'clean' },
        });
      expect(response.status).toBe(200);
      expect(response.body.tags).toEqual({ screened: 'clean', team: 'ops' });
    });

    test.each([
      ['content', { content: 'The office is in Porto' }],
      ['metadata', { metadata: { source: 'crawler' } }],
    ])('a %s update removes the key', async (_f, body) => {
      const id = await createMemory(await createStore());
      expect(await putMemory(id, body)).toEqual({ team: 'ops' });
    });

    test('a tags update keeps what it sets', async () => {
      const id = await createMemory(await createStore());
      expect(
        await putMemory(id, { tags: { screened: 'clean', team: 'sales' } })
      ).toEqual({ screened: 'clean', team: 'sales' });
    });

    test('rewriting the same content keeps the key', async () => {
      const id = await createMemory(await createStore());
      expect(
        await putMemory(id, { content: 'The office is in Lisbon' })
      ).toEqual({ screened: 'clean', team: 'ops' });
    });
  });
});
