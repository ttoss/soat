import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A `file` message part reaches the model in its own media type, read from
 * storage as the call leaves, and a model whose provider declares it cannot
 * read that modality refuses it before the provider is called.
 *
 * Driven against a local OpenAI-compatible stub that records each request
 * body: only the body the provider receives shows the part arrived natively.
 */

const IMAGE_BYTES = Buffer.from('not-really-a-png-but-bytes-all-the-same');

type LlmStub = {
  baseUrl: string;
  bodies: () => string[];
  close: () => Promise<void>;
};

const startLlmStub = async (): Promise<LlmStub> => {
  const bodies: string[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-file-parts',
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
    bodies: () => {
      return [...bodies];
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

describe('file message parts', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let otherProjectId: string;
  let imageFileId: string;
  let otherProjectFileId: string;
  let stub: LlmStub;
  let fallbackStub: LlmStub;

  const upload = async (args: { projectId: string }): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/files/upload')
      .attach('file', IMAGE_BYTES, {
        filename: 'scan.png',
        contentType: 'image/png',
      })
      .field('project_id', args.projectId);
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createProvider = async (args: {
    name: string;
    model: string;
    baseUrl?: string;
    modelInputModalities?: Record<string, string[]>;
  }): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: args.name,
        provider: 'ollama',
        default_model: args.model,
        base_url: args.baseUrl ?? stub.baseUrl,
        ...(args.modelInputModalities
          ? { model_input_modalities: args.modelInputModalities }
          : {}),
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createAgent = async (args: {
    name: string;
    aiProviderId?: string;
    modelRouteId?: string;
  }): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        name: args.name,
        ...(args.aiProviderId ? { ai_provider_id: args.aiProviderId } : {}),
        ...(args.modelRouteId ? { model_route_id: args.modelRouteId } : {}),
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const generate = (args: {
    token: string;
    agentId: string;
    messages: unknown[];
  }) => {
    return authenticatedTestClient(args.token)
      .post(`/api/v1/agents/${args.agentId}/generate?wait=true`)
      .send({ messages: args.messages });
  };

  const askAbout = (fileId: string) => {
    return [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What does this show?' },
          { type: 'file', file_id: fileId },
        ],
      },
    ];
  };

  beforeAll(async () => {
    stub = await startLlmStub();
    fallbackStub = await startLlmStub();
    const setup = await setupProjectWithUsers({
      prefix: 'fileparts',
      policyActions: ['agents:CreateAgentGeneration'],
      createOtherProject: true,
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId!;
    imageFileId = await upload({ projectId });
    otherProjectFileId = await upload({ projectId: otherProjectId });
  });

  afterAll(async () => {
    await stub.close();
    await fallbackStub.close();
  });

  describe('POST /api/v1/ai-providers model_input_modalities', () => {
    test('stores the declaration and returns it', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'declaring provider',
          provider: 'ollama',
          default_model: 'reader',
          base_url: stub.baseUrl,
          model_input_modalities: { reader: ['text', 'image', 'file'] },
        });

      expect(res.status).toBe(201);
      expect(res.body.model_input_modalities).toEqual({
        reader: ['text', 'image', 'file'],
      });
    });

    test('is empty when the provider declares none', async () => {
      const id = await createProvider({ name: 'silent', model: 'silent' });

      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/ai-providers/${id}`
      );

      expect(res.status).toBe(200);
      expect(res.body.model_input_modalities).toEqual({});
    });

    test('refuses a modality it does not know', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'unknown modality',
          provider: 'ollama',
          default_model: 'reader',
          base_url: stub.baseUrl,
          model_input_modalities: { reader: ['smell'] },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('PATCH with null clears the declaration', async () => {
      const id = await createProvider({
        name: 'clearable',
        model: 'clearable',
        modelInputModalities: { clearable: ['text'] },
      });

      const res = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/ai-providers/${id}`)
        .send({ model_input_modalities: null });

      expect(res.status).toBe(200);
      expect(res.body.model_input_modalities).toEqual({});
    });
  });

  describe('POST /api/v1/agents/:agent_id/generate', () => {
    test('sends the file to the model in its own media type', async () => {
      const agentId = await createAgent({
        name: 'native reader',
        aiProviderId: await createProvider({
          name: 'native provider',
          model: 'native-model',
          modelInputModalities: { 'native-model': ['text', 'image'] },
        }),
      });
      const before = stub.bodies().length;

      const res = await generate({
        token: adminToken,
        agentId,
        messages: askAbout(imageFileId),
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      const sent = stub.bodies().slice(before).join('\n');
      expect(sent).toContain(
        `data:image/png;base64,${IMAGE_BYTES.toString('base64')}`
      );
      expect(sent).not.toContain('soat-file:');
    });

    test('sends the file to a model that declares nothing', async () => {
      const agentId = await createAgent({
        name: 'undeclared reader',
        aiProviderId: await createProvider({
          name: 'undeclared provider',
          model: 'undeclared-model',
        }),
      });

      const res = await generate({
        token: adminToken,
        agentId,
        messages: askAbout(imageFileId),
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
    });

    test('refuses a modality the model declares it cannot read, before calling it', async () => {
      const agentId = await createAgent({
        name: 'text-only reader',
        aiProviderId: await createProvider({
          name: 'text-only provider',
          model: 'text-only-model',
          modelInputModalities: { 'text-only-model': ['text'] },
        }),
      });
      const before = stub.bodies().length;

      const res = await generate({
        token: adminToken,
        agentId,
        messages: askAbout(imageFileId),
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INPUT_MODALITY_UNSUPPORTED');
      expect(res.body.error.meta).toEqual({
        model: 'text-only-model',
        modalities: ['image'],
      });
      expect(stub.bodies().length).toBe(before);
    });

    test('refuses a part the provider adapter cannot send, before calling it', async () => {
      const upload = await authenticatedTestClient(adminToken)
        .post('/api/v1/files/upload')
        .attach('file', Buffer.from('a,b\n1,2\n'), {
          filename: 'table.csv',
          contentType: 'text/csv',
        })
        .field('project_id', projectId);
      expect(upload.status).toBe(201);
      const agentId = await createAgent({
        name: 'adapter-limited reader',
        aiProviderId: await createProvider({
          name: 'adapter-limited provider',
          model: 'adapter-limited-model',
        }),
      });
      const before = stub.bodies().length;

      const res = await generate({
        token: adminToken,
        agentId,
        messages: askAbout(upload.body.id),
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('AI_PROVIDER_FUNCTIONALITY_UNSUPPORTED');
      expect(res.body.error.meta.functionality).toBe(
        'file part media type text/csv'
      );
      expect(stub.bodies().length).toBe(before);
    });

    test('a file in another project is not found', async () => {
      const agentId = await createAgent({
        name: 'cross-project reader',
        aiProviderId: await createProvider({
          name: 'cross-project provider',
          model: 'cross-project-model',
        }),
      });

      const res = await generate({
        token: adminToken,
        agentId,
        messages: askAbout(otherProjectFileId),
      });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });

    test('reads the file as the caller, who needs files:DownloadFile', async () => {
      const agentId = await createAgent({
        name: 'caller-checked reader',
        aiProviderId: await createProvider({
          name: 'caller-checked provider',
          model: 'caller-checked-model',
        }),
      });

      const res = await generate({
        token: userToken,
        agentId,
        messages: askAbout(imageFileId),
      });

      expect(res.status).toBe(403);
    });

    test('refuses a file part outside a user message', async () => {
      const agentId = await createAgent({
        name: 'assistant-file reader',
        aiProviderId: await createProvider({
          name: 'assistant-file provider',
          model: 'assistant-file-model',
        }),
      });

      const res = await generate({
        token: adminToken,
        agentId,
        messages: [
          { role: 'user', content: 'hello' },
          {
            role: 'assistant',
            content: [{ type: 'file', file_id: imageFileId }],
          },
          { role: 'user', content: 'and now?' },
        ],
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('refuses a part outside the wire contract', async () => {
      const agentId = await createAgent({
        name: 'raw-part reader',
        aiProviderId: await createProvider({
          name: 'raw-part provider',
          model: 'raw-part-model',
        }),
      });

      const res = await generate({
        token: adminToken,
        agentId,
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', image: 'https://example.com/a.png' }],
          },
        ],
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('model routes', () => {
    const createRoute = async (args: {
      name: string;
      targets: Array<{ aiProviderId: string; model: string }>;
    }): Promise<string> => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/model-routes')
        .send({
          project_id: projectId,
          name: args.name,
          targets: args.targets.map((target) => {
            return {
              ai_provider_id: target.aiProviderId,
              model: target.model,
            };
          }),
        });
      expect(res.status).toBe(201);
      return res.body.id;
    };

    test('skips a target that cannot read the input', async () => {
      const modelRouteId = await createRoute({
        name: 'modality route',
        targets: [
          {
            aiProviderId: await createProvider({
              name: 'route text-only',
              model: 'route-text-model',
              modelInputModalities: { 'route-text-model': ['text'] },
            }),
            model: 'route-text-model',
          },
          {
            aiProviderId: await createProvider({
              name: 'route image reader',
              model: 'route-image-model',
              baseUrl: fallbackStub.baseUrl,
              modelInputModalities: {
                'route-image-model': ['text', 'image'],
              },
            }),
            model: 'route-image-model',
          },
        ],
      });
      const agentId = await createAgent({
        name: 'routed reader',
        modelRouteId,
      });
      const primaryBefore = stub.bodies().length;
      const fallbackBefore = fallbackStub.bodies().length;

      const res = await generate({
        token: adminToken,
        agentId,
        messages: askAbout(imageFileId),
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      expect(stub.bodies().length).toBe(primaryBefore);
      expect(fallbackStub.bodies().length).toBe(fallbackBefore + 1);
    });

    test('refuses when no target reads the input', async () => {
      const modelRouteId = await createRoute({
        name: 'text-only route',
        targets: [
          {
            aiProviderId: await createProvider({
              name: 'all text-only',
              model: 'all-text-model',
              modelInputModalities: { 'all-text-model': ['text'] },
            }),
            model: 'all-text-model',
          },
        ],
      });
      const agentId = await createAgent({
        name: 'text-only routed reader',
        modelRouteId,
      });

      const res = await generate({
        token: adminToken,
        agentId,
        messages: askAbout(imageFileId),
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INPUT_MODALITY_UNSUPPORTED');
      expect(res.body.error.meta.modalities).toEqual(['image']);
    });
  });
});
