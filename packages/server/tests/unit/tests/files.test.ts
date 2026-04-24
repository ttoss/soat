import fs from 'node:fs';

import { storageDir } from '../setupTests';
import { authenticatedTestClient, loginAs, testClient } from '../testClient';

describe('Files', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectId: string;
  let policyId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });

    adminToken = await loginAs('admin', 'supersecret');

    const createUserRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'filesuser', password: 'filespass' });

    userId = createUserRes.body.id;
    userToken = await loginAs('filesuser', 'filespass');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Files Test Project' });
    projectId = projectRes.body.id;

    const policyRes = await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/policies`)
      .send({
        permissions: [
          'files:UploadFile',
          'files:GetFile',
          'files:DownloadFile',
          'files:UpdateFileMetadata',
          'files:DeleteFile',
          'files:CreateFile',
        ],
      });
    policyId = policyRes.body.id;

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/projects/${projectId}/members`)
      .send({ user_id: userId, policy_id: policyId });
  });

  afterAll(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  describe('POST /api/v1/files/upload', () => {
    test('authenticated user with permission can upload a file', async () => {
      const fileContent = Buffer.from('Hello, world!');

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload')
        .attach('file', fileContent, {
          filename: 'hello.txt',
          contentType: 'text/plain',
        })
        .field('project_id', projectId);

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.filename).toBe('hello.txt');
      expect(response.body.content_type).toBe('text/plain');
      expect(response.body.size).toBe(fileContent.length);
    });

    test('unauthenticated request cannot upload', async () => {
      const fileContent = Buffer.from('data');

      const response = await testClient
        .post('/api/v1/files/upload')
        .attach('file', fileContent, { filename: 'data.txt' })
        .field('project_id', projectId);

      expect(response.status).toBe(401);
    });

    test('upload without file returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload')
        .send({ project_id: projectId });

      expect(response.status).toBe(400);
    });

    test('upload without project_id returns 400', async () => {
      const fileContent = Buffer.from('data');

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload')
        .attach('file', fileContent, { filename: 'data.txt' });

      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/v1/files/:id', () => {
    let fileId: string;

    beforeAll(async () => {
      const fileContent = Buffer.from('Get me!');
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload')
        .attach('file', fileContent, {
          filename: 'getme.txt',
          contentType: 'text/plain',
        })
        .field('project_id', projectId);
      fileId = res.body.id;
    });

    test('user with permission can get a file by ID', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/files/${fileId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(fileId);
      expect(response.body.filename).toBe('getme.txt');
    });

    test('unauthenticated request cannot get a file', async () => {
      const response = await testClient.get(`/api/v1/files/${fileId}`);

      expect(response.status).toBe(401);
    });

    test('returns 404 for non-existent file', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        '/api/v1/files/nonexistent-file-id'
      );

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/v1/files/:id/download', () => {
    let fileId: string;
    const originalContent = 'Download me, please!';

    beforeAll(async () => {
      const fileContent = Buffer.from(originalContent);
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload')
        .attach('file', fileContent, {
          filename: 'download.txt',
          contentType: 'text/plain',
        })
        .field('project_id', projectId);
      fileId = res.body.id;
    });

    test('user with permission can download a file', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/files/${fileId}/download`
      );

      expect(response.status).toBe(200);
      expect(response.text).toBe(originalContent);
      expect(response.headers['content-type']).toMatch(/text\/plain/);
      expect(response.headers['content-disposition']).toMatch(
        /attachment; filename="download.txt"/
      );
    });

    test('unauthenticated request cannot download a file', async () => {
      const response = await testClient.get(`/api/v1/files/${fileId}/download`);

      expect(response.status).toBe(401);
    });
  });

  describe('PATCH /api/v1/files/:id/metadata', () => {
    let fileId: string;

    beforeAll(async () => {
      const fileContent = Buffer.from('Metadata target');
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload')
        .attach('file', fileContent, {
          filename: 'meta.txt',
          contentType: 'text/plain',
        })
        .field('project_id', projectId);
      fileId = res.body.id;
    });

    test('user with permission can update file metadata', async () => {
      const newMetadata = JSON.stringify({ author: 'Alice', version: 2 });

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/files/${fileId}/metadata`)
        .send({ metadata: newMetadata });

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(fileId);
      expect(response.body.metadata).toBe(newMetadata);
    });

    test('unauthenticated request cannot update metadata', async () => {
      const response = await testClient
        .patch(`/api/v1/files/${fileId}/metadata`)
        .send({ metadata: '{}' });

      expect(response.status).toBe(401);
    });

    test('returns 404 for non-existent file', async () => {
      const response = await authenticatedTestClient(adminToken)
        .patch('/api/v1/files/nonexistent-file-id/metadata')
        .send({ metadata: '{}' });

      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /api/v1/files/:id', () => {
    test('user with permission can delete a file and it is removed from disk', async () => {
      const fileContent = Buffer.from('Delete me!');
      const uploadRes = await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload')
        .attach('file', fileContent, {
          filename: 'todelete.txt',
          contentType: 'text/plain',
        })
        .field('project_id', projectId);
      const fileId = uploadRes.body.id;

      // Verify file exists on disk
      const filesOnDisk = fs.readdirSync(storageDir);
      expect(
        filesOnDisk.some((f) => {
          return f.includes(fileId);
        })
      ).toBe(true);

      const deleteRes = await authenticatedTestClient(userToken).delete(
        `/api/v1/files/${fileId}`
      );

      expect(deleteRes.status).toBe(204);

      // Verify file is removed from disk
      const filesAfter = fs.readdirSync(storageDir);
      expect(
        filesAfter.some((f) => {
          return f.includes(fileId);
        })
      ).toBe(false);
    });

    test('unauthenticated request cannot delete a file', async () => {
      const fileContent = Buffer.from('Protected');
      const uploadRes = await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload')
        .attach('file', fileContent, { filename: 'protected.txt' })
        .field('project_id', projectId);
      const fileId = uploadRes.body.id;

      const response = await testClient.delete(`/api/v1/files/${fileId}`);

      expect(response.status).toBe(401);
    });

    test('returns 404 when deleting a non-existent file', async () => {
      const response = await authenticatedTestClient(adminToken).delete(
        '/api/v1/files/nonexistent-file-id'
      );

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/v1/files/:id/download/base64', () => {
    let fileId: string;
    const originalContent = 'Base64 download test content!';

    beforeAll(async () => {
      const fileContent = Buffer.from(originalContent);
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload')
        .attach('file', fileContent, {
          filename: 'base64dl.txt',
          contentType: 'text/plain',
        })
        .field('project_id', projectId);
      fileId = res.body.id;
    });

    test('user with permission can download a file as base64', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/files/${fileId}/download/base64`
      );

      expect(response.status).toBe(200);
      expect(response.body.content).toBe(
        Buffer.from(originalContent).toString('base64')
      );
      expect(response.body.filename).toBe('base64dl.txt');
      expect(response.body.content_type).toBe('text/plain');
      expect(response.body.size).toBe(Buffer.from(originalContent).length);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/files/${fileId}/download/base64`
      );

      expect(response.status).toBe(401);
    });

    test('returns 404 for non-existent file', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        '/api/v1/files/nonexistent-file-id/download/base64'
      );

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/v1/files/upload/base64', () => {
    test('user with permission can upload a file via base64', async () => {
      const content = Buffer.from('Hello base64 upload!').toString('base64');

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload/base64')
        .send({
          project_id: projectId,
          content,
          filename: 'base64upload.txt',
          content_type: 'text/plain',
        });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.filename).toBe('base64upload.txt');
      expect(response.body.content_type).toBe('text/plain');
    });

    test('unauthenticated request returns 401', async () => {
      const content = Buffer.from('data').toString('base64');

      const response = await testClient
        .post('/api/v1/files/upload/base64')
        .send({ project_id: projectId, content, filename: 'test.txt' });

      expect(response.status).toBe(401);
    });
  });

  describe('PATCH /api/v1/files/:id/metadata - filename update', () => {
    let fileId: string;

    beforeAll(async () => {
      const fileContent = Buffer.from('Filename update target');
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload')
        .attach('file', fileContent, {
          filename: 'original-name.txt',
          contentType: 'text/plain',
        })
        .field('project_id', projectId);
      fileId = res.body.id;
    });

    test('user can update filename only', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/files/${fileId}/metadata`)
        .send({ filename: 'renamed-file.txt' });

      expect(response.status).toBe(200);
      expect(response.body.filename).toBe('renamed-file.txt');
    });

    test('user can update both filename and metadata', async () => {
      const newMetadata = JSON.stringify({ version: 3 });

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/files/${fileId}/metadata`)
        .send({ filename: 'both-updated.txt', metadata: newMetadata });

      expect(response.status).toBe(200);
      expect(response.body.filename).toBe('both-updated.txt');
      expect(response.body.metadata).toBe(newMetadata);
    });
  });

  describe('GET /api/v1/files - project_id filter', () => {
    let secondProjectId: string;

    beforeAll(async () => {
      const projectRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Files Filter Project' });
      secondProjectId = projectRes.body.id;

      const policyRes = await authenticatedTestClient(adminToken)
        .post(`/api/v1/projects/${secondProjectId}/policies`)
        .send({ permissions: ['files:UploadFile', 'files:GetFile'] });

      await authenticatedTestClient(adminToken)
        .post(`/api/v1/projects/${secondProjectId}/members`)
        .send({ user_id: userId, policy_id: policyRes.body.id });

      await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload')
        .attach('file', Buffer.from('proj2 file'), {
          filename: 'proj2.txt',
          contentType: 'text/plain',
        })
        .field('project_id', secondProjectId);
    });

    test('listing with project_id returns only files in that project', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/files?project_id=${secondProjectId}`
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBe(1);
      expect(response.body.data[0].filename).toBe('proj2.txt');
    });

    test('listing without projectId returns files across projects', async () => {
      const response =
        await authenticatedTestClient(userToken).get('/api/v1/files');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
      // Should include files from both projects
      expect(response.body.data.length).toBeGreaterThanOrEqual(2);
    });

    test('returns 403 when requesting files for a project the user cannot access', async () => {
      const forbiddenProjectRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Forbidden Files Project' });
      const forbiddenProjectId = forbiddenProjectRes.body.id;

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/files?project_id=${forbiddenProjectId}`
      );

      expect(response.status).toBe(403);
    });
  });
});
