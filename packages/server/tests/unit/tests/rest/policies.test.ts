import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('Policies', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');

    const createUserRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'policyuser', password: 'policyuserpass' });

    userId = createUserRes.body.id;
    userToken = await loginAs('policyuser', 'policyuserpass');
  });

  describe('GET /api/v1/policies', () => {
    test('admin can list policies', async () => {
      const response =
        await authenticatedTestClient(adminToken).get('/api/v1/policies');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get('/api/v1/policies');

      expect(response.status).toBe(401);
    });

    test('non-admin user returns 403', async () => {
      const response =
        await authenticatedTestClient(userToken).get('/api/v1/policies');

      expect(response.status).toBe(403);
    });

    test('admin can list policies filtered by user_id', async () => {
      const policyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          name: 'user-filter-policy',
          document: {
            statement: [{ effect: 'Allow', action: ['files:GetFile'] }],
          },
        });
      const policyId = policyRes.body.id;

      await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${userId}/policies`)
        .send({ policy_ids: [policyId] });

      const response = await authenticatedTestClient(adminToken).get(
        `/api/v1/policies?user_id=${userId}`
      );

      expect(response.status).toBe(200);
      expect(
        response.body.data.map((p: { id: string }) => {
          return p.id;
        })
      ).toEqual([policyId]);
    });

    test('listing by an unknown user_id returns an empty array', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        '/api/v1/policies?user_id=user_doesnotexist0'
      );

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
    });
  });

  describe('POST /api/v1/policies', () => {
    test('admin can create a policy with document', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          name: 'Full Doc Policy',
          document: {
            statement: [
              {
                effect: 'Allow',
                action: ['files:GetFile'],
                resource: ['*'],
              },
              {
                effect: 'Deny',
                action: ['files:DeleteFile'],
              },
            ],
          },
        });

      expect(response.status).toBe(201);
      expect(response.body.id).toMatch(/^pol_/);
      expect(response.body.name).toBe('Full Doc Policy');
      expect(response.body.document.statement[0].action).toContain(
        'files:GetFile'
      );
      expect(response.body.document.statement[1].action).toContain(
        'files:DeleteFile'
      );
      expect(response.body.created_at).toBeDefined();
      expect(response.body.updated_at).toBeDefined();
    });

    test('returns 400 for a document with an invalid effect', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          name: 'Invalid Effect Policy',
          document: {
            statement: [{ effect: 'MaybeAllow', action: ['files:GetFile'] }],
          },
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('returns 400 when document is missing', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({ name: 'No Document Policy' });

      expect(response.status).toBe(400);
    });

    test('returns 400 for an unknown/typo action string (F-11)', async () => {
      // A mis-named action must be rejected at create time so a `Deny` cannot
      // silently no-op against a nonexistent action.
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          name: 'Typo Action Policy',
          document: {
            statement: [
              {
                effect: 'Deny',
                action: ['memories:CreateMemoryEntryy'],
                resource: ['*'],
              },
            ],
          },
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid policy document');
      expect(
        response.body.details.some((d: string) => {
          return d.includes('memories:CreateMemoryEntryy');
        })
      ).toBe(true);
    });

    test('returns 400 for an action whose module does not exist (F-11)', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          name: 'Unknown Module Policy',
          document: {
            statement: [{ effect: 'Allow', action: ['nonexistent:DoThing'] }],
          },
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid policy document');
    });

    test('accepts a real memory-write action and a module wildcard (F-11)', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          name: 'Valid Memory Policy',
          document: {
            statement: [
              {
                effect: 'Deny',
                action: [
                  'memories:CreateMemoryEntry',
                  'memories:UpdateMemoryEntry',
                ],
                resource: ['*'],
              },
              { effect: 'Allow', action: ['memories:*'] },
            ],
          },
        });

      expect(response.status).toBe(201);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.post('/api/v1/policies').send({
        document: {
          statement: [{ effect: 'Allow', action: ['files:GetFile'] }],
        },
      });

      expect(response.status).toBe(401);
    });

    test('non-admin user returns 403', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [{ effect: 'Allow', action: ['files:GetFile'] }],
          },
        });

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/policies/:policyId', () => {
    let policyId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          name: 'Get Me',
          document: {
            statement: [{ effect: 'Allow', action: ['files:GetFile'] }],
          },
        });

      policyId = res.body.id;
    });

    test('admin can get a policy by id', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        `/api/v1/policies/${policyId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(policyId);
      expect(response.body.name).toBe('Get Me');
      expect(response.body.document.statement[0].action).toContain(
        'files:GetFile'
      );
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(`/api/v1/policies/${policyId}`);

      expect(response.status).toBe(401);
    });

    test('non-admin user returns 403', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/policies/${policyId}`
      );

      expect(response.status).toBe(403);
    });

    test('returns 404 for non-existent policy', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        '/api/v1/policies/pol_nonexistent12345'
      );

      expect(response.status).toBe(404);
    });
  });

  describe('PUT /api/v1/policies/:policyId', () => {
    let policyId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          name: 'Update Me',
          document: {
            statement: [{ effect: 'Allow', action: ['files:GetFile'] }],
          },
        });

      policyId = res.body.id;
    });

    test('admin can update a policy', async () => {
      const response = await authenticatedTestClient(adminToken)
        .put(`/api/v1/policies/${policyId}`)
        .send({
          name: 'Updated Policy',
          document: {
            statement: [
              {
                effect: 'Allow',
                action: ['files:GetFile', 'files:DeleteFile'],
              },
            ],
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(policyId);
      expect(response.body.name).toBe('Updated Policy');
      expect(response.body.document.statement[0].action).toContain(
        'files:GetFile'
      );
      expect(response.body.document.statement[0].action).toContain(
        'files:DeleteFile'
      );
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .put(`/api/v1/policies/${policyId}`)
        .send({ document: { statement: [] } });

      expect(response.status).toBe(401);
    });

    test('non-admin user returns 403', async () => {
      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/policies/${policyId}`)
        .send({ document: { statement: [] } });

      expect(response.status).toBe(403);
    });

    test('keeps the existing name when name is omitted', async () => {
      const response = await authenticatedTestClient(adminToken)
        .put(`/api/v1/policies/${policyId}`)
        .send({
          document: {
            statement: [{ effect: 'Allow', action: ['files:GetFile'] }],
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.name).toBe('Updated Policy');
    });

    test('returns 400 for a document with an invalid effect', async () => {
      const response = await authenticatedTestClient(adminToken)
        .put(`/api/v1/policies/${policyId}`)
        .send({
          document: {
            statement: [{ effect: 'MaybeAllow', action: ['files:GetFile'] }],
          },
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    test('returns 404 for non-existent policy', async () => {
      const response = await authenticatedTestClient(adminToken)
        .put('/api/v1/policies/pol_nonexistent12345')
        .send({ document: { statement: [] } });

      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /api/v1/policies/:policyId', () => {
    const sendDoc = () => {
      return {
        document: {
          statement: [{ effect: 'Allow', action: ['files:GetFile'] }],
        },
      };
    };

    test('admin can delete a policy', async () => {
      const createRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send(sendDoc());

      const policyId = createRes.body.id;

      const deleteRes = await authenticatedTestClient(adminToken).delete(
        `/api/v1/policies/${policyId}`
      );
      expect(deleteRes.status).toBe(204);

      const getRes = await authenticatedTestClient(adminToken).get(
        `/api/v1/policies/${policyId}`
      );
      expect(getRes.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const createRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send(sendDoc());

      const response = await testClient.delete(
        `/api/v1/policies/${createRes.body.id}`
      );

      expect(response.status).toBe(401);
    });

    test('non-admin user returns 403', async () => {
      const createRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send(sendDoc());

      const response = await authenticatedTestClient(userToken).delete(
        `/api/v1/policies/${createRes.body.id}`
      );

      expect(response.status).toBe(403);
    });

    test('returns 404 for non-existent policy', async () => {
      const response = await authenticatedTestClient(adminToken).delete(
        '/api/v1/policies/pol_nonexistent12345'
      );

      expect(response.status).toBe(404);
    });
  });

  describe('PUT /api/v1/users/:userId/policies', () => {
    let policyId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [{ effect: 'Allow', action: ['files:GetFile'] }],
          },
        });

      policyId = res.body.id;
    });

    test('admin can attach policies to a user', async () => {
      const response = await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${userId}/policies`)
        .send({ policy_ids: [policyId] });

      expect(response.status).toBe(204);
    });

    test('can clear user policies by passing empty array', async () => {
      const response = await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${userId}/policies`)
        .send({ policy_ids: [] });

      expect(response.status).toBe(204);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .put(`/api/v1/users/${userId}/policies`)
        .send({ policy_ids: [policyId] });

      expect(response.status).toBe(401);
    });

    test('non-admin user returns 403', async () => {
      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/users/${userId}/policies`)
        .send({ policy_ids: [policyId] });

      expect(response.status).toBe(403);
    });

    test('returns 404 for non-existent user', async () => {
      const response = await authenticatedTestClient(adminToken)
        .put('/api/v1/users/usr_nonexistent12345/policies')
        .send({ policy_ids: [policyId] });

      expect(response.status).toBe(404);
    });
  });
});
