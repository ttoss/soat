import * as actorsLib from 'src/lib/actors';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('Actors', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectId: string;
  let policyId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');

    const createUserRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'actorsuser', password: 'actorspass' });

    userId = createUserRes.body.id;
    userToken = await loginAs('actorsuser', 'actorspass');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Actors Test Project' });
    projectId = projectRes.body.id;

    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: [
                'actors:ListActors',
                'actors:GetActor',
                'actors:CreateActor',
                'actors:DeleteActor',
                'actors:UpdateActor',
              ],
            },
          ],
        },
      });
    policyId = policyRes.body.id;

    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userId}/policies`)
      .send({ policy_ids: [policyId] });
  });

  describe('POST /api/v1/actors', () => {
    test('authenticated user with permission can create an actor', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/actors')
        .send({ project_id: projectId, name: 'Alice' });

      expect(response.status).toBe(201);
      expect(response.body.id).toMatch(/^act_/);
      expect(response.body.name).toBe('Alice');
      expect(response.body.project_id).toBe(projectId);
      expect(response.body.type).toBeUndefined();
      expect(response.body.external_id).toBeUndefined();
    });

    test('can create an actor with type and externalId', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/actors')
        .send({
          project_id: projectId,
          name: 'Bob',
          type: 'customer',
          external_id: '+15550001111',
        });

      expect(response.status).toBe(201);
      expect(response.body.name).toBe('Bob');
      expect(response.body.type).toBe('customer');
      expect(response.body.external_id).toBe('+15550001111');
    });

    test('duplicate externalId within same project returns 200 with existing actor (idempotent)', async () => {
      const first = await authenticatedTestClient(userToken)
        .post('/api/v1/actors')
        .send({
          project_id: projectId,
          name: 'Charlie',
          external_id: '+15559999999',
        });

      expect(first.status).toBe(201);

      const second = await authenticatedTestClient(userToken)
        .post('/api/v1/actors')
        .send({
          project_id: projectId,
          name: 'Charlie2',
          external_id: '+15559999999',
        });

      expect(second.status).toBe(200);
      expect(second.body.id).toBe(first.body.id);
      expect(second.body.name).toBe('Charlie');
    });

    test('new externalId returns 201', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/actors')
        .send({
          project_id: projectId,
          name: 'Dave',
          external_id: '+15558887777',
        });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.external_id).toBe('+15558887777');
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post('/api/v1/actors')
        .send({ project_id: projectId, name: 'Anon' });

      expect(response.status).toBe(401);
    });

    test('missing name returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/actors')
        .send({ project_id: projectId });

      expect(response.status).toBe(400);
    });

    test('missing projectId returns 400 for JWT users', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/actors')
        .send({ name: 'NoProject' });

      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/v1/actors', () => {
    beforeAll(async () => {
      await authenticatedTestClient(userToken)
        .post('/api/v1/actors')
        .send({ project_id: projectId, name: 'ListActor1' });
      await authenticatedTestClient(userToken)
        .post('/api/v1/actors')
        .send({ project_id: projectId, name: 'ListActor2' });
    });

    test('authenticated user with permission can list actors', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/actors?project_id=${projectId}`
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThanOrEqual(2);
      expect(response.body.total).toBeGreaterThanOrEqual(2);
    });

    test('listing without projectId returns all accessible actors', async () => {
      const response =
        await authenticatedTestClient(userToken).get('/api/v1/actors');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    test('can filter by externalId', async () => {
      await authenticatedTestClient(userToken).post('/api/v1/actors').send({
        project_id: projectId,
        name: 'ExternalFiltered',
        external_id: '+15558887777',
      });

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/actors?external_id=%2B15558887777`
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(
        response.body.data.some((a: { external_id: string }) => {
          return a.external_id === '+15558887777';
        })
      ).toBe(true);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/actors?project_id=${projectId}`
      );

      expect(response.status).toBe(401);
    });

    test('logs and returns 500 when router has an unhandled error', async () => {
      const loggerSpy = jest.spyOn(console, 'error').mockImplementation(() => {
        return undefined;
      });

      const listActorsSpy = jest
        .spyOn(actorsLib, 'listActors')
        .mockRejectedValueOnce(new Error('forced actors list failure'));

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/actors?project_id=${projectId}`
      );

      expect(response.status).toBe(500);

      const requestFailedCall = loggerSpy.mock.calls.find((call) => {
        return call[0] === 'Request failed:';
      }) as [string, Record<string, unknown>] | undefined;

      expect(requestFailedCall).toBeDefined();
      expect(requestFailedCall?.[1]).toEqual(
        expect.objectContaining({
          method: 'GET',
          path: '/api/v1/actors',
          status: 500,
        })
      );

      listActorsSpy.mockRestore();
      loggerSpy.mockRestore();
    });
  });

  describe('GET /api/v1/actors/:id', () => {
    let actorId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/actors')
        .send({ project_id: projectId, name: 'FetchActor', type: 'agent' });
      actorId = res.body.id;
    });

    test('user with permission can get an actor by ID', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/actors/${actorId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(actorId);
      expect(response.body.name).toBe('FetchActor');
      expect(response.body.type).toBe('agent');
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(`/api/v1/actors/${actorId}`);

      expect(response.status).toBe(401);
    });

    test('returns 404 for non-existent actor', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        '/api/v1/actors/act_nonexistent'
      );

      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /api/v1/actors/:id', () => {
    test('user with permission can delete an actor', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/actors')
        .send({ project_id: projectId, name: 'ToDelete' });
      const actorId = createRes.body.id;

      const deleteRes = await authenticatedTestClient(userToken).delete(
        `/api/v1/actors/${actorId}`
      );

      expect(deleteRes.status).toBe(204);

      const getRes = await authenticatedTestClient(userToken).get(
        `/api/v1/actors/${actorId}`
      );
      expect(getRes.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/actors')
        .send({ project_id: projectId, name: 'ToDeleteAnon' });

      const response = await testClient.delete(
        `/api/v1/actors/${createRes.body.id}`
      );

      expect(response.status).toBe(401);
    });

    test('returns 404 for non-existent actor', async () => {
      const response = await authenticatedTestClient(adminToken).delete(
        '/api/v1/actors/act_nonexistent'
      );

      expect(response.status).toBe(404);
    });
  });

  describe('PATCH /api/v1/actors/:id', () => {
    let actorId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/actors')
        .send({ project_id: projectId, name: 'UpdateMe', type: 'customer' });
      actorId = res.body.id;
    });

    test('user with permission can update an actor name', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/actors/${actorId}`)
        .send({ name: 'UpdatedName' });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(actorId);
      expect(response.body.name).toBe('UpdatedName');
    });

    test('user can update type and externalId', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/actors/${actorId}`)
        .send({ type: 'assistant', external_id: '+15551112222' });

      expect(response.status).toBe(200);
      expect(response.body.type).toBe('assistant');
      expect(response.body.external_id).toBe('+15551112222');
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .patch(`/api/v1/actors/${actorId}`)
        .send({ name: 'Hacked' });

      expect(response.status).toBe(401);
    });

    test('returns 404 for non-existent actor', async () => {
      const response = await authenticatedTestClient(adminToken)
        .patch('/api/v1/actors/act_nonexistent')
        .send({ name: 'Ghost' });

      expect(response.status).toBe(404);
    });
  });

  describe('PATCH /api/v1/actors/:id', () => {
    let actorId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/actors')
        .send({ project_id: projectId, name: 'UpdateMe', type: 'customer' });
      actorId = res.body.id;
    });

    test('user with permission can update an actor name', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/actors/${actorId}`)
        .send({ name: 'UpdatedName' });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(actorId);
      expect(response.body.name).toBe('UpdatedName');
    });

    test('user can update type and externalId', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/actors/${actorId}`)
        .send({ type: 'assistant', external_id: '+15559998888' });

      expect(response.status).toBe(200);
      expect(response.body.type).toBe('assistant');
      expect(response.body.external_id).toBe('+15559998888');
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .patch(`/api/v1/actors/${actorId}`)
        .send({ name: 'Hacked' });

      expect(response.status).toBe(401);
    });

    test('returns 404 for non-existent actor', async () => {
      const response = await authenticatedTestClient(adminToken)
        .patch('/api/v1/actors/act_nonexistent')
        .send({ name: 'Ghost' });

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/v1/actors with name and type filters (FEAT-9)', () => {
    beforeAll(async () => {
      await authenticatedTestClient(userToken).post('/api/v1/actors').send({
        project_id: projectId,
        name: 'NameFilterAgent',
        type: 'agent',
      });
      await authenticatedTestClient(userToken).post('/api/v1/actors').send({
        project_id: projectId,
        name: 'NameFilterCustomer',
        type: 'customer',
      });
      await authenticatedTestClient(userToken)
        .post('/api/v1/actors')
        .send({ project_id: projectId, name: 'Unrelated', type: 'agent' });
    });

    test('filtering by name (partial, case-insensitive) returns matching actors', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/actors?project_id=${projectId}&name=namefilter`
      );

      expect(response.status).toBe(200);
      const names = response.body.data.map((a: { name: string }) => {
        return a.name;
      });
      expect(names).toContain('NameFilterAgent');
      expect(names).toContain('NameFilterCustomer');
      expect(names).not.toContain('Unrelated');
    });

    test('filtering by type returns only matching actors', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/actors?project_id=${projectId}&type=customer`
      );

      expect(response.status).toBe(200);
      const types = response.body.data.map((a: { type: string }) => {
        return a.type;
      });
      expect(
        types.every((t: string) => {
          return t === 'customer';
        })
      ).toBe(true);
    });

    test('filtering by name and type combined', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/actors?project_id=${projectId}&name=namefilter&type=agent`
      );

      expect(response.status).toBe(200);
      const names = response.body.data.map((a: { name: string }) => {
        return a.name;
      });
      expect(names).toContain('NameFilterAgent');
      expect(names).not.toContain('NameFilterCustomer');
    });

    test('non-matching name filter returns empty array', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/actors?project_id=${projectId}&name=xyznonexistentxyz`
      );

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
    });
  });
});
