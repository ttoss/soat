import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('ActorTags', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectId: string;
  let actorId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');

    const createUserRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'actortagsuser', password: 'actortagspass' });

    userId = createUserRes.body.id;
    userToken = await loginAs('actortagsuser', 'actortagspass');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'ActorTags Test Project' });
    projectId = projectRes.body.id;

    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        permissions: [
          'actors:ListActors',
          'actors:GetActor',
          'actors:CreateActor',
          'actors:DeleteActor',
          'actors:UpdateActor',
        ],
      });
    const policyId = policyRes.body.id;

    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userId}/policies`)
      .send({ policy_ids: [policyId] });

    const actorRes = await authenticatedTestClient(userToken)
      .post('/api/v1/actors')
      .send({ project_id: projectId, name: 'TaggedActor' });
    actorId = actorRes.body.id;
  });

  describe('GET /api/v1/actors/:id/tags', () => {
    test('authenticated user can get actor tags', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/actors/${actorId}/tags`
      );

      expect(response.status).toBe(200);
    });

    test('returns empty object when actor has no tags', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/actors/${actorId}/tags`
      );

      expect(response.status).toBe(200);
      expect(response.body).toBeDefined();
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(`/api/v1/actors/${actorId}/tags`);

      expect(response.status).toBe(401);
    });

    test('returns 404 for non-existent actor', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/actors/act_nonexistent/tags'
      );

      expect(response.status).toBe(404);
    });
  });

  describe('PUT /api/v1/actors/:id/tags', () => {
    test('authenticated user can set actor tags', async () => {
      const response = await authenticatedTestClient(userToken)
        .put(`/api/v1/actors/${actorId}/tags`)
        .send({ environment: 'production', tier: 'premium' });

      expect(response.status).toBe(200);
    });

    test('PUT replaces all existing tags', async () => {
      await authenticatedTestClient(userToken)
        .put(`/api/v1/actors/${actorId}/tags`)
        .send({ initial: 'value' });

      await authenticatedTestClient(userToken)
        .put(`/api/v1/actors/${actorId}/tags`)
        .send({ replaced: 'new' });

      const getRes = await authenticatedTestClient(userToken).get(
        `/api/v1/actors/${actorId}/tags`
      );

      expect(getRes.status).toBe(200);
      expect(getRes.body).not.toHaveProperty('initial');
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .put(`/api/v1/actors/${actorId}/tags`)
        .send({ key: 'value' });

      expect(response.status).toBe(401);
    });

    test('returns 404 for non-existent actor', async () => {
      const response = await authenticatedTestClient(userToken)
        .put('/api/v1/actors/act_nonexistent/tags')
        .send({ key: 'value' });

      expect(response.status).toBe(404);
    });
  });

  describe('PATCH /api/v1/actors/:id/tags', () => {
    test('authenticated user can merge actor tags', async () => {
      await authenticatedTestClient(userToken)
        .put(`/api/v1/actors/${actorId}/tags`)
        .send({ existing: 'value' });

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/actors/${actorId}/tags`)
        .send({ newkey: 'newvalue' });

      expect(response.status).toBe(200);
    });

    test('PATCH preserves existing tags when merging', async () => {
      await authenticatedTestClient(userToken)
        .put(`/api/v1/actors/${actorId}/tags`)
        .send({ keep: 'me' });

      await authenticatedTestClient(userToken)
        .patch(`/api/v1/actors/${actorId}/tags`)
        .send({ added: 'tag' });

      const getRes = await authenticatedTestClient(userToken).get(
        `/api/v1/actors/${actorId}/tags`
      );

      expect(getRes.status).toBe(200);
      expect(getRes.body).toHaveProperty('keep', 'me');
      expect(getRes.body).toHaveProperty('added', 'tag');
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .patch(`/api/v1/actors/${actorId}/tags`)
        .send({ key: 'value' });

      expect(response.status).toBe(401);
    });

    test('returns 404 for non-existent actor', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch('/api/v1/actors/act_nonexistent/tags')
        .send({ key: 'value' });

      expect(response.status).toBe(404);
    });
  });
});
