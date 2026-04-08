import { authenticatedTestClient, loginAs, testClient } from '../testClient';

/**
 * Integration test for the full IAM permissions flow:
 *
 * 1. admin creates a project
 * 2. admin creates a regular user
 * 3. admin assigns the user to the project with a read-only policy
 * 4. user can read a file using JWT
 * 5. user cannot delete that file using JWT
 * 6. user creates an API key scoped to the project
 * 7. user assigns the deleteFile action to the API key
 * 8. user can read the file using the API key
 * 9. user cannot delete the file using the API key (membership policy intersection)
 */

// ─── Group 1: Setup (Steps 1-3) ──────────────────────────────────────────

describe('Group 1: Setup - Admin creates project, user, and assigns permissions', () => {
  let adminToken: string;
  let projectId: string;
  let userId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');

    // Create project
    const projectResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Test Project' });
    projectId = projectResponse.body.id;

    // Create user
    const userResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'alice', password: 'alicepass' });
    userId = userResponse.body.id;
  });

  test('admin can create a project', async () => {
    const response = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Test Project' });

    expect(response.status).toBe(201);
    expect(response.body.id).toBeDefined();
    expect(response.body.name).toBe('Test Project');
  });

  test('admin can create a regular user', async () => {
    const response = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'alice2', password: 'alicepass' });

    expect(response.status).toBe(201);
    expect(response.body.id).toBeDefined();
    expect(response.body.username).toBe('alice2');
    expect(response.body.role).toBe('user');
  });

  test('admin creates a read-only policy for the project', async () => {
    const response = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/policies`)
      .send({
        permissions: ['files:GetFile'],
        notPermissions: ['files:DeleteFile'],
      });

    expect(response.status).toBe(201);
    expect(response.body.id).toBeDefined();
    expect(response.body.permissions).toEqual(['files:GetFile']);
    expect(response.body.notPermissions).toEqual(['files:DeleteFile']);
  });

  test('admin adds user to project with the read-only policy', async () => {
    // First create the policy
    const policyResponse = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/policies`)
      .send({
        permissions: ['files:GetFile'],
        notPermissions: ['files:DeleteFile'],
      });
    const policyId = policyResponse.body.id;

    const response = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/members`)
      .send({
        userId,
        policyId,
      });

    expect(response.status).toBe(201);
  });
});

// ─── Group 2: JWT Permissions (Steps 4-5) ─────────────────────────────────

describe('Group 2: JWT Permissions - User can read but not delete file', () => {
  let adminToken: string;
  let projectId: string;
  let userId: string;
  let userToken: string;
  let fileId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');

    // Create project
    const projectResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Test Project' });
    projectId = projectResponse.body.id;

    // Create user
    const userResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'charlie', password: 'charliepass' });
    userId = userResponse.body.id;
    userToken = await loginAs('charlie', 'charliepass');

    // Create policy and add user to project
    const policyResponse = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/policies`)
      .send({
        permissions: ['files:GetFile'],
        notPermissions: ['files:DeleteFile'],
      });
    const policyId = policyResponse.body.id;

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/members`)
      .send({
        userId,
        policyId,
      });

    // Create file in project
    const fileResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/files')
      .send({
        projectId,
        filename: 'test.txt',
        storageType: 'local',
        storagePath: '/tmp/test.txt',
      });
    fileId = fileResponse.body.id;
  });

  test('user can read file with JWT', async () => {
    const response = await authenticatedTestClient(userToken).get(
      `/api/v1/files/${fileId}`
    );

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(fileId);
    expect(response.body.filename).toBe('test.txt');
  });

  test('user cannot delete file with JWT', async () => {
    const response = await authenticatedTestClient(userToken).delete(
      `/api/v1/files/${fileId}`
    );

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Forbidden');
  });
});

// ─── Group 3: API Key Permissions (Steps 6-9) ─────────────────────────────

describe('Group 3: API Key Permissions - Create key, assign permissions, test access', () => {
  let adminToken: string;
  let projectId: string;
  let userId: string;
  let userToken: string;
  let apiKey: string;
  let fileId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');

    // Create project
    const projectResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Test Project' });
    projectId = projectResponse.body.id;

    // Create user
    const userResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'diana', password: 'dianapass' });
    userId = userResponse.body.id;
    userToken = await loginAs('diana', 'dianapass');

    // Create policy and add user to project
    const policyResponse = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/policies`)
      .send({
        permissions: ['files:GetFile', 'projects:GetProject'],
        notPermissions: ['files:DeleteFile'],
      });
    const policyId = policyResponse.body.id;

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/members`)
      .send({
        userId,
        policyId,
      });

    // Create API key with delete permission
    const newPolicyResponse = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/policies`)
      .send({
        permissions: ['files:GetFile', 'files:DeleteFile'],
      });
    const newPolicyId = newPolicyResponse.body.id;

    const apiKeyResponse = await authenticatedTestClient(userToken)
      .post('/api/v1/api-keys')
      .send({
        projectId,
        policyId: newPolicyId,
        name: 'Test API Key',
      });
    apiKey = apiKeyResponse.body.key;

    // Create file
    const fileResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/files')
      .send({
        projectId,
        filename: 'test.txt',
        storageType: 'local',
        storagePath: '/tmp/test.txt',
      });
    fileId = fileResponse.body.id;
  });

  test('user can create an API key for the project', async () => {
    // First get the policy ID
    const policiesResponse = await authenticatedTestClient(userToken).get(
      `/api/v1/projects/${projectId}/policies`
    );
    const policyId = policiesResponse.body[0].id;

    const response = await authenticatedTestClient(userToken)
      .post('/api/v1/api-keys')
      .send({
        projectId,
        policyId,
        name: 'Test API Key',
      });

    expect(response.status).toBe(201);
    expect(response.body.id).toBeDefined();
    expect(response.body.name).toBe('Test API Key');
    expect(response.body.key).toMatch(/^sk_/);
    expect(response.body.keyPrefix).toBe(response.body.key.slice(0, 8));
  });

  test('user can read file using the API key', async () => {
    const response = await testClient
      .get(`/api/v1/files/${fileId}`)
      .set('Authorization', `Bearer ${apiKey}`);

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(fileId);
    expect(response.body.filename).toBe('test.txt');
  });

  test('user cannot delete file using the API key due to policy intersection', async () => {
    const response = await testClient
      .delete(`/api/v1/files/${fileId}`)
      .set('Authorization', `Bearer ${apiKey}`);

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Forbidden');
  });
});
