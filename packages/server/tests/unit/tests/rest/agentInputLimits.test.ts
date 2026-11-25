import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import * as pdfModule from 'src/lib/pdf';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A model's declared input limits refuse an oversized request before the
 * provider is called, and the model listing serves them with the model.
 */

const IMAGE_BYTES = Buffer.alloc(64, 1);
const PDF_BYTES = Buffer.from('%PDF-1.4 pages measured by countPdfPages');

type LlmStub = {
  baseUrl: string;
  calls: () => number;
  close: () => Promise<void>;
};

const startLlmStub = async (): Promise<LlmStub> => {
  let calls = 0;
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      calls += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-input-limits',
          object: 'chat.completion',
          created: 0,
          model: 'stub-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'seen' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        })
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls: () => {
      return calls;
    },
    close: () => {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => {
          return error ? reject(error) : resolve();
        });
      });
    },
  };
};

describe('model input limits', () => {
  let adminToken: string;
  let projectId: string;
  let imageFileId: string;
  let pdfFileId: string;
  let stub: LlmStub;

  const upload = async (args: {
    bytes: Buffer;
    filename: string;
    contentType: string;
  }): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/files/upload')
      .attach('file', args.bytes, {
        filename: args.filename,
        contentType: args.contentType,
      })
      .field('project_id', projectId);
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createProvider = (args: {
    name: string;
    model: string;
    modelInputLimits?: unknown;
    extra?: Record<string, unknown>;
  }) => {
    return authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: args.name,
        provider: 'ollama',
        default_model: args.model,
        base_url: stub.baseUrl,
        ...(args.modelInputLimits === undefined
          ? {}
          : { model_input_limits: args.modelInputLimits }),
        ...args.extra,
      });
  };

  const agentOn = async (args: {
    name: string;
    model: string;
    modelInputLimits?: unknown;
  }): Promise<string> => {
    const provider = await createProvider(args);
    expect(provider.status).toBe(201);
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        name: args.name,
        ai_provider_id: provider.body.id,
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const generate = (args: { agentId: string; fileIds: string[] }) => {
    return authenticatedTestClient(adminToken)
      .post(`/api/v1/agents/${args.agentId}/generate?wait=true`)
      .send({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What does this show?' },
              ...args.fileIds.map((fileId) => {
                return { type: 'file', file_id: fileId };
              }),
            ],
          },
        ],
      });
  };

  beforeAll(async () => {
    stub = await startLlmStub();
    const setup = await setupProjectWithUsers({
      prefix: 'inputlimits',
      policyActions: ['agents:CreateAgentGeneration'],
      createOtherProject: false,
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
    imageFileId = await upload({
      bytes: IMAGE_BYTES,
      filename: 'scan.png',
      contentType: 'image/png',
    });
    pdfFileId = await upload({
      bytes: PDF_BYTES,
      filename: 'report.pdf',
      contentType: 'application/pdf',
    });
  });

  afterAll(async () => {
    await stub.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('POST /api/v1/ai-providers model_input_limits', () => {
    test('stores the declaration and returns it', async () => {
      const limits = {
        reader: { max_bytes: { image: 1024, file: 2048 }, max_pages: 10 },
      };

      const res = await createProvider({
        name: 'declaring limits',
        model: 'reader',
        modelInputLimits: limits,
      });

      expect(res.status).toBe(201);
      expect(res.body.model_input_limits).toEqual(limits);
    });

    test('is empty when the provider declares none', async () => {
      const res = await createProvider({ name: 'no limits', model: 'reader' });

      expect(res.status).toBe(201);
      expect(res.body.model_input_limits).toEqual({});
    });

    test.each([
      ['an unknown limit', { reader: { max_tokens: 10 } }],
      ['an unknown modality', { reader: { max_bytes: { smell: 10 } } }],
      ['a limit that is not a positive integer', { reader: { max_parts: 0 } }],
      ['a model that is not an object', { reader: 5 }],
    ])('refuses %s', async (_label, limits) => {
      const res = await createProvider({
        name: 'bad limits',
        model: 'reader',
        modelInputLimits: limits,
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('PATCH with null clears the declaration', async () => {
      const created = await createProvider({
        name: 'clearable limits',
        model: 'reader',
        modelInputLimits: { reader: { max_parts: 1 } },
      });

      const res = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/ai-providers/${created.body.id}`)
        .send({ model_input_limits: null });

      expect(res.status).toBe(200);
      expect(res.body.model_input_limits).toEqual({});
    });
  });

  describe('GET /api/v1/ai-providers/{ai_provider_id}/models', () => {
    test('serves each model with its declared limits', async () => {
      const created = await createProvider({
        name: 'catalog with limits',
        model: 'big',
        modelInputLimits: { big: { max_bytes: { image: 5 } } },
        extra: {
          model_aliases: { big: 'vendor-big', small: 'vendor-small' },
          model_aliases_only: true,
        },
      });
      expect(created.status).toBe(201);

      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/ai-providers/${created.body.id}/models`
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
        { id: 'big', input_limits: { max_bytes: { image: 5 } } },
        { id: 'small' },
      ]);
    });
  });

  describe('POST /api/v1/agents/:agent_id/generate', () => {
    test('refuses a file over max_bytes before calling the provider', async () => {
      const agentId = await agentOn({
        name: 'small image reader',
        model: 'small-image-model',
        modelInputLimits: {
          'small-image-model': { max_bytes: { image: IMAGE_BYTES.length - 1 } },
        },
      });
      const before = stub.calls();

      const res = await generate({ agentId, fileIds: [imageFileId] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INPUT_LIMIT_EXCEEDED');
      expect(res.body.error.meta).toMatchObject({
        model: 'small-image-model',
        limit: 'max_bytes',
        modality: 'image',
        max: IMAGE_BYTES.length - 1,
        value: IMAGE_BYTES.length,
        part: { message_index: 0, part_index: 1, file_id: imageFileId },
      });
      expect(stub.calls()).toBe(before);
    });

    test('sends a file within its limits', async () => {
      const agentId = await agentOn({
        name: 'roomy image reader',
        model: 'roomy-image-model',
        modelInputLimits: {
          'roomy-image-model': {
            max_bytes: { image: IMAGE_BYTES.length },
            max_parts: 1,
          },
        },
      });
      const before = stub.calls();

      const res = await generate({ agentId, fileIds: [imageFileId] });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      expect(stub.calls()).toBe(before + 1);
    });

    test('refuses more file parts than max_parts', async () => {
      const agentId = await agentOn({
        name: 'one part reader',
        model: 'one-part-model',
        modelInputLimits: { 'one-part-model': { max_parts: 1 } },
      });
      const before = stub.calls();

      const res = await generate({
        agentId,
        fileIds: [imageFileId, imageFileId],
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INPUT_LIMIT_EXCEEDED');
      expect(res.body.error.meta).toMatchObject({
        limit: 'max_parts',
        max: 1,
        value: 2,
        part: { message_index: 0, part_index: 2, file_id: imageFileId },
      });
      expect(stub.calls()).toBe(before);
    });

    test('refuses a PDF over max_pages', async () => {
      // unpdf cannot load in Jest's VM (`jest.config.ts`), so the page count is
      // stubbed as `extractPdfPages` is in the documents tests.
      const count = jest.spyOn(pdfModule, 'countPdfPages').mockResolvedValue(3);
      const agentId = await agentOn({
        name: 'short pdf reader',
        model: 'short-pdf-model',
        modelInputLimits: { 'short-pdf-model': { max_pages: 2 } },
      });
      const before = stub.calls();

      const res = await generate({ agentId, fileIds: [pdfFileId] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INPUT_LIMIT_EXCEEDED');
      expect(res.body.error.meta).toMatchObject({
        limit: 'max_pages',
        max: 2,
        value: 3,
        part: { file_id: pdfFileId },
      });
      expect(count).toHaveBeenCalled();
      expect(stub.calls()).toBe(before);
    });

    test('does not count pages when no max_pages is declared', async () => {
      const count = jest.spyOn(pdfModule, 'countPdfPages');
      const agentId = await agentOn({
        name: 'any pdf reader',
        model: 'any-pdf-model',
        modelInputLimits: { 'any-pdf-model': { max_bytes: { file: 1024 } } },
      });

      const res = await generate({ agentId, fileIds: [pdfFileId] });

      expect(res.status).toBe(200);
      expect(count).not.toHaveBeenCalled();
    });
  });
});
