import fs from 'node:fs';

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
      expect(Array.isArray(response.body.data)).toBe(true);
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
        get.responses?.['200']?.content?.['application/json']?.schema
          ?.properties?.data?.items?.$ref;
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
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBe(0);
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
        expect(Array.isArray(response.body.data)).toBe(true);
        expect(response.body.data.length).toBe(1);
        expect(response.body.data[0].id).toBe(projectAId);
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
        expect(Array.isArray(response.body.data)).toBe(true);
        expect(response.body.data.length).toBe(0);
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

        // An OAuth-style token with a `prj` claim, mirroring the issueTokens
        // hook. The `*` scope is an all-permissions consent: consent is enforced
        // at request time, so a token with no action scopes grants nothing.
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
        expect(Array.isArray(response.body.data)).toBe(true);
        expect(response.body.data.length).toBe(1);
        expect(response.body.data[0].id).toBe(oauthScopedProjectId);
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
        expect(Array.isArray(response.body.data)).toBe(true);
        expect(response.body.data.length).toBe(1);
        expect(response.body.data[0].id).toBe(adminScopedProjectId);
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

    test('defaults to null (unlimited) max_concurrent_runs', async () => {
      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/projects/${projectId}`
      );
      expect(res.status).toBe(200);
      expect(res.body.max_concurrent_runs).toBeNull();
    });

    test('admin can set max_concurrent_runs', async () => {
      const response = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/projects/${projectId}`)
        .send({ max_concurrent_runs: 5 });

      expect(response.status).toBe(200);
      expect(response.body.max_concurrent_runs).toBe(5);

      const getRes = await authenticatedTestClient(adminToken).get(
        `/api/v1/projects/${projectId}`
      );
      expect(getRes.body.max_concurrent_runs).toBe(5);
    });

    test('admin can clear max_concurrent_runs with null', async () => {
      await authenticatedTestClient(adminToken)
        .patch(`/api/v1/projects/${projectId}`)
        .send({ max_concurrent_runs: 3 });

      const response = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/projects/${projectId}`)
        .send({ max_concurrent_runs: null });

      expect(response.status).toBe(200);
      expect(response.body.max_concurrent_runs).toBeNull();
    });

    test('rejects 0 with 400', async () => {
      const response = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/projects/${projectId}`)
        .send({ max_concurrent_runs: 0 });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('rejects a negative value with 400', async () => {
      const response = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/projects/${projectId}`)
        .send({ max_concurrent_runs: -1 });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('rejects a non-integer value with 400', async () => {
      const response = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/projects/${projectId}`)
        .send({ max_concurrent_runs: 2.5 });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('defaults to null (no project ceiling) max_chain_generations', async () => {
      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/projects/${projectId}`
      );
      expect(res.status).toBe(200);
      expect(res.body.max_chain_generations).toBeNull();
    });

    test('admin can set and clear max_chain_generations', async () => {
      const set = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/projects/${projectId}`)
        .send({ max_chain_generations: 25 });

      expect(set.status).toBe(200);
      expect(set.body.max_chain_generations).toBe(25);

      const getRes = await authenticatedTestClient(adminToken).get(
        `/api/v1/projects/${projectId}`
      );
      expect(getRes.body.max_chain_generations).toBe(25);

      const cleared = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/projects/${projectId}`)
        .send({ max_chain_generations: null });

      expect(cleared.status).toBe(200);
      expect(cleared.body.max_chain_generations).toBeNull();
    });

    test.each([0, -1, 2.5])(
      'rejects max_chain_generations %p with 400',
      async (value) => {
        const response = await authenticatedTestClient(adminToken)
          .patch(`/api/v1/projects/${projectId}`)
          .send({ max_chain_generations: value });

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_FAILED');
      }
    );

    test('a non-admin cannot set max_chain_generations', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/projects/${projectId}`)
        .send({ max_chain_generations: 5 });

      expect(response.status).toBe(403);
    });
  });

  describe('trace content lifecycle settings', () => {
    let projectId: string;

    beforeEach(async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Content Lifecycle Project' });
      projectId = res.body.id;
    });

    test('a new project stores content with retention disabled', async () => {
      // The shipped defaults must change nothing for an existing tenant:
      // retention is opt-in and content is stored, exactly as before #837/#838.
      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/projects/${projectId}`
      );

      expect(res.status).toBe(200);
      expect(res.body.trace_content_retention_days).toBeNull();
      expect(res.body.trace_content_mode).toBe('full');
    });

    test('admin can set and clear the retention window', async () => {
      const set = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/projects/${projectId}`)
        .send({ trace_content_retention_days: 90 });

      expect(set.status).toBe(200);
      expect(set.body.trace_content_retention_days).toBe(90);

      const cleared = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/projects/${projectId}`)
        .send({ trace_content_retention_days: null });

      expect(cleared.status).toBe(200);
      expect(cleared.body.trace_content_retention_days).toBeNull();
    });

    test.each([
      ['zero', 0],
      ['a negative window', -30],
      ['a fractional window', 1.5],
    ])('rejects %s with 400', async (_label, value) => {
      const res = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/projects/${projectId}`)
        .send({ trace_content_retention_days: value });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('admin can switch the project to zero-retention', async () => {
      const res = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/projects/${projectId}`)
        .send({ trace_content_mode: 'none' });

      expect(res.status).toBe(200);
      expect(res.body.trace_content_mode).toBe('none');

      const get = await authenticatedTestClient(adminToken).get(
        `/api/v1/projects/${projectId}`
      );
      expect(get.body.trace_content_mode).toBe('none');
    });

    test('rejects an unknown mode with 400', async () => {
      const res = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/projects/${projectId}`)
        .send({ trace_content_mode: 'partial' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a non-admin cannot change either setting', async () => {
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/projects/${projectId}`)
        .send({ trace_content_retention_days: 30 });

      expect(res.status).toBe(403);
    });

    test('an unauthenticated request cannot change either setting', async () => {
      const res = await testClient
        .patch(`/api/v1/projects/${projectId}`)
        .send({ trace_content_mode: 'none' });

      expect(res.status).toBe(401);
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
          type: 'builtin',
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

    test('force=true removes uploaded files from storage, not just their DB rows', async () => {
      const projRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Force Delete Storage Project' });
      const forceStorageProjectId = projRes.body.id;

      const uploadRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/files/upload/base64')
        .send({
          project_id: forceStorageProjectId,
          content: Buffer.from('force delete storage bytes').toString('base64'),
          filename: 'force-delete-storage.txt',
          content_type: 'text/plain',
        });
      expect(uploadRes.status).toBe(201);

      const file = await db.File.findOne({
        where: { publicId: uploadRes.body.id },
      });
      const storagePath = file!.storagePath;

      expect(fs.existsSync(storagePath)).toBe(true);

      const forcedResponse = await authenticatedTestClient(adminToken).delete(
        `/api/v1/projects/${forceStorageProjectId}?force=true`
      );
      expect(forcedResponse.status).toBe(204);

      expect(
        await db.File.findOne({ where: { id: file!.id as number } })
      ).toBeNull();
      expect(fs.existsSync(storagePath)).toBe(false);
    });

    test('returns 409 PROJECT_HAS_DEPENDENTS when the project only has usage history', async () => {
      const projRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Usage Only Project' });
      const usageProjectId = projRes.body.id;

      const project = await db.Project.findOne({
        where: { publicId: usageProjectId },
      });

      await db.UsageEvent.create({
        projectId: project?.get('id'),
        meterType: 'llm_tokens',
        provider: 'openai',
        model: 'gpt-4o',
        costUsd: '0.01',
        idempotencyKey: `usage-only-${usageProjectId}`,
      });

      const response = await authenticatedTestClient(adminToken).delete(
        `/api/v1/projects/${usageProjectId}`
      );

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('PROJECT_HAS_DEPENDENTS');

      const getProjectRes = await authenticatedTestClient(adminToken).get(
        `/api/v1/projects/${usageProjectId}`
      );
      expect(getProjectRes.status).toBe(200);
    });

    test('force=true deletes a project along with its usage history', async () => {
      const projRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Force Delete Usage Project' });
      const forceUsageProjectId = projRes.body.id;

      const project = await db.Project.findOne({
        where: { publicId: forceUsageProjectId },
      });
      const internalProjectId = project?.get('id') as number;

      const usageEvent = await db.UsageEvent.create({
        projectId: internalProjectId,
        meterType: 'llm_tokens',
        provider: 'openai',
        model: 'gpt-4o',
        costUsd: '0.02',
        idempotencyKey: `force-usage-${forceUsageProjectId}`,
      });

      await db.UsageComponent.create({
        usageEventId: usageEvent.get('id'),
        component: 'input_tokens',
        quantity: '100',
        unit: 'token',
        unitPrice: '0.0001',
        costUsd: '0.01',
      });

      const forcedResponse = await authenticatedTestClient(adminToken).delete(
        `/api/v1/projects/${forceUsageProjectId}?force=true`
      );
      expect(forcedResponse.status).toBe(204);

      expect(
        await db.UsageEvent.findOne({
          where: { publicId: usageEvent.get('publicId') as string },
        })
      ).toBeNull();
      expect(
        await db.UsageComponent.findOne({
          where: { usageEventId: usageEvent.get('id') as number },
        })
      ).toBeNull();
    });

    // Each holds rows whose `projectId` FK is NO ACTION, so a project holding
    // only them counted 0 dependents and took the bare `destroy()` path — a raw
    // 500 from the constraint, which `force` did not help (#1079).

    /** Creates a dataset + eval pair (evaluations), a workflow + task
     * (automation), a trigger, a guardrail and a quota in `project`. */
    const createLateModuleResources = async (project: string) => {
      const aiProviderRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: project,
          name: 'Late Module Provider',
          provider: 'ollama',
          default_model: 'llama3.2',
        });
      expect(aiProviderRes.status).toBe(201);

      const agentRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderRes.body.id,
          project_id: project,
          name: 'Late Module Agent',
        });
      expect(agentRes.status).toBe(201);

      const datasetRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/datasets')
        .send({ project_id: project, name: 'late-module-dataset' });
      expect(datasetRes.status).toBe(201);

      const evalRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/evals')
        .send({
          project_id: project,
          name: 'late-module-eval',
          agent_id: agentRes.body.id,
          dataset_id: datasetRes.body.id,
          scorers: [{ type: 'contains', value: 'x' }],
        });
      expect(evalRes.status).toBe(201);

      const workflowRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/workflows')
        .send({
          project_id: project,
          name: 'late-module-workflow',
          states: [
            { name: 'draft', initial: true },
            { name: 'done', terminal: true },
          ],
          transitions: [{ name: 'finish', from: ['draft'], to: 'done' }],
        });
      expect(workflowRes.status).toBe(201);

      const taskRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/tasks')
        .send({
          project_id: project,
          workflow_id: workflowRes.body.id,
          title: 'late-module-task',
        });
      expect(taskRes.status).toBe(201);

      const triggerRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/triggers')
        .send({
          project_id: project,
          name: 'late-module-trigger',
          type: 'webhook',
          target_type: 'agent',
          target_id: agentRes.body.id,
        });
      expect(triggerRes.status).toBe(201);

      const guardrailRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/guardrails')
        .send({
          project_id: project,
          name: 'late-module-guardrail',
          document: {
            default_class: 'C',
            class: { if: [{ '<': [{ var: 'args.amount' }, 500] }, 'B', 'C'] },
          },
        });
      expect(guardrailRes.status).toBe(201);

      const quotaRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/quotas')
        .send({
          project_id: project,
          scope: 'project',
          metric: 'requests',
          window: 'calendar_month',
          limit: 10,
        });
      expect(quotaRes.status).toBe(201);

      return {
        datasetId: datasetRes.body.id as string,
        evalId: evalRes.body.id as string,
        workflowId: workflowRes.body.id as string,
        taskId: taskRes.body.id as string,
        triggerId: triggerRes.body.id as string,
        guardrailId: guardrailRes.body.id as string,
        quotaId: quotaRes.body.id as string,
      };
    };

    /**
     * The records a project writes about itself as it runs — activity,
     * approvals, exceptions, guardrail evaluations — and an orchestration queue
     * task. Each has a blocking `projectId` (or `orchestrationRunId`) FK and no
     * route that creates one directly, so they are written at the DB layer, the
     * same way the usage-history tests above do.
     */
    const createRunRecords = async (internalProjectId: number) => {
      const activity = await db.ActivityEntry.create({
        projectId: internalProjectId,
        kind: 'action_executed',
        severity: 'info',
        summary: 'late-module activity',
      });

      const approval = await db.ApprovalItem.create({
        projectId: internalProjectId,
        origin: 'tool_call',
        status: 'pending',
        proposedAction: { tool: 'noop' },
        expiresAt: new Date(Date.now() + 60_000),
      });

      const exception = await db.ExceptionItem.create({
        projectId: internalProjectId,
        status: 'open',
        severity: 'warning',
        kind: 'manual',
        title: 'late-module exception',
        lastSeenAt: new Date(),
      });

      const guardrailEvaluation = await db.GuardrailEvaluation.create({
        projectId: internalProjectId,
        guardrailId: 'grd_late_module',
        scope: 'agent',
        resolvedClass: 'C',
        decision: 'allowed',
        contextSource: 'none',
        contextSnapshot: {},
      });

      const orchestration = await db.Orchestration.create({
        projectId: internalProjectId,
        name: 'late-module-orchestration',
        definition: { nodes: [], edges: [] },
      });
      const orchestrationRun = await db.OrchestrationRun.create({
        projectId: internalProjectId,
        orchestrationId: orchestration.get('id'),
        status: 'queued',
        input: {},
      });
      const runTask = await db.OrchestrationRunTask.create({
        orchestrationRunId: orchestrationRun.get('id'),
        kind: 'continue',
      });

      return {
        activityId: activity.get('id') as number,
        approvalId: approval.get('id') as number,
        exceptionId: exception.get('id') as number,
        guardrailEvaluationId: guardrailEvaluation.get('id') as number,
        orchestrationRunId: orchestrationRun.get('id') as number,
        runTaskId: runTask.get('id') as number,
      };
    };

    test('returns 409 PROJECT_HAS_DEPENDENTS when the project only holds a dataset', async () => {
      const projRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Dataset Only Project' });
      const datasetOnlyProjectId = projRes.body.id;

      const datasetRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/datasets')
        .send({ project_id: datasetOnlyProjectId, name: 'lonely-dataset' });
      expect(datasetRes.status).toBe(201);

      const response = await authenticatedTestClient(adminToken).delete(
        `/api/v1/projects/${datasetOnlyProjectId}`
      );

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('PROJECT_HAS_DEPENDENTS');

      const getProjectRes = await authenticatedTestClient(adminToken).get(
        `/api/v1/projects/${datasetOnlyProjectId}`
      );
      expect(getProjectRes.status).toBe(200);
    });

    test('force=true deletes a project holding evaluation, automation, guardrail and quota resources', async () => {
      const projRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Late Module Force Delete Project' });
      const lateProjectId = projRes.body.id;

      const created = await createLateModuleResources(lateProjectId);

      const project = await db.Project.findOne({
        where: { publicId: lateProjectId },
      });
      const records = await createRunRecords(project?.get('id') as number);

      const blockedResponse = await authenticatedTestClient(adminToken).delete(
        `/api/v1/projects/${lateProjectId}`
      );
      expect(blockedResponse.status).toBe(409);

      const forcedResponse = await authenticatedTestClient(adminToken).delete(
        `/api/v1/projects/${lateProjectId}?force=true`
      );
      expect(forcedResponse.status).toBe(204);

      expect(
        await db.Dataset.findOne({ where: { publicId: created.datasetId } })
      ).toBeNull();
      expect(
        await db.Eval.findOne({ where: { publicId: created.evalId } })
      ).toBeNull();
      expect(
        await db.Workflow.findOne({ where: { publicId: created.workflowId } })
      ).toBeNull();
      expect(
        await db.Task.findOne({ where: { publicId: created.taskId } })
      ).toBeNull();
      expect(
        await db.Trigger.findOne({ where: { publicId: created.triggerId } })
      ).toBeNull();
      expect(
        await db.Guardrail.findOne({ where: { publicId: created.guardrailId } })
      ).toBeNull();
      expect(
        await db.Quota.findOne({ where: { publicId: created.quotaId } })
      ).toBeNull();

      expect(
        await db.ActivityEntry.findOne({ where: { id: records.activityId } })
      ).toBeNull();
      expect(
        await db.ApprovalItem.findOne({ where: { id: records.approvalId } })
      ).toBeNull();
      expect(
        await db.ExceptionItem.findOne({ where: { id: records.exceptionId } })
      ).toBeNull();
      expect(
        await db.GuardrailEvaluation.findOne({
          where: { id: records.guardrailEvaluationId },
        })
      ).toBeNull();
      expect(
        await db.OrchestrationRunTask.findOne({
          where: { id: records.runTaskId },
        })
      ).toBeNull();
      expect(
        await db.OrchestrationRun.findOne({
          where: { id: records.orchestrationRunId },
        })
      ).toBeNull();
    });

    test('force=true unwinds documents, traces and generations, self-references included', async () => {
      const projRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Force Delete Graph Project' });
      const graphProjectId = projRes.body.id;

      const aiProviderRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: graphProjectId,
          name: 'Graph Provider',
          provider: 'ollama',
          default_model: 'llama3.2',
        });
      const agentRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          ai_provider_id: aiProviderRes.body.id,
          project_id: graphProjectId,
          name: 'Graph Agent',
        });
      expect(agentRes.status).toBe(201);

      const project = await db.Project.findOne({
        where: { publicId: graphProjectId },
      });
      const internalProjectId = project?.get('id') as number;
      const agent = await db.Agent.findOne({
        where: { publicId: agentRes.body.id },
      });
      const agentId = agent?.get('id') as number;

      // A file with a document on it: `Document.fileId` is RESTRICT, so the
      // document has to go before the file it describes.
      const file = await db.File.create({
        projectId: internalProjectId,
        path: '/force-delete-graph.txt',
        filename: 'force-delete-graph.txt',
        contentType: 'text/plain',
        size: 4,
        storageType: 'local',
        storagePath: '/tmp/force-delete-graph.txt',
        metadata: null,
      });
      const document = await db.Document.create({
        fileId: file.get('id'),
        title: 'Force delete graph document',
        metadata: null,
        tags: null,
        embedding: null,
      });

      // Traces and generations point at their own kind with RESTRICT FKs, so
      // the cascade nulls those links before destroying the rows.
      const rootTrace = await db.Trace.create({
        projectId: internalProjectId,
        agentId,
      });
      const childTrace = await db.Trace.create({
        projectId: internalProjectId,
        agentId,
        parentTraceId: rootTrace.get('id'),
        rootTraceId: rootTrace.get('id'),
      });
      const initiatorGeneration = await db.Generation.create({
        projectId: internalProjectId,
        agentId,
        traceId: rootTrace.get('id'),
        status: 'completed',
        startedAt: new Date(),
      });
      const nestedGeneration = await db.Generation.create({
        projectId: internalProjectId,
        agentId,
        traceId: childTrace.get('id'),
        status: 'completed',
        startedAt: new Date(),
        initiatorGenerationId: initiatorGeneration.get('id'),
      });

      const forcedResponse = await authenticatedTestClient(adminToken).delete(
        `/api/v1/projects/${graphProjectId}?force=true`
      );
      expect(forcedResponse.status).toBe(204);

      expect(
        await db.Document.findOne({ where: { id: document.get('id') } })
      ).toBeNull();
      expect(
        await db.File.findOne({ where: { id: file.get('id') } })
      ).toBeNull();
      expect(
        await db.Trace.findOne({ where: { id: childTrace.get('id') } })
      ).toBeNull();
      expect(
        await db.Trace.findOne({ where: { id: rootTrace.get('id') } })
      ).toBeNull();
      expect(
        await db.Generation.findOne({
          where: { id: nestedGeneration.get('id') },
        })
      ).toBeNull();
      expect(
        await db.Generation.findOne({
          where: { id: initiatorGeneration.get('id') },
        })
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

  describe('project + provider-slug prices', () => {
    let priceProjectId: string;
    let priceUserToken: string;
    let priceNoPermToken: string;
    const futureFrom = '2099-01-01T00:00:00.000Z';

    beforeAll(async () => {
      const projRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Price Tier Project' });
      priceProjectId = projRes.body.id;

      const userRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/users')
        .send({ username: 'priceuser', password: 'pricepass' });
      const policyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [
              {
                effect: 'Allow',
                action: [
                  'projects:GetProjectPrices',
                  'projects:ManageProjectPrices',
                ],
              },
            ],
          },
        });
      await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${userRes.body.id}/policies`)
        .send({ policy_ids: [policyRes.body.id] });
      priceUserToken = await loginAs('priceuser', 'pricepass');

      await authenticatedTestClient(adminToken)
        .post('/api/v1/users')
        .send({ username: 'pricenoperm', password: 'nopass' });
      priceNoPermToken = await loginAs('pricenoperm', 'nopass');
    });

    describe('GET /api/v1/projects/:project_id/prices', () => {
      test('unauthenticated request returns 401', async () => {
        const res = await testClient.get(
          `/api/v1/projects/${priceProjectId}/prices`
        );
        expect(res.status).toBe(401);
      });

      test('user without permission returns 403', async () => {
        const res = await authenticatedTestClient(priceNoPermToken).get(
          `/api/v1/projects/${priceProjectId}/prices`
        );
        expect(res.status).toBe(403);
      });

      test('unknown project returns 404', async () => {
        const res = await authenticatedTestClient(priceUserToken).get(
          '/api/v1/projects/proj_doesNotExist01/prices'
        );
        expect(res.status).toBe(404);
      });

      test('starts empty for a project with no price rows', async () => {
        const res = await authenticatedTestClient(priceUserToken).get(
          `/api/v1/projects/${priceProjectId}/prices`
        );
        expect(res.status).toBe(200);
        expect(res.body.prices).toEqual([]);
      });
    });

    describe('PUT /api/v1/projects/:project_id/prices', () => {
      test('unauthenticated request returns 401', async () => {
        const res = await testClient
          .put(`/api/v1/projects/${priceProjectId}/prices`)
          .send({ prices: [] });
        expect(res.status).toBe(401);
      });

      test('user without permission returns 403', async () => {
        const res = await authenticatedTestClient(priceNoPermToken)
          .put(`/api/v1/projects/${priceProjectId}/prices`)
          .send({ prices: [] });
        expect(res.status).toBe(403);
      });

      test('rejects an unparseable effective_from with 400', async () => {
        const res = await authenticatedTestClient(priceUserToken)
          .put(`/api/v1/projects/${priceProjectId}/prices`)
          .send({
            prices: [
              {
                provider: 'openai',
                model: 'gpt-4o',
                component: 'input_tokens',
                unit: 'token',
                unit_price: 0.000001,
                effective_from: 'not-a-timestamp',
              },
            ],
          });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
      });

      test('upserts a project component price and reads it back', async () => {
        const putRes = await authenticatedTestClient(priceUserToken)
          .put(`/api/v1/projects/${priceProjectId}/prices`)
          .send({
            prices: [
              {
                provider: 'openai',
                model: 'gpt-4o',
                component: 'input_tokens',
                unit: 'token',
                unit_price: 0.000004,
                effective_from: futureFrom,
              },
            ],
          });
        expect(putRes.status).toBe(200);
        expect(putRes.body.prices).toHaveLength(1);
        const price = putRes.body.prices[0];
        expect(price.id).toMatch(/^price_/);
        expect(price.project_id).toBe(priceProjectId);
        // A project + slug row is not tied to any one provider instance.
        expect(price.ai_provider_id).toBeNull();
        expect(price.provider).toBe('openai');
        expect(price.model).toBe('gpt-4o');
        expect(price.component).toBe('input_tokens');
        expect(price.unit_price).toBe(0.000004);

        const getRes = await authenticatedTestClient(priceUserToken).get(
          `/api/v1/projects/${priceProjectId}/prices`
        );
        expect(getRes.status).toBe(200);
        expect(getRes.body.prices).toHaveLength(1);
        expect(getRes.body.prices[0].id).toBe(price.id);
      });

      test('re-upserting the same key updates the rate in place', async () => {
        const res = await authenticatedTestClient(priceUserToken)
          .put(`/api/v1/projects/${priceProjectId}/prices`)
          .send({
            prices: [
              {
                provider: 'openai',
                model: 'gpt-4o',
                component: 'input_tokens',
                unit: 'token',
                unit_price: 0.000006,
                effective_from: futureFrom,
              },
            ],
          });
        expect(res.status).toBe(200);
        expect(res.body.prices[0].unit_price).toBe(0.000006);

        const getRes = await authenticatedTestClient(priceUserToken).get(
          `/api/v1/projects/${priceProjectId}/prices`
        );
        expect(
          getRes.body.prices.filter((p: { model: string }) => {
            return p.model === 'gpt-4o';
          })
        ).toHaveLength(1);
      });

      // Nothing has been priced against a (provider, model, component) with no
      // rows, so a first write may take effect now rather than leaving the
      // project unpriced until a future timestamp lands (#1196).
      test('accepts a past effective_from on a first write, then refuses to back-date it', async () => {
        const effectiveFrom = new Date(Date.now() - 1000).toISOString();
        const first = await authenticatedTestClient(priceUserToken)
          .put(`/api/v1/projects/${priceProjectId}/prices`)
          .send({
            prices: [
              {
                provider: 'openai',
                model: 'project-first-write-model',
                component: 'input_tokens',
                unit: 'token',
                unit_price: 0.000001,
                effective_from: effectiveFrom,
              },
            ],
          });
        expect(first.status).toBe(200);
        expect(
          new Date(first.body.prices[0].effective_from).toISOString()
        ).toBe(effectiveFrom);

        const second = await authenticatedTestClient(priceUserToken)
          .put(`/api/v1/projects/${priceProjectId}/prices`)
          .send({
            prices: [
              {
                provider: 'openai',
                model: 'project-first-write-model',
                component: 'input_tokens',
                unit: 'token',
                unit_price: 0.000002,
                effective_from: new Date(Date.now() - 500).toISOString(),
              },
            ],
          });
        expect(second.status).toBe(400);
        expect(second.body.error.code).toBe('VALIDATION_FAILED');
      });
    });
  });
});
