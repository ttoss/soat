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
      expect(Array.isArray(response.body)).toBe(true);
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
  });

  describe('POST /api/v1/policies', () => {
    test('admin can create a policy with shorthand permissions', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          name: 'Shorthand Policy',
          permissions: ['files:GetFile'],
          not_permissions: ['files:DeleteFile'],
        });

      expect(response.status).toBe(201);
      expect(response.body.id).toMatch(/^pol_/);
      expect(response.body.name).toBe('Shorthand Policy');
      expect(response.body.permissions).toEqual(['files:GetFile']);
      expect(response.body.not_permissions).toEqual(['files:DeleteFile']);
      expect(response.body.created_at).toBeDefined();
      expect(response.body.updated_at).toBeDefined();
    });

    test('admin can create a policy with full document', async () => {
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
            ],
          },
        });

      expect(response.status).toBe(201);
      expect(response.body.id).toMatch(/^pol_/);
      expect(response.body.name).toBe('Full Doc Policy');
      expect(response.body.permissions).toContain('files:GetFile');
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post('/api/v1/policies')
        .send({ permissions: ['files:GetFile'] });

      expect(response.status).toBe(401);
    });

    test('non-admin user returns 403', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/policies')
        .send({ permissions: ['files:GetFile'] });

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/policies/:policyId', () => {
    let policyId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({ name: 'Get Me', permissions: ['files:GetFile'] });

      policyId = res.body.id;
    });

    test('admin can get a policy by id', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        `/api/v1/policies/${policyId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(policyId);
      expect(response.body.name).toBe('Get Me');
      expect(response.body.permissions).toEqual(['files:GetFile']);
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
        .send({ name: 'Update Me', permissions: ['files:GetFile'] });

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
                action: ['files:GetFile', 'files:ListFiles'],
              },
            ],
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(policyId);
      expect(response.body.name).toBe('Updated Policy');
      expect(response.body.permissions).toContain('files:GetFile');
      expect(response.body.permissions).toContain('files:ListFiles');
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

    test('returns 404 for non-existent policy', async () => {
      const response = await authenticatedTestClient(adminToken)
        .put('/api/v1/policies/pol_nonexistent12345')
        .send({ document: { statement: [] } });

      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /api/v1/policies/:policyId', () => {
    test('admin can delete a policy', async () => {
      const createRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({ permissions: ['files:GetFile'] });

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
        .send({ permissions: ['files:GetFile'] });

      const response = await testClient.delete(
        `/api/v1/policies/${createRes.body.id}`
      );

      expect(response.status).toBe(401);
    });

    test('non-admin user returns 403', async () => {
      const createRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({ permissions: ['files:GetFile'] });

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
        .send({ permissions: ['files:GetFile'] });

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

  describe('GET /api/v1/users/:userId/policies', () => {
    let policyId: string;
    let targetUserId: string;

    beforeAll(async () => {
      const userRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/users')
        .send({ username: 'policytarget', password: 'policytargetpass' });

      targetUserId = userRes.body.id;

      const policyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({ name: 'Target Policy', permissions: ['files:GetFile'] });

      policyId = policyRes.body.id;

      await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${targetUserId}/policies`)
        .send({ policy_ids: [policyId] });
    });

    test('admin can list user policies', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        `/api/v1/users/${targetUserId}/policies`
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(
        response.body.some((p: { id: string }) => {
          return p.id === policyId;
        })
      ).toBe(true);
    });

    test('returned policy has expected shape', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        `/api/v1/users/${targetUserId}/policies`
      );

      const policy = response.body.find((p: { id: string }) => {
        return p.id === policyId;
      });
      expect(policy.id).toMatch(/^pol_/);
      expect(policy.name).toBe('Target Policy');
      expect(policy.permissions).toBeDefined();
      expect(policy.not_permissions).toBeDefined();
      expect(policy.created_at).toBeDefined();
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/users/${targetUserId}/policies`
      );

      expect(response.status).toBe(401);
    });

    test('non-admin user returns 403', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/users/${targetUserId}/policies`
      );

      expect(response.status).toBe(403);
    });

    test('returns 404 for non-existent user', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        '/api/v1/users/usr_nonexistent12345/policies'
      );

      expect(response.status).toBe(404);
    });
  });
});
