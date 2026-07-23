import fs from 'node:fs';

import { db } from 'src/db';
import {
  buildFileDownloadUrl,
  signFileDownloadToken,
  verifyFileDownloadToken,
} from 'src/lib/fileDownloadToken';
import * as pdfModule from 'src/lib/pdf';
import * as toolsModule from 'src/lib/tools';

import { ONE_PAGE_PDF_BUFFER } from '../../fixtures/pdf';
import { storageDir } from '../../setupTests';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('IngestionRules', () => {
  let adminToken: string;
  let noPermToken: string;
  let projectId: string;
  let httpToolId: string;
  let agentId: string;
  const originalSoatBaseUrl = process.env.SOAT_BASE_URL;

  beforeAll(async () => {
    // file_delivery: download_url builds an absolute URL for an external
    // converter — buildFileDownloadUrl requires SOAT_BASE_URL to be set.
    process.env.SOAT_BASE_URL = 'https://soat.example.test';

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
    if (originalSoatBaseUrl === undefined) {
      delete process.env.SOAT_BASE_URL;
    } else {
      process.env.SOAT_BASE_URL = originalSoatBaseUrl;
    }
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

    test('preserves preset_parameters keys verbatim through create and read (not camelCased)', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/ingestion-rules')
        .send({
          project_id: projectId,
          content_type_glob: 'audio/wav',
          tool_id: httpToolId,
          preset_parameters: { smart_format: true, detect_language: true },
        });

      expect(res.status).toBe(201);
      expect(res.body.preset_parameters).toEqual({
        smart_format: true,
        detect_language: true,
      });

      const getRes = await authenticatedTestClient(adminToken).get(
        `/api/v1/ingestion-rules/${res.body.id as string}`
      );
      expect(getRes.body.preset_parameters).toEqual({
        smart_format: true,
        detect_language: true,
      });
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

    test('rejects preset_parameters containing the reserved key "file" (400)', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/ingestion-rules')
        .send({
          project_id: projectId,
          content_type_glob: 'image/webp',
          tool_id: httpToolId,
          preset_parameters: { file: { data_base64: 'attacker-controlled' } },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INGESTION_RULE_VALIDATION_FAILED');
    });

    test('rejects preset_parameters containing the reserved key "callback" (400)', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/ingestion-rules')
        .send({
          project_id: projectId,
          content_type_glob: 'image/avif',
          tool_id: httpToolId,
          preset_parameters: { callback: { url: 'https://evil.example' } },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INGESTION_RULE_VALIDATION_FAILED');
    });

    test('rejects an invalid chunk_strategy (400)', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/ingestion-rules')
        .send({
          project_id: projectId,
          content_type_glob: 'image/heic',
          tool_id: httpToolId,
          chunk_strategy: 'sentence',
        });

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
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);
    });

    test('list honors limit and offset', async () => {
      const full = await authenticatedTestClient(adminToken).get(
        `/api/v1/ingestion-rules?project_id=${projectId}`
      );
      expect(full.body.data.length).toBeGreaterThan(1);

      const limited = await authenticatedTestClient(adminToken).get(
        `/api/v1/ingestion-rules?project_id=${projectId}&limit=1`
      );
      expect(limited.status).toBe(200);
      expect(limited.body.data.length).toBe(1);

      const paged = await authenticatedTestClient(adminToken).get(
        `/api/v1/ingestion-rules?project_id=${projectId}&limit=1&offset=1`
      );
      expect(paged.status).toBe(200);
      expect(paged.body.data.length).toBe(1);
      expect(paged.body.data[0].id).not.toBe(limited.body.data[0].id);
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

    test('admin can switch a rule from a tool to an agent converter via PATCH', async () => {
      const createRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ingestion-rules')
        .send({
          project_id: projectId,
          content_type_glob: 'text/x-switch-converter',
          tool_id: httpToolId,
        });
      const switchRuleId = createRes.body.id as string;

      // Admin's resolveProjectIds({ action }) with no target project resolves
      // to `undefined` (unrestricted) — this exercises resolveConverterRefs'
      // unrestricted-lookup path, not just the single-project array path.
      const res = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/ingestion-rules/${switchRuleId}`)
        .send({ tool_id: null, agent_id: agentId });

      expect(res.status).toBe(200);
      expect(res.body.tool_id).toBeNull();
      expect(res.body.agent_id).toBe(agentId);

      await authenticatedTestClient(adminToken).delete(
        `/api/v1/ingestion-rules/${switchRuleId}`
      );
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
    let pdfSpy: jest.SpyInstance;
    let pdfRuleId: string;

    const ocrGeneration = () => {
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
    };

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
      const pdfRule = await authenticatedTestClient(adminToken)
        .post('/api/v1/ingestion-rules')
        .send({
          project_id: projectId,
          content_type_glob: 'application/pdf',
          agent_id: agentId,
          native_extraction: 'first',
          chunk_strategy: 'whole',
        });
      pdfRuleId = pdfRule.body.id;
    });

    afterEach(() => {
      callToolSpy?.mockRestore();
      pdfSpy?.mockRestore();
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

    test('a converter-ingested document can be re-ingested (not UNSUPPORTED_FILE_TYPE)', async () => {
      ocrGeneration();

      const fileId = await uploadFile({
        buffer: Buffer.from('fake-tiff-bytes'),
        filename: 'receipt-reingest.tiff',
        contentType: 'image/tiff',
      });

      const ingestRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/documents/ingest?async=false')
        .send({ project_id: projectId, file_id: fileId });
      expect(ingestRes.status).toBe(201);
      expect(ingestRes.body.status).toBe('ready');
      const docId = ingestRes.body.id as string;

      ocrGeneration();
      const reRes = await authenticatedTestClient(adminToken)
        .post(`/api/v1/documents/${docId}/ingest?async=false`)
        .send({});

      expect(reRes.status).toBe(201);
      expect(reRes.body.status).toBe('ready');
      expect(mockCreateGeneration).toHaveBeenCalledTimes(2);
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

    test('preset_parameters reach the converter tool with snake_case keys intact', async () => {
      // audio/wav is an exact match, so it wins over the audio/* rule above
      // and carries the preset_parameters created in the CRUD block's
      // "preserves preset_parameters keys verbatim" test.
      callToolSpy = jest.spyOn(toolsModule, 'callTool').mockResolvedValue({
        pages: [{ text: 'Transcribed with presets.', page_number: 1 }],
      });

      const fileId = await uploadFile({
        buffer: Buffer.from('fake-wav-bytes'),
        filename: 'presets.wav',
        contentType: 'audio/wav',
      });

      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/documents/ingest?async=false')
        .send({ project_id: projectId, file_id: fileId });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('ready');
      expect(callToolSpy).toHaveBeenCalledTimes(1);
      const input = callToolSpy.mock.calls[0][0].input as Record<
        string,
        unknown
      >;
      expect(input.smart_format).toBe(true);
      expect(input.detect_language).toBe(true);
      expect(input.smartFormat).toBeUndefined();
      expect(input.detectLanguage).toBeUndefined();
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

    test('a plain-string converter output becomes one ready page', async () => {
      callToolSpy = jest
        .spyOn(toolsModule, 'callTool')
        .mockResolvedValue('Plain transcript text.');

      const fileId = await uploadFile({
        buffer: Buffer.from('bytes'),
        filename: 'plain.mp3',
        contentType: 'audio/mpeg',
      });

      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/documents/ingest?async=false')
        .send({ project_id: projectId, file_id: fileId });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('ready');
      expect((res.body.metadata as Record<string, unknown>).chunk_count).toBe(
        1
      );
    });

    test('a { status: "pending" } deferral fails (async callback unsupported)', async () => {
      callToolSpy = jest
        .spyOn(toolsModule, 'callTool')
        .mockResolvedValue({ status: 'pending' });

      const fileId = await uploadFile({
        buffer: Buffer.from('bytes'),
        filename: 'pending.mp3',
        contentType: 'audio/mpeg',
      });

      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/documents/ingest?async=false')
        .send({ project_id: projectId, file_id: fileId });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('failed');
      expect(
        (res.body.metadata as Record<string, unknown>).failure_reason
      ).toBe('CONVERTER_FAILED');
    });

    test('a converter tool error fails the document (CONVERTER_FAILED)', async () => {
      callToolSpy = jest
        .spyOn(toolsModule, 'callTool')
        .mockRejectedValue(new Error('provider unreachable'));

      const fileId = await uploadFile({
        buffer: Buffer.from('bytes'),
        filename: 'boom.mp3',
        contentType: 'audio/mpeg',
      });

      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/documents/ingest?async=false')
        .send({ project_id: projectId, file_id: fileId });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('failed');
      expect(
        (res.body.metadata as Record<string, unknown>).failure_reason
      ).toBe('CONVERTER_FAILED');
    });

    test('a scanned PDF (no text layer) falls back to the converter', async () => {
      pdfSpy = jest.spyOn(pdfModule, 'extractPdfPages').mockResolvedValue([]);
      ocrGeneration();

      const fileId = await uploadFile({
        buffer: ONE_PAGE_PDF_BUFFER,
        filename: 'scanned.pdf',
        contentType: 'application/pdf',
      });

      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/documents/ingest?async=false')
        .send({ project_id: projectId, file_id: fileId });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('ready');
      expect(mockCreateGeneration).toHaveBeenCalledTimes(1);
    });

    test('an agent converter with no text output fails (CONVERTER_FAILED)', async () => {
      mockCreateGeneration.mockResolvedValueOnce({
        id: 'gen_x',
        traceId: 'trc_x',
        status: 'requires_action',
        requiredAction: { type: 'submit_tool_outputs', toolCalls: [] },
      });

      const fileId = await uploadFile({
        buffer: Buffer.from('bytes'),
        filename: 'no-output.tiff',
        contentType: 'image/tiff',
      });

      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/documents/ingest?async=false')
        .send({ project_id: projectId, file_id: fileId });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('failed');
      expect(
        (res.body.metadata as Record<string, unknown>).failure_reason
      ).toBe('CONVERTER_FAILED');
    });

    test('paged output honors page_number/pageNumber and drops empty pages', async () => {
      callToolSpy = jest.spyOn(toolsModule, 'callTool').mockResolvedValue({
        pages: [
          { text: 'first page' }, // no page_number → index + 1
          { text: '   ' }, // blank → dropped
          { text: 'third page', pageNumber: 3 }, // camelCase accepted
        ],
      });

      const fileId = await uploadFile({
        buffer: Buffer.from('bytes'),
        filename: 'paged.mp3',
        contentType: 'audio/mpeg',
      });

      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/documents/ingest?async=false')
        .send({ project_id: projectId, file_id: fileId });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('ready');
      // The 'size' strategy re-chunks the joined text, so assert the parse ran
      // (a ready document) rather than a specific page count.
      expect(
        (res.body.metadata as Record<string, unknown>).chunk_count
      ).toBeGreaterThanOrEqual(1);
    });

    test('a non-numeric page_number fails the document (CONVERTER_OUTPUT_INVALID)', async () => {
      callToolSpy = jest.spyOn(toolsModule, 'callTool').mockResolvedValue({
        pages: [{ text: 'bad page number', page_number: 'one' }],
      });

      const fileId = await uploadFile({
        buffer: Buffer.from('bytes'),
        filename: 'bad-page-number.mp3',
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

    test('a native text file with no rule uses native extraction', async () => {
      const fileId = await uploadFile({
        buffer: Buffer.from('Plain native text, no converter involved.'),
        filename: 'notes.txt',
        contentType: 'text/plain',
      });

      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/documents/ingest?async=false')
        .send({ project_id: projectId, file_id: fileId });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('ready');
      expect(mockCreateGeneration).not.toHaveBeenCalled();
    });

    test('a native text file with no extractable text fails (FILE_PARSE_FAILED)', async () => {
      const fileId = await uploadFile({
        buffer: Buffer.from('   \n  \t '),
        filename: 'blank.txt',
        contentType: 'text/plain',
      });

      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/documents/ingest?async=false')
        .send({ project_id: projectId, file_id: fileId });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('failed');
      expect(
        (res.body.metadata as Record<string, unknown>).failure_reason
      ).toBe('FILE_PARSE_FAILED');
    });

    test('a born-digital PDF uses native extraction (converter not called)', async () => {
      pdfSpy = jest
        .spyOn(pdfModule, 'extractPdfPages')
        .mockResolvedValue(['Born-digital text layer.']);

      const fileId = await uploadFile({
        buffer: ONE_PAGE_PDF_BUFFER,
        filename: 'born-digital-native.pdf',
        contentType: 'application/pdf',
      });

      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/documents/ingest?async=false')
        .send({ project_id: projectId, file_id: fileId });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('ready');
      expect(mockCreateGeneration).not.toHaveBeenCalled();
    });

    test('native_extraction: skip converts a PDF even when it has a text layer', async () => {
      await authenticatedTestClient(adminToken)
        .patch(`/api/v1/ingestion-rules/${pdfRuleId}`)
        .send({ native_extraction: 'skip' });

      pdfSpy = jest
        .spyOn(pdfModule, 'extractPdfPages')
        .mockResolvedValue(['A real text layer that would normally be used.']);
      ocrGeneration();

      const fileId = await uploadFile({
        buffer: ONE_PAGE_PDF_BUFFER,
        filename: 'born-digital.pdf',
        contentType: 'application/pdf',
      });

      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/documents/ingest?async=false')
        .send({ project_id: projectId, file_id: fileId });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('ready');
      // The converter ran (native extraction was bypassed).
      expect(mockCreateGeneration).toHaveBeenCalledTimes(1);
    });

    describe('async conversion via ingestion-callback (Phase 5)', () => {
      const waitForConversionAttempt = async (
        docId: string,
        timeout = 5000
      ): Promise<string> => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const row = await db.Document.findOne({ where: { publicId: docId } });
          if (row?.conversionAttemptId) return row.conversionAttemptId;
          await new Promise((r) => {
            return setTimeout(r, 20);
          });
        }
        throw new Error(
          `Timed out waiting for document ${docId} to record a conversion attempt`
        );
      };

      const waitForTerminalStatus = async (
        docId: string,
        timeout = 5000
      ): Promise<Record<string, unknown>> => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const res = await authenticatedTestClient(adminToken).get(
            `/api/v1/documents/${docId}/status`
          );
          if (res.body.status === 'ready' || res.body.status === 'failed') {
            return res.body as Record<string, unknown>;
          }
          await new Promise((r) => {
            return setTimeout(r, 20);
          });
        }
        throw new Error(`Timed out waiting for document ${docId} to finish`);
      };

      const ingestPendingAudio = async (filename: string) => {
        callToolSpy = jest
          .spyOn(toolsModule, 'callTool')
          .mockResolvedValue({ status: 'pending' });

        const fileId = await uploadFile({
          buffer: Buffer.from('async-bytes'),
          filename,
          contentType: 'audio/mpeg',
        });
        const ingestRes = await authenticatedTestClient(adminToken)
          .post('/api/v1/documents/ingest')
          .send({ project_id: projectId, file_id: fileId });
        expect(ingestRes.status).toBe(202);

        const docId = ingestRes.body.id as string;
        await waitForConversionAttempt(docId);
        return docId;
      };

      const latestCallbackToken = (): string => {
        const calls = callToolSpy.mock.calls;
        const input = calls[calls.length - 1][0].input as {
          callback?: { url: string; token: string };
        };
        expect(input.callback?.url).toContain('/ingestion-callback?token=');
        return input.callback!.token;
      };

      test('a pending tool converter leaves the document processing; a callback completes it and it becomes searchable', async () => {
        const docId = await ingestPendingAudio('callback-success.mp3');

        const processingRes = await authenticatedTestClient(adminToken).get(
          `/api/v1/documents/${docId}/status`
        );
        expect(processingRes.body.status).toBe('processing');

        const callbackRes = await testClient
          .post(
            `/api/v1/documents/${docId}/ingestion-callback?token=${latestCallbackToken()}`
          )
          .send({ text: 'Async transcript delivered later.' });
        expect(callbackRes.status).toBe(204);

        const finalStatus = await waitForTerminalStatus(docId);
        expect(finalStatus.status).toBe('ready');
        expect(finalStatus.chunk_count).toBe(1);

        const getRes = await authenticatedTestClient(adminToken).get(
          `/api/v1/documents/${docId}`
        );
        expect(getRes.body.content).toBe('Async transcript delivered later.');
      });

      test('a replayed callback is rejected with 409 INGESTION_CALLBACK_CONFLICT', async () => {
        const docId = await ingestPendingAudio('callback-replay.mp3');
        const token = latestCallbackToken();

        const first = await testClient
          .post(`/api/v1/documents/${docId}/ingestion-callback?token=${token}`)
          .send({ text: 'First delivery.' });
        expect(first.status).toBe(204);

        const replay = await testClient
          .post(`/api/v1/documents/${docId}/ingestion-callback?token=${token}`)
          .send({ text: 'Replayed delivery.' });
        expect(replay.status).toBe(409);
        expect(replay.body.error.code).toBe('INGESTION_CALLBACK_CONFLICT');
      });

      test('a callback for an attempt superseded by re-ingest is rejected, but the fresh attempt still works', async () => {
        const docId = await ingestPendingAudio('callback-superseded.mp3');
        const staleToken = latestCallbackToken();

        // Re-ingest mints a fresh attempt; the converter defers again.
        const reingestRes = await authenticatedTestClient(adminToken)
          .post(`/api/v1/documents/${docId}/ingest`)
          .send({});
        expect(reingestRes.status).toBe(202);
        await waitForConversionAttempt(docId);
        const freshToken = latestCallbackToken();
        expect(freshToken).not.toBe(staleToken);

        const staleCallback = await testClient
          .post(
            `/api/v1/documents/${docId}/ingestion-callback?token=${staleToken}`
          )
          .send({ text: 'Stale delivery.' });
        expect(staleCallback.status).toBe(409);

        const freshCallback = await testClient
          .post(
            `/api/v1/documents/${docId}/ingestion-callback?token=${freshToken}`
          )
          .send({ text: 'Fresh delivery.' });
        expect(freshCallback.status).toBe(204);
      });

      test('an invalid token is rejected with 401 INGESTION_CALLBACK_INVALID_TOKEN', async () => {
        const docId = await ingestPendingAudio('callback-invalid-token.mp3');

        const res = await testClient
          .post(`/api/v1/documents/${docId}/ingestion-callback?token=garbage`)
          .send({ text: 'x' });
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('INGESTION_CALLBACK_INVALID_TOKEN');
      });

      test('a callback that itself defers with { status: "pending" } is rejected', async () => {
        const docId = await ingestPendingAudio('callback-nested-pending.mp3');

        const res = await testClient
          .post(
            `/api/v1/documents/${docId}/ingestion-callback?token=${latestCallbackToken()}`
          )
          .send({ status: 'pending' });
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('CONVERTER_OUTPUT_INVALID');
      });

      test('missing document returns 404', async () => {
        const res = await testClient
          .post(
            '/api/v1/documents/doc_nonexistent/ingestion-callback?token=garbage'
          )
          .send({ text: 'x' });
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
      });

      test('a stale conversion times out with CONVERSION_TIMEOUT, and a late callback then loses the race', async () => {
        const docId = await ingestPendingAudio('callback-timeout.mp3');
        const token = latestCallbackToken();

        // Simulate a converter that never called back: push updatedAt beyond
        // the (default 30-minute) conversion stall timeout. `status` must be
        // included alongside `updatedAt` — Sequelize's bulk `update()` with
        // `silent: true` and only a timestamp field in the values set is a
        // no-op (0 rows affected), even though the row matches the `where`.
        const stale = new Date(Date.now() - 60 * 60 * 1000);
        await db.Document.update(
          { status: 'processing', updatedAt: stale },
          { where: { publicId: docId }, silent: true }
        );

        const res = await authenticatedTestClient(adminToken).get(
          `/api/v1/documents/${docId}/status`
        );
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('failed');
        expect(res.body.error).toBe('CONVERSION_TIMEOUT');

        // The sweeper already cleared conversionAttemptId, so a late callback
        // loses the race and is rejected — never silently dropped.
        const lateCallback = await testClient
          .post(`/api/v1/documents/${docId}/ingestion-callback?token=${token}`)
          .send({ text: 'Too late.' });
        expect(lateCallback.status).toBe(409);
      });
    });
  });

  describe('authorization branches', () => {
    let ruleId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/ingestion-rules')
        .send({
          project_id: projectId,
          content_type_glob: 'text/x-auth',
          tool_id: httpToolId,
        });
      ruleId = res.body.id;
    });

    test('list without permission returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/ingestion-rules?project_id=${projectId}`
      );
      expect(res.status).toBe(403);
    });

    test('project-scoped API key without GetIngestionRule permission returns 403', async () => {
      const policyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [
              {
                effect: 'Allow',
                action: ['ingestion-rules:ListIngestionRules'],
              },
            ],
          },
        });
      const keyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/api-keys')
        .send({
          name: 'No GetIngestionRule Key',
          project_id: projectId,
          policy_ids: [policyRes.body.id],
        });
      expect(keyRes.status).toBe(201);

      const res = await authenticatedTestClient(keyRes.body.key as string).get(
        `/api/v1/ingestion-rules/${ruleId}`
      );
      expect(res.status).toBe(403);
    });

    test('get is 401 unauthenticated and 404 without permission (no accessible projects)', async () => {
      expect(
        (await testClient.get(`/api/v1/ingestion-rules/${ruleId}`)).status
      ).toBe(401);
      // noPermToken has no policies → projectIds=[] → rule not found in empty
      // scope. This also means a cross-project id and a nonexistent id are
      // indistinguishable to a caller without access — no existence oracle.
      expect(
        (
          await authenticatedTestClient(noPermToken).get(
            `/api/v1/ingestion-rules/${ruleId}`
          )
        ).status
      ).toBe(404);
    });

    test('patch is 401 unauthenticated and 404 without permission (no accessible projects)', async () => {
      expect(
        (
          await testClient
            .patch(`/api/v1/ingestion-rules/${ruleId}`)
            .send({ chunk_strategy: 'whole' })
        ).status
      ).toBe(401);
      expect(
        (
          await authenticatedTestClient(noPermToken)
            .patch(`/api/v1/ingestion-rules/${ruleId}`)
            .send({ chunk_strategy: 'whole' })
        ).status
      ).toBe(404);
    });

    test('delete is 401 unauthenticated and 404 without permission (no accessible projects)', async () => {
      expect(
        (await testClient.delete(`/api/v1/ingestion-rules/${ruleId}`)).status
      ).toBe(401);
      expect(
        (
          await authenticatedTestClient(noPermToken).delete(
            `/api/v1/ingestion-rules/${ruleId}`
          )
        ).status
      ).toBe(404);
    });

    test('project-scoped API key without UpdateIngestionRule/DeleteIngestionRule permission returns 403', async () => {
      const policyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [
              {
                effect: 'Allow',
                action: ['ingestion-rules:ListIngestionRules'],
              },
            ],
          },
        });
      const keyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/api-keys')
        .send({
          name: 'No Update/Delete IngestionRule Key',
          project_id: projectId,
          policy_ids: [policyRes.body.id],
        });
      expect(keyRes.status).toBe(201);
      const rawKey = keyRes.body.key as string;

      const patchRes = await authenticatedTestClient(rawKey)
        .patch(`/api/v1/ingestion-rules/${ruleId}`)
        .send({ chunk_strategy: 'whole' });
      expect(patchRes.status).toBe(403);

      const deleteRes = await authenticatedTestClient(rawKey).delete(
        `/api/v1/ingestion-rules/${ruleId}`
      );
      expect(deleteRes.status).toBe(403);
    });
  });

  describe('cross-project access does not leak resource existence', () => {
    let otherProjectUserToken: string;
    let ruleInProjectId: string;

    beforeAll(async () => {
      const otherProjectRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Ingestion Rules Other Project' });
      const otherProjectId = otherProjectRes.body.id as string;

      const userRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/users')
        .send({ username: 'ir-other-project', password: 'nopassword' });

      // A policy scoped to otherProjectId only, via a resource SRN — this
      // caller has the ingestion-rules actions, just not on `projectId`.
      const policyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [
              {
                effect: 'Allow',
                action: [
                  'ingestion-rules:GetIngestionRule',
                  'ingestion-rules:UpdateIngestionRule',
                  'ingestion-rules:DeleteIngestionRule',
                ],
                resource: [`soat:${otherProjectId}:*:*`],
              },
            ],
          },
        });

      await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${userRes.body.id as string}/policies`)
        .send({ policy_ids: [policyRes.body.id] });

      otherProjectUserToken = await loginAs('ir-other-project', 'nopassword');

      const ruleRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ingestion-rules')
        .send({
          project_id: projectId,
          content_type_glob: 'text/x-cross-project',
          tool_id: httpToolId,
        });
      ruleInProjectId = ruleRes.body.id;
    });

    test('get on a rule from an inaccessible project returns 404, not 403', async () => {
      const res = await authenticatedTestClient(otherProjectUserToken).get(
        `/api/v1/ingestion-rules/${ruleInProjectId}`
      );
      expect(res.status).toBe(404);
    });

    test('patch on a rule from an inaccessible project returns 404, not 403', async () => {
      const res = await authenticatedTestClient(otherProjectUserToken)
        .patch(`/api/v1/ingestion-rules/${ruleInProjectId}`)
        .send({ chunk_strategy: 'whole' });
      expect(res.status).toBe(404);
    });

    test('delete on a rule from an inaccessible project returns 404, not 403', async () => {
      const res = await authenticatedTestClient(otherProjectUserToken).delete(
        `/api/v1/ingestion-rules/${ruleInProjectId}`
      );
      expect(res.status).toBe(404);
    });
  });

  describe('fileDownloadToken', () => {
    test('sign and verify round-trip for the same file', () => {
      const token = signFileDownloadToken({ fileId: 'fl_abc' });
      expect(verifyFileDownloadToken({ token, fileId: 'fl_abc' })).toBe(true);
    });

    test('rejects a token scoped to a different file', () => {
      const token = signFileDownloadToken({ fileId: 'fl_abc' });
      expect(verifyFileDownloadToken({ token, fileId: 'fl_other' })).toBe(
        false
      );
    });

    test('rejects a malformed token', () => {
      expect(
        verifyFileDownloadToken({ token: 'not-a-jwt', fileId: 'fl_abc' })
      ).toBe(false);
    });

    test('buildFileDownloadUrl embeds a verifiable token', () => {
      const url = buildFileDownloadUrl({ fileId: 'fl_xyz' });
      expect(url).toContain('/api/v1/files/fl_xyz/download?token=');
      const token = url.split('token=')[1];
      expect(verifyFileDownloadToken({ token, fileId: 'fl_xyz' })).toBe(true);
    });

    test('buildFileDownloadUrl throws when SOAT_BASE_URL is unset (no unreachable localhost fallback)', () => {
      const original = process.env.SOAT_BASE_URL;
      delete process.env.SOAT_BASE_URL;

      try {
        expect(() => {
          return buildFileDownloadUrl({ fileId: 'fl_xyz' });
        }).toThrow(/SOAT_BASE_URL/);
      } finally {
        if (original === undefined) {
          delete process.env.SOAT_BASE_URL;
        } else {
          process.env.SOAT_BASE_URL = original;
        }
      }
    });
  });
});
