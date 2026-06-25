import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * Project-scoped API keys make `projectId` implicit (issue #267).
 *
 * When a request authenticates with a project-scoped API key:
 *  - omitting `project_id` defaults to the key's project;
 *  - supplying a `project_id` that matches the key's project is accepted;
 *  - supplying a `project_id` that belongs to a different project returns 403.
 *
 * JWT auth is unchanged: a write without `project_id` still returns 400, since a
 * concrete project is never inferred from a JWT user's accessible projects.
 */
describe('Implicit projectId via project-scoped API key', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectAId: string;
  let projectBId: string;
  let scopedKey: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });
    adminToken = await loginAs('admin', 'supersecret');

    const userRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'pkuser', password: 'pkpass' });
    userId = userRes.body.id;
    userToken = await loginAs('pkuser', 'pkpass');

    const projectARes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Implicit Project A' });
    projectAId = projectARes.body.id;

    const projectBRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Implicit Project B' });
    projectBId = projectBRes.body.id;

    // Broad policy covering every create/list action exercised below.
    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: [
                'files:CreateFile',
                'files:UploadFile',
                'files:GetFile',
                'secrets:CreateSecret',
                'webhooks:CreateWebhook',
              ],
            },
          ],
        },
      });

    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userId}/policies`)
      .send({ policy_ids: [policyRes.body.id] });

    // Project-scoped API key bound to project A.
    const keyRes = await authenticatedTestClient(userToken)
      .post('/api/v1/api-keys')
      .send({
        project_id: projectAId,
        policy_ids: [policyRes.body.id],
        name: 'Scoped key for A',
      });
    expect(keyRes.status).toBe(201);
    expect(keyRes.body.key).toMatch(/^sk_/);
    scopedKey = keyRes.body.key;
  });

  describe('POST /api/v1/files', () => {
    test('omitting project_id uses the key project', async () => {
      const res = await authenticatedTestClient(scopedKey)
        .post('/api/v1/files')
        .send({
          filename: 'implicit.txt',
          storage_type: 'local',
          storage_path: '/tmp/implicit.txt',
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();

      // The create response omits project_id; read it back to prove the file
      // landed in the key's project.
      const getRes = await authenticatedTestClient(scopedKey).get(
        `/api/v1/files/${res.body.id}`
      );
      expect(getRes.status).toBe(200);
      expect(getRes.body.project_id).toBe(projectAId);
    });

    test('matching project_id is accepted', async () => {
      const res = await authenticatedTestClient(scopedKey)
        .post('/api/v1/files')
        .send({
          project_id: projectAId,
          filename: 'match.txt',
          storage_type: 'local',
          storage_path: '/tmp/match.txt',
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
    });

    test('mismatched project_id returns 403', async () => {
      const res = await authenticatedTestClient(scopedKey)
        .post('/api/v1/files')
        .send({
          project_id: projectBId,
          filename: 'mismatch.txt',
          storage_type: 'local',
          storage_path: '/tmp/mismatch.txt',
        });

      expect(res.status).toBe(403);
    });

    test('JWT auth without project_id still returns 400', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/files')
        .send({
          filename: 'jwt.txt',
          storage_type: 'local',
          storage_path: '/tmp/jwt.txt',
        });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/v1/files/upload/base64', () => {
    test('omitting project_id uses the key project', async () => {
      const res = await authenticatedTestClient(scopedKey)
        .post('/api/v1/files/upload/base64')
        .send({
          content: Buffer.from('hello').toString('base64'),
          filename: 'b64.txt',
          content_type: 'text/plain',
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
    });

    test('mismatched project_id returns 403', async () => {
      const res = await authenticatedTestClient(scopedKey)
        .post('/api/v1/files/upload/base64')
        .send({
          project_id: projectBId,
          content: Buffer.from('nope').toString('base64'),
          filename: 'b64-mismatch.txt',
        });

      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/v1/files', () => {
    test('listing without project_id returns only the key project files', async () => {
      // A file owned by project B (created by admin) must not leak into the
      // scoped key's implicit listing.
      const bFileRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/files')
        .send({
          project_id: projectBId,
          filename: 'b-only.txt',
          storage_type: 'local',
          storage_path: '/tmp/b-only.txt',
        });
      const bFileId = bFileRes.body.id;

      const res = await authenticatedTestClient(scopedKey).get('/api/v1/files');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      const ids = res.body.data.map((file: { id: string }) => {
        return file.id;
      });
      // Files created earlier in this suite (project A) are present...
      expect(ids.length).toBeGreaterThan(0);
      // ...but the project B file is not.
      expect(ids).not.toContain(bFileId);
    });
  });

  describe('POST /api/v1/secrets', () => {
    test('omitting project_id uses the key project', async () => {
      const res = await authenticatedTestClient(scopedKey)
        .post('/api/v1/secrets')
        .send({ name: 'IMPLICIT_SECRET', value: 'shh' });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
    });

    test('mismatched project_id returns 403', async () => {
      const res = await authenticatedTestClient(scopedKey)
        .post('/api/v1/secrets')
        .send({ project_id: projectBId, name: 'NOPE', value: 'shh' });

      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/v1/webhooks', () => {
    test('omitting project_id uses the key project', async () => {
      const res = await authenticatedTestClient(scopedKey)
        .post('/api/v1/webhooks')
        .send({
          name: 'Implicit hook',
          url: 'https://example.com/hook',
          events: ['generation.completed'],
        });

      expect(res.status).toBe(201);
      expect(res.body.project_id).toBe(projectAId);
    });

    test('mismatched project_id returns 403', async () => {
      const res = await authenticatedTestClient(scopedKey)
        .post('/api/v1/webhooks')
        .send({
          project_id: projectBId,
          name: 'Mismatch hook',
          url: 'https://example.com/hook',
          events: ['generation.completed'],
        });

      expect(res.status).toBe(403);
    });
  });
});
