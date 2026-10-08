import createDebug from 'debug';

import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';

// What an `http` tool puts on the wire, read off a live target: the request a
// tool sends is the same whether an agent turn or a direct call dispatches it,
// so the direct call is the narrow entry point for the request's shape.

describe('POST /api/v1/tools/{tool_id}/call — http request shape', () => {
  let turn: AgentToolTurn;

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'httpshape' });
  });

  beforeEach(() => {
    turn.target.reset();
  });

  afterAll(async () => {
    await turn.close();
  });

  /** An http tool whose `execute` targets `path` (plus `query`) on the target. */
  const httpTool = async (args: {
    method?: string;
    query?: string;
    execute?: Record<string, unknown>;
    tool?: Record<string, unknown>;
  }) => {
    const name = turn.unique('http');
    const tool = await turn.createTool({
      name,
      parameters: { type: 'object', properties: {} },
      execute: {
        url: `${turn.target.baseUrl}/${name}${args.query ?? ''}`,
        method: args.method ?? 'POST',
        ...args.execute,
      },
      ...args.tool,
    });
    return { ...tool, path: `/${name}` };
  };

  const call = (
    toolId: string,
    body: { input?: Record<string, unknown>; tool_context?: object } = {}
  ) => {
    return turn.api().post(`/api/v1/tools/${toolId}/call`).send(body);
  };

  describe('query string and body', () => {
    test('a GET sends its input as a query string, JSON-encoding objects and dropping nulls', async () => {
      const tool = await httpTool({ method: 'GET' });

      const res = await call(tool.id, {
        input: { filter: 'active', where: { status: 'open' }, skip: null },
      });

      expect(res.status).toBe(200);
      const [request] = turn.target.requestsAt(tool.path);
      expect(request.method).toBe('GET');
      const query = new URL(request.url, 'http://x').searchParams;
      expect(Object.fromEntries(query)).toEqual({
        filter: 'active',
        where: JSON.stringify({ status: 'open' }),
      });
    });

    test('a GET on a URL that already has a query string appends to it', async () => {
      const tool = await httpTool({ method: 'GET', query: '?version=1' });

      expect(
        (await call(tool.id, { input: { filter: 'active' } })).status
      ).toBe(200);

      expect(turn.target.requestsAt(tool.path)[0].url).toBe(
        `${tool.path}?version=1&filter=active`
      );
    });

    test('a DELETE carries its input as a JSON body', async () => {
      const tool = await httpTool({
        method: 'DELETE',
        execute: { headers: { 'Content-Type': 'application/json' } },
      });

      expect((await call(tool.id, { input: { item_id: 'abc' } })).status).toBe(
        200
      );

      const [request] = turn.target.requestsAt(tool.path);
      expect(request.method).toBe('DELETE');
      expect(request.headers['content-type']).toBe('application/json');
      expect(request.body).toEqual({ item_id: 'abc' });
    });

    test('an unknown method is sent as POST', async () => {
      const tool = await httpTool({ method: 'INVALID' });

      expect((await call(tool.id)).status).toBe(200);

      expect(turn.target.requestsAt(tool.path)[0].method).toBe('POST');
    });

    test('body_mode multipart sends form fields and a decoded file part', async () => {
      const tool = await httpTool({
        execute: {
          body_mode: 'multipart',
          // Dropped, so fetch can set the multipart boundary itself.
          headers: { 'Content-Type': 'application/json' },
        },
      });

      const res = await call(tool.id, {
        input: {
          model: 'grok-stt',
          options: { language: 'en' },
          skip: null,
          file: {
            dataBase64: Buffer.from('AUDIO-BYTES-123').toString('base64'),
            contentType: 'text/plain',
          },
          named: {
            data_base64: Buffer.from('NAMED').toString('base64'),
            filename: 'clip.wav',
          },
        },
      });

      expect(res.status).toBe(200);
      const [request] = turn.target.requestsAt(tool.path);
      expect(request.headers['content-type']).toMatch(
        /^multipart\/form-data; boundary=/
      );
      expect(request.raw).toContain('name="model"');
      expect(request.raw).toContain('grok-stt');
      expect(request.raw).toContain('{"language":"en"}');
      expect(request.raw).not.toContain('name="skip"');
      expect(request.raw).toContain('name="file"; filename="file"');
      expect(request.raw).toContain('Content-Type: text/plain');
      expect(request.raw).toContain('AUDIO-BYTES-123');
      expect(request.raw).toContain('name="named"; filename="clip.wav"');
      expect(request.raw).toContain('NAMED');
    });
  });

  describe('{{context:...}} header templates', () => {
    test('several tokens resolve, including two in one header value', async () => {
      const tool = await httpTool({
        execute: {
          headers: {
            Authorization: 'Bearer {{context:ocaToken}}',
            'X-Pair': '{{context:tenant}}/{{context:ocaToken}}',
          },
        },
      });

      const res = await call(tool.id, {
        tool_context: { ocaToken: 'tok_abc', tenant: 'acme' },
      });

      expect(res.status).toBe(200);
      const { headers } = turn.target.requestsAt(tool.path)[0];
      expect(headers['authorization']).toBe('Bearer tok_abc');
      expect(headers['x-pair']).toBe('acme/tok_abc');
    });

    test('an empty-string context value is a value, not a missing key', async () => {
      const tool = await httpTool({
        execute: { headers: { 'X-Tenant': '{{context:tenant}}' } },
      });

      const res = await call(tool.id, { tool_context: { tenant: '' } });

      expect(res.status).toBe(200);
      expect(turn.target.requestsAt(tool.path)[0].headers['x-tenant']).toBe('');
    });

    // Both token kinds resolve in one pass, so a substituted value is data and
    // never template source: a caller cannot read a project secret back out
    // through a context value, nor a secret pull in caller context.
    test('a context value shaped like a secret token is sent verbatim', async () => {
      const secret = await turn
        .api()
        .post('/api/v1/secrets')
        .send({
          project_id: turn.projectId,
          name: turn.unique('ctx-injection'),
          value: 'SUPER-SECRET-VALUE',
        });
      expect(secret.status).toBe(201);
      const tool = await httpTool({
        execute: { headers: { 'X-Tenant': '{{context:tenant}}' } },
      });

      const res = await call(tool.id, {
        tool_context: { tenant: `{{secret:${secret.body.id}}}` },
      });

      expect(res.status).toBe(200);
      expect(turn.target.requestsAt(tool.path)[0].headers['x-tenant']).toBe(
        `{{secret:${secret.body.id}}}`
      );
    });

    test('a secret value shaped like a context token is sent verbatim', async () => {
      const secret = await turn
        .api()
        .post('/api/v1/secrets')
        .send({
          project_id: turn.projectId,
          name: turn.unique('ctx-lookalike'),
          value: '{{context:ocaToken}}',
        });
      expect(secret.status).toBe(201);
      const tool = await httpTool({
        execute: {
          headers: {
            'X-Both': `{{secret:${secret.body.id}}}|{{context:tenant}}`,
          },
        },
      });

      const res = await call(tool.id, {
        tool_context: { ocaToken: 'tok_abc', tenant: 'acme' },
      });

      expect(res.status).toBe(200);
      expect(turn.target.requestsAt(tool.path)[0].headers['x-both']).toBe(
        '{{context:ocaToken}}|acme'
      );
    });
  });

  describe('context_keys', () => {
    test('an empty allowlist forwards no caller key', async () => {
      const tool = await httpTool({
        execute: { headers: { 'X-Static': 'v' } },
        tool: { context_keys: [] },
      });

      const res = await call(tool.id, {
        tool_context: { ocaToken: 'tok_abc', tenant: 'acme' },
      });

      expect(res.status).toBe(200);
      const { headers } = turn.target.requestsAt(tool.path)[0];
      expect(headers['x-soat-context-tenant']).toBeUndefined();
      expect(headers['x-soat-context-ocatoken']).toBeUndefined();
      expect(headers['x-static']).toBe('v');
    });

    // The template governs substitution into a header the tool declared; the
    // allowlist governs only which keys are forwarded as prefixed headers.
    test('a template still substitutes a key the allowlist omits', async () => {
      const tool = await httpTool({
        execute: { headers: { Authorization: 'Bearer {{context:ocaToken}}' } },
        tool: { context_keys: ['tenant'] },
      });

      const res = await call(tool.id, {
        tool_context: { ocaToken: 'tok_abc', tenant: 'acme' },
      });

      expect(res.status).toBe(200);
      const { headers } = turn.target.requestsAt(tool.path)[0];
      expect(headers['authorization']).toBe('Bearer tok_abc');
      expect(headers['x-soat-context-ocatoken']).toBeUndefined();
      expect(headers['x-soat-context-tenant']).toBe('acme');
    });
  });

  describe('responses', () => {
    test('a 2xx answer that is not JSON is returned as its text', async () => {
      const tool = await httpTool({});
      turn.target.reply(tool.path, {
        raw: '<html><body>hello</body></html>',
        contentType: 'text/html',
      });

      const res = await call(tool.id);

      expect(res.status).toBe(200);
      expect(res.text).toContain('<html><body>hello</body></html>');
    });
  });

  describe('execute.response_mode base64', () => {
    // Every byte value, so a lossy text decode cannot pass.
    const BYTES = Buffer.from(
      Array.from({ length: 256 }, (_, index) => {
        return index;
      })
    );

    afterEach(() => {
      delete process.env.TOOL_RESPONSE_MAX_BYTES;
    });

    const binaryTool = () => {
      return httpTool({
        method: 'GET',
        execute: { response_mode: 'base64' },
      });
    };

    test('returns the body as a file object, byte for byte', async () => {
      const tool = await binaryTool();
      turn.target.reply(tool.path, {
        raw: BYTES,
        contentType: 'audio/ogg; codecs=opus',
        headers: {
          'Content-Disposition': 'attachment; filename="voice note.ogg"',
        },
      });

      const res = await call(tool.id);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        content_type: 'audio/ogg',
        filename: 'voice note.ogg',
        data_base64: BYTES.toString('base64'),
      });
    });

    test('reads an RFC 5987 filename over the plain one', async () => {
      const tool = await binaryTool();
      turn.target.reply(tool.path, {
        raw: BYTES,
        contentType: 'application/pdf',
        headers: {
          'Content-Disposition':
            'attachment; filename="fallback.pdf"; filename*=UTF-8\'\'recibo%20n%C2%BA1.pdf',
        },
      });

      const res = await call(tool.id);

      expect(res.body.filename).toBe('recibo nº1.pdf');
    });

    test('omits filename when the target names none', async () => {
      const tool = await binaryTool();
      turn.target.reply(tool.path, { raw: BYTES, contentType: 'image/jpeg' });

      const res = await call(tool.id);

      expect(res.status).toBe(200);
      expect(res.body.content_type).toBe('image/jpeg');
      expect(res.body).not.toHaveProperty('filename');
    });

    test('a body over TOOL_RESPONSE_MAX_BYTES is 502 TOOL_RESPONSE_TOO_LARGE', async () => {
      process.env.TOOL_RESPONSE_MAX_BYTES = '255';
      const tool = await binaryTool();
      turn.target.reply(tool.path, { raw: BYTES, contentType: 'image/png' });

      const res = await call(tool.id);

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('TOOL_RESPONSE_TOO_LARGE');
      expect(res.body.error.meta.max_bytes).toBe(255);
    });

    test('a non-2xx answer is still TOOL_HTTP_ERROR with its text', async () => {
      const tool = await binaryTool();
      turn.target.reply(tool.path, { status: 404, raw: 'gone' });

      const res = await call(tool.id);

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('TOOL_HTTP_ERROR');
      expect(res.body.error.meta.tool_response_body).toBe('gone');
    });

    test('a pipeline step hands the file to a multipart upload', async () => {
      const download = await binaryTool();
      turn.target.reply(download.path, {
        raw: Buffer.from('PNG-BYTES'),
        contentType: 'image/png',
        headers: { 'Content-Disposition': 'inline; filename="a.png"' },
      });
      const upload = await httpTool({ execute: { body_mode: 'multipart' } });
      const pipeline = await turn.createTool({
        name: turn.unique('pipeline'),
        type: 'pipeline',
        parameters: { type: 'object', properties: {} },
        execute: undefined,
        pipeline: {
          steps: [
            { id: 'download', tool_id: download.id, input: {} },
            {
              id: 'upload',
              tool_id: upload.id,
              input: { file: { var: 'steps.download' } },
            },
          ],
        },
      });

      expect((await call(pipeline.id)).status).toBe(200);

      const [request] = turn.target.requestsAt(upload.path);
      expect(request.raw).toContain('name="file"; filename="a.png"');
      expect(request.raw).toContain('Content-Type: image/png');
      expect(request.raw).toContain('PNG-BYTES');
    });

    test('a generation transcript keeps the file object without its bytes', async () => {
      const name = turn.unique('media');
      const tool = await turn.createTool({
        name,
        parameters: { type: 'object', properties: {} },
        execute: {
          url: `${turn.target.baseUrl}/${name}`,
          method: 'GET',
          response_mode: 'base64',
        },
      });
      turn.target.reply(`/${tool.name}`, {
        raw: BYTES,
        contentType: 'image/png',
      });
      const agentId = await turn.createAgent({
        tool_bindings: [{ tool_id: tool.id }],
      });

      const generation = await turn.startTurn({
        agentId,
        calls: [{ name: tool.name, args: {} }],
      });

      const transcript = await turn
        .api()
        .get(`/api/v1/generations/${generation.id}/transcript`);
      expect(transcript.status).toBe(200);
      expect(transcript.body.steps[0].tool_results[0].result).toEqual({
        content_type: 'image/png',
        data_base64: '[omitted: 256 bytes]',
      });
    });
  });

  describe('SOAT_ERROR_LOGS_ENABLED', () => {
    let previousNamespaces: string;
    let sink: jest.SpyInstance;

    beforeEach(() => {
      previousNamespaces = createDebug.disable();
      createDebug.enable('soat:toolResolver');
      sink = jest.spyOn(createDebug, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      sink.mockRestore();
      createDebug.disable();
      createDebug.enable(previousNamespaces);
      delete process.env.SOAT_ERROR_LOGS_ENABLED;
    });

    const failureLogged = (): boolean => {
      return sink.mock.calls.some((args: unknown[]) => {
        return String(args[0]).includes('logToolCallError');
      });
    };

    test('a failed call is logged by default', async () => {
      const tool = await httpTool({});
      turn.target.reply(tool.path, { status: 500, raw: 'Boom' });

      expect((await call(tool.id)).status).toBe(502);
      expect(failureLogged()).toBe(true);
    });

    test('a failed call is not logged when the toggle is off', async () => {
      process.env.SOAT_ERROR_LOGS_ENABLED = 'off';
      const tool = await httpTool({});
      turn.target.reply(tool.path, { status: 500, raw: 'Boom' });

      expect((await call(tool.id)).status).toBe(502);
      expect(failureLogged()).toBe(false);
    });
  });
});
