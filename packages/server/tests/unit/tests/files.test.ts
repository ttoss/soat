import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { authenticatedTestClient, loginAs, testClient } from '../testClient';

describe('Files', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectId: string;
  let policyId: string;
  let storageDir: string;

  beforeAll(async () => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soat-files-test-'));
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    process.env.FILES_STORAGE_DIR = storageDir;

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
      .send({ userId, policyId });
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
        .field('projectId', projectId);

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.filename).toBe('hello.txt');
      expect(response.body.contentType).toBe('text/plain');
      expect(response.body.size).toBe(fileContent.length);
    });

    test('unauthenticated request cannot upload', async () => {
      const fileContent = Buffer.from('data');

      const response = await testClient
        .post('/api/v1/files/upload')
        .attach('file', fileContent, { filename: 'data.txt' })
        .field('projectId', projectId);

      expect(response.status).toBe(401);
    });

    test('upload without file returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload')
        .send({ projectId });

      expect(response.status).toBe(400);
    });

    test('upload without projectId returns 400', async () => {
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
        .field('projectId', projectId);
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
        .field('projectId', projectId);
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
        .field('projectId', projectId);
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
        .field('projectId', projectId);
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
        .field('projectId', projectId);
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
});
