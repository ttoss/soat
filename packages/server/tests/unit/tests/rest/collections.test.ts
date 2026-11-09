import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

const ACTIONS = [
  'collections:ListCollections',
  'collections:CreateCollection',
  'collections:GetCollection',
  'collections:UpdateCollection',
  'collections:DeleteCollection',
  'collections:ListCollectionItems',
  'collections:GetCollectionItem',
  'collections:PutCollectionItem',
  'collections:UpdateCollectionItem',
  'collections:DeleteCollectionItem',
];

const TICKET_SCHEMA = {
  type: 'object',
  required: ['status'],
  properties: { status: { type: 'string', enum: ['open', 'closed'] } },
};

describe('Collections', () => {
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let readerToken: string;
  let projectId: string;
  let seq = 0;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'collections',
      policyActions: ACTIONS,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;

    // Reads collections and items and writes nothing: a write refused to a
    // caller inside the project is `403`, where one outside it is `404`.
    readerToken = await createScopedPrincipal({
      adminToken,
      projectId,
      username: 'collectionsreader',
      actions: [
        'collections:GetCollection',
        'collections:ListCollectionItems',
        'collections:GetCollectionItem',
      ],
    });
  }, 60_000);

  const uniqueName = (): string => {
    seq += 1;
    return `collection-${seq}`;
  };

  const createCollection = async (body: object = {}) => {
    const response = await authenticatedTestClient(userToken)
      .post('/api/v1/collections')
      .send({ project_id: projectId, name: uniqueName(), ...body });
    expect(response.status).toBe(201);
    return response.body as { id: string; name: string };
  };

  const itemPath = (collectionId: string, key: string) => {
    return `/api/v1/collections/${collectionId}/items/${key}`;
  };

  const putItem = (args: {
    collectionId: string;
    key: string;
    body: object;
    token?: string;
  }) => {
    return authenticatedTestClient(args.token ?? userToken)
      .put(itemPath(args.collectionId, args.key))
      .send(args.body);
  };

  describe('POST /api/v1/collections', () => {
    test('creates a collection', async () => {
      const name = uniqueName();
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/collections')
        .send({ project_id: projectId, name, schema: TICKET_SCHEMA });

      expect(response.status).toBe(201);
      expect(response.body.id).toMatch(/^coll_/);
      expect(response.body).toMatchObject({
        project_id: projectId,
        name,
        schema: TICKET_SCHEMA,
      });
    });

    test('refuses a second collection of the same name', async () => {
      const { name } = await createCollection();
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/collections')
        .send({ project_id: projectId, name });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('NAME_CONFLICT');
    });

    test('refuses a schema that does not compile', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/collections')
        .send({
          project_id: projectId,
          name: uniqueName(),
          schema: { type: 'not-a-type' },
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('refuses a blank name', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/collections')
        .send({ project_id: projectId, name: '  ' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('returns 401 without a token', async () => {
      const response = await testClient
        .post('/api/v1/collections')
        .send({ project_id: projectId, name: uniqueName() });
      expect(response.status).toBe(401);
    });

    test('returns 403 without the action', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post('/api/v1/collections')
        .send({ project_id: projectId, name: uniqueName() });
      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/collections', () => {
    test('lists the collections in the project', async () => {
      const created = await createCollection();
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/collections?project_id=${projectId}&limit=100`
      );

      expect(response.status).toBe(200);
      expect(
        (response.body.data as { id: string }[]).map((entry) => {
          return entry.id;
        })
      ).toContain(created.id);
    });

    test('returns 401 without a token', async () => {
      const response = await testClient.get('/api/v1/collections');
      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/v1/collections/:collection_id', () => {
    test('returns the collection', async () => {
      const created = await createCollection();
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/collections/${created.id}`
      );
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ id: created.id, schema: null });
    });

    test('returns 404 for an unknown id', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/collections/coll_doesnotexist0000'
      );
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });

    test('hides the collection from a caller without the action', async () => {
      const created = await createCollection();
      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/collections/${created.id}`
      );
      expect(response.status).toBe(404);
    });
  });

  describe('PATCH /api/v1/collections/:collection_id', () => {
    test('renames the collection and sets its schema', async () => {
      const created = await createCollection();
      const name = uniqueName();
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/collections/${created.id}`)
        .send({ name, schema: TICKET_SCHEMA });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ name, schema: TICKET_SCHEMA });
    });

    test('clears the schema with null', async () => {
      const created = await createCollection({ schema: TICKET_SCHEMA });
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/collections/${created.id}`)
        .send({ schema: null });

      expect(response.status).toBe(200);
      expect(response.body.schema).toBeNull();
    });

    test('refuses a name another collection holds', async () => {
      const first = await createCollection();
      const second = await createCollection();
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/collections/${second.id}`)
        .send({ name: first.name });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('NAME_CONFLICT');
    });

    test('returns 403 to a reader', async () => {
      const created = await createCollection();
      const response = await authenticatedTestClient(readerToken)
        .patch(`/api/v1/collections/${created.id}`)
        .send({ name: uniqueName() });
      expect(response.status).toBe(403);
    });
  });

  describe('DELETE /api/v1/collections/:collection_id', () => {
    test('deletes the collection with its items', async () => {
      const created = await createCollection();
      await putItem({
        collectionId: created.id,
        key: 'a',
        body: { data: { n: 1 } },
      });

      const response = await authenticatedTestClient(userToken).delete(
        `/api/v1/collections/${created.id}`
      );
      expect(response.status).toBe(204);

      const item = await authenticatedTestClient(userToken).get(
        itemPath(created.id, 'a')
      );
      expect(item.status).toBe(404);
    });

    test('returns 401 without a token', async () => {
      const created = await createCollection();
      const response = await testClient.delete(
        `/api/v1/collections/${created.id}`
      );
      expect(response.status).toBe(401);
    });
  });

  describe('PUT /api/v1/collections/:collection_id/items/:key', () => {
    test('creates an item at a free key', async () => {
      const { id } = await createCollection();
      const response = await putItem({
        collectionId: id,
        key: 'ticket-1',
        body: { data: { status: 'open' }, tags: { team: 'support' } },
      });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        collection_id: id,
        key: 'ticket-1',
        data: { status: 'open' },
        tags: { team: 'support' },
        version: 1,
      });
      expect(response.body.id).toBeUndefined();
    });

    test('replaces the data, keeping tags it does not send', async () => {
      const { id } = await createCollection();
      await putItem({
        collectionId: id,
        key: 'ticket-1',
        body: { data: { status: 'open', note: 'x' }, tags: { team: 'a' } },
      });

      const response = await putItem({
        collectionId: id,
        key: 'ticket-1',
        body: { data: { status: 'closed' } },
      });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        data: { status: 'closed' },
        tags: { team: 'a' },
        version: 2,
      });
    });

    test('clears the tags with null', async () => {
      const { id } = await createCollection();
      await putItem({
        collectionId: id,
        key: 'k',
        body: { data: {}, tags: { team: 'a' } },
      });
      const response = await putItem({
        collectionId: id,
        key: 'k',
        body: { data: {}, tags: null },
      });
      expect(response.status).toBe(200);
      expect(response.body.tags).toBeUndefined();
    });

    test('refuses a stale If-Match with the version in force', async () => {
      const { id } = await createCollection();
      await putItem({ collectionId: id, key: 'k', body: { data: { n: 1 } } });
      await putItem({ collectionId: id, key: 'k', body: { data: { n: 2 } } });

      const response = await authenticatedTestClient(userToken)
        .put(itemPath(id, 'k'))
        .set('If-Match', '"1"')
        .send({ data: { n: 3 } });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('VERSION_CONFLICT');
      expect(response.body.error.meta.current_version).toBe(2);
    });

    test('writes when the precondition names the version in force', async () => {
      const { id } = await createCollection();
      await putItem({ collectionId: id, key: 'k', body: { data: { n: 1 } } });

      const response = await putItem({
        collectionId: id,
        key: 'k',
        body: { data: { n: 2 }, expected_version: 1 },
      });
      expect(response.status).toBe(200);
      expect(response.body.version).toBe(2);
    });

    test('answers 404 to a precondition on a free key', async () => {
      const { id } = await createCollection();
      const response = await putItem({
        collectionId: id,
        key: 'free',
        body: { data: {}, expected_version: 1 },
      });
      expect(response.status).toBe(404);
    });

    test('serializes concurrent creates of one key', async () => {
      const { id } = await createCollection();
      const responses = await Promise.all(
        [1, 2, 3, 4].map((n) => {
          return putItem({
            collectionId: id,
            key: 'race',
            body: { data: { n } },
          });
        })
      );
      const statuses = responses.map((response) => {
        return response.status;
      });

      expect(
        statuses.filter((status) => {
          return status === 201;
        })
      ).toHaveLength(1);
      for (const status of statuses) {
        expect([200, 201, 409]).toContain(status);
      }
    });

    test('refuses data that breaks the collection schema', async () => {
      const { id } = await createCollection({ schema: TICKET_SCHEMA });
      const response = await putItem({
        collectionId: id,
        key: 'k',
        body: { data: { status: 'pending' } },
      });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.message).toContain('schema');
    });

    test('refuses data that is not an object', async () => {
      const { id } = await createCollection();
      const response = await putItem({
        collectionId: id,
        key: 'k',
        body: { data: [1, 2] },
      });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('refuses data over the item ceiling', async () => {
      const { id } = await createCollection();
      const response = await putItem({
        collectionId: id,
        key: 'k',
        body: { data: { blob: 'x'.repeat(70 * 1024) } },
      });
      expect(response.status).toBe(400);
      expect(response.body.error.meta.max_bytes).toBe(64 * 1024);
    });

    test('refuses a key that cannot name an item', async () => {
      const { id } = await createCollection();
      const response = await putItem({
        collectionId: id,
        key: 'bad*key',
        body: { data: {} },
      });
      expect(response.status).toBe(400);
      expect(response.body.error.meta.field).toBe('key');
    });

    test('refuses a reserved tag key', async () => {
      const { id } = await createCollection();
      const response = await putItem({
        collectionId: id,
        key: 'k',
        body: { data: {}, tags: { 'system.owner': 'x' } },
      });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('RESERVED_TAG_KEY');
    });

    test('returns 401 without a token', async () => {
      const { id } = await createCollection();
      const response = await testClient
        .put(itemPath(id, 'k'))
        .send({ data: {} });
      expect(response.status).toBe(401);
    });

    test('returns 403 to a reader', async () => {
      const { id } = await createCollection();
      const response = await putItem({
        collectionId: id,
        key: 'k',
        body: { data: {} },
        token: readerToken,
      });
      expect(response.status).toBe(403);
    });
  });

  describe('PATCH /api/v1/collections/:collection_id/items/:key', () => {
    test('merges into the data as a JSON merge patch', async () => {
      const { id } = await createCollection();
      await putItem({
        collectionId: id,
        key: 'k',
        body: { data: { a: 1, b: { c: 1, d: 2 }, e: 'x' } },
      });

      const response = await authenticatedTestClient(userToken)
        .patch(itemPath(id, 'k'))
        .send({ data: { b: { d: null, f: 3 }, e: null, g: true } });

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ a: 1, b: { c: 1, f: 3 }, g: true });
      expect(response.body.version).toBe(2);
    });

    test('replaces the tags alone', async () => {
      const { id } = await createCollection();
      await putItem({ collectionId: id, key: 'k', body: { data: { a: 1 } } });

      const response = await authenticatedTestClient(userToken)
        .patch(itemPath(id, 'k'))
        .send({ tags: { team: 'b' } });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        data: { a: 1 },
        tags: { team: 'b' },
      });
    });

    test('judges the merged data against the schema', async () => {
      const { id } = await createCollection({ schema: TICKET_SCHEMA });
      await putItem({
        collectionId: id,
        key: 'k',
        body: { data: { status: 'open' } },
      });

      const response = await authenticatedTestClient(userToken)
        .patch(itemPath(id, 'k'))
        .send({ data: { status: null } });
      expect(response.status).toBe(400);
    });

    test('refuses a stale If-Match', async () => {
      const { id } = await createCollection();
      await putItem({ collectionId: id, key: 'k', body: { data: { n: 1 } } });
      await putItem({ collectionId: id, key: 'k', body: { data: { n: 2 } } });

      const response = await authenticatedTestClient(userToken)
        .patch(itemPath(id, 'k'))
        .set('If-Match', '1')
        .send({ data: { n: 3 } });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('VERSION_CONFLICT');
    });

    test('returns 404 for a free key', async () => {
      const { id } = await createCollection();
      const response = await authenticatedTestClient(userToken)
        .patch(itemPath(id, 'free'))
        .send({ data: {} });
      expect(response.status).toBe(404);
    });

    test('returns 403 to a reader', async () => {
      const { id } = await createCollection();
      await putItem({ collectionId: id, key: 'k', body: { data: {} } });
      const response = await authenticatedTestClient(readerToken)
        .patch(itemPath(id, 'k'))
        .send({ data: {} });
      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/collections/:collection_id/items/:key', () => {
    test('returns the item', async () => {
      const { id } = await createCollection();
      await putItem({ collectionId: id, key: 'k', body: { data: { n: 1 } } });
      const response = await authenticatedTestClient(userToken).get(
        itemPath(id, 'k')
      );
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ key: 'k', data: { n: 1 } });
    });

    test('returns 404 for a free key', async () => {
      const { id } = await createCollection();
      const response = await authenticatedTestClient(userToken).get(
        itemPath(id, 'free')
      );
      expect(response.status).toBe(404);
    });

    test('returns 401 without a token', async () => {
      const { id } = await createCollection();
      const response = await testClient.get(itemPath(id, 'k'));
      expect(response.status).toBe(401);
    });
  });

  describe('DELETE /api/v1/collections/:collection_id/items/:key', () => {
    test('deletes the item', async () => {
      const { id } = await createCollection();
      await putItem({ collectionId: id, key: 'k', body: { data: {} } });

      const response = await authenticatedTestClient(userToken).delete(
        itemPath(id, 'k')
      );
      expect(response.status).toBe(204);

      const after = await authenticatedTestClient(userToken).get(
        itemPath(id, 'k')
      );
      expect(after.status).toBe(404);
    });

    test('returns 404 for a free key', async () => {
      const { id } = await createCollection();
      const response = await authenticatedTestClient(userToken).delete(
        itemPath(id, 'free')
      );
      expect(response.status).toBe(404);
    });

    test('returns 403 to a reader', async () => {
      const { id } = await createCollection();
      await putItem({ collectionId: id, key: 'k', body: { data: {} } });
      const response = await authenticatedTestClient(readerToken).delete(
        itemPath(id, 'k')
      );
      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/collections/:collection_id/items', () => {
    let collectionId: string;

    beforeAll(async () => {
      ({ id: collectionId } = await createCollection());
      const items = [
        {
          key: 'a',
          data: { status: 'open', priority: 1 },
          tags: { team: 'x' },
        },
        {
          key: 'b',
          data: { status: 'open', priority: 3 },
          tags: { team: 'y' },
        },
        {
          key: 'c',
          data: { status: 'closed', priority: 5 },
          tags: { team: 'x' },
        },
      ];
      for (const item of items) {
        await putItem({
          collectionId,
          key: item.key,
          body: { data: item.data, tags: item.tags },
        });
      }
    });

    const list = (query: string) => {
      return authenticatedTestClient(userToken).get(
        `/api/v1/collections/${collectionId}/items${query}`
      );
    };

    const keys = (body: { data: { key: string }[] }) => {
      return body.data.map((item) => {
        return item.key;
      });
    };

    test('lists every item in key order', async () => {
      const response = await list('');
      expect(response.status).toBe(200);
      expect(keys(response.body)).toEqual(['a', 'b', 'c']);
    });

    test('narrows by data equality', async () => {
      const data = encodeURIComponent(JSON.stringify({ status: 'open' }));
      const response = await list(`?data=${data}`);
      expect(keys(response.body)).toEqual(['a', 'b']);
    });

    test('narrows by a data range', async () => {
      const data = encodeURIComponent(JSON.stringify({ priority: { gte: 3 } }));
      const response = await list(`?data=${data}`);
      expect(keys(response.body)).toEqual(['b', 'c']);
    });

    test('narrows by tags', async () => {
      const response = await list('?tags=team:x');
      expect(keys(response.body)).toEqual(['a', 'c']);
    });

    test('pages with a cursor', async () => {
      const first = await list('?limit=2');
      expect(keys(first.body)).toEqual(['a', 'b']);
      const second = await list(
        `?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`
      );
      expect(keys(second.body)).toEqual(['c']);
      expect(second.body.next_cursor).toBeNull();
    });

    test('refuses a data filter that is not JSON', async () => {
      const response = await list('?data=not-json');
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('refuses a tag pair without a colon', async () => {
      const response = await list('?tags=team');
      expect(response.status).toBe(400);
    });

    test('returns 401 without a token', async () => {
      const response = await testClient.get(
        `/api/v1/collections/${collectionId}/items`
      );
      expect(response.status).toBe(401);
    });

    test('returns 404 to a caller without the action', async () => {
      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/collections/${collectionId}/items`
      );
      expect(response.status).toBe(404);
    });

    test('answers the admin', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        `/api/v1/collections/${collectionId}/items`
      );
      expect(response.status).toBe(200);
      expect(keys(response.body)).toEqual(['a', 'b', 'c']);
    });
  });
});
