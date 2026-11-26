import { randomBytes } from 'node:crypto';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * A file uploaded without a type is stored with the one its bytes show, so a
 * model it reaches reads it natively instead of as opaque bytes.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('File content type', () => {
  let userToken: string;
  let projectId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'filecontenttype',
      policyActions: [
        'files:UploadFile',
        'files:GetFile',
        'files:DownloadFile',
      ],
    });
    userToken = setup.userToken;
    projectId = setup.projectId;
  });

  const uploadBase64 = (body: Record<string, unknown>) => {
    return authenticatedTestClient(userToken)
      .post('/api/v1/files/upload/base64')
      .send({ project_id: projectId, ...body });
  };

  const download = async (fileId: string): Promise<Buffer> => {
    const response = await authenticatedTestClient(userToken)
      .get(`/api/v1/files/${fileId}/download`)
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
    expect(response.status).toBe(200);
    return response.body;
  };

  describe('POST /api/v1/files/upload/base64', () => {
    test.each([
      ['image/png', PNG],
      ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
      ['image/gif', Buffer.from('GIF89a')],
      ['image/webp', Buffer.from('RIFF\0\0\0\0WEBPVP8 ')],
      ['application/pdf', Buffer.from('%PDF-1.7')],
    ])(
      'an upload with no content_type is stored as %s when its bytes are one',
      async (expected, signature) => {
        const content = Buffer.concat([signature, Buffer.from('the rest')]);

        const response = await uploadBase64({
          content: content.toString('base64'),
          filename: `untyped-${expected.replace('/', '-')}`,
        });

        expect(response.status).toBe(201);
        expect(response.body.content_type).toBe(expected);
        expect(Buffer.compare(await download(response.body.id), content)).toBe(
          0
        );
      }
    );

    test('unrecognised bytes with no content_type stay untyped', async () => {
      const response = await uploadBase64({
        content: Buffer.from('plain words').toString('base64'),
        filename: 'words',
      });

      expect(response.status).toBe(201);
      expect(response.body.content_type).toBeNull();
    });

    test('a file shorter than any signature stays untyped', async () => {
      const response = await uploadBase64({
        content: Buffer.from([0x89]).toString('base64'),
        filename: 'one-byte',
      });

      expect(response.status).toBe(201);
      expect(response.body.content_type).toBeNull();
      expect(response.body.size).toBe(1);
    });

    test('a declared content_type is kept whatever the bytes are', async () => {
      const response = await uploadBase64({
        content: Buffer.from('%PDF-1.7 not really').toString('base64'),
        filename: 'declared.txt',
        content_type: 'text/plain',
      });

      expect(response.status).toBe(201);
      expect(response.body.content_type).toBe('text/plain');
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post('/api/v1/files/upload/base64')
        .send({
          project_id: projectId,
          content: PNG.toString('base64'),
          filename: 'anon.png',
        });

      expect(response.status).toBe(401);
    });
  });

  describe('POST /api/v1/files/upload', () => {
    test('a part declared application/octet-stream is stored as its bytes show', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload')
        .attach('file', Buffer.concat([PNG, Buffer.from('pixels')]), {
          filename: 'multipart-untyped',
          contentType: 'application/octet-stream',
        })
        .field('project_id', projectId);

      expect(response.status).toBe(201);
      expect(response.body.content_type).toBe('image/png');
    });
  });

  describe('PUT /api/v1/files/upload/{token}', () => {
    test('a streamed body with no type is typed from its head and stored whole', async () => {
      const token = await authenticatedTestClient(userToken)
        .post('/api/v1/files/presigned-url')
        .send({ project_id: projectId, filename: 'streamed' });
      expect(token.status).toBe(201);
      const content = Buffer.concat([PNG, randomBytes(512 * 1024)]);

      const upload = await testClient
        .put(`/api/v1/files/upload/${token.body.upload_token}`)
        .set('Content-Type', 'application/octet-stream')
        .send(content);

      expect(upload.status).toBe(201);
      expect(upload.body.content_type).toBe('image/png');
      expect(upload.body.size).toBe(content.length);
      expect(Buffer.compare(await download(upload.body.id), content)).toBe(0);
    });
  });
});
