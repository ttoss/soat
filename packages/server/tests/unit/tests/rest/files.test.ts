import fs from 'node:fs';

import { db } from 'src/db';
import { signFileDownloadToken } from 'src/lib/fileDownloadToken';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { storageDir } from '../../setupTests';
import { authenticatedTestClient, testClient } from '../../testClient';

describe('Files', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectId: string;
  let noPermToken: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'files',
      policyActions: [
        'files:UploadFile',
        'files:GetFile',
        'files:DownloadFile',
        'files:UpdateFileMetadata',
        'files:DeleteFile',
        'files:CreateFile',
      ],
    });

    adminToken = setup.adminToken;
    userToken = setup.userToken;
    userId = setup.userId;
    projectId = setup.projectId;
    noPermToken = setup.noPermToken as string;
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

    test('uploading to an existing key returns 409, not 500', async () => {
      const first = await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload')
        .attach('file', Buffer.from('first'), {
          filename: 'dup-upload.txt',
          contentType: 'text/plain',
        })
        .field('project_id', projectId);
      expect(first.status).toBe(201);

      const second = await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload')
        .attach('file', Buffer.from('second'), {
          filename: 'dup-upload.txt',
          contentType: 'text/plain',
        })
        .field('project_id', projectId);

      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('NAME_CONFLICT');
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

    test('user without GetFile permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/files/${fileId}`
      );

      expect(response.status).toBe(403);
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

    test('a valid download token authorizes the download without a session', async () => {
      const token = signFileDownloadToken({ fileId });

      const response = await testClient.get(
        `/api/v1/files/${fileId}/download?token=${token}`
      );

      expect(response.status).toBe(200);
      expect(response.text).toBe(originalContent);
    });

    test('a valid download token for a nonexistent file returns 404', async () => {
      const token = signFileDownloadToken({ fileId: 'nonexistent-file-id' });

      const response = await testClient.get(
        `/api/v1/files/nonexistent-file-id/download?token=${token}`
      );

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('RESOURCE_NOT_FOUND');
      expect(response.body.error.message).toMatch(/file not found/i);
    });

    test('a malformed token falls back to session auth and returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/files/${fileId}/download?token=not-a-jwt`
      );

      expect(response.status).toBe(401);
    });

    test('a token scoped to a different file does not authorize this download', async () => {
      const token = signFileDownloadToken({ fileId: 'some-other-file-id' });

      const response = await testClient.get(
        `/api/v1/files/${fileId}/download?token=${token}`
      );

      expect(response.status).toBe(401);
    });

    test('user without DownloadFile permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/files/${fileId}/download`
      );

      expect(response.status).toBe(403);
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

    test('user without UpdateFileMetadata permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .patch(`/api/v1/files/${fileId}/metadata`)
        .send({ metadata: '{}' });

      expect(response.status).toBe(403);
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

      // Verify file exists on disk (files are stored in subdirectories)
      const filesOnDisk = fs.readdirSync(storageDir, {
        recursive: true,
      }) as string[];
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
      const filesAfter = fs.readdirSync(storageDir, {
        recursive: true,
      }) as string[];
      expect(
        filesAfter.some((f) => {
          return f.includes(fileId);
        })
      ).toBe(false);
    });

    test('returns 409 when deleting a file referenced by another record', async () => {
      const fileContent = Buffer.from('Keep me!');
      const uploadRes = await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload')
        .attach('file', fileContent, {
          filename: 'referenced.txt',
          contentType: 'text/plain',
        })
        .field('project_id', projectId);

      const fileId = uploadRes.body.id as string;
      const fileRow = await db.File.findOne({ where: { publicId: fileId } });
      expect(fileRow).not.toBeNull();

      await db.Document.create({
        fileId: fileRow!.id,
        title: 'Referenced file',
        metadata: null,
        tags: null,
        embedding: null,
      });

      const deleteRes = await authenticatedTestClient(userToken).delete(
        `/api/v1/files/${fileId}`
      );

      expect(deleteRes.status).toBe(409);
      expect(deleteRes.body.error.code).toBe('FILE_HAS_DEPENDENTS');

      const filesAfter = fs.readdirSync(storageDir, {
        recursive: true,
      }) as string[];
      expect(
        filesAfter.some((f) => {
          return f.includes(fileId);
        })
      ).toBe(true);
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

    test('user without DeleteFile permission returns 403', async () => {
      const fileContent = Buffer.from('Protect me from delete!');
      const uploadRes = await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload')
        .attach('file', fileContent, {
          filename: 'no-delete-perm.txt',
          contentType: 'text/plain',
        })
        .field('project_id', projectId);
      const fileId = uploadRes.body.id;

      const response = await authenticatedTestClient(noPermToken).delete(
        `/api/v1/files/${fileId}`
      );

      expect(response.status).toBe(403);
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

    test('returns 403 without DownloadFile permission', async () => {
      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/files/${fileId}/download/base64`
      );

      expect(response.status).toBe(403);
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
          prefix: '/uploads',
          filename: 'base64upload.txt',
          content_type: 'text/plain',
        });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      // key = prefix + '/' + filename.
      expect(response.body.path).toBe('/uploads/base64upload.txt');
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

    test('returns 400 when content is missing', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload/base64')
        .send({ project_id: projectId, filename: 'missing-content.txt' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.message).toMatch(/content/);
    });

    test('returns 400 when project_id is missing', async () => {
      const content = Buffer.from('data').toString('base64');

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload/base64')
        .send({ content, filename: 'missing-project.txt' });

      expect(response.status).toBe(400);
      // Legacy plain-string body from the shared `resolveWriteProjectId`
      // helper (rest/v1/helpers.ts), used across ~13 route files — not
      // migrated to DomainError here to avoid a cross-cutting route change.
      expect(response.body.error).toMatch(/projectId is required/i);
    });

    test('returns 403 when user has no upload permission', async () => {
      const content = Buffer.from('no permission').toString('base64');

      const response = await authenticatedTestClient(noPermToken)
        .post('/api/v1/files/upload/base64')
        .send({ project_id: projectId, content, filename: 'denied.txt' });

      expect(response.status).toBe(403);
    });

    test('uploading to an existing key returns 409, not 500', async () => {
      const content = Buffer.from('data').toString('base64');

      const first = await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload/base64')
        .send({
          project_id: projectId,
          content,
          prefix: '/uploads',
          filename: 'dup-base64.txt',
        });
      expect(first.status).toBe(201);

      const second = await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload/base64')
        .send({
          project_id: projectId,
          content,
          prefix: '/uploads',
          filename: 'dup-base64.txt',
        });

      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('NAME_CONFLICT');
    });
  });

  describe('POST /api/v1/files/presigned-url', () => {
    test('user with permission receives a token, url and expiry', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/files/presigned-url')
        .send({
          project_id: projectId,
          content_type: 'application/pdf',
          prefix: '/documents',
          filename: 'token-report.pdf',
        });

      expect(response.status).toBe(201);
      expect(response.body.upload_token).toMatch(/^upt_/);
      expect(response.body.upload_url).toBe(
        `/api/v1/files/upload/${response.body.upload_token}`
      );
      expect(new Date(response.body.expires_at).getTime()).toBeGreaterThan(
        Date.now()
      );
    });

    test('upload_url is absolute when SOAT_BASE_URL is set', async () => {
      const originalBaseUrl = process.env.SOAT_BASE_URL;
      process.env.SOAT_BASE_URL = 'https://api.example.com';

      try {
        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/files/presigned-url')
          .send({ project_id: projectId, filename: 'absolute-url.txt' });

        expect(response.status).toBe(201);
        expect(response.body.upload_url).toBe(
          `https://api.example.com/api/v1/files/upload/${response.body.upload_token}`
        );
      } finally {
        if (originalBaseUrl === undefined) {
          delete process.env.SOAT_BASE_URL;
        } else {
          process.env.SOAT_BASE_URL = originalBaseUrl;
        }
      }
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post('/api/v1/files/presigned-url')
        .send({ project_id: projectId });

      expect(response.status).toBe(401);
    });

    test('returns 400 when project_id is missing', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/files/presigned-url')
        .send({ filename: 'no-project.txt' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.message).toMatch(/projectId/);
    });

    test('returns 403 when user has no upload permission', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post('/api/v1/files/presigned-url')
        .send({ project_id: projectId });

      expect(response.status).toBe(403);
    });

    test('returns 400 for a well-formed but non-existent project_id', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/files/presigned-url')
        .send({ project_id: 'proj_nonexistent12345', filename: 'x.txt' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid project ID');
    });
  });

  describe('POST /api/v1/files/upload/:token', () => {
    const requestToken = async (overrides?: Record<string, unknown>) => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/files/presigned-url')
        .send({ project_id: projectId, ...overrides });
      return res.body.upload_token as string;
    };

    test('uploads file via base64 content without a bearer token', async () => {
      const token = await requestToken({
        filename: 'from-token.txt',
        content_type: 'text/plain',
      });
      const content = Buffer.from('uploaded via token').toString('base64');

      // testClient is unauthenticated — the token is the only credential.
      const response = await testClient
        .post(`/api/v1/files/upload/${token}`)
        .send({ content });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      // filename comes from the token.
      expect(response.body.filename).toBe('from-token.txt');
      expect(response.body.content_type).toBe('text/plain');
      expect(response.body.size).toBe(Buffer.from('uploaded via token').length);
    });

    test('uploads file via multipart/form-data', async () => {
      const token = await requestToken();
      const fileContent = Buffer.from('multipart token upload');

      const response = await testClient
        .post(`/api/v1/files/upload/${token}`)
        .attach('file', fileContent, {
          filename: 'multipart.txt',
          contentType: 'text/plain',
        });

      expect(response.status).toBe(201);
      expect(response.body.filename).toBe('multipart.txt');
    });

    test('token is single-use — second upload returns 409', async () => {
      const token = await requestToken();
      const content = Buffer.from('first').toString('base64');

      const first = await testClient
        .post(`/api/v1/files/upload/${token}`)
        .send({ content });
      expect(first.status).toBe(201);

      const second = await testClient
        .post(`/api/v1/files/upload/${token}`)
        .send({ content: Buffer.from('second').toString('base64') });
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('UPLOAD_TOKEN_USED');
    });

    test('returns 404 for an unknown token', async () => {
      const content = Buffer.from('data').toString('base64');

      const response = await testClient
        .post('/api/v1/files/upload/upt_doesnotexist000')
        .send({ content });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('UPLOAD_TOKEN_NOT_FOUND');
    });

    test('returns 410 for an expired token', async () => {
      // Create a token then force its expiry into the past.
      const token = await requestToken();
      await db.UploadToken.update(
        { expiresAt: new Date(Date.now() - 1000) },
        { where: { publicId: token } }
      );

      const content = Buffer.from('data').toString('base64');
      const response = await testClient
        .post(`/api/v1/files/upload/${token}`)
        .send({ content });

      expect(response.status).toBe(410);
      expect(response.body.error.code).toBe('UPLOAD_TOKEN_EXPIRED');
    });

    test('returns 400 when neither file nor content is provided', async () => {
      const token = await requestToken();

      const response = await testClient
        .post(`/api/v1/files/upload/${token}`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('POST /api/v1/files', () => {
    test('authenticated user with permission can create file metadata record', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/files')
        .send({
          project_id: projectId,
          filename: 'from-create-route.txt',
          content_type: 'text/plain',
          size: 12,
        });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      // prefix defaults to root, so the key is /<filename>; storage is
      // system-managed and not exposed in the response.
      expect(response.body.prefix).toBe('/');
      expect(response.body.filename).toBe('from-create-route.txt');
      expect(response.body.path).toBe('/from-create-route.txt');
      expect(response.body.storage_type).toBeUndefined();
      expect(response.body.storage_path).toBeUndefined();
    });

    test('builds the key from prefix + filename and ignores storage fields', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/files')
        .send({
          project_id: projectId,
          prefix: '/keyed',
          filename: 'q1.pdf',
          storage_type: 'gcs',
          storage_path: '/attacker/controlled/path.txt',
        });

      expect(response.status).toBe(201);
      // path (read-only key) = prefix + '/' + filename; storage stays internal.
      expect(response.body.prefix).toBe('/keyed');
      expect(response.body.filename).toBe('q1.pdf');
      expect(response.body.path).toBe('/keyed/q1.pdf');
      expect(response.body.storage_type).toBeUndefined();
      expect(response.body.storage_path).toBeUndefined();
    });

    test('ignores a client-supplied read-only path', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/files')
        .send({
          project_id: projectId,
          prefix: '/docs',
          filename: 'report.pdf',
          path: '/attacker/elsewhere.pdf',
        });

      expect(response.status).toBe(201);
      // path is derived from prefix + filename; the supplied path is ignored.
      expect(response.body.path).toBe('/docs/report.pdf');
    });

    test('returns 401 for unauthenticated create request', async () => {
      const response = await testClient.post('/api/v1/files').send({
        project_id: projectId,
        filename: 'unauth-create.txt',
      });

      expect(response.status).toBe(401);
    });

    test('returns 403 when user has no create permission', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post('/api/v1/files')
        .send({
          project_id: projectId,
          filename: 'forbidden-create.txt',
        });

      expect(response.status).toBe(403);
    });

    test('returns 403 when project does not exist', async () => {
      // Project resolution now flows through resolveProjectIds (#267), which
      // returns 403 for a project the caller cannot prove access to —
      // including one that does not exist — rather than leaking its absence.
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/files')
        .send({
          project_id: 'prj_nonexistent123',
          filename: 'bad-project.txt',
        });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Forbidden');
    });

    test('creating a metadata record at an existing key returns 409, not 500', async () => {
      const first = await authenticatedTestClient(userToken)
        .post('/api/v1/files')
        .send({
          project_id: projectId,
          prefix: '/dup-create',
          filename: 'dup.txt',
        });
      expect(first.status).toBe(201);

      const second = await authenticatedTestClient(userToken)
        .post('/api/v1/files')
        .send({
          project_id: projectId,
          prefix: '/dup-create',
          filename: 'dup.txt',
        });

      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('NAME_CONFLICT');
    });
  });

  describe('PATCH /api/v1/files/:id/metadata - rename & move', () => {
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

    test('moving via prefix keeps the filename and rebuilds the key', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/files/${fileId}/metadata`)
        .send({ prefix: '/moved' });

      expect(response.status).toBe(200);
      expect(response.body.prefix).toBe('/moved');
      expect(response.body.filename).toBe('original-name.txt');
      expect(response.body.path).toBe('/moved/original-name.txt');
    });

    test('renaming via filename keeps the prefix and rebuilds the key', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/files/${fileId}/metadata`)
        .send({ filename: 'friendly-name.txt' });

      expect(response.status).toBe(200);
      expect(response.body.prefix).toBe('/moved');
      expect(response.body.filename).toBe('friendly-name.txt');
      expect(response.body.path).toBe('/moved/friendly-name.txt');
    });

    test('user can update prefix and metadata together', async () => {
      const newMetadata = JSON.stringify({ version: 3 });

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/files/${fileId}/metadata`)
        .send({ prefix: '/reports', metadata: newMetadata });

      expect(response.status).toBe(200);
      expect(response.body.path).toBe('/reports/friendly-name.txt');
      expect(response.body.metadata).toBe(newMetadata);
    });

    test('moving onto an existing key returns 409', async () => {
      // Seed another file to collide with: /occupied.txt.
      await authenticatedTestClient(userToken)
        .post('/api/v1/files')
        .send({ project_id: projectId, filename: 'occupied.txt' });

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/files/${fileId}/metadata`)
        .send({ prefix: '/', filename: 'occupied.txt' });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('NAME_CONFLICT');
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
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [
              {
                effect: 'Allow',
                action: ['files:UploadFile', 'files:GetFile'],
              },
            ],
          },
        });

      await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${userId}/policies`)
        .send({ policy_ids: [policyRes.body.id] });

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

      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/files?project_id=${forbiddenProjectId}`
      );

      expect(response.status).toBe(403);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get('/api/v1/files');

      expect(response.status).toBe(401);
    });

    test('accepts limit and offset query params', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/files?project_id=${secondProjectId}&limit=1&offset=0`
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
    });
  });

  describe('GET /api/v1/files/:id/tags', () => {
    let taggedFileId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/files/upload')
        .attach('file', Buffer.from('tags file'), {
          filename: 'tags.txt',
          contentType: 'text/plain',
        })
        .field('project_id', projectId);
      taggedFileId = res.body.id;
    });

    test('returns tags for a file', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        `/api/v1/files/${taggedFileId}/tags`
      );
      expect(response.status).toBe(200);
    });

    test('returns 401 for unauthenticated request', async () => {
      const response = await testClient.get(
        `/api/v1/files/${taggedFileId}/tags`
      );
      expect(response.status).toBe(401);
    });

    test('returns 404 for non-existent file', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        '/api/v1/files/nonexistent-file-id/tags'
      );
      expect(response.status).toBe(404);
    });

    test('user without GetFile permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/files/${taggedFileId}/tags`
      );
      expect(response.status).toBe(403);
    });
  });

  describe('PUT /api/v1/files/:id/tags', () => {
    let taggedFileId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/files/upload')
        .attach('file', Buffer.from('put tags file'), {
          filename: 'puttags.txt',
          contentType: 'text/plain',
        })
        .field('project_id', projectId);
      taggedFileId = res.body.id;
    });

    test('replaces file tags', async () => {
      const response = await authenticatedTestClient(adminToken)
        .put(`/api/v1/files/${taggedFileId}/tags`)
        .send({ env: 'prod', version: '1' });
      expect(response.status).toBe(200);
      expect(response.body.tags).toEqual({ env: 'prod', version: '1' });
    });

    test('returns 401 for unauthenticated request', async () => {
      const response = await testClient
        .put(`/api/v1/files/${taggedFileId}/tags`)
        .send({});
      expect(response.status).toBe(401);
    });

    test('returns 404 for non-existent file', async () => {
      const response = await authenticatedTestClient(adminToken)
        .put('/api/v1/files/nonexistent-file-id/tags')
        .send({ env: 'prod' });
      expect(response.status).toBe(404);
    });

    test('user without UpdateFileMetadata permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .put(`/api/v1/files/${taggedFileId}/tags`)
        .send({ env: 'prod' });
      expect(response.status).toBe(403);
    });
  });

  describe('PATCH /api/v1/files/:id/tags', () => {
    let taggedFileId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/files/upload')
        .attach('file', Buffer.from('patch tags file'), {
          filename: 'patchtags.txt',
          contentType: 'text/plain',
        })
        .field('project_id', projectId);
      taggedFileId = res.body.id;
      await authenticatedTestClient(adminToken)
        .put(`/api/v1/files/${taggedFileId}/tags`)
        .send({ env: 'test' });
    });

    test('merges file tags', async () => {
      const response = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/files/${taggedFileId}/tags`)
        .send({ version: '2' });
      expect(response.status).toBe(200);
      expect(response.body.tags).toEqual({ env: 'test', version: '2' });
    });

    test('returns 401 for unauthenticated request', async () => {
      const response = await testClient
        .patch(`/api/v1/files/${taggedFileId}/tags`)
        .send({});
      expect(response.status).toBe(401);
    });

    test('returns 404 for non-existent file', async () => {
      const response = await authenticatedTestClient(adminToken)
        .patch('/api/v1/files/nonexistent-file-id/tags')
        .send({ version: '2' });
      expect(response.status).toBe(404);
    });

    test('user without UpdateFileMetadata permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .patch(`/api/v1/files/${taggedFileId}/tags`)
        .send({ version: '3' });
      expect(response.status).toBe(403);
    });
  });
});
