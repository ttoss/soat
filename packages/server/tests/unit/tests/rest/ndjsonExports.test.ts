import fs from 'node:fs';

import { db } from 'src/db';
import { emitActivityEntry } from 'src/lib/activity';
import { EXPORT_BATCH_SIZE } from 'src/lib/ndjsonExport';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { storageDir } from '../../setupTests';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * The corpus, as files. Every export answers the same way —
 * `application/x-ndjson`, one JSON object per line, oldest first — and returns
 * the rows the module's own listing returns, so a file and a page never
 * disagree about what a project holds.
 */
describe('NDJSON exports', () => {
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let projectInternalId: number;

  /**
   * Reads an export as raw text: `application/x-ndjson` is not a type
   * superagent parses, so the body is buffered and decoded by hand.
   */
  const exportNdjson = async (args: {
    token: string;
    path: string;
    query?: Record<string, string>;
  }) => {
    return authenticatedTestClient(args.token)
      .get(args.path)
      .query(args.query ?? {})
      .buffer(true)
      .parse((response, callback) => {
        let text = '';
        response.on('data', (chunk: Buffer) => {
          text += chunk.toString('utf8');
        });
        response.on('end', () => {
          callback(null, text);
        });
      });
  };

  const parseLines = (body: unknown): Array<Record<string, unknown>> => {
    return String(body)
      .split('\n')
      .filter((line) => {
        return line.trim().length > 0;
      })
      .map((line) => {
        return JSON.parse(line) as Record<string, unknown>;
      });
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'ndjson',
      policyActions: [
        'documents:CreateDocument',
        'documents:ListDocuments',
        'documents:ExportDocuments',
        'memories:CreateMemoryStore',
        'memories:CreateMemory',
        'memories:ListMemories',
        'memories:ExportMemories',
        'activity:ListActivity',
        'activity:ExportActivity',
      ],
    });
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;

    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    projectInternalId = project!.id as number;
  });

  afterAll(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  describe('GET /api/v1/documents/export', () => {
    beforeAll(async () => {
      for (const filename of ['first.txt', 'second.txt']) {
        await authenticatedTestClient(userToken)
          .post('/api/v1/documents')
          .send({
            project_id: projectId,
            content: `Content of ${filename}`,
            filename,
            path: `/exports/${filename}`,
          });
      }
      await authenticatedTestClient(userToken).post('/api/v1/documents').send({
        project_id: projectId,
        content: 'Filed elsewhere',
        filename: 'elsewhere.txt',
        path: '/other/elsewhere.txt',
      });
    });

    test('streams the documents as one JSON object per line', async () => {
      const res = await exportNdjson({
        token: userToken,
        path: '/api/v1/documents/export',
        query: { project_id: projectId },
      });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/x-ndjson');
      expect(res.headers['content-disposition']).toContain('.ndjson');

      const lines = parseLines(res.body);
      expect(lines.length).toBeGreaterThanOrEqual(3);
      expect(lines[0].id).toEqual(expect.stringMatching(/^doc_/));
      expect(lines[0].path).toEqual(expect.any(String));
    });

    test('oldest first, so a file is read start to end', async () => {
      const res = await exportNdjson({
        token: userToken,
        path: '/api/v1/documents/export',
        query: { project_id: projectId },
      });

      const created = parseLines(res.body).map((line) => {
        return String(line.created_at);
      });
      expect([...created].sort()).toEqual(created);
    });

    test('path_prefix narrows it exactly as it narrows the listing', async () => {
      const res = await exportNdjson({
        token: userToken,
        path: '/api/v1/documents/export',
        query: { project_id: projectId, path_prefix: '/exports' },
      });

      const paths = parseLines(res.body).map((line) => {
        return String(line.path);
      });
      expect(paths.length).toBe(2);
      expect(
        paths.every((path) => {
          return path.startsWith('/exports/');
        })
      ).toBe(true);
    });

    test('project_id is required', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/documents/export'
      );

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.get('/api/v1/documents/export').query({
        project_id: projectId,
      });

      expect(res.status).toBe(401);
    });

    test('a caller without the export permission returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .get('/api/v1/documents/export')
        .query({ project_id: projectId });

      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/v1/memory-stores/:memory_store_id/export', () => {
    let memoryStoreId: string;

    beforeAll(async () => {
      const store = await authenticatedTestClient(userToken)
        .post('/api/v1/memory-stores')
        .send({ project_id: projectId, name: 'Export store' });
      memoryStoreId = store.body.id;

      await authenticatedTestClient(userToken)
        .post('/api/v1/memories')
        .send({
          memory_store_id: memoryStoreId,
          content: 'The customer prefers email.',
          tags: { topic: 'contact' },
        });
    });

    test('streams the store’s memories as one JSON object per line', async () => {
      const res = await exportNdjson({
        token: userToken,
        path: `/api/v1/memory-stores/${memoryStoreId}/export`,
      });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/x-ndjson');

      const lines = parseLines(res.body);
      expect(lines).toHaveLength(1);
      expect(lines[0].id).toEqual(expect.stringMatching(/^mem_/));
      expect(lines[0].content).toBe('The customer prefers email.');
    });

    test('a tag filter narrows it', async () => {
      const res = await exportNdjson({
        token: userToken,
        path: `/api/v1/memory-stores/${memoryStoreId}/export`,
        query: { tags: 'topic:billing' },
      });

      expect(res.status).toBe(200);
      expect(parseLines(res.body)).toHaveLength(0);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.get(
        `/api/v1/memory-stores/${memoryStoreId}/export`
      );

      expect(res.status).toBe(401);
    });

    test('a caller without the export permission returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/memory-stores/${memoryStoreId}/export`
      );

      expect(res.status).toBe(403);
    });

    test('an unknown store returns 404', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/memory-stores/mem_store_missing/export'
      );

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v1/activity/export', () => {
    beforeAll(async () => {
      // Activity has no create endpoint — entries are platform-written, and
      // `emitActivityEntry` is the sanctioned seeding path (activity.test.ts).
      // One past the batch size, so the export crosses a page boundary: a
      // cursor that repeats or skips a row shows up as a wrong count here.
      for (let index = 0; index <= EXPORT_BATCH_SIZE; index += 1) {
        await emitActivityEntry({
          projectId: projectInternalId,
          kind: 'action_executed',
          summary: `Seeded entry ${index}`,
        });
      }
    });

    test('streams every entry, across the batch boundary, oldest first', async () => {
      const res = await exportNdjson({
        token: userToken,
        path: '/api/v1/activity/export',
        query: { project_id: projectId },
      });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/x-ndjson');

      const lines = parseLines(res.body);
      expect(lines.length).toBe(EXPORT_BATCH_SIZE + 1);

      const ids = lines.map((line) => {
        return String(line.id);
      });
      expect(new Set(ids).size).toBe(ids.length);

      const created = lines.map((line) => {
        return String(line.created_at);
      });
      expect([...created].sort()).toEqual(created);
    });

    test('a kind filter narrows it', async () => {
      const res = await exportNdjson({
        token: userToken,
        path: '/api/v1/activity/export',
        query: { project_id: projectId, kind: 'approval_created' },
      });

      expect(res.status).toBe(200);
      expect(parseLines(res.body)).toHaveLength(0);
    });

    test('project_id is required', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/activity/export'
      );

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient
        .get('/api/v1/activity/export')
        .query({ project_id: projectId });

      expect(res.status).toBe(401);
    });

    test('a caller without the export permission returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .get('/api/v1/activity/export')
        .query({ project_id: projectId });

      expect(res.status).toBe(403);
    });
  });
});
