import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A multipart upload is spooled to the temp directory, never held in memory,
 * and the spool is gone once the request is answered, whatever the answer.
 */
describe('File upload spool', () => {
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let spoolDir: string;
  const originalTmpdir = process.env.TMPDIR;
  const originalUploadMax = process.env.FILE_UPLOAD_MAX_BYTES;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'uploadspool',
      policyActions: [
        'files:UploadFile',
        'files:GetFile',
        'files:DownloadFile',
      ],
    });
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;
  });

  beforeEach(() => {
    // `os.tmpdir()` reads TMPDIR on each call, and the upload middleware asks
    // per request, so each test watches a directory of its own.
    spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soat-spool-test-'));
    process.env.TMPDIR = spoolDir;
  });

  afterEach(() => {
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
    if (originalUploadMax === undefined) {
      delete process.env.FILE_UPLOAD_MAX_BYTES;
    } else {
      process.env.FILE_UPLOAD_MAX_BYTES = originalUploadMax;
    }
    fs.rmSync(spoolDir, { recursive: true, force: true });
  });

  describe('POST /api/v1/files/upload', () => {
    test('stores the spooled bytes exactly and removes the spool', async () => {
      const content = randomBytes(3 * 1024 * 1024);

      const upload = await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload')
        .attach('file', content, {
          filename: 'large.bin',
          contentType: 'application/octet-stream',
        })
        .field('project_id', projectId);

      expect(upload.status).toBe(201);
      expect(upload.body.id).toBeDefined();
      expect(upload.body.size).toBe(content.length);
      expect(fs.readdirSync(spoolDir)).toEqual([]);

      const download = await authenticatedTestClient(userToken)
        .get(`/api/v1/files/${upload.body.id}/download`)
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
          });
          res.on('end', () => {
            done(null, Buffer.concat(chunks));
          });
        });

      expect(download.status).toBe(200);
      expect(Buffer.compare(download.body, content)).toBe(0);
    });

    test('removes the spool when the upload is refused after spooling', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post('/api/v1/files/upload')
        .attach('file', Buffer.from('not allowed'), {
          filename: 'denied.txt',
          contentType: 'text/plain',
        })
        .field('project_id', projectId);

      expect(response.status).toBe(403);
      expect(fs.readdirSync(spoolDir)).toEqual([]);
    });

    test('removes the spool when the file is over the limit', async () => {
      process.env.FILE_UPLOAD_MAX_BYTES = '1024';

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload')
        .attach('file', Buffer.alloc(64 * 1024, 'a'), {
          filename: 'big.txt',
          contentType: 'text/plain',
        })
        .field('project_id', projectId);

      expect(response.status).toBe(413);
      expect(response.body.error.code).toBe('UPLOAD_TOO_LARGE');
      expect(fs.readdirSync(spoolDir)).toEqual([]);
    });
  });

  describe('POST /api/v1/files/upload/:token', () => {
    test('stores a spooled multipart upload and removes the spool', async () => {
      const presigned = await authenticatedTestClient(userToken)
        .post('/api/v1/files/presigned-url')
        .send({ project_id: projectId, filename: 'token.bin' });
      expect(presigned.status).toBe(201);
      const content = randomBytes(256 * 1024);

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/files/upload/${presigned.body.upload_token}`)
        .attach('file', content, {
          filename: 'token.bin',
          contentType: 'application/octet-stream',
        });

      expect(response.status).toBe(201);
      expect(response.body.size).toBe(content.length);
      expect(fs.readdirSync(spoolDir)).toEqual([]);
    });
  });
});
