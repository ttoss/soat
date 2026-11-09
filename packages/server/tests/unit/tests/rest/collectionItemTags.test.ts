import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * An item's tags: the sub-resource, the `?tags=` filter, and the
 * `soat:ResourceTag/<key>` condition that scopes a principal to one actor's
 * items.
 */
describe('Collection item tags', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let collectionId: string;
  let actorToken: string;

  const itemPath = (key: string) => {
    return `/api/v1/collections/${collectionId}/items/${key}`;
  };

  const put = (args: { key: string; body: object; token?: string }) => {
    return authenticatedTestClient(args.token ?? userToken)
      .put(itemPath(args.key))
      .send(args.body);
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'collitemtags',
      policyActions: ['collections:*'],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;

    const collection = await authenticatedTestClient(userToken)
      .post('/api/v1/collections')
      .send({ project_id: projectId, name: 'tickets' });
    collectionId = collection.body.id;

    await put({ key: 'a1', body: { data: { n: 1 }, tags: { actor_id: 'A' } } });
    await put({ key: 'a2', body: { data: { n: 2 }, tags: { actor_id: 'A' } } });
    await put({ key: 'b1', body: { data: { n: 3 }, tags: { actor_id: 'B' } } });

    // Every collection action on the collection; item actions only on items
    // tagged with actor A.
    const actorUser = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'collitemactor', password: 'collitemactorpass' });
    const policy = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: ['collections:*'],
              resource: [`srn:${projectId}:collection:*`],
            },
            {
              effect: 'Allow',
              action: ['collections:*'],
              resource: [`srn:${projectId}:collection_item:*`],
              condition: {
                StringEquals: { 'soat:ResourceTag/actor_id': 'A' },
              },
            },
          ],
        },
      });
    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${actorUser.body.id}/policies`)
      .send({ policy_ids: [policy.body.id] });
    actorToken = await loginAs('collitemactor', 'collitemactorpass');
  }, 60_000);

  describe('GET /api/v1/collections/:collection_id/items/:key/tags', () => {
    test('returns the bag', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `${itemPath('a1')}/tags`
      );
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ actor_id: 'A' });
    });

    test('returns an empty bag for an untagged item', async () => {
      await put({ key: 'untagged', body: { data: {} } });
      const response = await authenticatedTestClient(userToken).get(
        `${itemPath('untagged')}/tags`
      );
      expect(response.body).toEqual({});
    });

    test('returns 401 without a token', async () => {
      const response = await testClient.get(`${itemPath('a1')}/tags`);
      expect(response.status).toBe(401);
    });

    test('returns 404 for a free key', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `${itemPath('free')}/tags`
      );
      expect(response.status).toBe(404);
    });
  });

  describe('PUT and PATCH /api/v1/collections/:collection_id/items/:key/tags', () => {
    test('replaces the bag and bumps the version', async () => {
      await put({ key: 'replace', body: { data: {}, tags: { x: '1' } } });
      const response = await authenticatedTestClient(userToken)
        .put(`${itemPath('replace')}/tags`)
        .send({ y: '2' });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ y: '2' });

      const item = await authenticatedTestClient(userToken).get(
        itemPath('replace')
      );
      expect(item.body.version).toBe(2);
    });

    test('merges into the bag', async () => {
      await put({ key: 'merge', body: { data: {}, tags: { x: '1' } } });
      const response = await authenticatedTestClient(userToken)
        .patch(`${itemPath('merge')}/tags`)
        .send({ y: '2' });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ x: '1', y: '2' });
    });

    test('refuses a non-string value', async () => {
      const response = await authenticatedTestClient(userToken)
        .put(`${itemPath('a1')}/tags`)
        .send({ x: 1 });
      expect(response.status).toBe(400);
    });

    test('refuses an array body', async () => {
      const response = await authenticatedTestClient(userToken)
        .put(`${itemPath('a1')}/tags`)
        .send(['a']);
      expect(response.status).toBe(400);
    });
  });

  test('a grant on the collection alone lists no items', async () => {
    const reader = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'collitemcollonly', password: 'collitemcollonlypass' });
    const policy = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: ['collections:ListCollectionItems'],
              resource: [`srn:${projectId}:collection:${collectionId}`],
            },
          ],
        },
      });
    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${reader.body.id}/policies`)
      .send({ policy_ids: [policy.body.id] });
    const token = await loginAs('collitemcollonly', 'collitemcollonlypass');

    const response = await authenticatedTestClient(token).get(
      `/api/v1/collections/${collectionId}/items`
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [], next_cursor: null });
  });

  describe('a principal scoped to one actor by tag', () => {
    const keys = (body: { data: { key: string }[] }) => {
      return body.data.map((item) => {
        return item.key;
      });
    };

    test('lists only that actor’s items', async () => {
      const response = await authenticatedTestClient(actorToken).get(
        `/api/v1/collections/${collectionId}/items`
      );
      expect(response.status).toBe(200);
      expect(keys(response.body)).toEqual(['a1', 'a2']);
    });

    test('reads its own item', async () => {
      const response = await authenticatedTestClient(actorToken).get(
        itemPath('a1')
      );
      expect(response.status).toBe(200);
    });

    test('cannot read another actor’s item', async () => {
      const response = await authenticatedTestClient(actorToken).get(
        itemPath('b1')
      );
      expect(response.status).toBe(404);
    });

    test('creates an item carrying its own tag', async () => {
      const response = await put({
        key: 'a-new',
        body: { data: {}, tags: { actor_id: 'A' } },
        token: actorToken,
      });
      expect(response.status).toBe(201);
    });

    test('cannot create an item outside its tag', async () => {
      const response = await put({
        key: 'b-new',
        body: { data: {}, tags: { actor_id: 'B' } },
        token: actorToken,
      });
      expect(response.status).toBe(403);
    });

    test('cannot create an untagged item', async () => {
      const response = await put({
        key: 'untagged-new',
        body: { data: {} },
        token: actorToken,
      });
      expect(response.status).toBe(403);
    });

    test('cannot move its item to another actor', async () => {
      const response = await authenticatedTestClient(actorToken)
        .patch(itemPath('a2'))
        .send({ tags: { actor_id: 'B' } });
      expect(response.status).toBe(403);

      const retag = await authenticatedTestClient(actorToken)
        .put(`${itemPath('a2')}/tags`)
        .send({ actor_id: 'B' });
      expect(retag.status).toBe(403);
    });

    test('cannot overwrite another actor’s item', async () => {
      const response = await put({
        key: 'b1',
        body: { data: {}, tags: { actor_id: 'A' } },
        token: actorToken,
      });
      expect(response.status).toBe(403);
    });
  });
});
