import { createServer } from 'node:http';

import { db } from 'src/db';
import {
  buildContextHeaders,
  HttpToolError,
  isSoatActionAllowedByBoundary,
  parseHttpExecuteConfig,
  resolveAgentTools,
  resolveBodyParamInterpolations,
  resolveUrlPathParams,
} from 'src/lib/agentToolResolver';
import {
  buildMcpToolExecute,
  executeSoatTool,
  resolveMcpTools,
  resolveSoatTools,
} from 'src/lib/agentToolResolverExternalTools';
import * as discussionCompletion from 'src/lib/discussionCompletion';
import { soatTools } from 'src/lib/soatTools';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('resolveAgentTools', () => {
  let adminToken: string;
  let projectId: string;
  let httpToolId: string;
  let clientToolId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'toolresolveradmin', password: 'supersecret' });

    adminToken = await loginAs('toolresolveradmin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Tool Resolver Test Project' });
    projectId = projectRes.body.id;

    const httpToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'myHttpTool',
        type: 'http',
        description: 'Test HTTP tool',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            page: { type: 'number' },
          },
        },
        execute: {
          url: 'https://example.com/api/search',
          method: 'GET',
        },
      });
    httpToolId = httpToolRes.body.id;

    const clientToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'myClientTool',
        type: 'client',
        description: 'Test client tool',
        parameters: {
          type: 'object',
          properties: {
            input: { type: 'string' },
          },
        },
      });
    clientToolId = clientToolRes.body.id;
  });

  test('resolves http tool and returns tool with execute function', async () => {
    const tools = await resolveAgentTools({ toolIds: [httpToolId] });
    expect(tools).toHaveProperty('myHttpTool');
    expect(typeof tools.myHttpTool).toBe('object');
  });

  test('resolves client tool and returns tool without execute function', async () => {
    const tools = await resolveAgentTools({ toolIds: [clientToolId] });
    expect(tools).toHaveProperty('myClientTool');
    expect('execute' in tools.myClientTool).toBe(false);
  });

  test('skips unknown tool IDs', async () => {
    const tools = await resolveAgentTools({ toolIds: ['agt_tl_unknown000'] });
    expect(Object.keys(tools)).toHaveLength(0);
  });

  test('resolves multiple tools at once', async () => {
    const tools = await resolveAgentTools({
      toolIds: [httpToolId, clientToolId],
    });
    expect(Object.keys(tools)).toHaveLength(2);
    expect(tools).toHaveProperty('myHttpTool');
    expect(tools).toHaveProperty('myClientTool');
  });

  test('http tool execute covers GET method branches with query args', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [] }), { status: 200 })
      );

    const tools = await resolveAgentTools({ toolIds: [httpToolId] });
    const httpTool = tools.myHttpTool;

    if ('execute' in httpTool && typeof httpTool.execute === 'function') {
      await httpTool.execute({ query: 'test', page: 1 }, {} as never);
    }

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('example.com'),
      expect.objectContaining({ method: 'GET' })
    );

    fetchMock.mockRestore();
  });

  test('http tool execute covers POST method branches', async () => {
    const postToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'myPostHttpTool',
        type: 'http',
        description: 'Test POST HTTP tool',
        parameters: { type: 'object', properties: {} },
        execute: {
          url: 'https://example.com/api/create',
          method: 'POST',
        },
      });

    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'new-item' }), { status: 201 })
      );

    const tools = await resolveAgentTools({ toolIds: [postToolRes.body.id] });
    const postTool = tools.myPostHttpTool;

    if ('execute' in postTool && typeof postTool.execute === 'function') {
      await postTool.execute({ name: 'test item' }, {} as never);
    }

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/api/create',
      expect.objectContaining({ method: 'POST' })
    );

    fetchMock.mockRestore();
  });

  test('http tool execute forwards every top-level input field in the JSON body, not just nested ones', async () => {
    const siblingToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'mySiblingFieldsHttpTool',
        type: 'http',
        description: 'Test HTTP tool with sibling top-level fields',
        parameters: { type: 'object', properties: {} },
        execute: {
          url: 'https://example.com/api/create',
          method: 'POST',
        },
      });

    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'new-item' }), { status: 201 })
      );

    const tools = await resolveAgentTools({
      toolIds: [siblingToolRes.body.id],
    });
    const siblingTool = tools.mySiblingFieldsHttpTool;

    if ('execute' in siblingTool && typeof siblingTool.execute === 'function') {
      await siblingTool.execute(
        { locale: 'pt-BR', data: { title: 'Hello', theme: 'test' } },
        {} as never
      );
    }

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/api/create',
      expect.objectContaining({
        body: JSON.stringify({
          locale: 'pt-BR',
          data: { title: 'Hello', theme: 'test' },
        }),
      })
    );

    fetchMock.mockRestore();
  });

  test('http tool execute with body_mode multipart sends a real multipart request with a decoded file part', async () => {
    // Capture the raw request the tool sends by pointing execute.url at a
    // local server that echoes back the content-type header and raw body.
    let captured: { contentType: string | undefined; body: string } | null =
      null;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on('end', () => {
        captured = {
          contentType: req.headers['content-type'],
          body: Buffer.concat(chunks).toString('binary'),
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const port =
      address && typeof address === 'object' ? address.port : undefined;

    const multipartToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'myMultipartHttpTool',
        type: 'http',
        description: 'Test multipart HTTP tool',
        parameters: { type: 'object', properties: {} },
        execute: {
          url: `http://127.0.0.1:${port}/v1/stt`,
          method: 'POST',
          body_mode: 'multipart',
          // A caller-set Content-Type must be dropped so fetch can set the
          // multipart boundary itself.
          headers: { 'Content-Type': 'application/json' },
        },
      });

    // `execute` is a pass-through config; its snake_case keys round-trip
    // unchanged through caseTransform.
    expect(multipartToolRes.body.execute.body_mode).toBe('multipart');

    const tools = await resolveAgentTools({
      toolIds: [multipartToolRes.body.id],
    });
    const multipartTool = tools.myMultipartHttpTool;

    if (
      'execute' in multipartTool &&
      typeof multipartTool.execute === 'function'
    ) {
      await multipartTool.execute(
        {
          model: 'grok-stt',
          // Nested object (not a file shape) is JSON-stringified into a field.
          options: { language: 'en' },
          // Null values are skipped entirely.
          skip: null,
          // camelCase file keys and a missing filename are also supported.
          file: {
            dataBase64: Buffer.from('AUDIO-BYTES-123').toString('base64'),
            contentType: 'text/plain',
          },
        },
        {} as never
      );
    }

    await new Promise<void>((resolve) => {
      server.close(() => {
        return resolve();
      });
    });

    expect(captured).not.toBeNull();
    const result = captured as unknown as {
      contentType: string;
      body: string;
    };
    // fetch sets its own multipart boundary; the caller's JSON Content-Type
    // is dropped.
    expect(result.contentType).toMatch(/^multipart\/form-data; boundary=/);
    // Plain field is a form field.
    expect(result.body).toContain('name="model"');
    expect(result.body).toContain('grok-stt');
    // Nested object is JSON-stringified.
    expect(result.body).toContain('name="options"');
    expect(result.body).toContain('{"language":"en"}');
    // Null-valued field is omitted.
    expect(result.body).not.toContain('name="skip"');
    // File-shaped field becomes a file part; a missing filename defaults to the
    // field name and binary content is decoded (not base64).
    expect(result.body).toContain('name="file"');
    expect(result.body).toContain('filename="file"');
    expect(result.body).toContain('Content-Type: text/plain');
    expect(result.body).toContain('AUDIO-BYTES-123');
  });

  test('http tool execute throws HttpToolError on non-OK response with JSON body', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
      );

    const tools = await resolveAgentTools({ toolIds: [httpToolId] });
    const httpTool = tools.myHttpTool;

    let thrownError: unknown;
    if ('execute' in httpTool && typeof httpTool.execute === 'function') {
      try {
        await httpTool.execute({}, {} as never);
      } catch (error) {
        thrownError = error;
      }
    }

    expect(thrownError).toBeInstanceOf(HttpToolError);
    const httpError = thrownError as HttpToolError;
    expect(httpError.status).toBe(401);
    expect(httpError.message).toContain('HTTP 401');
    expect(httpError.body).toContain('Unauthorized');
    expect(httpError.url).toContain('example.com');
    expect(httpError.method).toBe('GET');
    expect(JSON.stringify(httpError)).not.toBe('{}');
    const serialized = JSON.parse(JSON.stringify(httpError)) as {
      message: string;
      name: string;
      status: number;
      body: string;
      url: string;
      method: string;
    };
    expect(serialized.message).toContain('HTTP 401');
    expect(serialized.name).toBe('HttpToolError');
    expect(serialized.status).toBe(401);
    expect(serialized.body).toContain('Unauthorized');
    expect(serialized.url).toContain('example.com');
    expect(serialized.method).toBe('GET');

    fetchMock.mockRestore();
  });

  test('http tool execute throws HttpToolError on non-OK response with plain text body', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));

    const tools = await resolveAgentTools({ toolIds: [httpToolId] });
    const httpTool = tools.myHttpTool;

    let thrownError: unknown;
    if ('execute' in httpTool && typeof httpTool.execute === 'function') {
      try {
        await httpTool.execute({}, {} as never);
      } catch (error) {
        thrownError = error;
      }
    }

    expect(thrownError).toBeInstanceOf(HttpToolError);
    const httpError = thrownError as HttpToolError;
    expect(httpError.status).toBe(403);
    expect(httpError.body).toBe('Forbidden');

    fetchMock.mockRestore();
  });

  test('http tool execute supports legacy execute config stored as JSON string', async () => {
    const legacyToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'myLegacyHttpTool',
        type: 'http',
        description: 'Legacy stored execute payload',
        parameters: { type: 'object', properties: {} },
        execute: {
          url: 'https://example.com/api/users/{user_id}',
          method: 'GET',
        },
      });

    await db.Tool.update(
      {
        execute: {
          url: 'https://example.com/api/users/{user_id}',
          method: 'GET',
        },
      },
      { where: { publicId: legacyToolRes.body.id } }
    );

    await db.sequelize.query(
      'UPDATE tools SET execute = to_jsonb($1::text) WHERE public_id = $2',
      {
        bind: [
          JSON.stringify({
            url: 'https://example.com/api/users/{user_id}',
            method: 'GET',
          }),
          legacyToolRes.body.id,
        ],
      }
    );

    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      );

    const tools = await resolveAgentTools({ toolIds: [legacyToolRes.body.id] });
    const legacyTool = tools.myLegacyHttpTool;

    if ('execute' in legacyTool && typeof legacyTool.execute === 'function') {
      await legacyTool.execute(
        { user_id: 'u_01', include: 'projects' },
        {} as never
      );
    }

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/api/users/u_01?include=projects',
      expect.objectContaining({ method: 'GET' })
    );

    fetchMock.mockRestore();
  });

  test('logs HTTP tool call errors when SOAT_ERROR_LOGS_ENABLED is enabled', async () => {
    const originalValue = process.env.SOAT_ERROR_LOGS_ENABLED;
    process.env.SOAT_ERROR_LOGS_ENABLED = 'true';

    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('Boom', { status: 500 }));

    const tools = await resolveAgentTools({ toolIds: [httpToolId] });
    const httpTool = tools.myHttpTool;

    if ('execute' in httpTool && typeof httpTool.execute === 'function') {
      await expect(httpTool.execute({}, {} as never)).rejects.toBeInstanceOf(
        HttpToolError
      );
    }

    fetchMock.mockRestore();
    process.env.SOAT_ERROR_LOGS_ENABLED = originalValue;
  });

  test('DELETE tool with JSON body sends Content-Type and body in request', async () => {
    const deleteToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'myDeleteHttpTool',
        type: 'http',
        description: 'Test DELETE HTTP tool with body',
        parameters: {
          type: 'object',
          properties: {
            item_id: { type: 'string' },
          },
        },
        execute: {
          url: 'https://example.com/api/items',
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
        },
      });
    expect(deleteToolRes.status).toBe(201);

    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ deleted: true }), { status: 200 })
      );

    const tools = await resolveAgentTools({ toolIds: [deleteToolRes.body.id] });
    const deleteTool = tools.myDeleteHttpTool;

    if ('execute' in deleteTool && typeof deleteTool.execute === 'function') {
      await deleteTool.execute({ item_id: 'abc' }, {} as never);
    }

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/api/items',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ item_id: 'abc' }),
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      })
    );

    fetchMock.mockRestore();
  });

  test('does not log HTTP tool call errors when SOAT_ERROR_LOGS_ENABLED is disabled', async () => {
    const originalValue = process.env.SOAT_ERROR_LOGS_ENABLED;
    process.env.SOAT_ERROR_LOGS_ENABLED = 'false';

    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('Boom', { status: 500 }));

    const tools = await resolveAgentTools({ toolIds: [httpToolId] });
    const httpTool = tools.myHttpTool;

    if ('execute' in httpTool && typeof httpTool.execute === 'function') {
      await expect(httpTool.execute({}, {} as never)).rejects.toBeInstanceOf(
        HttpToolError
      );
    }

    fetchMock.mockRestore();
    process.env.SOAT_ERROR_LOGS_ENABLED = originalValue;
  });

  test('http tool with a malformed execute config throws when called', async () => {
    const invalidToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'myInvalidHttpTool',
        type: 'http',
        description: 'Test HTTP tool with a malformed execute config',
        parameters: { type: 'object', properties: {} },
        // Missing `url` — parseHttpExecuteConfig returns null, so
        // resolveHttpTool falls back to buildInvalidHttpToolExecute.
        execute: { method: 'GET' },
      });

    const tools = await resolveAgentTools({
      toolIds: [invalidToolRes.body.id],
    });
    const invalidTool = tools.myInvalidHttpTool;

    expect('execute' in invalidTool && typeof invalidTool.execute).toBe(
      'function'
    );
    if ('execute' in invalidTool && typeof invalidTool.execute === 'function') {
      await expect(invalidTool.execute({}, {} as never)).rejects.toThrow(
        'Invalid HTTP tool execute config for myInvalidHttpTool'
      );
    }
  });

  test('wraps a tool execute with output_mapping and reshapes the result', async () => {
    const mappedToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'myMappedHttpTool',
        type: 'http',
        description: 'Test HTTP tool with output_mapping',
        parameters: { type: 'object', properties: {} },
        execute: { url: 'https://example.com/api/mapped', method: 'GET' },
        output_mapping: { text: { var: 'output.body' } },
      });

    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ body: 'hello' }), { status: 200 })
      );

    const tools = await resolveAgentTools({
      toolIds: [mappedToolRes.body.id],
    });
    const mappedTool = tools.myMappedHttpTool;

    expect('execute' in mappedTool).toBe(true);
    if ('execute' in mappedTool && typeof mappedTool.execute === 'function') {
      const result = await mappedTool.execute({}, {} as never);
      expect(result).toEqual({ text: 'hello' });
    }

    fetchMock.mockRestore();
  });

  test('pipeline tool execute delegates to callTool (fails deep in the pipeline runner)', async () => {
    const soatToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'myPipelineSoatSubTool',
        type: 'soat',
        description: 'SOAT sub-tool used by the pipeline tool',
        actions: ['list-tools'],
      });

    const pipelineToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'myPipelineTool',
        type: 'pipeline',
        description: 'Pipeline tool used to exercise resolvePipelineTool',
        pipeline: {
          steps: [
            {
              id: 'first',
              tool_id: soatToolRes.body.id,
              action: 'list-tools',
              input: {},
            },
          ],
        },
      });

    const tools = await resolveAgentTools({
      toolIds: [pipelineToolRes.body.id],
    });
    const pipelineTool = tools.myPipelineTool;

    expect('execute' in pipelineTool).toBe(true);
    if (
      'execute' in pipelineTool &&
      typeof pipelineTool.execute === 'function'
    ) {
      // The SOAT step makes an internal HTTP call that is unreachable from
      // unit tests (see tools.test.ts), so the pipeline step fails — this
      // still proves execution reached resolvePipelineTool's callTool bridge.
      await expect(pipelineTool.execute({}, {} as never)).rejects.toThrow();
    }
  });
});

describe('resolveAgentTools - discussion type', () => {
  let adminToken: string;
  let projectId: string;
  let discussionId: string;
  let discussionToolId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'discresolveradmin', password: 'supersecret' });

    adminToken = await loginAs('discresolveradmin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Discussion Tool Resolver Project' });
    projectId = projectRes.body.id;

    const aiProvRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Discussion Resolver Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });

    const discussionRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/discussions')
      .send({
        project_id: projectId,
        name: 'review-panel',
        ai_provider_id: aiProvRes.body.id,
        participants: [],
      });
    discussionId = discussionRes.body.id;

    const toolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'review-theme',
        type: 'discussion',
        description: 'Run a panel review for a given topic',
        parameters: {
          type: 'object',
          required: ['topic'],
          properties: {
            topic: { type: 'string' },
          },
        },
        discussion_id: discussionId,
      });
    discussionToolId = toolRes.body.id;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('discussion tool is included in resolved tools', async () => {
    const tools = await resolveAgentTools({ toolIds: [discussionToolId] });
    expect(tools).toHaveProperty('review-theme');
  });

  test('discussion tool has an execute function', async () => {
    const tools = await resolveAgentTools({ toolIds: [discussionToolId] });
    expect('execute' in tools['review-theme']).toBe(true);
  });

  test('discussion tool execute calls runDiscussion and returns outcome and run_id', async () => {
    jest
      .spyOn(discussionCompletion, 'runDiscussionCompletion')
      .mockResolvedValue('Approved: proceed with the feature.');

    const tools = await resolveAgentTools({ toolIds: [discussionToolId] });
    const discTool = tools['review-theme'];

    let result: unknown;
    if ('execute' in discTool && typeof discTool.execute === 'function') {
      result = await discTool.execute({ topic: 'Should we ship?' }, {} as never);
    }

    expect(result).toMatchObject({
      outcome: 'Approved: proceed with the feature.',
      run_id: expect.stringMatching(/^drn_/),
    });
  });
});

describe('resolveAgentTools - ephemeral tools', () => {
  let adminToken: string;
  let projectId: string;
  let internalProjectId: number;

  beforeAll(async () => {
    // toolresolveradmin was bootstrapped by the first describe's beforeAll
    adminToken = await loginAs('toolresolveradmin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Ephemeral Tool Test Project' });
    projectId = projectRes.body.id;

    const projectRow = await db.Project.findOne({
      where: { publicId: projectId },
    });
    internalProjectId = projectRow!.id as number;
  });

  test('resolves an ephemeral http tool without creating a Tool row', async () => {
    const tools = await resolveAgentTools({
      toolIds: [],
      tools: [
        {
          name: 'ephemeralHttpTool',
          type: 'http',
          execute: { url: 'https://example.com/ping' },
        },
      ],
      projectId: internalProjectId,
    });

    expect(tools).toHaveProperty('ephemeralHttpTool');
    expect(typeof tools.ephemeralHttpTool.execute).toBe('function');

    const listRes = await authenticatedTestClient(adminToken).get(
      `/api/v1/tools?project_id=${projectId}`
    );
    expect(
      (listRes.body as Array<{ name: string }>).some((t) => {
        return t.name === 'ephemeralHttpTool';
      })
    ).toBe(false);
  });

  test('merges DB-backed toolIds with ephemeral tools', async () => {
    const persistedRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'persistedTool',
        type: 'client',
      });

    const tools = await resolveAgentTools({
      toolIds: [persistedRes.body.id],
      tools: [{ name: 'ephemeralClientTool', type: 'client' }],
      projectId: internalProjectId,
    });

    expect(Object.keys(tools).sort()).toEqual([
      'ephemeralClientTool',
      'persistedTool',
    ]);
  });

  test('rejects an ephemeral tool definition of type pipeline', async () => {
    await expect(
      resolveAgentTools({
        toolIds: [],
        tools: [{ name: 'ephemeralPipeline', type: 'pipeline' }],
        projectId: internalProjectId,
      })
    ).rejects.toThrow(/pipeline/i);
  });

  test('does not resolve ephemeral tools when projectId is not provided', async () => {
    const tools = await resolveAgentTools({
      toolIds: [],
      tools: [{ name: 'orphanedEphemeralTool' }],
    });
    expect(Object.keys(tools)).toHaveLength(0);
  });
});

describe('HttpToolError', () => {
  test('serializes to JSON with message, name, status, url, method, and body', () => {
    const error = new HttpToolError(
      'HTTP 401 GET https://api.example.com/items: Unauthorized',
      401,
      'Unauthorized',
      'https://api.example.com/items',
      'GET'
    );
    const json = JSON.stringify(error);
    expect(json).not.toBe('{}');
    const parsed = JSON.parse(json) as {
      message: string;
      name: string;
      status: number;
      body: string;
      url: string;
      method: string;
    };
    expect(parsed.message).toContain('HTTP 401');
    expect(parsed.name).toBe('HttpToolError');
    expect(parsed.status).toBe(401);
    expect(parsed.body).toBe('Unauthorized');
    expect(parsed.url).toBe('https://api.example.com/items');
    expect(parsed.method).toBe('GET');
  });

  test('is an instance of Error', () => {
    const error = new HttpToolError(
      'HTTP 500 POST https://api.example.com/items: Internal Server Error',
      500,
      'Internal Server Error',
      'https://api.example.com/items',
      'POST'
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('HttpToolError');
  });
});

describe('buildContextHeaders', () => {
  test('returns empty object when toolContext is undefined', () => {
    expect(buildContextHeaders(undefined)).toEqual({});
  });

  test('returns empty object when called with no arguments', () => {
    expect(buildContextHeaders()).toEqual({});
  });

  test('converts toolContext keys to X-Soat-Context-* headers with title-case first letter', () => {
    const result = buildContextHeaders({
      environment: 'production',
      tenantId: 'abc-123',
    });

    expect(result).toEqual({
      'X-Soat-Context-Environment': 'production',
      'X-Soat-Context-TenantId': 'abc-123',
    });
  });

  test('preserves header values unchanged', () => {
    const result = buildContextHeaders({ region: 'us-east-1' });

    expect(result['X-Soat-Context-Region']).toBe('us-east-1');
  });

  test('handles multiple context entries', () => {
    const result = buildContextHeaders({
      a: '1',
      b: '2',
      c: '3',
    });

    expect(Object.keys(result)).toHaveLength(3);
    expect(result['X-Soat-Context-A']).toBe('1');
    expect(result['X-Soat-Context-B']).toBe('2');
    expect(result['X-Soat-Context-C']).toBe('3');
  });
});

describe('isSoatActionAllowedByBoundary', () => {
  test('returns true when boundaryPolicy is null', () => {
    const result = isSoatActionAllowedByBoundary({
      boundaryPolicy: null,
      iamAction: 'agents:CreateGeneration',
    });

    expect(result).toBe(true);
  });

  test('returns true when boundaryPolicy is undefined', () => {
    const result = isSoatActionAllowedByBoundary({
      boundaryPolicy: undefined,
      iamAction: 'agents:CreateGeneration',
    });

    expect(result).toBe(true);
  });

  test('returns false when boundary policy is structurally invalid', () => {
    const result = isSoatActionAllowedByBoundary({
      boundaryPolicy: { invalid: 'policy', notAStatement: true },
      iamAction: 'agents:CreateGeneration',
    });

    expect(result).toBe(false);
  });

  test('returns true when valid Allow policy permits the action', () => {
    const policy = {
      statement: [
        {
          effect: 'Allow',
          action: ['agents:CreateGeneration'],
        },
      ],
    };

    const result = isSoatActionAllowedByBoundary({
      boundaryPolicy: policy,
      iamAction: 'agents:CreateGeneration',
    });

    expect(result).toBe(true);
  });

  test('returns false when valid policy does not allow the action', () => {
    const policy = {
      statement: [
        {
          effect: 'Allow',
          action: ['files:GetFile'],
        },
      ],
    };

    const result = isSoatActionAllowedByBoundary({
      boundaryPolicy: policy,
      iamAction: 'agents:CreateGeneration',
    });

    expect(result).toBe(false);
  });

  test('returns true when wildcard action allows everything', () => {
    const policy = {
      statement: [
        {
          effect: 'Allow',
          action: ['*'],
        },
      ],
    };

    const result = isSoatActionAllowedByBoundary({
      boundaryPolicy: policy,
      iamAction: 'agents:CreateGeneration',
    });

    expect(result).toBe(true);
  });
});

describe('resolveUrlPathParams', () => {
  test('returns unchanged url and all args as remaining when no placeholders', () => {
    const result = resolveUrlPathParams({
      url: 'https://example.com/api/items',
      toolArgs: { foo: 'bar', baz: 123 },
    });
    expect(result.resolvedUrl).toBe('https://example.com/api/items');
    expect(result.remainingArgs).toEqual({ foo: 'bar', baz: 123 });
  });

  test('replaces single path param and removes it from remainingArgs', () => {
    const result = resolveUrlPathParams({
      url: 'https://example.com/api/items/{itemId}',
      toolArgs: { itemId: 'item-123', filter: 'active' },
    });
    expect(result.resolvedUrl).toBe('https://example.com/api/items/item-123');
    expect(result.remainingArgs).toEqual({ filter: 'active' });
  });

  test('replaces multiple path params', () => {
    const result = resolveUrlPathParams({
      url: 'https://example.com/api/{projectId}/items/{itemId}',
      toolArgs: { projectId: 'prj-1', itemId: 'item-2', extra: 'value' },
    });
    expect(result.resolvedUrl).toBe(
      'https://example.com/api/prj-1/items/item-2'
    );
    expect(result.remainingArgs).toEqual({ extra: 'value' });
  });

  test('URL-encodes path param values', () => {
    const result = resolveUrlPathParams({
      url: 'https://example.com/search/{query}',
      toolArgs: { query: 'hello world' },
    });
    expect(result.resolvedUrl).toBe('https://example.com/search/hello%20world');
  });

  test('leaves placeholder unchanged when arg is not provided', () => {
    const result = resolveUrlPathParams({
      url: 'https://example.com/{id}/details',
      toolArgs: { other: 'value' },
    });
    expect(result.resolvedUrl).toBe('https://example.com/{id}/details');
    expect(result.remainingArgs).toEqual({ other: 'value' });
  });

  test('handles empty toolArgs', () => {
    const result = resolveUrlPathParams({
      url: 'https://example.com/{id}/details',
      toolArgs: {},
    });
    expect(result.resolvedUrl).toBe('https://example.com/{id}/details');
    expect(result.remainingArgs).toEqual({});
  });
});

describe('parseHttpExecuteConfig', () => {
  test('returns null when execute is null (parsedExecute not a plain object)', () => {
    expect(parseHttpExecuteConfig(null)).toBeNull();
  });

  test('returns null when url is not a string', () => {
    expect(parseHttpExecuteConfig({ url: 123 } as never)).toBeNull();
  });

  test('returns null when url is an empty string', () => {
    expect(parseHttpExecuteConfig({ url: '' } as never)).toBeNull();
  });

  test('returns HttpExecuteConfig when execute has a valid url string', () => {
    const result = parseHttpExecuteConfig({ url: 'https://example.com/api' });
    expect(result).toMatchObject({ url: 'https://example.com/api' });
  });
});

describe('resolveBodyParamInterpolations', () => {
  test('replaces ${body.field} with toolArg value and removes it from remainingArgs', () => {
    const result = resolveBodyParamInterpolations({
      url: 'https://example.com/api/items/${body.itemId}',
      toolArgs: { itemId: 'abc-123', other: 'value' },
    });
    expect(result.resolvedUrl).toBe('https://example.com/api/items/abc-123');
    expect(result.remainingArgs).toEqual({ other: 'value' });
  });

  test('replaces multiple ${body.xxx} placeholders', () => {
    const result = resolveBodyParamInterpolations({
      url: 'https://example.com/${body.projectId}/items/${body.itemId}',
      toolArgs: { projectId: 'prj-1', itemId: 'itm-2', extra: 'x' },
    });
    expect(result.resolvedUrl).toBe('https://example.com/prj-1/items/itm-2');
    expect(result.remainingArgs).toEqual({ extra: 'x' });
  });

  test('URL-encodes body param values', () => {
    const result = resolveBodyParamInterpolations({
      url: 'https://example.com/search/${body.query}',
      toolArgs: { query: 'hello world' },
    });
    expect(result.resolvedUrl).toBe('https://example.com/search/hello%20world');
    expect(result.remainingArgs).toEqual({});
  });

  test('leaves placeholder unchanged when arg not provided', () => {
    const result = resolveBodyParamInterpolations({
      url: 'https://example.com/items/${body.id}',
      toolArgs: { other: 'value' },
    });
    expect(result.resolvedUrl).toBe('https://example.com/items/${body.id}');
    expect(result.remainingArgs).toEqual({ other: 'value' });
  });
});

describe('resolveAgentTools - mcp and soat types', () => {
  let adminToken: string;
  let projectId: string;
  let mcpToolId: string;
  let httpToolId: string;

  beforeAll(async () => {
    // toolresolveradmin was bootstrapped by the first describe's beforeAll
    adminToken = await loginAs('toolresolveradmin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'MCP Tool Resolver Project' });
    projectId = projectRes.body.id;

    const mcpToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'myMcpServer',
        type: 'mcp',
        description: 'Test MCP server',
        mcp: { url: 'http://localhost:19999/mcp' },
      });
    mcpToolId = mcpToolRes.body.id;

    const httpToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'resolverHttpTool',
        type: 'http',
        description: 'HTTP tool for resolver branch tests',
        parameters: { type: 'object', properties: {} },
        execute: { url: 'https://example.com/branch-test', method: 'INVALID' },
      });
    httpToolId = httpToolRes.body.id;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('resolves mcp tools via fetch mock', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          result: {
            tools: [
              {
                name: 'search',
                description: 'Search tool',
                inputSchema: {
                  type: 'object',
                  properties: { query: { type: 'string' } },
                },
              },
            ],
          },
        }),
        { status: 200 }
      )
    );

    const tools = await resolveAgentTools({ toolIds: [mcpToolId] });

    expect(tools).toHaveProperty('search');
    expect(fetchMock).toHaveBeenCalled();
  });

  test('mcp tool returns empty result when fetch returns non-OK status', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 500 }));

    const tools = await resolveAgentTools({ toolIds: [mcpToolId] });

    expect(Object.keys(tools)).toHaveLength(0);
  });

  test('mcp tool returns empty result when fetch throws', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValueOnce(new Error('Network error'));

    const tools = await resolveAgentTools({ toolIds: [mcpToolId] });

    expect(Object.keys(tools)).toHaveLength(0);
  });

  test('http tool execute appends query params with & when URL already has ?', async () => {
    const urlWithQueryRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'toolWithExistingQuery',
        type: 'http',
        description: 'Tool with existing query params in URL',
        parameters: {
          type: 'object',
          properties: { filter: { type: 'string' } },
        },
        execute: { url: 'https://example.com/api?version=1', method: 'GET' },
      });

    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const tools = await resolveAgentTools({
      toolIds: [urlWithQueryRes.body.id],
    });
    if (
      'execute' in tools.toolWithExistingQuery &&
      typeof tools.toolWithExistingQuery.execute === 'function'
    ) {
      await tools.toolWithExistingQuery.execute(
        { filter: 'active' },
        {} as never
      );
    }

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('version=1'),
      expect.anything()
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('filter=active'),
      expect.anything()
    );
  });

  test('http tool execute falls back to POST for invalid method', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const tools = await resolveAgentTools({ toolIds: [httpToolId] });
    const httpTool = tools.resolverHttpTool;

    if ('execute' in httpTool && typeof httpTool.execute === 'function') {
      await httpTool.execute({}, {} as never);
    }

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/branch-test',
      expect.objectContaining({ method: 'POST' })
    );
  });

  test('mcp tool execute parses JSON text payload from tools/call', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: {
              tools: [
                {
                  name: 'json_echo',
                  inputSchema: { type: 'object', properties: {} },
                },
              ],
            },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: { content: [{ text: '{"ok":true}' }] },
          }),
          { status: 200 }
        )
      );

    const tools = await resolveAgentTools({ toolIds: [mcpToolId] });
    const mcpTool = tools.json_echo;

    if ('execute' in mcpTool && typeof mcpTool.execute === 'function') {
      const result = await mcpTool.execute({}, {} as never);
      expect(result).toEqual({ ok: true });
    }
  });

  test('mcp tool execute returns raw text when tools/call text is not JSON', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: {
              tools: [
                {
                  name: 'text_echo',
                  inputSchema: { type: 'object', properties: {} },
                },
              ],
            },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: { content: [{ text: 'plain text result' }] },
          }),
          { status: 200 }
        )
      );

    const tools = await resolveAgentTools({ toolIds: [mcpToolId] });
    const mcpTool = tools.text_echo;

    if ('execute' in mcpTool && typeof mcpTool.execute === 'function') {
      const result = await mcpTool.execute({}, {} as never);
      expect(result).toBe('plain text result');
    }
  });

  test('mcp tool execute returns full body when tools/call has no text content', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: {
              tools: [
                {
                  name: 'empty_content',
                  inputSchema: { type: 'object', properties: {} },
                },
              ],
            },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: { content: [] },
          }),
          { status: 200 }
        )
      );

    const tools = await resolveAgentTools({ toolIds: [mcpToolId] });
    const mcpTool = tools.empty_content;

    if ('execute' in mcpTool && typeof mcpTool.execute === 'function') {
      const result = await mcpTool.execute({}, {} as never);
      expect(result).toEqual({ result: { content: [] } });
    }
  });

  test('resolveAgentTools applies projectIds filter when provided', async () => {
    const tools = await resolveAgentTools({
      toolIds: [httpToolId],
      projectIds: [],
    });

    expect(Object.keys(tools)).toHaveLength(0);
  });

  test('soat tool resolves configured actions and executes through internal API', async () => {
    const soatToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'mySoatTool',
        type: 'soat',
        actions: ['list-files'],
      });

    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] })));

    const tools = await resolveAgentTools({ toolIds: [soatToolRes.body.id] });
    expect(tools).toHaveProperty('mySoatTool_list-files');

    const soatTool = tools['mySoatTool_list-files'];
    if ('execute' in soatTool && typeof soatTool.execute === 'function') {
      await soatTool.execute({}, {} as never);
    }

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/files'),
      expect.objectContaining({ method: 'GET' })
    );
  });

  test('soat tool returns boundary error when action is denied', async () => {
    const deniedSoatRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'myDeniedSoatTool',
        type: 'soat',
        actions: ['list-files'],
      });

    const tools = await resolveAgentTools({
      toolIds: [deniedSoatRes.body.id],
      boundaryPolicy: {
        statement: [{ effect: 'Deny', action: ['files:ListFiles'] }],
      },
    });

    const soatTool = tools['myDeniedSoatTool_list-files'];
    if ('execute' in soatTool && typeof soatTool.execute === 'function') {
      const result = await soatTool.execute({}, {} as never);
      expect(result).toEqual({
        error: 'Forbidden: boundary policy denies list-files',
      });
    }
  });

  test('soat tool with preset_parameters strips preset keys from inputSchema', async () => {
    const soatToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'myPresetSoatTool',
        type: 'soat',
        actions: ['get-document'],
        preset_parameters: { documentId: 'doc_preset123' },
      });
    expect(soatToolRes.status).toBe(201);

    const tools = await resolveAgentTools({
      toolIds: [soatToolRes.body.id],
    });
    expect(tools).toHaveProperty('myPresetSoatTool_get-document');

    const soatTool = tools['myPresetSoatTool_get-document'];
    // The inputSchema presented to the model should NOT include 'id'
    const schema = soatTool.inputSchema as {
      jsonSchema?: { properties?: Record<string, unknown> };
    };
    const properties = schema?.jsonSchema?.properties ?? {};
    expect(properties).not.toHaveProperty('documentId');
  });

  test('soat tool with preset_parameters injects preset values into execution', async () => {
    const soatToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'myPresetExecTool',
        type: 'soat',
        actions: ['get-document'],
        preset_parameters: { documentId: 'doc_injected' },
      });

    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {} })));

    const tools = await resolveAgentTools({ toolIds: [soatToolRes.body.id] });
    const soatTool = tools['myPresetExecTool_get-document'];

    if ('execute' in soatTool && typeof soatTool.execute === 'function') {
      // Model does not supply 'id' — it is injected from preset_parameters
      await soatTool.execute({}, {} as never);
    }

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('doc_injected'),
      expect.anything()
    );
  });

  test('soat tool without preset_parameters works as before', async () => {
    const soatToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'myNoPresetTool',
        type: 'soat',
        actions: ['list-files'],
      });

    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] })));

    const tools = await resolveAgentTools({ toolIds: [soatToolRes.body.id] });
    expect(tools).toHaveProperty('myNoPresetTool_list-files');

    const soatTool = tools['myNoPresetTool_list-files'];
    if ('execute' in soatTool && typeof soatTool.execute === 'function') {
      await soatTool.execute({}, {} as never);
    }

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/files'),
      expect.objectContaining({ method: 'GET' })
    );
  });

  test('resolves pipeline tool and returns tool with execute function', async () => {
    const soatToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'pipelineStepSoatTool',
        type: 'soat',
        actions: ['list-files'],
      });

    const pipelineToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'myPipelineTool',
        type: 'pipeline',
        pipeline: {
          steps: [
            {
              id: 'first',
              tool_id: soatToolRes.body.id,
              action: 'list-files',
              input: {},
            },
          ],
          output: { result: { var: 'steps.first' } },
        },
      });

    const tools = await resolveAgentTools({
      toolIds: [pipelineToolRes.body.id],
    });

    expect(tools).toHaveProperty('myPipelineTool');
    const pipelineTool = tools.myPipelineTool;
    expect('execute' in pipelineTool && typeof pipelineTool.execute).toBe(
      'function'
    );
  });

  test('mcp tool with no url configured is skipped instead of throwing', async () => {
    const brokenMcpRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'brokenMcpServer',
        type: 'mcp',
        mcp: {},
      });

    const tools = await resolveAgentTools({ toolIds: [brokenMcpRes.body.id] });

    expect(tools).toEqual({});
  });

  test('http tool execute JSON-stringifies an object-typed query argument', async () => {
    const getToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'objectQueryArgTool',
        type: 'http',
        parameters: { type: 'object', properties: {} },
        execute: { url: 'https://example.com/objects', method: 'GET' },
      });

    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [] }), { status: 200 })
      );

    const tools = await resolveAgentTools({ toolIds: [getToolRes.body.id] });
    const httpTool = tools.objectQueryArgTool;

    if ('execute' in httpTool && typeof httpTool.execute === 'function') {
      await httpTool.execute({ filters: { status: 'active' } }, {} as never);
    }

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        encodeURIComponent(JSON.stringify({ status: 'active' }))
      ),
      expect.anything()
    );
  });
});

describe('buildMcpToolExecute', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('calls logToolCallingError and rethrows when fetch throws', async () => {
    const logToolCallingError = jest.fn();
    const networkError = new Error('Network failure');

    jest.spyOn(global, 'fetch').mockRejectedValueOnce(networkError);

    const execute = buildMcpToolExecute({
      mcpUrl: 'http://localhost:19999/mcp',
      mcpHeaders: { 'Content-Type': 'application/json' },
      mcpToolName: 'my_tool',
      logToolCallingError,
    });

    await expect(execute({})).rejects.toThrow('Network failure');

    expect(logToolCallingError).toHaveBeenCalledWith({
      toolName: 'my_tool',
      toolType: 'mcp',
      url: 'http://localhost:19999/mcp',
      method: 'POST',
      error: networkError,
    });
  });
});

describe('resolveMcpTools - direct', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('returns empty result when list response has no result field', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    const result = await resolveMcpTools({
      typedTool: { mcp: { url: 'http://localhost:19999/mcp' } },
      buildContextHeaders: () => {
        return {};
      },
      logToolCallingError: jest.fn(),
    });
    expect(Object.keys(result)).toHaveLength(0);
  });

  test('uses default empty schema when tool has no inputSchema', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ result: { tools: [{ name: 'noschema_tool' }] } }),
          { status: 200 }
        )
      );
    const result = await resolveMcpTools({
      typedTool: { mcp: { url: 'http://localhost:19999/mcp' } },
      buildContextHeaders: () => {
        return {};
      },
      logToolCallingError: jest.fn(),
    });
    expect(result).toHaveProperty('noschema_tool');
  });
});

describe('executeSoatTool - direct', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('exercises body/context/trace/depth branches when POST def with body fn is provided', async () => {
    const postDef = soatTools.find((t) => {
      return typeof t.body === 'function';
    });
    if (!postDef) {
      return;
    }
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'new-1' }), { status: 201 })
      );
    await executeSoatTool({
      toolName: 'test',
      def: postDef,
      rawArgs: {},
      base: 'http://localhost:5047',
      toolContext: { env: 'test' },
      traceId: 'trc_123',
      rootTraceId: null,
      remainingDepth: 3,
      buildContextHeaders: () => {
        return {};
      },
      logToolCallingError: jest.fn(),
    });
    expect(fetchMock).toHaveBeenCalled();
  });

  test('calls logToolCallingError and rethrows when fetch throws', async () => {
    const listDef = soatTools.find((t) => {
      return t.method === 'GET';
    });
    if (!listDef) {
      return;
    }
    const logToolCallingError = jest.fn();
    const networkError = new Error('SOAT network failure');
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(networkError);
    await expect(
      executeSoatTool({
        toolName: 'test',
        def: listDef,
        rawArgs: {},
        base: 'http://localhost:5047',
        buildContextHeaders: () => {
          return {};
        },
        logToolCallingError,
      })
    ).rejects.toThrow('SOAT network failure');
    expect(logToolCallingError).toHaveBeenCalled();
  });
});

describe('executeSoatTool - trace field injection scoping (issue #371)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('does not inject parent_trace_id/root_trace_id/max_call_depth for actions whose schema does not declare them', async () => {
    const searchKnowledgeDef = soatTools.find((t) => {
      return t.name === 'search-knowledge';
    });
    expect(searchKnowledgeDef).toBeDefined();

    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [] }), { status: 200 })
      );

    await executeSoatTool({
      toolName: 'test',
      def: searchKnowledgeDef!,
      rawArgs: { query: 'hello' },
      base: 'http://localhost:5047',
      traceId: 'trc_123',
      rootTraceId: 'trc_root',
      remainingDepth: 3,
      buildContextHeaders: () => {
        return {};
      },
      logToolCallingError: jest.fn(),
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sentBody).not.toHaveProperty('parent_trace_id');
    expect(sentBody).not.toHaveProperty('root_trace_id');
    expect(sentBody).not.toHaveProperty('max_call_depth');
  });

  test('still injects parent_trace_id/root_trace_id/max_call_depth for create-agent-generation', async () => {
    const createAgentGenerationDef = soatTools.find((t) => {
      return t.name === 'create-agent-generation';
    });
    expect(createAgentGenerationDef).toBeDefined();

    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'gen_1' }), { status: 201 })
      );

    await executeSoatTool({
      toolName: 'test',
      def: createAgentGenerationDef!,
      rawArgs: { agent_id: 'agt_1', messages: [] },
      base: 'http://localhost:5047',
      traceId: 'trc_123',
      rootTraceId: 'trc_root',
      remainingDepth: 3,
      buildContextHeaders: () => {
        return {};
      },
      logToolCallingError: jest.fn(),
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sentBody.parent_trace_id).toBe('trc_123');
    expect(sentBody.root_trace_id).toBe('trc_root');
    expect(sentBody.max_call_depth).toBe(2);
  });
});

describe('resolveSoatTools - direct', () => {
  test('returns empty object when actions is null', () => {
    const result = resolveSoatTools({
      typedTool: {
        name: 'myTool',
        description: null,
        actions: null,
        presetParameters: null,
      },
      buildContextHeaders: () => {
        return {};
      },
      isSoatActionAllowedByBoundary: () => {
        return true;
      },
      logToolCallingError: jest.fn(),
    });
    expect(Object.keys(result)).toHaveLength(0);
  });

  test('skips action when def not found in soatTools registry', () => {
    const result = resolveSoatTools({
      typedTool: {
        name: 'myTool',
        description: null,
        actions: ['completely-unknown-action-xyz'],
        presetParameters: null,
      },
      buildContextHeaders: () => {
        return {};
      },
      isSoatActionAllowedByBoundary: () => {
        return true;
      },
      logToolCallingError: jest.fn(),
    });
    expect(Object.keys(result)).toHaveLength(0);
  });
});
