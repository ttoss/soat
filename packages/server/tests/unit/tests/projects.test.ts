import { authenticatedTestClient, loginAs, testClient } from '../testClient';

describe('Projects', () => {
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
      .send({ username: 'alice', password: 'alicepass' });

    userId = createUserRes.body.id;
    userToken = await loginAs('alice', 'alicepass');
  });

  describe('POST /api/v1/projects', () => {
    test('admin can create a project', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'My Project' });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.name).toBe('My Project');
      expect(response.body.createdAt).toBeDefined();
      expect(response.body.updatedAt).toBeDefined();
    });

    test('unauthenticated request cannot create a project', async () => {
      const response = await testClient
        .post('/api/v1/projects')
        .send({ name: 'Unauthorized Project' });

      expect(response.status).toBe(401);
    });

    test('non-admin user cannot create a project', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/projects')
        .send({ name: 'Forbidden Project' });

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/projects', () => {
    test('admin can list all projects', async () => {
      const response =
        await authenticatedTestClient(adminToken).get('/api/v1/projects');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });

    test('unauthenticated request cannot list projects', async () => {
      const response = await testClient.get('/api/v1/projects');

      expect(response.status).toBe(401);
    });

    test('user only sees projects they are a member of', async () => {
      const projectRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Member Project' });
      const memberProjectId = projectRes.body.id;

      await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Other Project' });

      const policyRes = await authenticatedTestClient(adminToken)
        .post(`/api/v1/projects/${memberProjectId}/policies`)
        .send({ permissions: ['projects:GetProject'] });
      const policyId = policyRes.body.id;

      await authenticatedTestClient(adminToken)
        .post(`/api/v1/projects/${memberProjectId}/members`)
        .send({ userId, policyId });

      const response =
        await authenticatedTestClient(userToken).get('/api/v1/projects');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(
        response.body.some((p: { id: string }) => {
          return p.id === memberProjectId;
        })
      ).toBe(true);
      expect(response.body.length).toBe(1);
    });
    describe('project key only sees its scoped project', () => {
      let projectAId: string;
      let rawProjectKey: string;

      beforeAll(async () => {
        const projARes = await authenticatedTestClient(adminToken)
          .post('/api/v1/projects')
          .send({ name: 'project key Project A' });
        projectAId = projARes.body.id;

        const projBRes = await authenticatedTestClient(adminToken)
          .post('/api/v1/projects')
          .send({ name: 'project key Project B' });
        const projectBId = projBRes.body.id;

        const policyARes = await authenticatedTestClient(adminToken)
          .post(`/api/v1/projects/${projectAId}/policies`)
          .send({ permissions: ['projects:GetProject'] });
        const policyAId = policyARes.body.id;

        await authenticatedTestClient(adminToken)
          .post(`/api/v1/projects/${projectAId}/members`)
          .send({ userId, policyId: policyAId });

        const policyBRes = await authenticatedTestClient(adminToken)
          .post(`/api/v1/projects/${projectBId}/policies`)
          .send({ permissions: ['projects:GetProject'] });
        const policyBId = policyBRes.body.id;

        await authenticatedTestClient(adminToken)
          .post(`/api/v1/projects/${projectBId}/members`)
          .send({ userId, policyId: policyBId });

        const projectKeyRes = await authenticatedTestClient(userToken)
          .post('/api/v1/project-keys')
          .send({
            projectId: projectAId,
            policyId: policyAId,
            name: 'Scoped Key',
          });
        rawProjectKey = projectKeyRes.body.key;
      });

      test('project key user only sees the scoped project', async () => {
        const response =
          await authenticatedTestClient(rawProjectKey).get('/api/v1/projects');

        expect(response.status).toBe(200);
        expect(Array.isArray(response.body)).toBe(true);
        expect(response.body.length).toBe(1);
        expect(response.body[0].id).toBe(projectAId);
      });
    });
  });

  describe('GET /api/v1/projects/:id', () => {
    let projectId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Gettable Project' });
      projectId = res.body.id;
    });

    test('admin can get any project', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        `/api/v1/projects/${projectId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(projectId);
      expect(response.body.name).toBe('Gettable Project');
    });

    test('unauthenticated request cannot get a project', async () => {
      const response = await testClient.get(`/api/v1/projects/${projectId}`);

      expect(response.status).toBe(401);
    });

    test('user cannot get a project they are not a member of', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/projects/${projectId}`
      );

      expect(response.status).toBe(403);
    });

    test('user can get a project they are a member of', async () => {
      const policyRes = await authenticatedTestClient(adminToken)
        .post(`/api/v1/projects/${projectId}/policies`)
        .send({ permissions: ['projects:GetProject'] });
      const policyId = policyRes.body.id;

      await authenticatedTestClient(adminToken)
        .post(`/api/v1/projects/${projectId}/members`)
        .send({ userId, policyId });

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/projects/${projectId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(projectId);
    });

    test('returns 404 for unknown project id', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        '/api/v1/projects/proj_nonexistent12345'
      );

      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /api/v1/projects/:id', () => {
    test('admin can delete a project', async () => {
      const createRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'To Delete' });
      const { id } = createRes.body;

      const deleteRes = await authenticatedTestClient(adminToken).delete(
        `/api/v1/projects/${id}`
      );
      expect(deleteRes.status).toBe(204);

      const getRes = await authenticatedTestClient(adminToken).get(
        `/api/v1/projects/${id}`
      );
      expect(getRes.status).toBe(404);
    });

    test('unauthenticated request cannot delete a project', async () => {
      const createRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Not Deletable Unauth' });
      const { id } = createRes.body;

      const response = await testClient.delete(`/api/v1/projects/${id}`);

      expect(response.status).toBe(401);
    });

    test('non-admin user cannot delete a project', async () => {
      const createRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Not Deletable User' });
      const { id } = createRes.body;

      const response = await authenticatedTestClient(userToken).delete(
        `/api/v1/projects/${id}`
      );

      expect(response.status).toBe(403);
    });

    test('returns 404 when deleting non-existent project', async () => {
      const response = await authenticatedTestClient(adminToken).delete(
        '/api/v1/projects/proj_nonexistent12345'
      );

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/v1/projects/:projectId/policies', () => {
    let projectId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Policy Project' });
      projectId = res.body.id;
    });

    test('admin can create a project policy', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post(`/api/v1/projects/${projectId}/policies`)
        .send({ permissions: ['files:read', 'files:write'] });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.permissions).toEqual(['files:read', 'files:write']);
      expect(response.body.projectId).toBe(projectId);
    });

    test('admin can create a policy with notPermissions', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post(`/api/v1/projects/${projectId}/policies`)
        .send({
          permissions: ['files:read'],
          notPermissions: ['files:delete'],
        });

      expect(response.status).toBe(201);
      expect(response.body.notPermissions).toEqual(['files:delete']);
    });

    test('unauthenticated request cannot create a policy', async () => {
      const response = await testClient
        .post(`/api/v1/projects/${projectId}/policies`)
        .send({ permissions: ['files:read'] });

      expect(response.status).toBe(401);
    });

    test('non-admin user cannot create a policy', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/projects/${projectId}/policies`)
        .send({ permissions: ['files:read'] });

      expect(response.status).toBe(403);
    });

    test('returns 404 for non-existent project', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects/proj_nonexistent12345/policies')
        .send({ permissions: ['files:read'] });

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/v1/projects/:projectId/policies', () => {
    let projectId: string;
    let memberUserToken: string;
    let memberUserId: string;

    beforeAll(async () => {
      const projRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'List Policies Project' });
      projectId = projRes.body.id;

      const userRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/users')
        .send({ username: 'policyuser', password: 'policypass' });
      memberUserId = userRes.body.id;
      memberUserToken = await loginAs('policyuser', 'policypass');

      const policyRes = await authenticatedTestClient(adminToken)
        .post(`/api/v1/projects/${projectId}/policies`)
        .send({ permissions: ['projects:GetProject'] });

      await authenticatedTestClient(adminToken)
        .post(`/api/v1/projects/${projectId}/members`)
        .send({ userId: memberUserId, policyId: policyRes.body.id });
    });

    test('admin can list project policies', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        `/api/v1/projects/${projectId}/policies`
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
    });

    test('project member can list policies', async () => {
      const response = await authenticatedTestClient(memberUserToken).get(
        `/api/v1/projects/${projectId}/policies`
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });

    test('unauthenticated request cannot list policies', async () => {
      const response = await testClient.get(
        `/api/v1/projects/${projectId}/policies`
      );

      expect(response.status).toBe(401);
    });

    test('non-member user cannot list policies', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/projects/${projectId}/policies`
      );

      expect(response.status).toBe(403);
    });
  });

  describe('POST /api/v1/projects/:projectId/members', () => {
    let projectId: string;
    let policyId: string;

    beforeAll(async () => {
      const projRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Members Project' });
      projectId = projRes.body.id;

      const policyRes = await authenticatedTestClient(adminToken)
        .post(`/api/v1/projects/${projectId}/policies`)
        .send({ permissions: ['projects:GetProject'] });
      policyId = policyRes.body.id;
    });

    test('admin can add a user to a project', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post(`/api/v1/projects/${projectId}/members`)
        .send({ userId, policyId });

      expect(response.status).toBe(201);
    });

    test('unauthenticated request cannot add a member', async () => {
      const response = await testClient
        .post(`/api/v1/projects/${projectId}/members`)
        .send({ userId, policyId });

      expect(response.status).toBe(401);
    });

    test('non-admin user cannot add a member', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/projects/${projectId}/members`)
        .send({ userId, policyId });

      expect(response.status).toBe(403);
    });

    test('returns 404 for non-existent project', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects/proj_nonexistent12345/members')
        .send({ userId, policyId });

      expect(response.status).toBe(404);
    });
  });

  describe('cascade deletion when a project is deleted', () => {
    test('deleting a project removes its policies, memberships, and project keys', async () => {
      const projRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Cascade Test Project' });
      expect(projRes.status).toBe(201);
      const projectId = projRes.body.id;

      const policyRes = await authenticatedTestClient(adminToken)
        .post(`/api/v1/projects/${projectId}/policies`)
        .send({ permissions: ['projects:GetProject'] });
      expect(policyRes.status).toBe(201);
      const policyId = policyRes.body.id;

      const memberRes = await authenticatedTestClient(adminToken)
        .post(`/api/v1/projects/${projectId}/members`)
        .send({ userId, policyId });
      expect(memberRes.status).toBe(201);

      const projectKeyRes = await authenticatedTestClient(userToken)
        .post('/api/v1/project-keys')
        .send({ projectId, policyId, name: 'Cascade Test Key' });
      expect(projectKeyRes.status).toBe(201);
      const projectKeyId = projectKeyRes.body.id;

      const deleteRes = await authenticatedTestClient(adminToken).delete(
        `/api/v1/projects/${projectId}`
      );
      expect(deleteRes.status).toBe(204);

      // Policies cascade-deleted: project no longer found, so list returns []
      const policiesRes = await authenticatedTestClient(adminToken).get(
        `/api/v1/projects/${projectId}/policies`
      );
      expect(policiesRes.body).toEqual([]);

      // UserProject cascade-deleted: deleted project no longer in alice's project list
      const projectsRes =
        await authenticatedTestClient(userToken).get('/api/v1/projects');
      const projectIds = projectsRes.body.map((p: { id: string }) => {
        return p.id;
      });
      expect(projectIds).not.toContain(projectId);

      // ProjectKey cascade-deleted: key no longer found
      const projectKeyGetRes = await authenticatedTestClient(userToken).get(
        `/api/v1/project-keys/${projectKeyId}`
      );
      expect(projectKeyGetRes.status).toBe(404);
    });
  });
});
