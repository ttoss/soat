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

// ─── Group 4: Multiple Users with Different Policies ─────────────────────

describe('Group 4: Two users in the same project with different policies', () => {
  let adminToken: string;
  let projectId: string;
  let readerToken: string;
  let editorToken: string;
  let fileId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');

    const projectResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Multi-User Project' });
    projectId = projectResponse.body.id;

    const readerUserResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'frank', password: 'frankpass' });
    readerToken = await loginAs('frank', 'frankpass');

    const editorUserResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'grace', password: 'gracepass' });
    editorToken = await loginAs('grace', 'gracepass');

    const readPolicyResponse = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/policies`)
      .send({
        permissions: ['files:GetFile'],
        notPermissions: [],
      });
    const readPolicyId = readPolicyResponse.body.id;

    const editPolicyResponse = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/policies`)
      .send({
        permissions: ['files:GetFile', 'files:DeleteFile'],
        notPermissions: [],
      });
    const editPolicyId = editPolicyResponse.body.id;

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/members`)
      .send({ userId: readerUserResponse.body.id, policyId: readPolicyId });

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/members`)
      .send({ userId: editorUserResponse.body.id, policyId: editPolicyId });

    const fileResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/files')
      .send({
        projectId,
        filename: 'shared.txt',
        storageType: 'local',
        storagePath: '/tmp/shared.txt',
      });
    fileId = fileResponse.body.id;
  });

  test('reader user can read the file', async () => {
    const response = await authenticatedTestClient(readerToken).get(
      `/api/v1/files/${fileId}`
    );
    expect(response.status).toBe(200);
    expect(response.body.id).toBe(fileId);
  });

  test('reader user cannot delete the file', async () => {
    const response = await authenticatedTestClient(readerToken).delete(
      `/api/v1/files/${fileId}`
    );
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Forbidden');
  });

  test('editor user can read the file', async () => {
    const response = await authenticatedTestClient(editorToken).get(
      `/api/v1/files/${fileId}`
    );
    expect(response.status).toBe(200);
    expect(response.body.id).toBe(fileId);
  });

  test('editor user can delete the file', async () => {
    const response = await authenticatedTestClient(editorToken).delete(
      `/api/v1/files/${fileId}`
    );
    expect(response.status).toBe(204);
  });
});

// ─── Group 5: User with Multiple API Keys ─────────────────────────────────

describe('Group 5: User with multiple API keys scoped to different permissions', () => {
  let adminToken: string;
  let projectId: string;
  let userToken: string;
  let readOnlyApiKey: string;
  let deleteOnlyApiKey: string;
  let fileId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');

    const projectResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Multiple API Keys Project' });
    projectId = projectResponse.body.id;

    const userResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'howard', password: 'howardpass' });
    userToken = await loginAs('howard', 'howardpass');

    // User membership policy: allows both read and delete
    const memberPolicyResponse = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/policies`)
      .send({
        permissions: ['files:GetFile', 'files:DeleteFile'],
        notPermissions: [],
      });
    const memberPolicyId = memberPolicyResponse.body.id;

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/members`)
      .send({ userId: userResponse.body.id, policyId: memberPolicyId });

    // API key policy 1: read-only
    const readKeyPolicyResponse = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/policies`)
      .send({
        permissions: ['files:GetFile'],
        notPermissions: [],
      });
    const readKeyPolicyId = readKeyPolicyResponse.body.id;

    // API key policy 2: delete-only
    const deleteKeyPolicyResponse = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/policies`)
      .send({
        permissions: ['files:DeleteFile'],
        notPermissions: [],
      });
    const deleteKeyPolicyId = deleteKeyPolicyResponse.body.id;

    const readKeyResponse = await authenticatedTestClient(userToken)
      .post('/api/v1/api-keys')
      .send({ projectId, policyId: readKeyPolicyId, name: 'Read Key' });
    readOnlyApiKey = readKeyResponse.body.key;

    const deleteKeyResponse = await authenticatedTestClient(userToken)
      .post('/api/v1/api-keys')
      .send({ projectId, policyId: deleteKeyPolicyId, name: 'Delete Key' });
    deleteOnlyApiKey = deleteKeyResponse.body.key;

    const fileResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/files')
      .send({
        projectId,
        filename: 'target.txt',
        storageType: 'local',
        storagePath: '/tmp/target.txt',
      });
    fileId = fileResponse.body.id;
  });

  test('read-only API key can read the file', async () => {
    const response = await testClient
      .get(`/api/v1/files/${fileId}`)
      .set('Authorization', `Bearer ${readOnlyApiKey}`);
    expect(response.status).toBe(200);
    expect(response.body.id).toBe(fileId);
  });

  test('read-only API key cannot delete the file', async () => {
    const response = await testClient
      .delete(`/api/v1/files/${fileId}`)
      .set('Authorization', `Bearer ${readOnlyApiKey}`);
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Forbidden');
  });

  test('delete-only API key cannot read the file', async () => {
    const response = await testClient
      .get(`/api/v1/files/${fileId}`)
      .set('Authorization', `Bearer ${deleteOnlyApiKey}`);
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Forbidden');
  });

  test('delete-only API key can delete the file', async () => {
    const response = await testClient
      .delete(`/api/v1/files/${fileId}`)
      .set('Authorization', `Bearer ${deleteOnlyApiKey}`);
    expect(response.status).toBe(204);
  });
});

// ─── Group 6: API Key Project Isolation ──────────────────────────────────

describe('Group 6: API key cannot access files in a different project', () => {
  let adminToken: string;
  let projectAId: string;
  let projectBId: string;
  let userToken: string;
  let apiKey: string;
  let fileInProjectA: string;
  let fileInProjectB: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');

    const projectAResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Project Alpha' });
    projectAId = projectAResponse.body.id;

    const projectBResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Project Beta' });
    projectBId = projectBResponse.body.id;

    const userResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'ivan', password: 'ivanpass' });
    userToken = await loginAs('ivan', 'ivanpass');

    const policyResponse = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectAId}/policies`)
      .send({
        permissions: ['files:GetFile'],
        notPermissions: [],
      });
    const policyId = policyResponse.body.id;

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectAId}/members`)
      .send({ userId: userResponse.body.id, policyId });

    const apiKeyResponse = await authenticatedTestClient(userToken)
      .post('/api/v1/api-keys')
      .send({ projectId: projectAId, policyId, name: 'Project A Key' });
    apiKey = apiKeyResponse.body.key;

    const fileAResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/files')
      .send({
        projectId: projectAId,
        filename: 'alpha.txt',
        storageType: 'local',
        storagePath: '/tmp/alpha.txt',
      });
    fileInProjectA = fileAResponse.body.id;

    const fileBResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/files')
      .send({
        projectId: projectBId,
        filename: 'beta.txt',
        storageType: 'local',
        storagePath: '/tmp/beta.txt',
      });
    fileInProjectB = fileBResponse.body.id;
  });

  test('API key can read a file from its own project', async () => {
    const response = await testClient
      .get(`/api/v1/files/${fileInProjectA}`)
      .set('Authorization', `Bearer ${apiKey}`);
    expect(response.status).toBe(200);
    expect(response.body.id).toBe(fileInProjectA);
  });

  test('API key cannot read a file from a different project', async () => {
    const response = await testClient
      .get(`/api/v1/files/${fileInProjectB}`)
      .set('Authorization', `Bearer ${apiKey}`);
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Forbidden');
  });
});

// ─── Group 7: Wildcard * Policy ───────────────────────────────────────────

describe('Group 7: Policy with wildcard * grants all permissions', () => {
  let adminToken: string;
  let projectId: string;
  let userToken: string;
  let fileId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');

    const projectResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Wildcard Project' });
    projectId = projectResponse.body.id;

    const userResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'julia', password: 'juliapass' });
    userToken = await loginAs('julia', 'juliapass');

    const policyResponse = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/policies`)
      .send({
        permissions: ['*'],
        notPermissions: [],
      });
    const policyId = policyResponse.body.id;

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/members`)
      .send({ userId: userResponse.body.id, policyId });

    const fileResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/files')
      .send({
        projectId,
        filename: 'wildcard.txt',
        storageType: 'local',
        storagePath: '/tmp/wildcard.txt',
      });
    fileId = fileResponse.body.id;
  });

  test('user with wildcard * policy can read the file', async () => {
    const response = await authenticatedTestClient(userToken).get(
      `/api/v1/files/${fileId}`
    );
    expect(response.status).toBe(200);
    expect(response.body.id).toBe(fileId);
  });

  test('user with wildcard * policy can delete the file', async () => {
    const response = await authenticatedTestClient(userToken).delete(
      `/api/v1/files/${fileId}`
    );
    expect(response.status).toBe(204);
  });
});

// ─── Group 8: Namespace Wildcard files:* ──────────────────────────────────

describe('Group 8: Policy with files:* grants all file-namespace permissions', () => {
  let adminToken: string;
  let projectId: string;
  let userToken: string;
  let fileId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');

    const projectResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Namespace Wildcard Project' });
    projectId = projectResponse.body.id;

    const userResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'kevin', password: 'kevinpass' });
    userToken = await loginAs('kevin', 'kevinpass');

    const policyResponse = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/policies`)
      .send({
        permissions: ['files:*'],
        notPermissions: [],
      });
    const policyId = policyResponse.body.id;

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/members`)
      .send({ userId: userResponse.body.id, policyId });

    const fileResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/files')
      .send({
        projectId,
        filename: 'namespace.txt',
        storageType: 'local',
        storagePath: '/tmp/namespace.txt',
      });
    fileId = fileResponse.body.id;
  });

  test('user with files:* policy can read the file', async () => {
    const response = await authenticatedTestClient(userToken).get(
      `/api/v1/files/${fileId}`
    );
    expect(response.status).toBe(200);
    expect(response.body.id).toBe(fileId);
  });

  test('user with files:* policy can delete the file', async () => {
    const response = await authenticatedTestClient(userToken).delete(
      `/api/v1/files/${fileId}`
    );
    expect(response.status).toBe(204);
  });
});

// ─── Group 9: notPermissions Takes Precedence ─────────────────────────────

describe('Group 9: notPermissions overrides permissions when action appears in both', () => {
  let adminToken: string;
  let projectId: string;
  let userToken: string;
  let fileId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');

    const projectResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Conflict Policy Project' });
    projectId = projectResponse.body.id;

    const userResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'luna', password: 'lunapass' });
    userToken = await loginAs('luna', 'lunapass');

    // Same action appears in both permissions and notPermissions — deny wins
    const policyResponse = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/policies`)
      .send({
        permissions: ['files:GetFile', 'files:DeleteFile'],
        notPermissions: ['files:DeleteFile'],
      });
    const policyId = policyResponse.body.id;

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/members`)
      .send({ userId: userResponse.body.id, policyId });

    const fileResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/files')
      .send({
        projectId,
        filename: 'conflict.txt',
        storageType: 'local',
        storagePath: '/tmp/conflict.txt',
      });
    fileId = fileResponse.body.id;
  });

  test('user can read the file (allowed by permissions, not blocked by notPermissions)', async () => {
    const response = await authenticatedTestClient(userToken).get(
      `/api/v1/files/${fileId}`
    );
    expect(response.status).toBe(200);
    expect(response.body.id).toBe(fileId);
  });

  test('user cannot delete the file even though it is in permissions (notPermissions wins)', async () => {
    const response = await authenticatedTestClient(userToken).delete(
      `/api/v1/files/${fileId}`
    );
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Forbidden');
  });
});

// ─── Group 10: User Without Project Membership ────────────────────────────

describe('Group 10: User without project membership is denied access to all file operations', () => {
  let adminToken: string;
  let projectId: string;
  let outsiderToken: string;
  let fileId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');

    const projectResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Private Project' });
    projectId = projectResponse.body.id;

    // Create outsider user — deliberately NOT added to the project
    await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'mark', password: 'markpass' });
    outsiderToken = await loginAs('mark', 'markpass');

    const fileResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/files')
      .send({
        projectId,
        filename: 'private.txt',
        storageType: 'local',
        storagePath: '/tmp/private.txt',
      });
    fileId = fileResponse.body.id;
  });

  test('outsider user cannot read the file (no project membership)', async () => {
    const response = await authenticatedTestClient(outsiderToken).get(
      `/api/v1/files/${fileId}`
    );
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Forbidden');
  });

  test('outsider user cannot delete the file (no project membership)', async () => {
    const response = await authenticatedTestClient(outsiderToken).delete(
      `/api/v1/files/${fileId}`
    );
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Forbidden');
  });
});

// ─── Group 11: Multiple Admins ────────────────────────────────────────────

describe('Group 11: Multiple admins can all manage projects and bypass policy checks', () => {
  let admin1Token: string;
  let admin2Token: string;
  let projectId: string;
  let fileId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    admin1Token = await loginAs('admin', 'supersecret');

    // Admin1 promotes a second user to admin role
    await authenticatedTestClient(admin1Token)
      .post('/api/v1/users')
      .send({ username: 'nina', password: 'ninapass', role: 'admin' });
    admin2Token = await loginAs('nina', 'ninapass');

    const projectResponse = await authenticatedTestClient(admin1Token)
      .post('/api/v1/projects')
      .send({ name: 'Admin1 Project' });
    projectId = projectResponse.body.id;

    const fileResponse = await authenticatedTestClient(admin1Token)
      .post('/api/v1/files')
      .send({
        projectId,
        filename: 'admin-file.txt',
        storageType: 'local',
        storagePath: '/tmp/admin-file.txt',
      });
    fileId = fileResponse.body.id;
  });

  test('admin2 can create a project independently', async () => {
    const response = await authenticatedTestClient(admin2Token)
      .post('/api/v1/projects')
      .send({ name: 'Admin2 Project' });
    expect(response.status).toBe(201);
    expect(response.body.name).toBe('Admin2 Project');
  });

  test('admin2 can read files in a project created by admin1', async () => {
    const response = await authenticatedTestClient(admin2Token).get(
      `/api/v1/files/${fileId}`
    );
    expect(response.status).toBe(200);
    expect(response.body.id).toBe(fileId);
  });

  test('admin2 can create policies in a project created by admin1', async () => {
    const response = await authenticatedTestClient(admin2Token)
      .post(`/api/v1/projects/${projectId}/policies`)
      .send({
        permissions: ['files:GetFile'],
        notPermissions: [],
      });
    expect(response.status).toBe(201);
    expect(response.body.id).toBeDefined();
  });

  test('admin2 can delete files in a project created by admin1', async () => {
    const response = await authenticatedTestClient(admin2Token).delete(
      `/api/v1/files/${fileId}`
    );
    expect(response.status).toBe(204);
  });
});

// ─── Group 12: Multiple Users with Multiple API Keys ──────────────────────

describe('Group 12: Multiple users each with multiple API keys in the same project', () => {
  let adminToken: string;
  let projectId: string;
  let user1ReadKey: string;
  let user1DeleteKey: string;
  let user2Key: string;
  let fileId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');

    const projectResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Multi-User API Keys Project' });
    projectId = projectResponse.body.id;

    // User1 membership: full permissions
    const user1Response = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'oscar', password: 'oscarpass' });
    const user1Token = await loginAs('oscar', 'oscarpass');

    const fullPolicyResponse = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/policies`)
      .send({
        permissions: ['files:GetFile', 'files:DeleteFile'],
        notPermissions: [],
      });
    const fullPolicyId = fullPolicyResponse.body.id;

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/members`)
      .send({ userId: user1Response.body.id, policyId: fullPolicyId });

    // User2 membership: read-only
    const user2Response = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'patricia', password: 'patriciapass' });
    const user2Token = await loginAs('patricia', 'patriciapass');

    const readOnlyPolicyResponse = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/policies`)
      .send({
        permissions: ['files:GetFile'],
        notPermissions: [],
      });
    const readOnlyPolicyId = readOnlyPolicyResponse.body.id;

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/members`)
      .send({ userId: user2Response.body.id, policyId: readOnlyPolicyId });

    // API key policies
    const readKeyPolicyResponse = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/policies`)
      .send({
        permissions: ['files:GetFile'],
        notPermissions: [],
      });
    const readKeyPolicyId = readKeyPolicyResponse.body.id;

    const deleteKeyPolicyResponse = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/policies`)
      .send({
        permissions: ['files:GetFile', 'files:DeleteFile'],
        notPermissions: [],
      });
    const deleteKeyPolicyId = deleteKeyPolicyResponse.body.id;

    // User1 creates two API keys: one read-only, one full
    const u1ReadKeyResponse = await authenticatedTestClient(user1Token)
      .post('/api/v1/api-keys')
      .send({ projectId, policyId: readKeyPolicyId, name: 'Oscar Read Key' });
    user1ReadKey = u1ReadKeyResponse.body.key;

    const u1DeleteKeyResponse = await authenticatedTestClient(user1Token)
      .post('/api/v1/api-keys')
      .send({
        projectId,
        policyId: deleteKeyPolicyId,
        name: 'Oscar Delete Key',
      });
    user1DeleteKey = u1DeleteKeyResponse.body.key;

    // User2 creates a key with full key policy — but membership is read-only,
    // so the effective permission (intersection) is still read-only
    const u2KeyResponse = await authenticatedTestClient(user2Token)
      .post('/api/v1/api-keys')
      .send({
        projectId,
        policyId: deleteKeyPolicyId,
        name: 'Patricia Key',
      });
    user2Key = u2KeyResponse.body.key;

    const fileResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/files')
      .send({
        projectId,
        filename: 'multi.txt',
        storageType: 'local',
        storagePath: '/tmp/multi.txt',
      });
    fileId = fileResponse.body.id;
  });

  test('user1 read key can read the file', async () => {
    const response = await testClient
      .get(`/api/v1/files/${fileId}`)
      .set('Authorization', `Bearer ${user1ReadKey}`);
    expect(response.status).toBe(200);
    expect(response.body.id).toBe(fileId);
  });

  test('user1 read key cannot delete the file (key policy is read-only)', async () => {
    const response = await testClient
      .delete(`/api/v1/files/${fileId}`)
      .set('Authorization', `Bearer ${user1ReadKey}`);
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Forbidden');
  });

  test('user2 key can read the file', async () => {
    const response = await testClient
      .get(`/api/v1/files/${fileId}`)
      .set('Authorization', `Bearer ${user2Key}`);
    expect(response.status).toBe(200);
    expect(response.body.id).toBe(fileId);
  });

  test('user2 key cannot delete the file (membership policy is read-only, intersection blocks delete)', async () => {
    const response = await testClient
      .delete(`/api/v1/files/${fileId}`)
      .set('Authorization', `Bearer ${user2Key}`);
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Forbidden');
  });

  test('user1 delete key can read the file', async () => {
    const response = await testClient
      .get(`/api/v1/files/${fileId}`)
      .set('Authorization', `Bearer ${user1DeleteKey}`);
    expect(response.status).toBe(200);
    expect(response.body.id).toBe(fileId);
  });

  test('user1 delete key can delete the file', async () => {
    const response = await testClient
      .delete(`/api/v1/files/${fileId}`)
      .set('Authorization', `Bearer ${user1DeleteKey}`);
    expect(response.status).toBe(204);
  });
});
