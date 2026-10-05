import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';

import { storageDir } from '../../setupTests';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * Converter ingestion end to end: every converter here is a real `http` tool
 * pointed at a local server, so rule resolution, the tool call, the
 * callback token and the output parse all run for real.
 *
 * The server answers by path. `/defer` replies `{ status: "pending" }` and
 * keeps the callback token it was handed, which is what the async tests post
 * back with; every other path names itself in the page it returns, so a test
 * can read which rule converted a file off the document's content.
 */
type ConverterRequest = {
  path: string;
  body: { callback?: { url: string; token: string } };
};

describe('Converter ingestion', () => {
  let adminToken: string;
  let projectId: string;
  let stubServer: Server;
  let stubBaseUrl: string;
  const received: ConverterRequest[] = [];
  const originalSoatBaseUrl = process.env.SOAT_BASE_URL;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const createHttpTool = async (args: {
    name: string;
    path: string;
  }): Promise<string> => {
    const res = await asAdmin()
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: args.name,
        type: 'http',
        execute: { url: `${stubBaseUrl}${args.path}`, method: 'POST' },
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createRule = async (args: { glob: string; toolId: string }) => {
    const res = await asAdmin().post('/api/v1/ingestion-rules').send({
      project_id: projectId,
      content_type_glob: args.glob,
      tool_id: args.toolId,
      chunk_strategy: 'whole',
    });
    expect(res.status).toBe(201);
  };

  const uploadFile = async (args: {
    filename: string;
    contentType: string;
  }): Promise<string> => {
    const res = await asAdmin()
      .post('/api/v1/files/upload')
      .attach('file', Buffer.from(`bytes of ${args.filename}`), {
        filename: args.filename,
        contentType: args.contentType,
      })
      .field('project_id', projectId);
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const ingestAndRead = async (args: {
    filename: string;
    contentType: string;
  }): Promise<string> => {
    const fileId = await uploadFile(args);
    const ingest = await asAdmin()
      .post('/api/v1/documents/ingest?wait=true')
      .send({ project_id: projectId, file_id: fileId });
    expect(ingest.status).toBe(201);
    expect(ingest.body.status).toBe('ready');
    const document = await asAdmin().get(`/api/v1/documents/${ingest.body.id}`);
    return document.body.content;
  };

  /**
   * Ingests a file the deferring converter answers, and resolves once the
   * document records the attempt the callback must name — written only after
   * the converter has replied, so the token alone is not yet enough to call
   * back with.
   */
  const ingestDeferred = async (
    filename: string
  ): Promise<{ documentId: string; token: string }> => {
    const fileId = await uploadFile({ filename, contentType: 'audio/ogg' });
    const ingest = await asAdmin()
      .post('/api/v1/documents/ingest')
      .send({ project_id: projectId, file_id: fileId });
    expect(ingest.status).toBe(202);
    const documentId = ingest.body.id as string;

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const row = await db.Document.findOne({
        where: { publicId: documentId },
      });
      if (row?.conversionAttemptId) break;
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }

    const request = received.find((entry) => {
      return entry.body.callback?.url.includes(`/documents/${documentId}/`);
    });
    expect(request?.body.callback?.token).toBeDefined();
    return { documentId, token: request!.body.callback!.token };
  };

  const callBack = (args: {
    documentId: string;
    token: string;
    body: unknown;
  }) => {
    return testClient
      .post(
        `/api/v1/documents/${args.documentId}/ingestion-callback?token=${args.token}`
      )
      .send(args.body as object);
  };

  beforeAll(async () => {
    // The callback block is only offered to a converter when the server
    // knows its own public URL.
    process.env.SOAT_BASE_URL = 'https://soat.example.test';

    stubServer = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += String(chunk);
      });
      req.on('end', () => {
        const path = req.url ?? '';
        received.push({ path, body: raw ? JSON.parse(raw) : {} });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify(
            path === '/defer'
              ? { status: 'pending' }
              : { pages: [{ text: `converted by ${path}` }] }
          )
        );
      });
    });
    await new Promise<void>((resolve) => {
      stubServer.listen(0, '127.0.0.1', resolve);
    });
    stubBaseUrl = `http://127.0.0.1:${(stubServer.address() as AddressInfo).port}`;

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'convadmin', password: 'supersecret' });
    adminToken = await loginAs('convadmin', 'supersecret');

    const project = await asAdmin()
      .post('/api/v1/projects')
      .send({ name: 'Converter ingestion' });
    projectId = project.body.id;

    // Three rules that all match an `image/png`, at three specificities.
    await createRule({
      glob: '*/*',
      toolId: await createHttpTool({ name: 'any-type', path: '/any' }),
    });
    await createRule({
      glob: 'image/*',
      toolId: await createHttpTool({ name: 'any-image', path: '/image' }),
    });
    await createRule({
      glob: 'image/png',
      toolId: await createHttpTool({ name: 'png-only', path: '/png' }),
    });
    await createRule({
      glob: 'audio/ogg',
      toolId: await createHttpTool({ name: 'deferring', path: '/defer' }),
    });
  });

  afterAll(async () => {
    fs.rmSync(storageDir, { recursive: true, force: true });
    if (originalSoatBaseUrl === undefined) {
      delete process.env.SOAT_BASE_URL;
    } else {
      process.env.SOAT_BASE_URL = originalSoatBaseUrl;
    }
    await new Promise<void>((resolve) => {
      stubServer.close(() => {
        resolve();
      });
    });
  });

  describe('POST /api/v1/ingestion-rules', () => {
    test('refuses a client tool as converter', async () => {
      const tool = await asAdmin().post('/api/v1/tools').send({
        project_id: projectId,
        name: 'client-converter',
        type: 'client',
      });

      const res = await asAdmin().post('/api/v1/ingestion-rules').send({
        project_id: projectId,
        content_type_glob: 'video/mp4',
        tool_id: tool.body.id,
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INGESTION_RULE_VALIDATION_FAILED');
      expect(res.body.error.message).toMatch(/client tools/);
    });

    test('refuses a builtin tool converter that names no action', async () => {
      const tool = await asAdmin()
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'builtin-converter',
          type: 'builtin',
          actions: ['list-documents'],
        });

      const res = await asAdmin().post('/api/v1/ingestion-rules').send({
        project_id: projectId,
        content_type_glob: 'video/mp4',
        tool_id: tool.body.id,
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INGESTION_RULE_VALIDATION_FAILED');
      expect(res.body.error.message).toMatch(/action is required/);
    });
  });

  describe('POST /api/v1/documents/ingest', () => {
    test('the exact rule converts a file over the wildcards that also match', async () => {
      const content = await ingestAndRead({
        filename: 'shot.png',
        contentType: 'image/png',
      });

      expect(content).toBe('converted by /png');
    });

    test('a subtype wildcard converts a file over the full wildcard', async () => {
      const content = await ingestAndRead({
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
      });

      expect(content).toBe('converted by /image');
    });

    test('the full wildcard converts a file nothing more specific matches', async () => {
      const content = await ingestAndRead({
        filename: 'clip.webm',
        contentType: 'video/webm',
      });

      expect(content).toBe('converted by /any');
    });
  });

  describe('POST /api/v1/documents/:document_id/ingestion-callback', () => {
    test('a token minted for one document is refused on another', async () => {
      const first = await ingestDeferred('first.ogg');
      const second = await ingestDeferred('second.ogg');

      const res = await callBack({
        documentId: second.documentId,
        token: first.token,
        body: { text: 'Delivered to the wrong document.' },
      });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INGESTION_CALLBACK_INVALID_TOKEN');
    });

    test('a whitespace-only text yields a document with no chunks', async () => {
      const { documentId, token } = await ingestDeferred('blank.ogg');

      const res = await callBack({
        documentId,
        token,
        body: { text: ' \n\t ' },
      });

      expect(res.status).toBe(204);
      const status = await asAdmin().get(
        `/api/v1/documents/${documentId}/status`
      );
      expect(status.body.chunk_count ?? 0).toBe(0);
    });

    test('page entries that are not objects are dropped', async () => {
      const { documentId, token } = await ingestDeferred('odd-pages.ogg');

      const res = await callBack({
        documentId,
        token,
        body: { pages: ['not a page', 123, { text: 'The one real page.' }] },
      });

      expect(res.status).toBe(204);
      const document = await asAdmin().get(`/api/v1/documents/${documentId}`);
      expect(document.body.content).toBe('The one real page.');
    });

    test.each([
      ['a number', 42],
      ['null', null],
      ['an array', ['pages']],
      ['a boolean', true],
    ])(
      'a text that is %s is refused as unrecognized output',
      async (_label, text) => {
        const { documentId, token } = await ingestDeferred(
          `shape-${String(_label).replace(/\s/g, '-')}.ogg`
        );

        const res = await callBack({ documentId, token, body: { text } });

        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('CONVERTER_OUTPUT_INVALID');
      }
    );
  });

  describe('GET /api/v1/documents/:document_id/status', () => {
    const originalIngestion = process.env.INGESTION_STALL_TIMEOUT_MS;
    const originalConversion = process.env.CONVERSION_STALL_TIMEOUT_MS;

    afterEach(() => {
      for (const [key, value] of [
        ['INGESTION_STALL_TIMEOUT_MS', originalIngestion],
        ['CONVERSION_STALL_TIMEOUT_MS', originalConversion],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    /**
     * A worker that died mid-ingestion: `processing`, untouched for `ageMs`.
     * `status` accompanies `updatedAt` because a silent bulk `update()` that
     * carries only a timestamp is a no-op.
     */
    const stallDocument = async (args: {
      documentId: string;
      ageMs: number;
    }) => {
      await db.Document.update(
        { status: 'processing', updatedAt: new Date(Date.now() - args.ageMs) },
        { where: { publicId: args.documentId }, silent: true }
      );
    };

    const createStalledDocument = async (ageMs: number): Promise<string> => {
      const res = await asAdmin().post('/api/v1/documents').send({
        project_id: projectId,
        content: 'Stalled content.',
      });
      expect(res.status).toBe(201);
      await stallDocument({ documentId: res.body.id, ageMs });
      return res.body.id;
    };

    const readStatus = async (documentId: string) => {
      const res = await asAdmin().get(`/api/v1/documents/${documentId}/status`);
      expect(res.status).toBe(200);
      return res.body as { status: string; error?: string };
    };

    test.each([['not-a-number'], ['-100']])(
      'an INGESTION_STALL_TIMEOUT_MS of %s falls back to the five-minute window',
      async (value) => {
        process.env.INGESTION_STALL_TIMEOUT_MS = value;
        const fresh = await createStalledDocument(60 * 1000);
        const stale = await createStalledDocument(6 * 60 * 1000);

        expect((await readStatus(fresh)).status).toBe('processing');
        expect(await readStatus(stale)).toMatchObject({
          status: 'failed',
          error: 'INGESTION_TIMEOUT',
        });
      }
    );

    test('a valid INGESTION_STALL_TIMEOUT_MS replaces the default window', async () => {
      process.env.INGESTION_STALL_TIMEOUT_MS = '1000';
      const documentId = await createStalledDocument(2000);

      expect(await readStatus(documentId)).toMatchObject({
        status: 'failed',
        error: 'INGESTION_TIMEOUT',
      });
    });

    test('an unreadable CONVERSION_STALL_TIMEOUT_MS falls back to the thirty-minute window', async () => {
      process.env.CONVERSION_STALL_TIMEOUT_MS = 'nope';
      const fresh = await ingestDeferred('conversion-fresh.ogg');
      const stale = await ingestDeferred('conversion-stale.ogg');
      await stallDocument({
        documentId: fresh.documentId,
        ageMs: 10 * 60 * 1000,
      });
      await stallDocument({
        documentId: stale.documentId,
        ageMs: 31 * 60 * 1000,
      });

      expect((await readStatus(fresh.documentId)).status).toBe('processing');
      expect(await readStatus(stale.documentId)).toMatchObject({
        status: 'failed',
        error: 'CONVERSION_TIMEOUT',
      });
    });
  });
});
