import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('API Keys', () => {
  let adminToken: string;
  let aliceToken: string;
  let aliceId: string;
  let bobToken: string;
  let projectId: string;
  let policyId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');

    const aliceRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'akeyalice', password: 'alicepass' });

    aliceId = aliceRes.body.id;
    aliceToken = await loginAs('akeyalice', 'alicepass');

    await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'akeybob', password: 'bobpass' });

    bobToken = await loginAs('akeybob', 'bobpass');

    const projRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'API Key Test Project' });

    projectId = projRes.body.id;

    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [{ effect: 'Allow', action: ['files:GetFile'] }],
        },
      });

    policyId = policyRes.body.id;
  });

  describe('POST /api/v1/api-keys', () => {
    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post('/api/v1/api-keys')
        .send({ name: 'Test' });

      expect(response.status).toBe(401);
    });

    test('missing name returns 400', async () => {
      const response = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({});

      expect(response.status).toBe(400);
    });

    test('omitting project_id creates an unscoped key (201)', async () => {
      const response = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({ name: 'No Project Key' });

      expect(response.status).toBe(201);
      expect(response.body.id).toMatch(/^key_/);
      expect(response.body.key).toMatch(/^sk_/);
    });

    test('explicit null project_id creates an unscoped key (201)', async () => {
      const response = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({ name: 'Null Project Key', project_id: null });

      expect(response.status).toBe(201);
      expect(response.body.id).toMatch(/^key_/);
    });

    test('invalid project_id returns 400', async () => {
      const response = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({ name: 'Test', project_id: 'proj_nonexistent12345' });

      expect(response.status).toBe(400);
    });

    test('invalid policy_ids returns 400', async () => {
      const response = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({
          name: 'Test',
          project_id: projectId,
          policy_ids: ['pol_nonexistent12345'],
        });

      expect(response.status).toBe(400);
    });

    test('user can create an API key with project and policy', async () => {
      const response = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({
          name: 'Alice Key',
          project_id: projectId,
          policy_ids: [policyId],
        });

      expect(response.status).toBe(201);
      expect(response.body.id).toMatch(/^key_/);
      expect(response.body.name).toBe('Alice Key');
      expect(response.body.key).toMatch(/^sk_/);
      expect(response.body.key_prefix).toBeDefined();
      expect(response.body.key_prefix).toBe(response.body.key.slice(0, 8));
      expect(response.body.created_at).toBeDefined();
      expect(response.body.updated_at).toBeDefined();
      // raw key is only returned at creation — no user_id/project_id/policy_ids in create response
      expect(response.body.user_id).toBeUndefined();
    });

    test('user can create a minimal API key with just name and project', async () => {
      const response = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({ name: 'Minimal Key', project_id: projectId });

      expect(response.status).toBe(201);
      expect(response.body.id).toMatch(/^key_/);
      expect(response.body.key).toMatch(/^sk_/);
    });

    test('empty policy_ids array creates a policy-less key', async () => {
      const response = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({
          name: 'No Policies Key',
          project_id: projectId,
          policy_ids: [],
        });

      expect(response.status).toBe(201);
      expect(response.body.id).toMatch(/^key_/);
    });

    test('admin can also create an API key', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/api-keys')
        .send({ name: 'Admin Key', project_id: projectId });

      expect(response.status).toBe(201);
      expect(response.body.key).toMatch(/^sk_/);
    });
  });

  describe('GET /api/v1/api-keys/:id', () => {
    let keyId: string;
    let rawKey: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({
          name: 'Get Test Key',
          project_id: projectId,
          policy_ids: [policyId],
        });

      keyId = res.body.id;
      rawKey = res.body.key;
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(`/api/v1/api-keys/${keyId}`);

      expect(response.status).toBe(401);
    });

    test('non-existent key returns 404', async () => {
      const response = await authenticatedTestClient(aliceToken).get(
        '/api/v1/api-keys/key_nonexistent12345'
      );

      expect(response.status).toBe(404);
    });

    test('other user returns 403', async () => {
      const response = await authenticatedTestClient(bobToken).get(
        `/api/v1/api-keys/${keyId}`
      );

      expect(response.status).toBe(403);
    });

    test('owner can get key details', async () => {
      const response = await authenticatedTestClient(aliceToken).get(
        `/api/v1/api-keys/${keyId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(keyId);
      expect(response.body.name).toBe('Get Test Key');
      expect(response.body.key_prefix).toBeDefined();
      expect(response.body.user_id).toBe(aliceId);
      expect(response.body.project_id).toBe(projectId);
      expect(response.body.policy_ids).toContain(policyId);
      expect(response.body.created_at).toBeDefined();
      expect(response.body.updated_at).toBeDefined();
    });

    test('raw key is never returned in GET response', async () => {
      const response = await authenticatedTestClient(aliceToken).get(
        `/api/v1/api-keys/${keyId}`
      );

      expect(response.body.key).toBeUndefined();
    });

    test('admin can get any key', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        `/api/v1/api-keys/${keyId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(keyId);
    });

    test('api key bearer auth works with raw key', async () => {
      const response = await authenticatedTestClient(rawKey).get(
        `/api/v1/api-keys/${keyId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(keyId);
    });
  });

  describe('PUT /api/v1/api-keys/:id', () => {
    let keyId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({ name: 'Put Test Key', project_id: projectId });

      keyId = res.body.id;
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .put(`/api/v1/api-keys/${keyId}`)
        .send({ name: 'Updated' });

      expect(response.status).toBe(401);
    });

    test('non-existent key returns 404', async () => {
      const response = await authenticatedTestClient(aliceToken)
        .put('/api/v1/api-keys/key_nonexistent12345')
        .send({ name: 'Updated' });

      expect(response.status).toBe(404);
    });

    test('other user returns 403', async () => {
      const response = await authenticatedTestClient(bobToken)
        .put(`/api/v1/api-keys/${keyId}`)
        .send({ name: 'Updated' });

      expect(response.status).toBe(403);
    });

    test('owner can update key name', async () => {
      const response = await authenticatedTestClient(aliceToken)
        .put(`/api/v1/api-keys/${keyId}`)
        .send({ name: 'Updated Key Name' });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(keyId);
      expect(response.body.name).toBe('Updated Key Name');
      expect(response.body.key).toBeUndefined();
    });

    test('owner can attach policies via update', async () => {
      const response = await authenticatedTestClient(aliceToken)
        .put(`/api/v1/api-keys/${keyId}`)
        .send({ policy_ids: [policyId] });

      expect(response.status).toBe(200);
      expect(response.body.policy_ids).toContain(policyId);
    });

    test('owner can re-scope key to a different project via update', async () => {
      const otherProj = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Put Re-scope Project' });

      const response = await authenticatedTestClient(aliceToken)
        .put(`/api/v1/api-keys/${keyId}`)
        .send({ project_id: otherProj.body.id });

      expect(response.status).toBe(200);
      expect(response.body.project_id).toBe(otherProj.body.id);
    });

    test('owner can clear project scope with project_id null', async () => {
      const response = await authenticatedTestClient(aliceToken)
        .put(`/api/v1/api-keys/${keyId}`)
        .send({ project_id: null });

      expect(response.status).toBe(200);
      expect(response.body.project_id).toBeNull();
    });

    test('owner can re-scope an unscoped key back to a project', async () => {
      // The previous test cleared this key's scope; set it back to a project.
      const response = await authenticatedTestClient(aliceToken)
        .put(`/api/v1/api-keys/${keyId}`)
        .send({ project_id: projectId });

      expect(response.status).toBe(200);
      expect(response.body.project_id).toBe(projectId);
    });

    test('invalid policy_ids on update returns 400', async () => {
      const response = await authenticatedTestClient(aliceToken)
        .put(`/api/v1/api-keys/${keyId}`)
        .send({ policy_ids: ['pol_nonexistent12345'] });

      expect(response.status).toBe(400);
    });
  });

  describe('DELETE /api/v1/api-keys/:id', () => {
    test('unauthenticated request returns 401', async () => {
      const createRes = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({ name: 'Delete Unauth', project_id: projectId });

      const response = await testClient.delete(
        `/api/v1/api-keys/${createRes.body.id}`
      );

      expect(response.status).toBe(401);
    });

    test('other user returns 403', async () => {
      const createRes = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({ name: 'Delete Other', project_id: projectId });

      const response = await authenticatedTestClient(bobToken).delete(
        `/api/v1/api-keys/${createRes.body.id}`
      );

      expect(response.status).toBe(403);
    });

    test('non-existent key returns 404', async () => {
      const response = await authenticatedTestClient(aliceToken).delete(
        '/api/v1/api-keys/key_nonexistent12345'
      );

      expect(response.status).toBe(404);
    });

    test('owner can delete their key', async () => {
      const createRes = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({ name: 'Delete Me', project_id: projectId });

      const keyId = createRes.body.id;

      const deleteRes = await authenticatedTestClient(aliceToken).delete(
        `/api/v1/api-keys/${keyId}`
      );

      expect(deleteRes.status).toBe(204);

      const getRes = await authenticatedTestClient(aliceToken).get(
        `/api/v1/api-keys/${keyId}`
      );

      expect(getRes.status).toBe(404);
    });

    test('admin can delete any key', async () => {
      const createRes = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({ name: 'Admin Delete Me', project_id: projectId });

      const keyId = createRes.body.id;

      const deleteRes = await authenticatedTestClient(adminToken).delete(
        `/api/v1/api-keys/${keyId}`
      );

      expect(deleteRes.status).toBe(204);
    });
  });

  describe('GET /api/v1/api-keys', () => {
    let aliceKeyId: string;
    let bobKeyId: string;
    let scopedProjectId: string;
    let scopedKeyId: string;
    let rawScopedKey: string;

    beforeAll(async () => {
      const aliceKeyRes = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({ name: 'Alice List Key', project_id: projectId });

      aliceKeyId = aliceKeyRes.body.id;

      const bobKeyRes = await authenticatedTestClient(bobToken)
        .post('/api/v1/api-keys')
        .send({ name: 'Bob List Key', project_id: projectId });

      bobKeyId = bobKeyRes.body.id;

      const projRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'List Keys Project' });

      scopedProjectId = projRes.body.id;

      const scopedKeyRes = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({ name: 'Scoped List Key', project_id: scopedProjectId });

      scopedKeyId = scopedKeyRes.body.id;
      rawScopedKey = scopedKeyRes.body.key;
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get('/api/v1/api-keys');

      expect(response.status).toBe(401);
    });

    test('admin can list all API keys', async () => {
      const response =
        await authenticatedTestClient(adminToken).get('/api/v1/api-keys');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      const ids = response.body.map((k: { id: string }) => {
        return k.id;
      });
      expect(ids).toContain(aliceKeyId);
      expect(ids).toContain(bobKeyId);
      expect(ids).toContain(scopedKeyId);
    });

    test('regular user sees only their own API keys', async () => {
      const response =
        await authenticatedTestClient(aliceToken).get('/api/v1/api-keys');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      const ids = response.body.map((k: { id: string }) => {
        return k.id;
      });
      expect(ids).toContain(aliceKeyId);
      expect(ids).toContain(scopedKeyId);
      expect(ids).not.toContain(bobKeyId);
    });

    test('API key scoped to a project only sees keys scoped to that project', async () => {
      const response =
        await authenticatedTestClient(rawScopedKey).get('/api/v1/api-keys');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      const ids = response.body.map((k: { id: string }) => {
        return k.id;
      });
      expect(ids).toContain(scopedKeyId);
      expect(ids).not.toContain(aliceKeyId);
      expect(ids).not.toContain(bobKeyId);
    });

    test('response includes expected fields', async () => {
      const response =
        await authenticatedTestClient(aliceToken).get('/api/v1/api-keys');

      expect(response.status).toBe(200);
      const key = response.body.find((k: { id: string }) => {
        return k.id === scopedKeyId;
      });
      expect(key).toBeDefined();
      expect(key.id).toMatch(/^key_/);
      expect(key.name).toBe('Scoped List Key');
      expect(key.key_prefix).toBeDefined();
      expect(key.user_id).toBeDefined();
      expect(key.project_id).toBe(scopedProjectId);
      expect(Array.isArray(key.policy_ids)).toBe(true);
      expect(key.created_at).toBeDefined();
      expect(key.updated_at).toBeDefined();
      expect(key.key).toBeUndefined();
    });
  });

  describe('API key project scoping', () => {
    let projectAId: string;
    let rawKey: string;

    beforeAll(async () => {
      const projARes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Scope Project A' });

      projectAId = projARes.body.id;

      await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Scope Project B' });

      // Give alice a policy that allows listing projects and files
      const listPolicyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [
              {
                effect: 'Allow',
                action: ['projects:ListProjects', 'files:GetFile'],
              },
            ],
          },
        });

      await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${aliceId}/policies`)
        .send({ policy_ids: [listPolicyRes.body.id] });

      const keyRes = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({ name: 'Scoped Key', project_id: projectAId });

      rawKey = keyRes.body.key;
    });

    test('api key scoped to project only sees that project when listing', async () => {
      const response =
        await authenticatedTestClient(rawKey).get('/api/v1/projects');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBe(1);
      expect(response.body[0].id).toBe(projectAId);
    });

    test('a policy-less key falls back to the owning user policies for getPolicies', async () => {
      // The key itself has no policy_ids, so files.ts's `authUser.getPolicies`
      // call falls back to alice's own user-level policies (createApiKeyGetPolicies's
      // userPolicyIds branch) to evaluate `files:GetFile` access.
      const response = await authenticatedTestClient(rawKey).get(
        `/api/v1/files?project_id=${projectAId}`
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    afterAll(async () => {
      // Detach alice's project-listing policy so it doesn't bleed into other tests
      await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${aliceId}/policies`)
        .send({ policy_ids: [] });
    });
  });

  describe('Unscoped API keys (no project scope)', () => {
    let projX: string;
    let projY: string;
    let listAllPolicyId: string;

    beforeAll(async () => {
      const xRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Unscoped Project X' });
      projX = xRes.body.id;

      const yRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Unscoped Project Y' });
      projY = yRes.body.id;

      // A user-level policy allowing alice to list projects everywhere.
      const listAllRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [{ effect: 'Allow', action: ['projects:ListProjects'] }],
          },
        });
      listAllPolicyId = listAllRes.body.id;

      await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${aliceId}/policies`)
        .send({ policy_ids: [listAllPolicyId] });
    });

    afterAll(async () => {
      await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${aliceId}/policies`)
        .send({ policy_ids: [] });
    });

    test('GET on an unscoped key reports project_id null', async () => {
      const create = await authenticatedTestClient(adminToken)
        .post('/api/v1/api-keys')
        .send({ name: 'Unscoped GET Key' });

      const get = await authenticatedTestClient(adminToken).get(
        `/api/v1/api-keys/${create.body.id}`
      );

      expect(get.status).toBe(200);
      expect(get.body.project_id).toBeNull();
    });

    test('list shows unscoped keys with project_id null', async () => {
      const create = await authenticatedTestClient(adminToken)
        .post('/api/v1/api-keys')
        .send({ name: 'Unscoped List Key' });

      const list =
        await authenticatedTestClient(adminToken).get('/api/v1/api-keys');
      const found = list.body.find((k: { id: string }) => {
        return k.id === create.body.id;
      });
      expect(found).toBeDefined();
      expect(found.project_id).toBeNull();
    });

    test('unscoped admin key can reach more than one project', async () => {
      const create = await authenticatedTestClient(adminToken)
        .post('/api/v1/api-keys')
        .send({ name: 'Unscoped Admin Span Key' });
      const raw = create.body.key;

      const res = await authenticatedTestClient(raw).get('/api/v1/projects');

      expect(res.status).toBe(200);
      const ids = res.body.map((p: { id: string }) => {
        return p.id;
      });
      expect(ids).toContain(projX);
      expect(ids).toContain(projY);
    });

    test('unscoped key owned by a regular user spans the projects the user can access', async () => {
      const create = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({ name: 'Unscoped Alice Span Key' });
      const raw = create.body.key;

      const res = await authenticatedTestClient(raw).get('/api/v1/projects');

      expect(res.status).toBe(200);
      const ids = res.body.map((p: { id: string }) => {
        return p.id;
      });
      expect(ids).toContain(projX);
      expect(ids).toContain(projY);
    });

    test('a key policy narrows an unscoped key to the intersection with owner policies', async () => {
      // Key policy allows ListProjects only on project X. Intersected with
      // alice's allow-everywhere ListProjects, the key can see X but not Y.
      const keyPolicyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [
              {
                effect: 'Allow',
                action: ['projects:ListProjects'],
                resource: [`soat:${projX}:*:*`],
              },
            ],
          },
        });

      const create = await authenticatedTestClient(aliceToken)
        .post('/api/v1/api-keys')
        .send({
          name: 'Unscoped Narrowed Key',
          policy_ids: [keyPolicyRes.body.id],
        });
      const raw = create.body.key;

      const res = await authenticatedTestClient(raw).get('/api/v1/projects');

      expect(res.status).toBe(200);
      const ids = res.body.map((p: { id: string }) => {
        return p.id;
      });
      expect(ids).toContain(projX);
      expect(ids).not.toContain(projY);
    });

    test('an unscoped key cannot exceed an owner who has no permissions', async () => {
      // bob is a regular user with no attached policies.
      const create = await authenticatedTestClient(bobToken)
        .post('/api/v1/api-keys')
        .send({ name: 'Unscoped Bob Key' });
      const raw = create.body.key;

      const res = await authenticatedTestClient(raw).get('/api/v1/projects');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
    });
  });
});
