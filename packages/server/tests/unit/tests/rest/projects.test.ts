import jwt from 'jsonwebtoken';
import { db } from 'src/db';
import { JWT_SECRET } from 'src/middleware/auth';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

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
      expect(response.body.created_at).toBeDefined();
      expect(response.body.updated_at).toBeDefined();
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

    test('missing name returns 400', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({});

      expect(response.status).toBe(400);
    });

    test('non-string name returns 400', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 123 });

      expect(response.status).toBe(400);
    });

    test('unknown body field returns 400 VALIDATION_FAILED', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Strict Project', description: 'not a field' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.message).toMatch(/description/);
    });
  });

  describe('GET /api/v1/projects', () => {
    test('admin can list all projects', async () => {
      const response =
        await authenticatedTestClient(adminToken).get('/api/v1/projects');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });

    test('the list operation is documented in the OpenAPI spec', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        '/api/v1/openapi.json'
      );

      expect(response.status).toBe(200);
      const get = response.body.paths?.['/api/v1/projects']?.get;
      expect(get).toBeDefined();
      // The OpenAPI spec endpoint bypasses caseTransform, so structural keys
      // like operationId stay camelCase.
      expect(get.operationId).toBe('listProjects');
      const itemsRef =
        get.responses?.['200']?.content?.['application/json']?.schema?.items
          ?.$ref;
      expect(itemsRef).toBe('#/components/schemas/ProjectRecord');
    });

    test('unauthenticated request cannot list projects', async () => {
      const response = await testClient.get('/api/v1/projects');

      expect(response.status).toBe(401);
    });

    test('user with no policies sees no projects', async () => {
      await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${userId}/policies`)
        .send({ policy_ids: [] });

      const response =
        await authenticatedTestClient(userToken).get('/api/v1/projects');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBe(0);
    });

    describe('api key scoped to project sees only that project', () => {
      let projectAId: string;
      let rawApiKey: string;

      beforeAll(async () => {
        const projARes = await authenticatedTestClient(adminToken)
          .post('/api/v1/projects')
          .send({ name: 'api key Scope Project A' });

        projectAId = projARes.body.id;

        await authenticatedTestClient(adminToken)
          .post('/api/v1/projects')
          .send({ name: 'api key Scope Project B' });

        const listPolicyRes = await authenticatedTestClient(adminToken)
          .post('/api/v1/policies')
          .send({
            document: {
              statement: [
                { effect: 'Allow', action: ['projects:ListProjects'] },
              ],
            },
          });

        await authenticatedTestClient(adminToken)
          .put(`/api/v1/users/${userId}/policies`)
          .send({ policy_ids: [listPolicyRes.body.id] });

        const apiKeyRes = await authenticatedTestClient(userToken)
          .post('/api/v1/api-keys')
          .send({ name: 'Scoped Key', project_id: projectAId });

        rawApiKey = apiKeyRes.body.key;
      });

      test('api key only sees its scoped project', async () => {
        const response =
          await authenticatedTestClient(rawApiKey).get('/api/v1/projects');

        expect(response.status).toBe(200);
        expect(Array.isArray(response.body)).toBe(true);
        expect(response.body.length).toBe(1);
        expect(response.body[0].id).toBe(projectAId);
      });

      afterAll(async () => {
        await authenticatedTestClient(adminToken)
          .put(`/api/v1/users/${userId}/policies`)
          .send({ policy_ids: [] });
      });
    });

    describe('api key scoped to project without ListProjects permission sees no projects', () => {
      let noPermProjectId: string;
      let noPermRawApiKey: string;

      beforeAll(async () => {
        // Explicitly clear the user's policies so the key carries no
        // projects:ListProjects grant, regardless of prior test state.
        await authenticatedTestClient(adminToken)
          .put(`/api/v1/users/${userId}/policies`)
          .send({ policy_ids: [] });

        const projRes = await authenticatedTestClient(adminToken)
          .post('/api/v1/projects')
          .send({ name: 'No Permission Scope Project' });
        noPermProjectId = projRes.body.id;

        const apiKeyRes = await authenticatedTestClient(userToken)
          .post('/api/v1/api-keys')
          .send({ name: 'No Permission Key', project_id: noPermProjectId });

        noPermRawApiKey = apiKeyRes.body.key;
      });

      test('api key without permission sees an empty project list', async () => {
        const response =
          await authenticatedTestClient(noPermRawApiKey).get(
            '/api/v1/projects'
          );

        expect(response.status).toBe(200);
        expect(Array.isArray(response.body)).toBe(true);
        expect(response.body.length).toBe(0);
      });
    });

    describe('OAuth token scoped to project sees only that project', () => {
      let oauthScopedProjectId: string;
      let otherProjectId: string;
      let adminOauthToken: string;

      beforeAll(async () => {
        const projARes = await authenticatedTestClient(adminToken)
          .post('/api/v1/projects')
          .send({ name: 'OAuth Scoped Project' });
        oauthScopedProjectId = projARes.body.id;

        const projBRes = await authenticatedTestClient(adminToken)
          .post('/api/v1/projects')
          .send({ name: 'OAuth Other Project' });
        otherProjectId = projBRes.body.id;

        // Decode the admin JWT to get publicId, then issue an OAuth-style token
        // (same JWT_SECRET, adds prj claim to simulate the OAuth issueTokens hook).
        // The `*` scope mirrors an "all permissions" consent — consent is now
        // enforced at request time, so a token with no action scopes grants
        // nothing. Project scoping is still enforced via the `prj` boundary.
        const decoded = jwt.decode(adminToken) as {
          publicId: string;
          role: string;
        };
        adminOauthToken = jwt.sign(
          {
            sub: decoded.publicId,
            publicId: decoded.publicId,
            role: decoded.role,
            scope: `* mcp:access prj:${oauthScopedProjectId}`,
            prj: oauthScopedProjectId,
          },
          JWT_SECRET,
          { expiresIn: '1h' }
        );
      });

      test('OAuth token only sees its scoped project', async () => {
        const response =
          await authenticatedTestClient(adminOauthToken).get(
            '/api/v1/projects'
          );

        expect(response.status).toBe(200);
        expect(Array.isArray(response.body)).toBe(true);
        expect(response.body.length).toBe(1);
        expect(response.body[0].id).toBe(oauthScopedProjectId);
      });

      test('OAuth token cannot access a project outside its scope', async () => {
        const response = await authenticatedTestClient(adminOauthToken).get(
          `/api/v1/projects/${otherProjectId}`
        );

        expect(response.status).toBe(403);
      });

      test('OAuth token can access its scoped project', async () => {
        const response = await authenticatedTestClient(adminOauthToken).get(
          `/api/v1/projects/${oauthScopedProjectId}`
        );

        expect(response.status).toBe(200);
        expect(response.body.id).toBe(oauthScopedProjectId);
      });
    });

    describe('admin api key scoped to project sees only that project', () => {
      let adminScopedProjectId: string;
      let adminRawApiKey: string;

      beforeAll(async () => {
        const projRes = await authenticatedTestClient(adminToken)
          .post('/api/v1/projects')
          .send({ name: 'Admin Scoped Project' });

        adminScopedProjectId = projRes.body.id;

        await authenticatedTestClient(adminToken)
          .post('/api/v1/projects')
          .send({ name: 'Admin Other Project' });

        const apiKeyRes = await authenticatedTestClient(adminToken)
          .post('/api/v1/api-keys')
          .send({ name: 'Admin Scoped Key', project_id: adminScopedProjectId });

        adminRawApiKey = apiKeyRes.body.key;
      });

      test('admin api key only sees its scoped project', async () => {
        const response =
          await authenticatedTestClient(adminRawApiKey).get('/api/v1/projects');

        expect(response.status).toBe(200);
        expect(Array.isArray(response.body)).toBe(true);
        expect(response.body.length).toBe(1);
        expect(response.body[0].id).toBe(adminScopedProjectId);
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

    test('user with no policies cannot get a project', async () => {
      await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${userId}/policies`)
        .send({ policy_ids: [] });

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/projects/${projectId}`
      );

      expect(response.status).toBe(403);
    });

    test('user with projects:GetProject policy can get a project', async () => {
      const policyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [{ effect: 'Allow', action: ['projects:GetProject'] }],
          },
        });

      await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${userId}/policies`)
        .send({ policy_ids: [policyRes.body.id] });

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/projects/${projectId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(projectId);

      await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${userId}/policies`)
        .send({ policy_ids: [] });
    });

    test('returns 404 for unknown project id', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        '/api/v1/projects/proj_nonexistent12345'
      );

      expect(response.status).toBe(404);
    });
  });

  describe('PATCH /api/v1/projects/:id', () => {
    let projectId: string;

    beforeEach(async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Renamable Project' });

      projectId = res.body.id;
    });

    test('admin can rename a project', async () => {
      const response = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/projects/${projectId}`)
        .send({ name: 'Renamed Project' });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(projectId);
      expect(response.body.name).toBe('Renamed Project');
      expect(response.body.updated_at).toBeDefined();

      const getRes = await authenticatedTestClient(adminToken).get(
        `/api/v1/projects/${projectId}`
      );
      expect(getRes.body.name).toBe('Renamed Project');
    });

    test('missing name returns 400', async () => {
      const response = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/projects/${projectId}`)
        .send({});

      expect(response.status).toBe(400);
    });

    test('non-string name returns 400', async () => {
      const response = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/projects/${projectId}`)
        .send({ name: 123 });

      expect(response.status).toBe(400);
    });

    test('unauthenticated request cannot rename a project', async () => {
      const response = await testClient
        .patch(`/api/v1/projects/${projectId}`)
        .send({ name: 'Nope' });

      expect(response.status).toBe(401);
    });

    test('non-admin user cannot rename a project', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/projects/${projectId}`)
        .send({ name: 'Nope' });

      expect(response.status).toBe(403);
    });

    test('returns 404 for unknown project id', async () => {
      const response = await authenticatedTestClient(adminToken)
        .patch('/api/v1/projects/proj_nonexistent12345')
        .send({ name: 'Nope' });

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

    test('deleting a project removes api keys scoped to it', async () => {
      const projRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Cascade Test Project' });

      expect(projRes.status).toBe(201);
      const cascadeProjectId = projRes.body.id;

      const keyRes = await authenticatedTestClient(userToken)
        .post('/api/v1/api-keys')
        .send({ name: 'Cascade Key', project_id: cascadeProjectId });

      expect(keyRes.status).toBe(201);
      const keyId = keyRes.body.id;

      const deleteRes = await authenticatedTestClient(adminToken).delete(
        `/api/v1/projects/${cascadeProjectId}`
      );

      expect(deleteRes.status).toBe(204);

      const getProjectRes = await authenticatedTestClient(adminToken).get(
        `/api/v1/projects/${cascadeProjectId}`
      );

      expect(getProjectRes.status).toBe(404);

      const getKeyRes = await authenticatedTestClient(userToken).get(
        `/api/v1/api-keys/${keyId}`
      );

      expect(getKeyRes.status).toBe(404);
    });

    test('returns 409 PROJECT_HAS_DEPENDENTS when the project has dependent resources', async () => {
      const projRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Blocked Delete Project' });
      const blockedProjectId = projRes.body.id;

      const aiProviderRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: blockedProjectId,
          name: 'Blocked Delete Provider',
          provider: 'ollama',
          default_model: 'llama3.2',
        });
      expect(aiProviderRes.status).toBe(201);

      const agentRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderRes.body.id,
          project_id: blockedProjectId,
          name: 'Blocked Delete Agent',
        });
      expect(agentRes.status).toBe(201);

      const response = await authenticatedTestClient(adminToken).delete(
        `/api/v1/projects/${blockedProjectId}`
      );

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('PROJECT_HAS_DEPENDENTS');

      const getProjectRes = await authenticatedTestClient(adminToken).get(
        `/api/v1/projects/${blockedProjectId}`
      );
      expect(getProjectRes.status).toBe(200);
    });

    test('force=true deletes a project along with its dependent resources', async () => {
      const projRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Force Delete Project' });
      const forceProjectId = projRes.body.id;

      const secretRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/secrets')
        .send({
          project_id: forceProjectId,
          name: 'Force Delete Secret',
          value: 'supersecretvalue',
        });
      expect(secretRes.status).toBe(201);

      const aiProviderRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: forceProjectId,
          name: 'Force Delete Provider',
          provider: 'ollama',
          default_model: 'llama3.2',
        });
      expect(aiProviderRes.status).toBe(201);

      const agentRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderRes.body.id,
          project_id: forceProjectId,
          name: 'Force Delete Agent',
        });
      expect(agentRes.status).toBe(201);

      const toolRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: forceProjectId,
          name: 'force-delete-tool',
          type: 'soat',
          description: 'A tool scoped to the project being force-deleted',
          actions: ['list-tools'],
        });
      expect(toolRes.status).toBe(201);

      const memoryRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/memories')
        .send({ project_id: forceProjectId, name: 'Force Delete Memory' });
      expect(memoryRes.status).toBe(201);

      const fileRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/files')
        .send({
          project_id: forceProjectId,
          filename: 'force-delete-file.txt',
          content_type: 'text/plain',
          size: 12,
        });
      expect(fileRes.status).toBe(201);

      const blockedResponse = await authenticatedTestClient(adminToken).delete(
        `/api/v1/projects/${forceProjectId}`
      );
      expect(blockedResponse.status).toBe(409);

      const forcedResponse = await authenticatedTestClient(adminToken).delete(
        `/api/v1/projects/${forceProjectId}?force=true`
      );
      expect(forcedResponse.status).toBe(204);

      const getProjectRes = await authenticatedTestClient(adminToken).get(
        `/api/v1/projects/${forceProjectId}`
      );
      expect(getProjectRes.status).toBe(404);

      expect(
        await db.Agent.findOne({ where: { publicId: agentRes.body.id } })
      ).toBeNull();
      expect(
        await db.AiProvider.findOne({
          where: { publicId: aiProviderRes.body.id },
        })
      ).toBeNull();
      expect(
        await db.Tool.findOne({ where: { publicId: toolRes.body.id } })
      ).toBeNull();
      expect(
        await db.Memory.findOne({ where: { publicId: memoryRes.body.id } })
      ).toBeNull();
      expect(
        await db.Secret.findOne({ where: { publicId: secretRes.body.id } })
      ).toBeNull();
      expect(
        await db.File.findOne({ where: { publicId: fileRes.body.id } })
      ).toBeNull();
    });

    test('force=true on a project without dependents just deletes it', async () => {
      const projRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Force Delete Empty Project' });
      const emptyProjectId = projRes.body.id;

      const response = await authenticatedTestClient(adminToken).delete(
        `/api/v1/projects/${emptyProjectId}?force=true`
      );

      expect(response.status).toBe(204);

      const getProjectRes = await authenticatedTestClient(adminToken).get(
        `/api/v1/projects/${emptyProjectId}`
      );
      expect(getProjectRes.status).toBe(404);
    });
  });
});
