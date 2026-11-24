import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { app } from 'src/app';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

/** Restores an env var after a test that sets it. */
const withEnv = async (
  name: string,
  value: string,
  run: () => Promise<void>
) => {
  const original = process.env[name];
  process.env[name] = value;
  try {
    await run();
  } finally {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
};

describe('File upload tokens', () => {
  let userToken: string;
  let projectId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'uploadtokens',
      policyActions: [
        'files:UploadFile',
        'files:GetFile',
        'files:DownloadFile',
      ],
    });
    userToken = setup.userToken;
    projectId = setup.projectId;
  });

  const issueToken = async (body: Record<string, unknown>) => {
    const response = await authenticatedTestClient(userToken)
      .post('/api/v1/files/presigned-url')
      .send({ project_id: projectId, ...body });
    expect(response.status).toBe(201);
    return response.body as {
      upload_token: string;
      upload_url: string;
      max_bytes: number;
      content_type?: string;
    };
  };

  const listPaths = async () => {
    const response = await authenticatedTestClient(userToken)
      .get('/api/v1/files')
      .query({ project_id: projectId, limit: 100 });
    return (response.body.data as { path: string }[]).map((file) => {
      return file.path;
    });
  };

  describe('POST /api/v1/files/presigned-url', () => {
    test('answers the size and type the token fixes', async () => {
      const token = await issueToken({
        filename: 'fixed.pdf',
        content_type: 'application/pdf',
        max_bytes: 1024,
      });

      expect(token.max_bytes).toBe(1024);
      expect(token.content_type).toBe('application/pdf');
    });

    test('max_bytes defaults to the deployment ceiling', async () => {
      await withEnv('FILE_UPLOAD_MAX_BYTES', '4096', async () => {
        const token = await issueToken({ filename: 'default-max.bin' });
        expect(token.max_bytes).toBe(4096);
      });
    });

    test('refuses max_bytes above the deployment ceiling', async () => {
      await withEnv('FILE_UPLOAD_MAX_BYTES', '4096', async () => {
        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/files/presigned-url')
          .send({ project_id: projectId, max_bytes: 4097 });

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_FAILED');
      });
    });

    test('builds upload_url from FILES_UPLOAD_URL_TEMPLATE', async () => {
      await withEnv(
        'FILES_UPLOAD_URL_TEMPLATE',
        'https://gateway.example.com/v1/projects/{project_id}/files/upload/{token}',
        async () => {
          const token = await issueToken({ filename: 'templated.bin' });
          expect(token.upload_url).toBe(
            `https://gateway.example.com/v1/projects/${projectId}/files/upload/${token.upload_token}`
          );
        }
      );
    });
  });

  describe('PUT /api/v1/files/upload/:token', () => {
    test('stores the raw body under the token, with no credential', async () => {
      const token = await issueToken({
        prefix: '/raw',
        filename: 'raw.pdf',
        content_type: 'application/pdf',
      });
      const content = randomBytes(512 * 1024);

      const upload = await testClient
        .put(`/api/v1/files/upload/${token.upload_token}`)
        .set('Content-Type', 'application/pdf')
        .send(content);

      expect(upload.status).toBe(201);
      expect(upload.body.id).toBeDefined();
      expect(upload.body.path).toBe('/raw/raw.pdf');
      expect(upload.body.size).toBe(content.length);
      expect(upload.body.content_type).toBe('application/pdf');

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
      expect(Buffer.compare(download.body, content)).toBe(0);
    });

    test('a text body is stored as sent, not parsed', async () => {
      const token = await issueToken({ filename: 'notes.json' });

      const upload = await testClient
        .put(`/api/v1/files/upload/${token.upload_token}`)
        .set('Content-Type', 'application/json')
        .send('{"stored":"verbatim"}');

      expect(upload.status).toBe(201);
      expect(upload.body.size).toBe(21);
    });

    test('a used token is refused', async () => {
      const token = await issueToken({ filename: 'once.bin' });
      const first = await testClient
        .put(`/api/v1/files/upload/${token.upload_token}`)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('first'));
      expect(first.status).toBe(201);

      const second = await testClient
        .put(`/api/v1/files/upload/${token.upload_token}`)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('second'));

      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('UPLOAD_TOKEN_USED');
    });

    test('an unknown token is refused', async () => {
      const response = await testClient
        .put('/api/v1/files/upload/upt_doesnotexist0000')
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('x'));

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('UPLOAD_TOKEN_NOT_FOUND');
    });

    test('a body over max_bytes is refused before it is read, and the token stays usable', async () => {
      const token = await issueToken({
        filename: 'bounded.bin',
        max_bytes: 16,
      });

      const tooLarge = await testClient
        .put(`/api/v1/files/upload/${token.upload_token}`)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.alloc(17));
      expect(tooLarge.status).toBe(413);
      expect(tooLarge.body.error.code).toBe('UPLOAD_TOO_LARGE');
      expect(tooLarge.body.error.meta.limit).toBe(16);

      const fits = await testClient
        .put(`/api/v1/files/upload/${token.upload_token}`)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.alloc(16));
      expect(fits.status).toBe(201);
    });

    test('a content type other than the token fixes is refused, and the token stays usable', async () => {
      const token = await issueToken({
        filename: 'typed.pdf',
        content_type: 'application/pdf',
      });

      const wrong = await testClient
        .put(`/api/v1/files/upload/${token.upload_token}`)
        .set('Content-Type', 'image/png')
        .send(Buffer.from('png'));
      expect(wrong.status).toBe(415);
      expect(wrong.body.error.code).toBe('UPLOAD_CONTENT_TYPE_MISMATCH');

      const right = await testClient
        .put(`/api/v1/files/upload/${token.upload_token}`)
        .set('Content-Type', 'application/pdf; charset=binary')
        .send(Buffer.from('%PDF'));
      expect(right.status).toBe(201);
    });

    test('a body without Content-Length is refused', async () => {
      const token = await issueToken({ filename: 'chunked.bin' });
      const server = http.createServer(app.callback()).listen(0);
      try {
        const { port } = server.address() as AddressInfo;
        const status = await new Promise<number>((resolve, reject) => {
          const request = http.request(
            {
              port,
              method: 'PUT',
              path: `/api/v1/files/upload/${token.upload_token}`,
              headers: {
                'Content-Type': 'application/octet-stream',
                'Transfer-Encoding': 'chunked',
              },
            },
            (response) => {
              response.resume();
              resolve(response.statusCode ?? 0);
            }
          );
          request.on('error', reject);
          request.end(Buffer.from('chunked body'));
        });

        expect(status).toBe(411);
      } finally {
        server.close();
      }
    });

    test('a body cut off mid-upload leaves no file behind', async () => {
      const token = await issueToken({ prefix: '/cut', filename: 'cut.bin' });
      const handle = app.callback();
      // Koa's handler answers with the request's own promise, so the test
      // waits for the server to finish with the aborted upload. It travels
      // boxed: resolving with a bare promise would wait for that promise.
      let markReceived: (request: {
        done: Promise<unknown>;
      }) => void = () => {};
      const received = new Promise<{ done: Promise<unknown> }>((resolve) => {
        markReceived = resolve;
      });
      const server = http
        .createServer((req, res) => {
          markReceived({ done: Promise.resolve(handle(req, res)) });
        })
        .listen(0);
      try {
        const { port } = server.address() as AddressInfo;
        const request = http.request({
          port,
          method: 'PUT',
          path: `/api/v1/files/upload/${token.upload_token}`,
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': 1024 * 1024,
          },
        });
        request.on('error', () => {});
        request.write(Buffer.alloc(1024));

        const { done } = await received;
        request.destroy();
        await done;

        expect(await listPaths()).not.toContain('/cut/cut.bin');
      } finally {
        server.close();
      }
    });
  });

  describe('POST /api/v1/files/upload/:token', () => {
    test('a multipart file over max_bytes is refused', async () => {
      const token = await issueToken({ filename: 'multi.bin', max_bytes: 16 });

      const response = await testClient
        .post(`/api/v1/files/upload/${token.upload_token}`)
        .attach('file', Buffer.alloc(17), {
          filename: 'multi.bin',
          contentType: 'application/octet-stream',
        });

      expect(response.status).toBe(413);
      expect(response.body.error.code).toBe('UPLOAD_TOO_LARGE');
    });

    test('a multipart file of another content type is refused', async () => {
      const token = await issueToken({
        filename: 'multi.pdf',
        content_type: 'application/pdf',
      });

      const response = await testClient
        .post(`/api/v1/files/upload/${token.upload_token}`)
        .attach('file', Buffer.from('png'), {
          filename: 'multi.png',
          contentType: 'image/png',
        });

      expect(response.status).toBe(415);
      expect(response.body.error.code).toBe('UPLOAD_CONTENT_TYPE_MISMATCH');
    });
  });
});
