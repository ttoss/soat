import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import {
  type ChatCompletionsStub,
  type RecordedRequest,
  startChatCompletionsStub,
  textCompletion,
  toolCallCompletion,
} from '../../fixtures/chatCompletionsStub';
import { authenticatedTestClient } from '../../testClient';

/**
 * A tool result that returns a file (`{ type: "file", file_id }`) reaches the
 * model as a native file part, read as the tool's result is recorded and
 * gated by the model's input modalities as the call leaves.
 */

const IMAGE_BYTES = Buffer.from('tool-result-scan-bytes');
const IMAGE_BASE64 = IMAGE_BYTES.toString('base64');

describe('tool results that return files', () => {
  let stub: ChatCompletionsStub;
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let imageFileId: string;
  let otherProjectFileId: string;
  let scanToolId: string;
  let photographToolId: string;
  /** What the `/scan` HTTP tool answers. */
  let scanReply: unknown;

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

  const createAgent = async (args: {
    name: string;
    toolId: string;
    modalities?: string[];
    limits?: Record<string, unknown>;
    extra?: Record<string, unknown>;
  }): Promise<string> => {
    const model = `${args.name.replace(/\s+/g, '-')}-model`;
    const provider = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: `${args.name} provider`,
        provider: 'ollama',
        default_model: model,
        base_url: stub.baseUrl,
        ...(args.modalities
          ? { model_input_modalities: { [model]: args.modalities } }
          : {}),
        ...(args.limits
          ? { model_input_limits: { [model]: args.limits } }
          : {}),
      });
    expect(provider.status).toBe(201);
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        name: args.name,
        ai_provider_id: provider.body.id,
        tool_bindings: [{ tool_id: args.toolId }],
        max_steps: 3,
        ...args.extra,
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const generate = (args: { token: string; agentId: string }) => {
    return authenticatedTestClient(args.token)
      .post(`/api/v1/agents/${args.agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'Look at the scan.' }] });
  };

  const submit = (args: {
    token: string;
    agentId: string;
    generationId: string;
    output: unknown;
  }) => {
    return authenticatedTestClient(args.token)
      .post(
        `/api/v1/agents/${args.agentId}/generate/${args.generationId}/tool-outputs`
      )
      .send({
        tool_outputs: [{ tool_call_id: 'call_scan', output: args.output }],
      });
  };

  /** The `role: "tool"` message the request carries for `call_scan`. */
  const toolMessage = (request: RecordedRequest): string => {
    const messages = Array.isArray(request.body.messages)
      ? request.body.messages
      : [];
    return JSON.stringify(
      messages.filter((message: unknown) => {
        return (
          typeof message === 'object' &&
          message !== null &&
          'role' in message &&
          message.role === 'tool'
        );
      })
    );
  };

  beforeAll(async () => {
    stub = await startChatCompletionsStub({
      routes: {
        '/scan': () => {
          return { body: scanReply };
        },
      },
    });
    const setup = await setupProjectWithUsers({
      prefix: 'toolresultfiles',
      policyActions: ['agents:CreateAgentGeneration', 'tools:CallTool'],
      createOtherProject: true,
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
    imageFileId = await upload({ projectId });
    otherProjectFileId = await upload({ projectId: setup.otherProjectId! });

    const scan = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        type: 'http',
        name: 'scan',
        parameters: { type: 'object', properties: {} },
        execute: { url: `${stub.baseUrl}/scan`, method: 'POST' },
      });
    expect(scan.status).toBe(201);
    scanToolId = scan.body.id;

    const photograph = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        type: 'client',
        name: 'photograph',
        parameters: { type: 'object', properties: {} },
      });
    expect(photograph.status).toBe(201);
    photographToolId = photograph.body.id;
  });

  afterAll(async () => {
    await stub.close();
  });

  describe('a server tool', () => {
    test('its file reaches the model in its own media type', async () => {
      const agentId = await createAgent({
        name: 'server reader',
        toolId: scanToolId,
        modalities: ['text', 'image'],
      });
      scanReply = { type: 'file', file_id: imageFileId };
      stub.reply(
        toolCallCompletion([{ id: 'call_scan', name: 'scan' }]),
        textCompletion('A scan.')
      );
      stub.completions.length = 0;

      const res = await generate({ token: adminToken, agentId });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      expect(stub.completions).toHaveLength(2);
      const sent = toolMessage(stub.completions[1]);
      expect(sent).toContain(IMAGE_BASE64);
      expect(sent).toContain('image/png');
      expect(sent).not.toContain('soat-file:');
    });

    test('a model that cannot read the file is refused before it is called', async () => {
      const agentId = await createAgent({
        name: 'server text-only',
        toolId: scanToolId,
        modalities: ['text'],
      });
      scanReply = { type: 'file', file_id: imageFileId };
      stub.reply(
        toolCallCompletion([{ id: 'call_scan', name: 'scan' }]),
        textCompletion('A scan.')
      );
      stub.completions.length = 0;

      const res = await generate({ token: adminToken, agentId });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INPUT_MODALITY_UNSUPPORTED');
      expect(res.body.error.meta.modalities).toEqual(['image']);
      expect(stub.completions).toHaveLength(1);
    });

    test('a file over a limit the model declares is refused before it is called', async () => {
      const agentId = await createAgent({
        name: 'server byte-limited',
        toolId: scanToolId,
        limits: { max_bytes: { image: IMAGE_BYTES.byteLength - 1 } },
      });
      scanReply = { type: 'file', file_id: imageFileId };
      stub.reply(
        toolCallCompletion([{ id: 'call_scan', name: 'scan' }]),
        textCompletion('A scan.')
      );
      stub.completions.length = 0;

      const res = await generate({ token: adminToken, agentId });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INPUT_LIMIT_EXCEEDED');
      expect(res.body.error.meta).toMatchObject({
        limit: 'max_bytes',
        modality: 'image',
        value: IMAGE_BYTES.byteLength,
        part: { part_index: 0, content_index: 0 },
      });
      expect(stub.completions).toHaveLength(1);
    });

    test('a file outside the turn’s project reaches the model as an error, never its bytes', async () => {
      const agentId = await createAgent({
        name: 'server cross-project',
        toolId: scanToolId,
      });
      scanReply = { type: 'file', file_id: otherProjectFileId };
      stub.reply(
        toolCallCompletion([{ id: 'call_scan', name: 'scan' }]),
        textCompletion('No scan.')
      );
      stub.completions.length = 0;

      const res = await generate({ token: adminToken, agentId });

      expect(res.status).toBe(200);
      expect(stub.completions).toHaveLength(2);
      const sent = toolMessage(stub.completions[1]);
      expect(sent).toContain(`File '${otherProjectFileId}' not found.`);
      expect(sent).not.toContain(IMAGE_BASE64);
    });

    test('an output that only resembles a file part stays JSON', async () => {
      const agentId = await createAgent({
        name: 'server lookalike',
        toolId: scanToolId,
      });
      scanReply = { type: 'file', file_id: imageFileId, note: 'extra' };
      stub.reply(
        toolCallCompletion([{ id: 'call_scan', name: 'scan' }]),
        textCompletion('ok')
      );
      stub.completions.length = 0;

      const res = await generate({ token: adminToken, agentId });

      expect(res.status).toBe(200);
      const sent = toolMessage(stub.completions[1]);
      expect(sent).toContain(imageFileId);
      expect(sent).not.toContain(IMAGE_BASE64);
    });
  });

  test('an output_schema answer step sends the file in a user message, with no tool', async () => {
    const agentId = await createAgent({
      name: 'schema reader',
      toolId: scanToolId,
      modalities: ['text', 'image'],
      extra: {
        max_steps: 2,
        output_schema: {
          type: 'object',
          required: ['summary'],
          properties: { summary: { type: 'string' } },
        },
      },
    });
    scanReply = [
      { type: 'text', text: 'the caption' },
      { type: 'file', file_id: imageFileId },
    ];
    stub.reply(
      toolCallCompletion([{ id: 'call_scan', name: 'scan' }]),
      textCompletion(JSON.stringify({ summary: 'A scan.' }))
    );
    stub.completions.length = 0;

    const res = await generate({ token: adminToken, agentId });

    expect(res.status).toBe(200);
    expect(res.body.output.object).toEqual({ summary: 'A scan.' });
    const answer = stub.completions[1].body;
    expect(answer.tools).toBeUndefined();
    expect(toolMessage(stub.completions[1])).toBe('[]');
    const sent = JSON.stringify(answer.messages);
    expect(sent).toContain('the caption');
    expect(sent).toContain(IMAGE_BASE64);
    expect(sent).not.toContain('soat-file:');
  });

  describe('a tool_output message block', () => {
    const generateWith = (args: {
      token: string;
      agentId: string;
      messages: unknown[];
    }) => {
      stub.reply(textCompletion('A scan.'));
      stub.completions.length = 0;
      return authenticatedTestClient(args.token)
        .post(`/api/v1/agents/${args.agentId}/generate?wait=true`)
        .send({ messages: args.messages });
    };

    const block = () => {
      return { type: 'tool_output', tool_id: scanToolId };
    };

    test('its file reaches the model as a file part beside the text', async () => {
      const agentId = await createAgent({
        name: 'block reader',
        toolId: scanToolId,
        modalities: ['text', 'image'],
      });
      scanReply = [
        { type: 'text', text: 'the caption' },
        { type: 'file', file_id: imageFileId },
      ];

      const res = await generateWith({
        token: adminToken,
        agentId,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Look at the scan.' }, block()],
          },
        ],
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      const sent = JSON.stringify(stub.completions[0].body.messages);
      expect(sent).toContain('the caption');
      expect(sent).toContain(IMAGE_BASE64);
      expect(sent).not.toContain(imageFileId);
    });

    test('as a message’s whole content, its file reaches the model', async () => {
      const agentId = await createAgent({
        name: 'block whole',
        toolId: scanToolId,
        modalities: ['text', 'image'],
      });
      scanReply = { type: 'file', file_id: imageFileId };

      const res = await generateWith({
        token: adminToken,
        agentId,
        messages: [{ role: 'user', content: block() }],
      });

      expect(res.status).toBe(200);
      const sent = JSON.stringify(stub.completions[0].body.messages);
      expect(sent).toContain(IMAGE_BASE64);
      expect(sent).not.toContain(imageFileId);
    });

    test('a file in another project is not found', async () => {
      const agentId = await createAgent({
        name: 'block cross-project',
        toolId: scanToolId,
      });
      scanReply = { type: 'file', file_id: otherProjectFileId };

      const res = await generateWith({
        token: adminToken,
        agentId,
        messages: [{ role: 'user', content: [block()] }],
      });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
      expect(stub.completions).toHaveLength(0);
    });

    test('is read as the caller, who needs files:DownloadFile', async () => {
      const agentId = await createAgent({
        name: 'block caller-checked',
        toolId: scanToolId,
      });
      scanReply = { type: 'file', file_id: imageFileId };

      const res = await generateWith({
        token: userToken,
        agentId,
        messages: [{ role: 'user', content: [block()] }],
      });

      expect(res.status).toBe(403);
      expect(stub.completions).toHaveLength(0);
    });

    test('a file outside a user message is refused', async () => {
      const agentId = await createAgent({
        name: 'block assistant',
        toolId: scanToolId,
      });
      scanReply = { type: 'file', file_id: imageFileId };

      const res = await generateWith({
        token: adminToken,
        agentId,
        messages: [
          { role: 'user', content: 'Scan it.' },
          { role: 'assistant', content: [block()] },
          { role: 'user', content: 'What did you see?' },
        ],
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(stub.completions).toHaveLength(0);
    });

    test('an output with no file still reaches the model as text', async () => {
      const agentId = await createAgent({
        name: 'block text',
        toolId: scanToolId,
      });
      scanReply = { found: 'nothing' };

      const res = await generateWith({
        token: adminToken,
        agentId,
        messages: [{ role: 'user', content: [block()] }],
      });

      expect(res.status).toBe(200);
      const sent = JSON.stringify(stub.completions[0].body.messages);
      expect(sent).toContain('nothing');
    });
  });

  describe('a client tool output', () => {
    const pause = async (args: { token: string; agentId: string }) => {
      stub.reply(
        toolCallCompletion([{ id: 'call_scan', name: 'photograph' }]),
        textCompletion('A scan.')
      );
      const paused = await generate(args);
      expect(paused.status).toBe(200);
      expect(paused.body.status).toBe('requires_action');
      stub.completions.length = 0;
      return paused.body.id as string;
    };

    test('its file reaches the model in its own media type', async () => {
      const agentId = await createAgent({
        name: 'client reader',
        toolId: photographToolId,
      });
      const generationId = await pause({ token: adminToken, agentId });

      const res = await submit({
        token: adminToken,
        agentId,
        generationId,
        output: [
          { type: 'text', text: 'Page one:' },
          { type: 'file', file_id: imageFileId },
        ],
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      const sent = toolMessage(stub.completions[0]);
      expect(sent).toContain(IMAGE_BASE64);
      expect(sent).toContain('Page one:');
    });

    test('a file in another project is not found', async () => {
      const agentId = await createAgent({
        name: 'client cross-project',
        toolId: photographToolId,
      });
      const generationId = await pause({ token: adminToken, agentId });

      const res = await submit({
        token: adminToken,
        agentId,
        generationId,
        output: { type: 'file', file_id: otherProjectFileId },
      });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
      expect(stub.completions).toHaveLength(0);
    });

    test('is read as the submitter, who needs files:DownloadFile', async () => {
      const agentId = await createAgent({
        name: 'client caller-checked',
        toolId: photographToolId,
      });
      const generationId = await pause({ token: userToken, agentId });

      const res = await submit({
        token: userToken,
        agentId,
        generationId,
        output: { type: 'file', file_id: imageFileId },
      });

      expect(res.status).toBe(403);
      expect(stub.completions).toHaveLength(0);
    });
  });
});
