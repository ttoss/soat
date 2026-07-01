import fs from 'node:fs';

import * as toolsModule from 'src/lib/tools';

import { storageDir } from '../../setupTests';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('IngestionRules', () => {
  let adminToken: string;
  let noPermToken: string;
  let projectId: string;
  let httpToolId: string;
  let agentId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });
    adminToken = await loginAs('admin', 'supersecret');

    await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'irnoperm', password: 'nopassword' });
    noPermToken = await loginAs('irnoperm', 'nopassword');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Ingestion Rules Project' });
    projectId = projectRes.body.id;

    const toolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'ocr-http',
        type: 'http',
        execute: { url: 'https://example.test/ocr', method: 'POST' },
      });
    httpToolId = toolRes.body.id;

    const providerRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Vision Provider',
        provider: 'openai',
        default_model: 'gpt-4o',
      });

    const agentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: providerRes.body.id,
        name: 'OCR Agent',
        instructions: 'Extract all text.',
      });
    agentId = agentRes.body.id;
  });

  afterAll(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  describe('POST /api/v1/ingestion-rules', () => {
    test('creates a rule with a tool converter', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/ingestion-rules')
        .send({
          project_id: projectId,
          content_type_glob: 'image/png',
          tool_id: httpToolId,
          file_delivery: 'base64',
          chunk_strategy: 'whole',
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toMatch(/^igr_/);
      expect(res.body.content_type_glob).toBe('image/png');
      expect(res.body.tool_id).toBe(httpToolId);
      expect(res.body.agent_id).toBeNull();
      expect(res.body.project_id).toBe(projectId);
    });

    test('creates a rule with an agent converter', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/ingestion-rules')
        .send({
          project_id: projectId,
          content_type_glob: 'image/jpeg',
          agent_id: agentId,
        });

      expect(res.status).toBe(201);
      expect(res.body.agent_id).toBe(agentId);
      expect(res.body.tool_id).toBeNull();
    });

    test('rejects a rule with both tool_id and agent_id (400)', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/ingestion-rules')
        .send({
          project_id: projectId,
          content_type_glob: 'image/gif',
          tool_id: httpToolId,
          agent_id: agentId,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INGESTION_RULE_VALIDATION_FAILED');
    });

    test('rejects a rule with neither tool_id nor agent_id (400)', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/ingestion-rules')
        .send({ project_id: projectId, content_type_glob: 'image/bmp' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INGESTION_RULE_VALIDATION_FAILED');
    });

    test('rejects an unknown tool_id (400 TOOL_NOT_FOUND)', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/ingestion-rules')
        .send({
          project_id: projectId,
          content_type_glob: 'image/webp',
          tool_id: 'tol_does_not_exist',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TOOL_NOT_FOUND');
    });

    test('rejects a duplicate content_type_glob (409)', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/ingestion-rules')
        .send({
          project_id: projectId,
          content_type_glob: 'image/png',
          tool_id: httpToolId,
        });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INGESTION_RULE_GLOB_CONFLICT');
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.post('/api/v1/ingestion-rules').send({
        project_id: projectId,
        content_type_glob: 'audio/mpeg',
        tool_id: httpToolId,
      });
      expect(res.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .post('/api/v1/ingestion-rules')
        .send({
          project_id: projectId,
          content_type_glob: 'audio/wav',
          tool_id: httpToolId,
        });
      expect(res.status).toBe(403);
    });
  });

  describe('GET / PATCH / DELETE /api/v1/ingestion-rules', () => {
    let ruleId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/ingestion-rules')
        .send({
          project_id: projectId,
          content_type_glob: 'application/pdf',
          agent_id: agentId,
          native_extraction: 'first',
        });
      ruleId = res.body.id;
    });

    test('lists rules for a project', async () => {
      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/ingestion-rules?project_id=${projectId}`
      );
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
    });

    test('list is unauthorized without a token (401)', async () => {
      const res = await testClient.get(
        `/api/v1/ingestion-rules?project_id=${projectId}`
      );
      expect(res.status).toBe(401);
    });

    test('gets a rule by id', async () => {
      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/ingestion-rules/${ruleId}`
      );
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(ruleId);
      expect(res.body.native_extraction).toBe('first');
    });

    test('returns 404 for a missing rule', async () => {
      const res = await authenticatedTestClient(adminToken).get(
        '/api/v1/ingestion-rules/igr_missing'
      );
      expect(res.status).toBe(404);
    });

    test('updates a rule', async () => {
      const res = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/ingestion-rules/${ruleId}`)
        .send({ native_extraction: 'skip', chunk_strategy: 'whole' });
      expect(res.status).toBe(200);
      expect(res.body.native_extraction).toBe('skip');
      expect(res.body.chunk_strategy).toBe('whole');
    });

    test('deletes a rule', async () => {
      const del = await authenticatedTestClient(adminToken).delete(
        `/api/v1/ingestion-rules/${ruleId}`
      );
      expect(del.status).toBe(204);

      const get = await authenticatedTestClient(adminToken).get(
        `/api/v1/ingestion-rules/${ruleId}`
      );
      expect(get.status).toBe(404);
    });
  });

  describe('converter ingestion via POST /api/v1/documents/ingest', () => {
    const uploadFile = async (args: {
      buffer: Buffer;
      filename: string;
      contentType: string;
    }) => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/files/upload')
        .attach('file', args.buffer, {
          filename: args.filename,
          contentType: args.contentType,
        })
        .field('project_id', projectId);
      expect(res.status).toBe(201);
      return res.body.id as string;
    };

    let callToolSpy: jest.SpyInstance;

    beforeAll(async () => {
      // Route audio through a tool converter, images through the agent converter.
      await authenticatedTestClient(adminToken)
        .post('/api/v1/ingestion-rules')
        .send({
          project_id: projectId,
          content_type_glob: 'audio/*',
          tool_id: httpToolId,
          file_delivery: 'download_url',
          chunk_strategy: 'size',
          chunk_size: 1000,
          chunk_overlap: 200,
        });
      await authenticatedTestClient(adminToken)
        .post('/api/v1/ingestion-rules')
        .send({
          project_id: projectId,
          content_type_glob: 'image/*',
          agent_id: agentId,
          chunk_strategy: 'whole',
        });
    });

    afterEach(() => {
      callToolSpy?.mockRestore();
      jest.clearAllMocks();
    });

    test('image routes to the agent converter and becomes ready + searchable', async () => {
      mockCreateGeneration.mockResolvedValueOnce({
        id: 'gen_ocr',
        traceId: 'trc_ocr',
        status: 'completed',
        output: {
          model: 'gpt-4o',
          content: 'Corner Cafe receipt. Total amount: 11.50 dollars.',
          finishReason: 'stop',
        },
      });

      // image/tiff has no exact rule, so it matches the image/* agent rule
      // (image/png is claimed by a tool rule in the CRUD block above).
      const fileId = await uploadFile({
        buffer: Buffer.from('fake-tiff-bytes'),
        filename: 'receipt.tiff',
        contentType: 'image/tiff',
      });

      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/documents/ingest?async=false')
        .send({
          project_id: projectId,
          file_id: fileId,
          path_prefix: '/img/',
        });

      expect(res.status).toBe(201);
      expect(mockCreateGeneration).toHaveBeenCalledTimes(1);
      expect(res.body.metadata).not.toHaveProperty('failure_reason');
      expect(res.body.status).toBe('ready');
      expect((res.body.metadata as Record<string, unknown>).chunk_count).toBe(
        1
      );

      const search = await authenticatedTestClient(adminToken)
        .post('/api/v1/knowledge/search')
        .send({ project_id: projectId, query: 'receipt total', limit: 3 });
      expect(search.status).toBe(200);
      const joined = JSON.stringify(search.body.results ?? []);
      expect(joined).toContain('Total amount: 11.50');
    });

    test('audio routes to the tool converter (download_url) and becomes ready', async () => {
      callToolSpy = jest.spyOn(toolsModule, 'callTool').mockResolvedValue({
        pages: [
          { text: 'Meeting transcript: launch next Tuesday.', page_number: 1 },
        ],
      });

      const fileId = await uploadFile({
        buffer: Buffer.from('fake-mp3-bytes'),
        filename: 'meeting.mp3',
        contentType: 'audio/mpeg',
      });

      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/documents/ingest?async=false')
        .send({
          project_id: projectId,
          file_id: fileId,
          path_prefix: '/aud/',
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('ready');
      expect(callToolSpy).toHaveBeenCalledTimes(1);
      // download_url delivery: converter input carries a signed URL, not base64.
      const input = callToolSpy.mock.calls[0][0].input as {
        file: { download_url?: string; data_base64?: string };
      };
      expect(input.file.download_url).toContain('/download?token=');
      expect(input.file.data_base64).toBeUndefined();
    });

    test('an unrecognized converter output fails the document (CONVERTER_OUTPUT_INVALID)', async () => {
      callToolSpy = jest
        .spyOn(toolsModule, 'callTool')
        .mockResolvedValue({ unexpected: 'shape' });

      const fileId = await uploadFile({
        buffer: Buffer.from('bytes'),
        filename: 'bad.mp3',
        contentType: 'audio/mpeg',
      });

      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/documents/ingest?async=false')
        .send({ project_id: projectId, file_id: fileId });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('failed');
      expect(
        (res.body.metadata as Record<string, unknown>).failure_reason
      ).toBe('CONVERTER_OUTPUT_INVALID');
    });

    test('a non-native file with no matching rule is rejected (UNSUPPORTED_FILE_TYPE)', async () => {
      const fileId = await uploadFile({
        buffer: Buffer.from('bytes'),
        filename: 'archive.zip',
        contentType: 'application/zip',
      });

      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/documents/ingest?async=false')
        .send({ project_id: projectId, file_id: fileId });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
    });
  });
});
