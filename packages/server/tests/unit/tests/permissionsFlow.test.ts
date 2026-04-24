import { authenticatedTestClient, loginAs, testClient } from '../testClient';

/**
 * Integration test for the full IAM permissions flow:
 *
 * 1. admin creates a project
 * 2. admin creates a regular user
 * 3. admin assigns the user to the project with a read-only policy
 * 4. user can read a file using JWT
 * 5. user cannot delete that file using JWT
 * 6. user creates an project key scoped to the project
 * 7. user assigns the deleteFile action to the project key
 * 8. user can read the file using the project key
 * 9. user cannot delete the file using the project key (membership policy intersection)
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
        not_permissions: ['files:DeleteFile'],
      });

    expect(response.status).toBe(201);
    expect(response.body.id).toBeDefined();
    expect(response.body.permissions).toEqual(['files:GetFile']);
    expect(response.body.not_permissions).toEqual(['files:DeleteFile']);
  });

  test('admin adds user to project with the read-only policy', async () => {
    // First create the policy
    const policyResponse = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/policies`)
      .send({
        permissions: ['files:GetFile'],
        not_permissions: ['files:DeleteFile'],
      });
    const policyId = policyResponse.body.id;

    const response = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/members`)
      .send({
        user_id: userId,
        policy_id: policyId,
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
        not_permissions: ['files:DeleteFile'],
      });
    const policyId = policyResponse.body.id;

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/members`)
      .send({
        user_id: userId,
        policy_id: policyId,
      });

    // Create file in project
    const fileResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/files')
      .send({
        project_id: projectId,
        filename: 'test.txt',
        storage_type: 'local',
        storage_path: '/tmp/test.txt',
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

// ─── Group 3: project key Permissions (Steps 6-9) ─────────────────────────────

describe('Group 3: project key Permissions - Create key, assign permissions, test access', () => {
  let adminToken: string;
  let projectId: string;
  let userId: string;
  let userToken: string;
  let projectKey: string;
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
        not_permissions: ['files:DeleteFile'],
      });
    const policyId = policyResponse.body.id;

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/members`)
      .send({
        user_id: userId,
        policy_id: policyId,
      });

    // Create project key with delete permission
    const newPolicyResponse = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/policies`)
      .send({
        permissions: ['files:GetFile', 'files:DeleteFile'],
      });
    const newPolicyId = newPolicyResponse.body.id;

    const projectKeyResponse = await authenticatedTestClient(userToken)
      .post('/api/v1/project-keys')
      .send({
        project_id: projectId,
        policy_id: newPolicyId,
        name: 'Test project key',
      });
    projectKey = projectKeyResponse.body.key;

    // Create file
    const fileResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/files')
      .send({
        project_id: projectId,
        filename: 'test.txt',
        storage_type: 'local',
        storage_path: '/tmp/test.txt',
      });
    fileId = fileResponse.body.id;
  });

  test('user can create an project key for the project', async () => {
    // First get the policy ID
    const policiesResponse = await authenticatedTestClient(userToken).get(
      `/api/v1/projects/${projectId}/policies`
    );
    const policyId = policiesResponse.body[0].id;

    const response = await authenticatedTestClient(userToken)
      .post('/api/v1/project-keys')
      .send({
        project_id: projectId,
        policy_id: policyId,
        name: 'Test project key',
      });

    expect(response.status).toBe(201);
    expect(response.body.id).toBeDefined();
    expect(response.body.name).toBe('Test project key');
    expect(response.body.key).toMatch(/^sk_/);
    expect(response.body.key_prefix).toBe(response.body.key.slice(0, 8));
  });

  test('user can read file using the project key', async () => {
    const response = await testClient
      .get(`/api/v1/files/${fileId}`)
      .set('Authorization', `Bearer ${projectKey}`);

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(fileId);
    expect(response.body.filename).toBe('test.txt');
  });

  test('user cannot delete file using the project key due to policy intersection', async () => {
    const response = await testClient
      .delete(`/api/v1/files/${fileId}`)
      .set('Authorization', `Bearer ${projectKey}`);

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
        not_permissions: [],
      });
    const readPolicyId = readPolicyResponse.body.id;

    const editPolicyResponse = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/policies`)
      .send({
        permissions: ['files:GetFile', 'files:DeleteFile'],
        not_permissions: [],
      });
    const editPolicyId = editPolicyResponse.body.id;

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/members`)
      .send({ user_id: readerUserResponse.body.id, policy_id: readPolicyId });

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/members`)
      .send({ user_id: editorUserResponse.body.id, policy_id: editPolicyId });

    const fileResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/files')
      .send({
        project_id: projectId,
        filename: 'shared.txt',
        storage_type: 'local',
        storage_path: '/tmp/shared.txt',
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

// ─── Group 5: User with Multiple project keys ─────────────────────────────────

describe('Group 5: User with multiple project keys scoped to different permissions', () => {
  let adminToken: string;
  let projectId: string;
  let userToken: string;
  let readOnlyProjectKey: string;
  let deleteOnlyProjectKey: string;
  let fileId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');

    const projectResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Multiple project keys Project' });
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
        not_permissions: [],
      });
    const memberPolicyId = memberPolicyResponse.body.id;

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/members`)
      .send({ user_id: userResponse.body.id, policy_id: memberPolicyId });

    // project key policy 1: read-only
    const readKeyPolicyResponse = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/policies`)
      .send({
        permissions: ['files:GetFile'],
        not_permissions: [],
      });
    const readKeyPolicyId = readKeyPolicyResponse.body.id;

    // project key policy 2: delete-only
    const deleteKeyPolicyResponse = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/policies`)
      .send({
        permissions: ['files:DeleteFile'],
        not_permissions: [],
      });
    const deleteKeyPolicyId = deleteKeyPolicyResponse.body.id;

    const readKeyResponse = await authenticatedTestClient(userToken)
      .post('/api/v1/project-keys')
      .send({ project_id: projectId, policy_id: readKeyPolicyId, name: 'Read Key' });
    readOnlyProjectKey = readKeyResponse.body.key;

    const deleteKeyResponse = await authenticatedTestClient(userToken)
      .post('/api/v1/project-keys')
      .send({ project_id: projectId, policy_id: deleteKeyPolicyId, name: 'Delete Key' });
    deleteOnlyProjectKey = deleteKeyResponse.body.key;

    const fileResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/files')
      .send({
        project_id: projectId,
        filename: 'target.txt',
        storage_type: 'local',
        storage_path: '/tmp/target.txt',
      });
    fileId = fileResponse.body.id;
  });

  test('read-only project key can read the file', async () => {
    const response = await testClient
      .get(`/api/v1/files/${fileId}`)
      .set('Authorization', `Bearer ${readOnlyProjectKey}`);
    expect(response.status).toBe(200);
    expect(response.body.id).toBe(fileId);
  });

  test('read-only project key cannot delete the file', async () => {
    const response = await testClient
      .delete(`/api/v1/files/${fileId}`)
      .set('Authorization', `Bearer ${readOnlyProjectKey}`);
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Forbidden');
  });

  test('delete-only project key cannot read the file', async () => {
    const response = await testClient
      .get(`/api/v1/files/${fileId}`)
      .set('Authorization', `Bearer ${deleteOnlyProjectKey}`);
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Forbidden');
  });

  test('delete-only project key can delete the file', async () => {
    const response = await testClient
      .delete(`/api/v1/files/${fileId}`)
      .set('Authorization', `Bearer ${deleteOnlyProjectKey}`);
    expect(response.status).toBe(204);
  });
});

// ─── Group 6: project key Project Isolation ──────────────────────────────────

describe('Group 6: project key cannot access files in a different project', () => {
  let adminToken: string;
  let projectAId: string;
  let projectBId: string;
  let userToken: string;
  let projectKey: string;
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
        not_permissions: [],
      });
    const policyId = policyResponse.body.id;

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectAId}/members`)
      .send({ user_id: userResponse.body.id, policy_id: policyId });

    const projectKeyResponse = await authenticatedTestClient(userToken)
      .post('/api/v1/project-keys')
      .send({ project_id: projectAId, policy_id: policyId, name: 'Project A Key' });
    projectKey = projectKeyResponse.body.key;

    const fileAResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/files')
      .send({
        project_id: projectAId,
        filename: 'alpha.txt',
        storage_type: 'local',
        storage_path: '/tmp/alpha.txt',
      });
    fileInProjectA = fileAResponse.body.id;

    const fileBResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/files')
      .send({
        project_id: projectBId,
        filename: 'beta.txt',
        storage_type: 'local',
        storage_path: '/tmp/beta.txt',
      });
    fileInProjectB = fileBResponse.body.id;
  });

  test('project key can read a file from its own project', async () => {
    const response = await testClient
      .get(`/api/v1/files/${fileInProjectA}`)
      .set('Authorization', `Bearer ${projectKey}`);
    expect(response.status).toBe(200);
    expect(response.body.id).toBe(fileInProjectA);
  });

  test('project key cannot read a file from a different project', async () => {
    const response = await testClient
      .get(`/api/v1/files/${fileInProjectB}`)
      .set('Authorization', `Bearer ${projectKey}`);
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
        not_permissions: [],
      });
    const policyId = policyResponse.body.id;

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/members`)
      .send({ user_id: userResponse.body.id, policy_id: policyId });

    const fileResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/files')
      .send({
        project_id: projectId,
        filename: 'wildcard.txt',
        storage_type: 'local',
        storage_path: '/tmp/wildcard.txt',
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
        not_permissions: [],
      });
    const policyId = policyResponse.body.id;

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/members`)
      .send({ user_id: userResponse.body.id, policy_id: policyId });

    const fileResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/files')
      .send({
        project_id: projectId,
        filename: 'namespace.txt',
        storage_type: 'local',
        storage_path: '/tmp/namespace.txt',
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
        not_permissions: ['files:DeleteFile'],
      });
    const policyId = policyResponse.body.id;

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/members`)
      .send({ user_id: userResponse.body.id, policy_id: policyId });

    const fileResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/files')
      .send({
        project_id: projectId,
        filename: 'conflict.txt',
        storage_type: 'local',
        storage_path: '/tmp/conflict.txt',
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
        project_id: projectId,
        filename: 'private.txt',
        storage_type: 'local',
        storage_path: '/tmp/private.txt',
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
        project_id: projectId,
        filename: 'admin-file.txt',
        storage_type: 'local',
        storage_path: '/tmp/admin-file.txt',
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
        not_permissions: [],
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

// ─── Group 12: Multiple Users with Multiple project keys ──────────────────────

describe('Group 12: Multiple users each with multiple project keys in the same project', () => {
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
      .send({ name: 'Multi-User project keys Project' });
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
        not_permissions: [],
      });
    const fullPolicyId = fullPolicyResponse.body.id;

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/members`)
      .send({ user_id: user1Response.body.id, policy_id: fullPolicyId });

    // User2 membership: read-only
    const user2Response = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'patricia', password: 'patriciapass' });
    const user2Token = await loginAs('patricia', 'patriciapass');

    const readOnlyPolicyResponse = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/policies`)
      .send({
        permissions: ['files:GetFile'],
        not_permissions: [],
      });
    const readOnlyPolicyId = readOnlyPolicyResponse.body.id;

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/members`)
      .send({ user_id: user2Response.body.id, policy_id: readOnlyPolicyId });

    // project key policies
    const readKeyPolicyResponse = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/policies`)
      .send({
        permissions: ['files:GetFile'],
        not_permissions: [],
      });
    const readKeyPolicyId = readKeyPolicyResponse.body.id;

    const deleteKeyPolicyResponse = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/policies`)
      .send({
        permissions: ['files:GetFile', 'files:DeleteFile'],
        not_permissions: [],
      });
    const deleteKeyPolicyId = deleteKeyPolicyResponse.body.id;

    // User1 creates two project keys: one read-only, one full
    const u1ReadKeyResponse = await authenticatedTestClient(user1Token)
      .post('/api/v1/project-keys')
      .send({ project_id: projectId, policy_id: readKeyPolicyId, name: 'Oscar Read Key' });
    user1ReadKey = u1ReadKeyResponse.body.key;

    const u1DeleteKeyResponse = await authenticatedTestClient(user1Token)
      .post('/api/v1/project-keys')
      .send({
        project_id: projectId,
        policy_id: deleteKeyPolicyId,
        name: 'Oscar Delete Key',
      });
    user1DeleteKey = u1DeleteKeyResponse.body.key;

    // User2 creates a key with full key policy — but membership is read-only,
    // so the effective permission (intersection) is still read-only
    const u2KeyResponse = await authenticatedTestClient(user2Token)
      .post('/api/v1/project-keys')
      .send({
        project_id: projectId,
        policy_id: deleteKeyPolicyId,
        name: 'Patricia Key',
      });
    user2Key = u2KeyResponse.body.key;

    const fileResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/files')
      .send({
        project_id: projectId,
        filename: 'multi.txt',
        storage_type: 'local',
        storage_path: '/tmp/multi.txt',
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
