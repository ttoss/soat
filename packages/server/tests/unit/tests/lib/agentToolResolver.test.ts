import type { IncomingHttpHeaders } from 'node:http';
import { createServer } from 'node:http';

import { db } from 'src/db';
import {
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
import { buildSoatRequestBody } from 'src/lib/agentToolResolverSoatBody';
import { withCallTimeout } from 'src/lib/inProcessApi';
import { soatTools } from 'src/lib/soatTools';
import {
  assertValidToolContextKeys,
  buildContextHeaders,
} from 'src/lib/toolContext';

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

  // The wire is the real contract. `buildContextHeaders` is unit-tested above,
  // but only a live request proves what a tool endpoint actually receives —
  // and it makes the docs' central claim executable: Node lowercases incoming
  // header names, so the casing a caller chose is NOT what they read back.
  // A tool endpoint must match these case-insensitively.
  test('http tool forwards tool_context to the endpoint as X-Soat-Context-<key>, which arrives lowercased', async () => {
    let received: IncomingHttpHeaders | null = null;
    const server = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        received = req.headers;
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

    const contextToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'myContextHttpTool',
        type: 'http',
        description: 'Test context-header HTTP tool',
        parameters: { type: 'object', properties: {} },
        execute: { url: `http://127.0.0.1:${port}/v1/do`, method: 'POST' },
      });

    const tools = await resolveAgentTools({
      toolIds: [contextToolRes.body.id],
      toolContext: {
        sessionId: 'ses_01',
        actor_external_id: 'snake',
        TenantId: 'pascal',
      },
    });
    const contextTool = tools.myContextHttpTool;

    if ('execute' in contextTool && typeof contextTool.execute === 'function') {
      await contextTool.execute({}, {} as never);
    }

    await new Promise<void>((resolve) => {
      server.close(() => {
        return resolve();
      });
    });

    const headers = received as IncomingHttpHeaders | null;
    expect(headers).not.toBeNull();

    // Every key reached the wire under `X-Soat-Context-` + itself, with its
    // own spelling preserved through the prefix — and Node hands it back
    // lowercased regardless of the case the caller chose.
    expect(headers?.['x-soat-context-sessionid']).toBe('ses_01');
    expect(headers?.['x-soat-context-actor_external_id']).toBe('snake');
    expect(headers?.['x-soat-context-tenantid']).toBe('pascal');

    // Separators are part of the key and are NOT collapsed: the snake_case key
    // did not become `actorexternalid`.
    expect(headers?.['x-soat-context-actorexternalid']).toBeUndefined();
  });

  // #945 item 2: `{{context:<key>}}` in a tool's headers. `tool_context` alone
  // can only produce `X-Soat-Context-*` headers — a security invariant that must
  // not be relaxed — so the tool declares where its credential goes, and the
  // caller only supplies the value.
  describe('{{context:...}} header interpolation', () => {
    // One local server per test, since each asserts on what one request carried.
    const startHeaderCaptureServer = async () => {
      const requests: IncomingHttpHeaders[] = [];
      const server = createServer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => {
          requests.push(req.headers);
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
      return {
        requests,
        port,
        close: async () => {
          await new Promise<void>((resolve) => {
            server.close(() => {
              return resolve();
            });
          });
        },
      };
    };

    const createHeaderTool = async (args: {
      name: string;
      port: number | undefined;
      headers: Record<string, string>;
      contextKeys?: string[];
    }) => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: args.name,
          type: 'http',
          parameters: { type: 'object', properties: {} },
          execute: {
            url: `http://127.0.0.1:${args.port}/v1/do`,
            method: 'POST',
            headers: args.headers,
          },
          ...(args.contextKeys ? { context_keys: args.contextKeys } : {}),
        });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };

    const callTool = async (args: {
      toolId: string;
      toolName: string;
      toolContext?: Record<string, string>;
    }) => {
      const tools = await resolveAgentTools({
        toolIds: [args.toolId],
        toolContext: args.toolContext,
      });
      const resolved = tools[args.toolName];
      if (!('execute' in resolved) || typeof resolved.execute !== 'function') {
        throw new Error(`tool ${args.toolName} resolved without an execute`);
      }
      return resolved.execute({}, {} as never);
    };

    test('resolves the token into the real header the tool declared', async () => {
      const srv = await startHeaderCaptureServer();
      try {
        const toolId = await createHeaderTool({
          name: 'ctxAuthTool',
          port: srv.port,
          headers: { Authorization: 'Bearer {{context:ocaToken}}' },
        });

        await callTool({
          toolId,
          toolName: 'ctxAuthTool',
          toolContext: { ocaToken: 'tok_abc' },
        });

        expect(srv.requests).toHaveLength(1);
        const headers = srv.requests[0]!;
        // The whole point: a real `Authorization` header, not an
        // `X-Soat-Context-*` one.
        expect(headers['authorization']).toBe('Bearer tok_abc');
        // The prefixed header is still sent too — the two mechanisms coexist.
        expect(headers['x-soat-context-ocatoken']).toBe('tok_abc');
      } finally {
        await srv.close();
      }
    });

    test('resolves several tokens, including two in one header value', async () => {
      const srv = await startHeaderCaptureServer();
      try {
        const toolId = await createHeaderTool({
          name: 'ctxMultiTool',
          port: srv.port,
          headers: {
            Authorization: 'Bearer {{context:ocaToken}}',
            'X-Pair': '{{context:tenant}}/{{context:ocaToken}}',
          },
        });

        await callTool({
          toolId,
          toolName: 'ctxMultiTool',
          toolContext: { ocaToken: 'tok_abc', tenant: 'acme' },
        });

        const headers = srv.requests[0]!;
        expect(headers['authorization']).toBe('Bearer tok_abc');
        expect(headers['x-pair']).toBe('acme/tok_abc');
      } finally {
        await srv.close();
      }
    });

    test('fails the tool call when the key is missing from a supplied tool_context, sending no request', async () => {
      const srv = await startHeaderCaptureServer();
      try {
        const toolId = await createHeaderTool({
          name: 'ctxMissingKeyTool',
          port: srv.port,
          headers: { Authorization: 'Bearer {{context:ocaToken}}' },
        });

        await expect(
          callTool({
            toolId,
            toolName: 'ctxMissingKeyTool',
            toolContext: { tenant: 'acme' },
          })
        ).rejects.toThrow(/ocaToken/);

        // An empty `Authorization: Bearer ` is worse than a failed call, so the
        // request must not have gone out at all.
        expect(srv.requests).toHaveLength(0);
      } finally {
        await srv.close();
      }
    });

    test('fails the tool call when the generation carries no tool_context at all', async () => {
      const srv = await startHeaderCaptureServer();
      try {
        const toolId = await createHeaderTool({
          name: 'ctxNoContextTool',
          port: srv.port,
          headers: { Authorization: 'Bearer {{context:ocaToken}}' },
        });

        await expect(
          callTool({ toolId, toolName: 'ctxNoContextTool' })
        ).rejects.toThrow(/ocaToken/);
        expect(srv.requests).toHaveLength(0);
      } finally {
        await srv.close();
      }
    });

    test('an empty-string context value is a value, not a missing key', async () => {
      const srv = await startHeaderCaptureServer();
      try {
        const toolId = await createHeaderTool({
          name: 'ctxEmptyValueTool',
          port: srv.port,
          headers: { 'X-Tenant': '{{context:tenant}}' },
        });

        await callTool({
          toolId,
          toolName: 'ctxEmptyValueTool',
          toolContext: { tenant: '' },
        });

        expect(srv.requests).toHaveLength(1);
        expect(srv.requests[0]!['x-tenant']).toBe('');
      } finally {
        await srv.close();
      }
    });

    // The security property of resolving both token kinds in ONE pass: a
    // substituted value is data, never template source. Without it, a caller
    // could put `{{secret:sec_...}}` in a context value and read a project
    // secret back out of the outbound header.
    test('a context value that looks like a secret token is not resolved as one', async () => {
      const srv = await startHeaderCaptureServer();
      try {
        const secretRes = await authenticatedTestClient(adminToken)
          .post('/api/v1/secrets')
          .send({
            project_id: projectId,
            name: 'ctx-injection-secret',
            value: 'SUPER-SECRET-VALUE',
          });
        expect(secretRes.status).toBe(201);
        const secretId = secretRes.body.id as string;

        const toolId = await createHeaderTool({
          name: 'ctxInjectionTool',
          port: srv.port,
          headers: { 'X-Tenant': '{{context:tenant}}' },
        });

        await callTool({
          toolId,
          toolName: 'ctxInjectionTool',
          toolContext: { tenant: `{{secret:${secretId}}}` },
        });

        const headers = srv.requests[0]!;
        expect(headers['x-tenant']).toBe(`{{secret:${secretId}}}`);
        expect(headers['x-tenant']).not.toContain('SUPER-SECRET-VALUE');
      } finally {
        await srv.close();
      }
    });

    // The mirror of the case above: a secret's decrypted value is data too.
    test('a secret value that looks like a context token is not resolved as one', async () => {
      const srv = await startHeaderCaptureServer();
      try {
        const secretRes = await authenticatedTestClient(adminToken)
          .post('/api/v1/secrets')
          .send({
            project_id: projectId,
            name: 'ctx-lookalike-secret',
            value: '{{context:ocaToken}}',
          });
        expect(secretRes.status).toBe(201);

        const toolId = await createHeaderTool({
          name: 'ctxSecretLookalikeTool',
          port: srv.port,
          headers: {
            'X-Both': `{{secret:${secretRes.body.id}}}|{{context:tenant}}`,
          },
        });

        await callTool({
          toolId,
          toolName: 'ctxSecretLookalikeTool',
          toolContext: { ocaToken: 'tok_abc', tenant: 'acme' },
        });

        // The secret resolved to its literal stored text; the context token that
        // text contains was NOT substituted, while the tool's own one was.
        expect(srv.requests[0]!['x-both']).toBe('{{context:ocaToken}}|acme');
      } finally {
        await srv.close();
      }
    });

    test('a tool with no {{context:...}} token still works with no tool_context', async () => {
      const srv = await startHeaderCaptureServer();
      try {
        const toolId = await createHeaderTool({
          name: 'ctxUnaffectedTool',
          port: srv.port,
          headers: { 'X-Static': 'static-value' },
        });

        await callTool({ toolId, toolName: 'ctxUnaffectedTool' });

        expect(srv.requests[0]!['x-static']).toBe('static-value');
      } finally {
        await srv.close();
      }
    });

    // #945 item 3: which keys egress to THIS tool. Asserted against a live
    // endpoint because the only thing that matters is what arrived on the wire.
    describe('context_keys allowlist', () => {
      test('forwards every key when the tool declares no allowlist', async () => {
        const srv = await startHeaderCaptureServer();
        try {
          const toolId = await createHeaderTool({
            name: 'ctxAllowAllTool',
            port: srv.port,
            headers: { 'X-Static': 'v' },
          });

          await callTool({
            toolId,
            toolName: 'ctxAllowAllTool',
            toolContext: { ocaToken: 'tok_abc', tenant: 'acme' },
          });

          const headers = srv.requests[0]!;
          expect(headers['x-soat-context-ocatoken']).toBe('tok_abc');
          expect(headers['x-soat-context-tenant']).toBe('acme');
        } finally {
          await srv.close();
        }
      });

      test('forwards only the listed keys', async () => {
        const srv = await startHeaderCaptureServer();
        try {
          const toolId = await createHeaderTool({
            name: 'ctxAllowOneTool',
            port: srv.port,
            headers: { 'X-Static': 'v' },
            contextKeys: ['tenant'],
          });

          await callTool({
            toolId,
            toolName: 'ctxAllowOneTool',
            toolContext: { ocaToken: 'tok_abc', tenant: 'acme' },
          });

          const headers = srv.requests[0]!;
          expect(headers['x-soat-context-tenant']).toBe('acme');
          // The credential did not egress to a tool that never asked for it.
          expect(headers['x-soat-context-ocatoken']).toBeUndefined();
        } finally {
          await srv.close();
        }
      });

      test('an empty allowlist forwards no caller keys at all', async () => {
        const srv = await startHeaderCaptureServer();
        try {
          const toolId = await createHeaderTool({
            name: 'ctxAllowNoneTool',
            port: srv.port,
            headers: { 'X-Static': 'v' },
            contextKeys: [],
          });

          await callTool({
            toolId,
            toolName: 'ctxAllowNoneTool',
            toolContext: { ocaToken: 'tok_abc', tenant: 'acme' },
          });

          const headers = srv.requests[0]!;
          expect(headers['x-soat-context-tenant']).toBeUndefined();
          expect(headers['x-soat-context-ocatoken']).toBeUndefined();
          expect(headers['x-static']).toBe('v');
        } finally {
          await srv.close();
        }
      });

      // The server-pinned identity keys are how a downstream tool knows who it
      // is acting for. They are not caller data and are never filtered out.
      test('always forwards the server-pinned identity keys', async () => {
        const srv = await startHeaderCaptureServer();
        try {
          const toolId = await createHeaderTool({
            name: 'ctxIdentityTool',
            port: srv.port,
            headers: { 'X-Static': 'v' },
            contextKeys: ['tenant'],
          });

          await callTool({
            toolId,
            toolName: 'ctxIdentityTool',
            toolContext: {
              tenant: 'acme',
              ocaToken: 'tok_abc',
              sessionId: 'ses_1',
              actorId: 'act_1',
              actorExternalId: 'ext_1',
            },
          });

          const headers = srv.requests[0]!;
          expect(headers['x-soat-context-sessionid']).toBe('ses_1');
          expect(headers['x-soat-context-actorid']).toBe('act_1');
          expect(headers['x-soat-context-actorexternalid']).toBe('ext_1');
          expect(headers['x-soat-context-ocatoken']).toBeUndefined();
        } finally {
          await srv.close();
        }
      });

      // A `{{context:...}}` key is not "forwarded" at all — it is substituted
      // into a header the tool itself declared, so the tool has already
      // consented to receiving it. Filtering must not break that.
      test('still substitutes a {{context:...}} key that the allowlist omits', async () => {
        const srv = await startHeaderCaptureServer();
        try {
          const toolId = await createHeaderTool({
            name: 'ctxTemplateBeatsFilterTool',
            port: srv.port,
            headers: { Authorization: 'Bearer {{context:ocaToken}}' },
            contextKeys: ['tenant'],
          });

          await callTool({
            toolId,
            toolName: 'ctxTemplateBeatsFilterTool',
            toolContext: { ocaToken: 'tok_abc', tenant: 'acme' },
          });

          const headers = srv.requests[0]!;
          expect(headers['authorization']).toBe('Bearer tok_abc');
          // ...but it is still absent as a prefixed header, since the allowlist
          // governs forwarding and the template governs substitution.
          expect(headers['x-soat-context-ocatoken']).toBeUndefined();
          expect(headers['x-soat-context-tenant']).toBe('acme');
        } finally {
          await srv.close();
        }
      });
    });
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

  test('http tool execute returns raw text for a 2xx response with a non-JSON body instead of throwing', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response('<html><body>hello</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    );

    const tools = await resolveAgentTools({ toolIds: [httpToolId] });
    const httpTool = tools.myHttpTool;

    let result: unknown;
    if ('execute' in httpTool && typeof httpTool.execute === 'function') {
      result = await httpTool.execute({}, {} as never);
    }

    expect(result).toBe('<html><body>hello</body></html>');

    fetchMock.mockRestore();
  });

  test('http tool execute returns empty string for a 2xx response with an empty body (e.g. 204 No Content)', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const tools = await resolveAgentTools({ toolIds: [httpToolId] });
    const httpTool = tools.myHttpTool;

    let result: unknown;
    if ('execute' in httpTool && typeof httpTool.execute === 'function') {
      result = await httpTool.execute({}, {} as never);
    }

    expect(result).toBe('');

    fetchMock.mockRestore();
  });

  // An `execute` persisted as a JSON string was tolerated for rows written
  // before single-casing; `backfillToolExecute` parsed those back into objects,
  // so a string can no longer be a valid config and is reported as one that is
  // not, rather than silently parsed.
  test('http tool execute stored as a JSON string is rejected as invalid', async () => {
    const stringExecuteRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'myStringExecuteHttpTool',
        type: 'http',
        description: 'execute persisted as a JSON string',
        parameters: { type: 'object', properties: {} },
        execute: {
          url: 'https://example.com/api/users/{user_id}',
          method: 'GET',
        },
      });

    await db.sequelize.query(
      'UPDATE tools SET execute = to_jsonb($1::text) WHERE public_id = $2',
      {
        bind: [
          JSON.stringify({
            url: 'https://example.com/api/users/{user_id}',
            method: 'GET',
          }),
          stringExecuteRes.body.id,
        ],
      }
    );

    const fetchMock = jest.spyOn(global, 'fetch');

    const tools = await resolveAgentTools({
      toolIds: [stringExecuteRes.body.id],
    });
    const tool = tools.myStringExecuteHttpTool;

    expect('execute' in tool && typeof tool.execute === 'function').toBe(true);
    if ('execute' in tool && typeof tool.execute === 'function') {
      await expect(
        tool.execute({ user_id: 'u_01' }, {} as never)
      ).rejects.toThrow(/Invalid HTTP tool execute config/);
    }
    // The request is never attempted — the config is refused, not guessed at.
    expect(fetchMock).not.toHaveBeenCalled();

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
      (listRes.body.data as Array<{ name: string }>).some((t) => {
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
    expect(buildContextHeaders({ toolContext: undefined })).toEqual({});
  });

  test('returns empty object for an empty args object', () => {
    expect(buildContextHeaders({})).toEqual({});
  });

  test('prefixes toolContext keys with X-Soat-Context- and nothing else', () => {
    const result = buildContextHeaders({
      toolContext: {
        environment: 'production',
        tenantId: 'abc-123',
      },
    });

    expect(result).toEqual({
      'X-Soat-Context-environment': 'production',
      'X-Soat-Context-tenantId': 'abc-123',
    });
  });

  test('preserves header values unchanged', () => {
    const result = buildContextHeaders({
      toolContext: { region: 'us-east-1' },
    });

    expect(result['X-Soat-Context-region']).toBe('us-east-1');
  });

  test('handles multiple context entries', () => {
    const result = buildContextHeaders({
      toolContext: {
        a: '1',
        b: '2',
        c: '3',
      },
    });

    expect(Object.keys(result)).toHaveLength(3);
    expect(result['X-Soat-Context-a']).toBe('1');
    expect(result['X-Soat-Context-b']).toBe('2');
    expect(result['X-Soat-Context-c']).toBe('3');
  });

  // #945 item 3 — `contextKeys` is the per-tool allowlist. `undefined`/`null`
  // means "forward all", which is what every tool created before it existed has.
  test('forwards everything when contextKeys is null or undefined', () => {
    const toolContext = { a: '1', b: '2' };

    expect(buildContextHeaders({ toolContext, contextKeys: null })).toEqual({
      'X-Soat-Context-a': '1',
      'X-Soat-Context-b': '2',
    });
    expect(
      buildContextHeaders({ toolContext, contextKeys: undefined })
    ).toEqual({
      'X-Soat-Context-a': '1',
      'X-Soat-Context-b': '2',
    });
  });

  test('forwards only listed keys when contextKeys is set', () => {
    expect(
      buildContextHeaders({
        toolContext: { a: '1', b: '2', c: '3' },
        contextKeys: ['a', 'c'],
      })
    ).toEqual({
      'X-Soat-Context-a': '1',
      'X-Soat-Context-c': '3',
    });
  });

  test('an empty contextKeys list forwards nothing', () => {
    expect(
      buildContextHeaders({
        toolContext: { a: '1', b: '2' },
        contextKeys: [],
      })
    ).toEqual({});
  });

  // A key names a header, and header names are case-insensitive (RFC 9110
  // §5.1) — `assertValidToolContextKeys` already refuses two keys that differ
  // only in case for that reason. So an allowlist entry matches the key it
  // names regardless of case; anything else would let the same header be both
  // allowed and denied depending on how it was typed.
  test('matches allowlist entries case-insensitively', () => {
    expect(
      buildContextHeaders({
        toolContext: { ocaToken: 'tok', tenant: 'acme' },
        contextKeys: ['OCATOKEN'],
      })
    ).toEqual({ 'X-Soat-Context-ocaToken': 'tok' });
  });

  test('a listed key that the bag does not carry adds no header', () => {
    expect(
      buildContextHeaders({
        toolContext: { a: '1' },
        contextKeys: ['a', 'absent'],
      })
    ).toEqual({ 'X-Soat-Context-a': '1' });
  });

  test('always forwards the server-pinned identity keys', () => {
    expect(
      buildContextHeaders({
        toolContext: {
          sessionId: 'ses_1',
          actorId: 'act_1',
          actorExternalId: 'ext_1',
          ocaToken: 'tok',
        },
        contextKeys: [],
      })
    ).toEqual({
      'X-Soat-Context-sessionId': 'ses_1',
      'X-Soat-Context-actorId': 'act_1',
      'X-Soat-Context-actorExternalId': 'ext_1',
    });
  });

  // The key is caller-owned and reaches the header name untouched: no
  // separator collapsing, no re-casing of any character — including the
  // first. Pinned as the whole contract, because every case-transform
  // incident in this project started with a transform this small.
  test('uses the key verbatim, transforming no character', () => {
    expect(
      buildContextHeaders({
        toolContext: {
          actor_external_id: 'snake',
          'actor-external-id': 'kebab',
          actorExternalId: 'camel',
          ActorExternalId: 'pascal',
          'actor.external.id': 'dotted',
        },
      })
    ).toEqual({
      'X-Soat-Context-actor_external_id': 'snake',
      'X-Soat-Context-actor-external-id': 'kebab',
      'X-Soat-Context-actorExternalId': 'camel',
      'X-Soat-Context-ActorExternalId': 'pascal',
      'X-Soat-Context-actor.external.id': 'dotted',
    });
  });

  // The header name is exactly `X-Soat-Context-` + the key, so a caller can
  // compute it with string concatenation and no knowledge of any rule.
  test.each([
    ['userId', 'X-Soat-Context-userId'],
    ['user_id', 'X-Soat-Context-user_id'],
    ['env', 'X-Soat-Context-env'],
    ['ENV', 'X-Soat-Context-ENV'],
    ['sessionId', 'X-Soat-Context-sessionId'],
  ])('key %s maps to %s', (key, header) => {
    expect(buildContextHeaders({ toolContext: { [key]: 'v' } })).toEqual({
      [header]: 'v',
    });
  });
});

describe('assertValidToolContextKeys', () => {
  test('accepts undefined and null', () => {
    expect(() => {
      return assertValidToolContextKeys(undefined);
    }).not.toThrow();
    expect(() => {
      return assertValidToolContextKeys(null);
    }).not.toThrow();
  });

  test('accepts an empty object', () => {
    expect(() => {
      return assertValidToolContextKeys({});
    }).not.toThrow();
  });

  test('accepts the keys the session path auto-populates', () => {
    expect(() => {
      return assertValidToolContextKeys({
        sessionId: 'ses_01',
        actorId: 'actor_01',
        actorExternalId: '+5511999999999',
      });
    }).not.toThrow();
  });

  // Every key shape that survives the header-name grammar keeps working —
  // validation must reject only what would break at call time, never narrow
  // what callers can already send.
  test('accepts snake_case, kebab-case and dotted keys', () => {
    expect(() => {
      return assertValidToolContextKeys({
        actor_external_id: 'a',
        'actor-external-id': 'b',
        'actor.external.id': 'c',
        "weird!#$%&'*+^_`|~1": 'd',
      });
    }).not.toThrow();
  });

  test('rejects a key containing a space', () => {
    expect(() => {
      return assertValidToolContextKeys({ 'bad key': 'x' });
    }).toThrow(
      expect.objectContaining({
        code: 'INVALID_TOOL_CONTEXT_KEY',
        httpStatus: 400,
      })
    );
  });

  test.each([
    ['colon', 'bad:key'],
    ['parenthesis', 'bad(key)'],
    ['non-ASCII', 'usuário'],
    ['newline', 'bad\nkey'],
    ['empty', ''],
  ])('rejects a key containing %s', (_label, key) => {
    expect(() => {
      return assertValidToolContextKeys({ [key]: 'x' });
    }).toThrow(expect.objectContaining({ code: 'INVALID_TOOL_CONTEXT_KEY' }));
  });

  test('reports every offending key in the error meta', () => {
    try {
      assertValidToolContextKeys({ 'bad key': '1', 'worse:key': '2', ok: '3' });
      throw new Error('expected assertValidToolContextKeys to throw');
    } catch (error) {
      const meta = (error as { meta?: { keys?: string[] } }).meta;
      expect(meta?.keys).toEqual(['bad key', 'worse:key']);
    }
  });

  // HTTP header names are case-insensitive, so two keys differing only in the
  // casing of a later character collapse into one outbound header and the last
  // one silently wins. Reject instead of dropping a value.
  test('rejects two keys that collide into the same header name', () => {
    expect(() => {
      return assertValidToolContextKeys({ userId: '1', userID: '2' });
    }).toThrow(
      expect.objectContaining({
        code: 'INVALID_TOOL_CONTEXT_KEY',
        httpStatus: 400,
      })
    );
  });

  // Keys are forwarded verbatim, so these two produce *different* header
  // strings — but HTTP folds them onto the same field, so the collision is
  // still real and must still be rejected rather than dropping a value.
  test('rejects two keys differing only in the first character casing', () => {
    expect(() => {
      return assertValidToolContextKeys({ userId: '1', UserId: '2' });
    }).toThrow(expect.objectContaining({ code: 'INVALID_TOOL_CONTEXT_KEY' }));
  });

  test('names the colliding header in the collision error', () => {
    try {
      assertValidToolContextKeys({ tenantId: '1', TenantId: '2' });
      throw new Error('expected assertValidToolContextKeys to throw');
    } catch (error) {
      const err = error as { message?: string; meta?: Record<string, unknown> };
      expect(err.message).toMatch(/X-Soat-Context-TenantId/);
      expect(err.meta?.header).toBe('X-Soat-Context-TenantId');
      expect(err.meta?.keys).toEqual(['tenantId', 'TenantId']);
    }
  });

  // Guards the contract the validator exists to protect: anything it accepts
  // must survive `new Headers()`, which is what fails at call time today.
  test('every accepted key produces a constructible Headers object', () => {
    const context = {
      sessionId: 'ses_01',
      actor_external_id: 'a',
      'actor-external-id': 'b',
      'actor.external.id': 'c',
    };
    assertValidToolContextKeys(context);
    expect(() => {
      return new Headers(buildContextHeaders({ toolContext: context }));
    }).not.toThrow();
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

  test('soat tool resolves configured actions and executes through the platform', async () => {
    const soatToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'mySoatTool',
        type: 'soat',
        actions: ['list-files'],
      });

    const tools = await resolveAgentTools({
      toolIds: [soatToolRes.body.id],
      authHeader: `Bearer ${adminToken}`,
    });
    expect(tools).toHaveProperty('mySoatTool_list-files');

    const soatTool = tools['mySoatTool_list-files'];
    expect(
      'execute' in soatTool && typeof soatTool.execute === 'function'
    ).toBe(true);

    // Since #888 the action runs in this process, so the assertion is the real
    // listing the platform returned rather than the shape of an outgoing
    // request. Nothing is listening on a port here.
    const result = await soatTool.execute!({}, {} as never);
    expect(Array.isArray((result as { data?: unknown[] }).data)).toBe(true);
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
    // A real target, so the preset's effect is observable in the result rather
    // than only in the request that carried it.
    const targetRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'myPresetTargetTool',
        type: 'soat',
        actions: ['list-files'],
      });
    expect(targetRes.status).toBe(201);

    const soatToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'myPresetExecTool',
        type: 'soat',
        actions: ['get-tool'],
        preset_parameters: { tool_id: targetRes.body.id },
      });
    expect(soatToolRes.status).toBe(201);

    const tools = await resolveAgentTools({
      toolIds: [soatToolRes.body.id],
      authHeader: `Bearer ${adminToken}`,
    });
    const soatTool = tools['myPresetExecTool_get-tool'];

    // The model supplies no `tool_id` — it comes from preset_parameters, and
    // the resource that came back is the proof it reached the path.
    const result = await soatTool.execute!({}, {} as never);
    expect((result as { id?: string }).id).toBe(targetRes.body.id);
    expect((result as { name?: string }).name).toBe('myPresetTargetTool');
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

    const tools = await resolveAgentTools({
      toolIds: [soatToolRes.body.id],
      authHeader: `Bearer ${adminToken}`,
    });
    expect(tools).toHaveProperty('myNoPresetTool_list-files');

    const soatTool = tools['myNoPresetTool_list-files'];
    const result = await soatTool.execute!({}, {} as never);
    expect(Array.isArray((result as { data?: unknown[] }).data)).toBe(true);
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

  const mockMcpListWithTwoTools = () => {
    return jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          result: { tools: [{ name: 'read_item' }, { name: 'delete_item' }] },
        }),
        { status: 200 }
      )
    );
  };

  test('exposes the entire MCP server surface when actions is null', async () => {
    mockMcpListWithTwoTools();
    const result = await resolveMcpTools({
      typedTool: { mcp: { url: 'http://localhost:19999/mcp' }, actions: null },
      buildContextHeaders: () => {
        return {};
      },
      logToolCallingError: jest.fn(),
    });
    expect(Object.keys(result).sort()).toEqual(['delete_item', 'read_item']);
  });

  test('exposes only allowlisted actions when actions is set', async () => {
    mockMcpListWithTwoTools();
    const result = await resolveMcpTools({
      typedTool: {
        mcp: { url: 'http://localhost:19999/mcp' },
        actions: ['read_item'],
      },
      buildContextHeaders: () => {
        return {};
      },
      logToolCallingError: jest.fn(),
    });
    expect(Object.keys(result)).toEqual(['read_item']);
    expect(result).not.toHaveProperty('delete_item');
  });

  test('exposes nothing when actions is an empty allowlist', async () => {
    mockMcpListWithTwoTools();
    const result = await resolveMcpTools({
      typedTool: { mcp: { url: 'http://localhost:19999/mcp' }, actions: [] },
      buildContextHeaders: () => {
        return {};
      },
      logToolCallingError: jest.fn(),
    });
    expect(Object.keys(result)).toHaveLength(0);
  });

  test('excludes denied actions when deniedActions is set', async () => {
    mockMcpListWithTwoTools();
    const result = await resolveMcpTools({
      typedTool: {
        mcp: { url: 'http://localhost:19999/mcp' },
        deniedActions: ['delete_item'],
      },
      buildContextHeaders: () => {
        return {};
      },
      logToolCallingError: jest.fn(),
    });
    expect(Object.keys(result)).toEqual(['read_item']);
    expect(result).not.toHaveProperty('delete_item');
  });

  test('denylist takes precedence over allowlist for the same action', async () => {
    mockMcpListWithTwoTools();
    const result = await resolveMcpTools({
      typedTool: {
        mcp: { url: 'http://localhost:19999/mcp' },
        actions: ['read_item', 'delete_item'],
        deniedActions: ['delete_item'],
      },
      buildContextHeaders: () => {
        return {};
      },
      logToolCallingError: jest.fn(),
    });
    expect(Object.keys(result)).toEqual(['read_item']);
    expect(result).not.toHaveProperty('delete_item');
  });
});

const soatDef = (name: string) => {
  const def = soatTools.find((t) => {
    return t.name === name;
  });
  expect(def).toBeDefined();
  return def!;
};

describe('executeSoatTool - direct', () => {
  test('an uncredentialed action fails the tool call and reports it', async () => {
    const logToolCallingError = jest.fn();

    // Since #888 the action is served in-process, so there is no network error
    // left to simulate — the failure that matters is the real one: no
    // `authHeader`, so the app's own auth middleware refuses the call. Sharing
    // a process must never imply sharing authority.
    await expect(
      executeSoatTool({
        toolName: 'test',
        def: soatDef('list-tools'),
        rawArgs: {},
        buildContextHeaders: () => {
          return {};
        },
        logToolCallingError,
      })
    ).rejects.toThrow(HttpToolError);

    expect(logToolCallingError).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'test_list-tools',
        toolType: 'soat',
        method: 'GET',
      })
    );
  });
});

describe('withCallTimeout', () => {
  test('returns the value when the call settles inside the budget', async () => {
    await expect(
      withCallTimeout({
        promise: Promise.resolve('done'),
        ms: 60_000,
        label: 'test action',
      })
    ).resolves.toBe('done');
  });

  test('rejects when the call does not settle, naming the action', async () => {
    // A promise that can never settle, so the timer wins without racing the
    // clock against real work.
    await expect(
      withCallTimeout({
        promise: new Promise<never>(() => {}),
        ms: 5,
        label: "SOAT action 'list-tools'",
      })
    ).rejects.toThrow(/SOAT action 'list-tools' timed out after 5ms/);
  });
});

describe('buildSoatRequestBody - trace field injection scoping (issue #371)', () => {
  test('does not inject parent_trace_id/root_trace_id/max_call_depth for actions whose schema does not declare them', () => {
    const body = buildSoatRequestBody({
      def: soatDef('search-knowledge'),
      rawArgs: { query: 'hello' },
      traceId: 'trc_123',
      rootTraceId: 'trc_root',
      remainingDepth: 3,
    });

    expect(body).not.toHaveProperty('parent_trace_id');
    expect(body).not.toHaveProperty('root_trace_id');
    expect(body).not.toHaveProperty('max_call_depth');
  });

  test('still injects parent_trace_id/root_trace_id/max_call_depth for create-agent-generation', () => {
    const body = buildSoatRequestBody({
      def: soatDef('create-agent-generation'),
      rawArgs: { agent_id: 'agt_1', messages: [] },
      toolContext: { env: 'test' },
      traceId: 'trc_123',
      rootTraceId: 'trc_root',
      remainingDepth: 3,
    });

    expect(body).toMatchObject({
      tool_context: { env: 'test' },
      parent_trace_id: 'trc_123',
      root_trace_id: 'trc_root',
      max_call_depth: 2,
    });
  });

  test('roots the lineage at the current trace when no root was carried in', () => {
    const body = buildSoatRequestBody({
      def: soatDef('create-agent-generation'),
      rawArgs: { agent_id: 'agt_1', messages: [] },
      traceId: 'trc_123',
      rootTraceId: null,
      remainingDepth: 3,
    });

    expect(body).toMatchObject({
      parent_trace_id: 'trc_123',
      root_trace_id: 'trc_123',
    });
  });

  // #945 item 3: this body is how a `soat` tool hands the bag to whatever it
  // starts, so the tool's allowlist has to bound it here too — otherwise a
  // credential excluded from the tool's own headers still reaches every tool of
  // the nested generation.
  test('filters the propagated tool_context through the tool context_keys', () => {
    const body = buildSoatRequestBody({
      def: soatDef('create-agent-generation'),
      rawArgs: { agent_id: 'agt_1', messages: [] },
      toolContext: { env: 'test', ocaToken: 'tok_abc', sessionId: 'ses_1' },
      contextKeys: ['env'],
    });

    expect(body).toMatchObject({
      // The identity key survives the allowlist; the credential does not.
      tool_context: { env: 'test', sessionId: 'ses_1' },
    });
    expect(body).toHaveProperty('tool_context');
    expect(
      (body as { tool_context: Record<string, string> }).tool_context
    ).not.toHaveProperty('ocaToken');
  });

  test('omits tool_context entirely when the allowlist leaves nothing', () => {
    const body = buildSoatRequestBody({
      def: soatDef('create-agent-generation'),
      rawArgs: { agent_id: 'agt_1', messages: [] },
      toolContext: { ocaToken: 'tok_abc' },
      contextKeys: [],
    });

    expect(body).not.toHaveProperty('tool_context');
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
