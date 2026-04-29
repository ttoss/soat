import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * Integration test for the full IAM permissions flow:
 *
 * 1. admin creates a project
 * 2. admin creates a regular user
 * 3. admin creates a global policy and attaches it to the user
 * 4. user can read a file using JWT
 * 5. user cannot delete that file using JWT
 * 6. user creates an API key scoped to the project
 * 7. user assigns the deleteFile action to the API key policy
 * 8. user can read the file using the API key
 * 9. user cannot delete the file using the API key (user policy deny intersection)
 */

// ─── Group 1: Setup (Steps 1-3) ──────────────────────────────────────────

describe('Group 1: Setup - Admin creates project, user, and assigns permissions', () => {
  let adminToken: string;
  let _projectId: string;
  let userId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');

    const projectResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Test Project' });

    _projectId = projectResponse.body.id;

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

  test('admin creates a global read-only policy', async () => {
    const response = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            { effect: 'Allow', action: ['files:GetFile'] },
            { effect: 'Deny', action: ['files:DeleteFile'] },
          ],
        },
      });

    expect(response.status).toBe(201);
    expect(response.body.id).toBeDefined();
    expect(response.body.document.statement[0].action).toEqual([
      'files:GetFile',
    ]);
    expect(response.body.document.statement[1].action).toEqual([
      'files:DeleteFile',
    ]);
  });

  test('admin attaches policy to user', async () => {
    const policyResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            { effect: 'Allow', action: ['files:GetFile'] },
            { effect: 'Deny', action: ['files:DeleteFile'] },
          ],
        },
      });

    const policyId = policyResponse.body.id;

    const response = await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userId}/policies`)
      .send({ policy_ids: [policyId] });

    expect(response.status).toBe(204);
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

    const projectResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Test Project' });

    projectId = projectResponse.body.id;

    const userResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'charlie', password: 'charliepass' });

    userId = userResponse.body.id;
    userToken = await loginAs('charlie', 'charliepass');

    const policyResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            { effect: 'Allow', action: ['files:GetFile'] },
            { effect: 'Deny', action: ['files:DeleteFile'] },
          ],
        },
      });

    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userId}/policies`)
      .send({ policy_ids: [policyResponse.body.id] });

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

// ─── Group 3: API Key Permissions (Steps 6-9) ─────────────────────────────────

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

    const projectResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Test Project' });

    projectId = projectResponse.body.id;

    const userResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'diana', password: 'dianapass' });

    userId = userResponse.body.id;
    userToken = await loginAs('diana', 'dianapass');

    // User policy: allows read, denies delete
    const userPolicyResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: ['files:GetFile', 'projects:GetProject'],
            },
            { effect: 'Deny', action: ['files:DeleteFile'] },
          ],
        },
      });

    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userId}/policies`)
      .send({ policy_ids: [userPolicyResponse.body.id] });

    // API key policy: allows both read and delete
    const keyPolicyResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            { effect: 'Allow', action: ['files:GetFile', 'files:DeleteFile'] },
          ],
        },
      });

    const apiKeyResponse = await authenticatedTestClient(userToken)
      .post('/api/v1/api-keys')
      .send({
        project_id: projectId,
        policy_ids: [keyPolicyResponse.body.id],
        name: 'Test API key',
      });

    apiKey = apiKeyResponse.body.key;

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

  test('user can create an API key for the project', async () => {
    const keyPolicyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [{ effect: 'Allow', action: ['files:GetFile'] }],
        },
      });

    const response = await authenticatedTestClient(userToken)
      .post('/api/v1/api-keys')
      .send({
        project_id: projectId,
        policy_ids: [keyPolicyRes.body.id],
        name: 'Test API key',
      });

    expect(response.status).toBe(201);
    expect(response.body.id).toBeDefined();
    expect(response.body.name).toBe('Test API key');
    expect(response.body.key).toMatch(/^sk_/);
    expect(response.body.key_prefix).toBe(response.body.key.slice(0, 8));
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
    // Key policy allows delete, but user policy denies it — deny wins
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
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [{ effect: 'Allow', action: ['files:GetFile'] }],
        },
      });

    const editPolicyResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            { effect: 'Allow', action: ['files:GetFile', 'files:DeleteFile'] },
          ],
        },
      });

    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${readerUserResponse.body.id}/policies`)
      .send({ policy_ids: [readPolicyResponse.body.id] });

    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${editorUserResponse.body.id}/policies`)
      .send({ policy_ids: [editPolicyResponse.body.id] });

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

// ─── Group 5: User with Multiple API Keys ─────────────────────────────────────

describe('Group 5: User with multiple API keys scoped to different permissions', () => {
  let adminToken: string;
  let projectId: string;
  let userToken: string;
  let userId: string;
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

    userId = userResponse.body.id;
    userToken = await loginAs('howard', 'howardpass');

    // User policy: allows both read and delete
    const memberPolicyResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            { effect: 'Allow', action: ['files:GetFile', 'files:DeleteFile'] },
          ],
        },
      });

    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userId}/policies`)
      .send({ policy_ids: [memberPolicyResponse.body.id] });

    // API key policy 1: read-only
    const readKeyPolicyResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [{ effect: 'Allow', action: ['files:GetFile'] }],
        },
      });

    // API key policy 2: delete-only
    const deleteKeyPolicyResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [{ effect: 'Allow', action: ['files:DeleteFile'] }],
        },
      });

    const readKeyResponse = await authenticatedTestClient(userToken)
      .post('/api/v1/api-keys')
      .send({
        project_id: projectId,
        policy_ids: [readKeyPolicyResponse.body.id],
        name: 'Read Key',
      });

    readOnlyApiKey = readKeyResponse.body.key;

    const deleteKeyResponse = await authenticatedTestClient(userToken)
      .post('/api/v1/api-keys')
      .send({
        project_id: projectId,
        policy_ids: [deleteKeyPolicyResponse.body.id],
        name: 'Delete Key',
      });

    deleteOnlyApiKey = deleteKeyResponse.body.key;

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

// ─── Group 6: API Key Project Isolation ──────────────────────────────────────

describe('Group 6: API key cannot access files in a different project', () => {
  let adminToken: string;
  let projectAId: string;
  let projectBId: string;
  let userToken: string;
  let userId: string;
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

    userId = userResponse.body.id;
    userToken = await loginAs('ivan', 'ivanpass');

    const policyResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [{ effect: 'Allow', action: ['files:GetFile'] }],
        },
      });

    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userId}/policies`)
      .send({ policy_ids: [policyResponse.body.id] });

    const apiKeyResponse = await authenticatedTestClient(userToken)
      .post('/api/v1/api-keys')
      .send({
        project_id: projectAId,
        policy_ids: [policyResponse.body.id],
        name: 'Project A Key',
      });

    apiKey = apiKeyResponse.body.key;

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
  let userId: string;
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

    userId = userResponse.body.id;
    userToken = await loginAs('julia', 'juliapass');

    const policyResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [{ effect: 'Allow', action: ['*'] }],
        },
      });

    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userId}/policies`)
      .send({ policy_ids: [policyResponse.body.id] });

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
  let userId: string;
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

    userId = userResponse.body.id;
    userToken = await loginAs('kevin', 'kevinpass');

    const policyResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [{ effect: 'Allow', action: ['files:*'] }],
        },
      });

    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userId}/policies`)
      .send({ policy_ids: [policyResponse.body.id] });

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
  let userId: string;
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

    userId = userResponse.body.id;
    userToken = await loginAs('luna', 'lunapass');

    const policyResponse = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            { effect: 'Allow', action: ['files:GetFile', 'files:DeleteFile'] },
            { effect: 'Deny', action: ['files:DeleteFile'] },
          ],
        },
      });

    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userId}/policies`)
      .send({ policy_ids: [policyResponse.body.id] });

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

  test('user can read the file (files:GetFile is allowed)', async () => {
    const response = await authenticatedTestClient(userToken).get(
      `/api/v1/files/${fileId}`
    );

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(fileId);
  });

  test('user cannot delete the file (notPermissions takes precedence)', async () => {
    const response = await authenticatedTestClient(userToken).delete(
      `/api/v1/files/${fileId}`
    );

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Forbidden');
  });
});

// ─── Group 10: Regression — project-scoped resource SRN in JWT policy ───────
//
// Before the auth.ts fix, isAllowed() was called without a `resource` arg when
// resolving which projects a user can access. That caused the default resource
// value of '*' to be tested against a policy pattern like
// `soat:proj_xxx:*:*`, which never matched — so every policy-scoped user got
// 403 even when their policy explicitly granted access.
//
// These tests would have failed on main before the fix.

describe('Group 10: JWT — policy with explicit project-scoped resource SRN grants access', () => {
  let adminToken: string;
  let projectAId: string;
  let projectBId: string;
  let userToken: string;
  let userId: string;
  let fileInProjectA: string;
  let fileInProjectB: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');

    const projectARes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'SRN JWT Project A' });

    projectAId = projectARes.body.id;

    const projectBRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'SRN JWT Project B' });

    projectBId = projectBRes.body.id;

    const userRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'mary', password: 'marypass' });

    userId = userRes.body.id;
    userToken = await loginAs('mary', 'marypass');

    // Policy that targets Project A explicitly via a resource SRN.
    // A user with this policy should be able to read files in Project A
    // but not in Project B.
    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: ['files:GetFile'],
              resource: [`soat:${projectAId}:*:*`],
            },
          ],
        },
      });

    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userId}/policies`)
      .send({ policy_ids: [policyRes.body.id] });

    const fileARes = await authenticatedTestClient(adminToken)
      .post('/api/v1/files')
      .send({
        project_id: projectAId,
        filename: 'srn-jwt-a.txt',
        storage_type: 'local',
        storage_path: '/tmp/srn-jwt-a.txt',
      });

    fileInProjectA = fileARes.body.id;

    const fileBRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/files')
      .send({
        project_id: projectBId,
        filename: 'srn-jwt-b.txt',
        storage_type: 'local',
        storage_path: '/tmp/srn-jwt-b.txt',
      });

    fileInProjectB = fileBRes.body.id;
  });

  test('user can read a file in the project targeted by the policy SRN', async () => {
    // Regression: was returning 403 before the resource SRN fix in auth.ts
    const response = await authenticatedTestClient(userToken).get(
      `/api/v1/files/${fileInProjectA}`
    );

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(fileInProjectA);
  });

  test('user cannot read a file in a project not covered by the policy SRN', async () => {
    const response = await authenticatedTestClient(userToken).get(
      `/api/v1/files/${fileInProjectB}`
    );

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Forbidden');
  });

  test('listing files filtered by the allowed project returns results', async () => {
    // Exercises filterAccessibleProjects with a resource SRN
    const response = await authenticatedTestClient(userToken).get(
      `/api/v1/files?projectId=${projectAId}`
    );

    expect(response.status).toBe(200);

    const ids = (response.body.data as Array<{ id: string }>).map((f) => {
      return f.id;
    });
    expect(ids).toContain(fileInProjectA);
  });

  test('listing files filtered by the denied project returns 403', async () => {
    const response = await authenticatedTestClient(userToken).get(
      `/api/v1/files?projectId=${projectBId}`
    );

    expect(response.status).toBe(403);
  });
});

// ─── Group 11: Regression — project-scoped resource SRN in API key policy ─
//
// Mirrors Group 10 for the API key code path (resolveApiKeyScopedProjectIds).
// The key's own policy carries an explicit resource SRN; before the fix the
// apiKeyIsAllowed call omitted the resource arg and always evaluated to false.

describe('Group 11: API key — scoped key with project-resource SRN in key policy grants access', () => {
  let adminToken: string;
  let projectAId: string;
  let userToken: string;
  let apiKey: string;
  let fileInProjectA: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');

    const projectARes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'SRN API Key Project A' });

    projectAId = projectARes.body.id;

    const userRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'nancy', password: 'nancypass' });

    userToken = await loginAs('nancy', 'nancypass');

    // Give user a broad policy so they can create the API key and are not
    // blocked by the user-level check.
    const userPolicyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [{ effect: 'Allow', action: ['*'] }],
        },
      });

    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userRes.body.id}/policies`)
      .send({ policy_ids: [userPolicyRes.body.id] });

    // Key policy targets Project A via an explicit resource SRN.
    const keyPolicyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: ['files:GetFile'],
              resource: [`soat:${projectAId}:*:*`],
            },
          ],
        },
      });

    const apiKeyRes = await authenticatedTestClient(userToken)
      .post('/api/v1/api-keys')
      .send({
        project_id: projectAId,
        policy_ids: [keyPolicyRes.body.id],
        name: 'SRN scoped key',
      });

    apiKey = apiKeyRes.body.key;

    const fileARes = await authenticatedTestClient(adminToken)
      .post('/api/v1/files')
      .send({
        project_id: projectAId,
        filename: 'srn-api-a.txt',
        storage_type: 'local',
        storage_path: '/tmp/srn-api-a.txt',
      });

    fileInProjectA = fileARes.body.id;
  });

  test('API key can read a file when the key policy SRN matches the project', async () => {
    // Regression: was returning 403 before the resource SRN fix in auth.ts
    const response = await testClient
      .get(`/api/v1/files/${fileInProjectA}`)
      .set('Authorization', `Bearer ${apiKey}`);

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(fileInProjectA);
  });
});

// ─── Group 12: Regression — admin API key with full-access policy ─────────
//
// An API key owned by an admin user with a full-access policy (action: ["*"],
// resource: ["*"]) was returning 403 on every endpoint. The root cause was
// that createApiKeyIsAllowed evaluated the user's explicit policyIds without
// checking the admin role bypass, causing evalUser to return false for admins
// who carry no policyIds.

describe('Group 12: Admin API key with full-access policy is not 403', () => {
  let adminToken: string;
  let projectId: string;
  let adminApiKey: string;
  let fileId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Admin Full-Access Key Project' });

    projectId = projectRes.body.id;

    // Full-access policy: action: ["*"], resource: ["*"]
    const fullAccessPolicyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: ['*'],
              resource: ['*'],
            },
          ],
        },
      });

    const keyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/api-keys')
      .send({
        name: 'admin-full-access',
        project_id: projectId,
        policy_ids: [fullAccessPolicyRes.body.id],
      });

    adminApiKey = keyRes.body.key;

    const fileRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/files')
      .send({
        project_id: projectId,
        filename: 'admin-key.txt',
        storage_type: 'local',
        storage_path: '/tmp/admin-key.txt',
      });

    fileId = fileRes.body.id;
  });

  test('admin API key with full-access policy can list files', async () => {
    const response = await testClient
      .get(`/api/v1/files?project_id=${projectId}`)
      .set('Authorization', `Bearer ${adminApiKey}`);

    expect(response.status).toBe(200);
  });

  test('admin API key with full-access policy can get a file', async () => {
    const response = await testClient
      .get(`/api/v1/files/${fileId}`)
      .set('Authorization', `Bearer ${adminApiKey}`);

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(fileId);
  });

  test('admin API key with full-access policy can delete a file', async () => {
    const response = await testClient
      .delete(`/api/v1/files/${fileId}`)
      .set('Authorization', `Bearer ${adminApiKey}`);

    expect(response.status).toBe(204);
  });
});
