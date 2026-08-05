import type http from 'node:http';

import { app } from 'src/app';
import { db } from 'src/db';
import { emitActivityEntry } from 'src/lib/activity';
import { flushAuditQueue } from 'src/lib/auditQueue';
import * as discussionCompletion from 'src/lib/discussionCompletion';
import { fileException } from 'src/lib/exceptions';
import { createGenerationRecord } from 'src/lib/generations';
import * as pdfModule from 'src/lib/pdf';
import { saveTrace } from 'src/lib/traces';

import { ONE_PAGE_PDF_BUFFER } from '../../fixtures/pdf';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

let httpServer: http.Server;

beforeAll(async () => {
  // Bind the worker's own port (set per Jest worker in setupTests.ts) so this
  // matches the base URL src/mcp/server.ts froze at import — the MCP tools'
  // soat self-calls target it. The per-worker port keeps this listener from
  // colliding with tools.test.ts, which needs its worker's port unbound.
  const port = parseInt(process.env.PORT || '15047', 10);
  await new Promise<void>((resolve, reject) => {
    httpServer = app.listen(port, resolve);
    httpServer.once('error', reject);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    if (!httpServer) return resolve();
    httpServer.close((err) => {
      return err ? reject(err) : resolve();
    });
  });
});

describe('MCP tools - happy path', () => {
  let adminToken: string;
  let projectId: string;
  let setupActorId: string;
  let chatAiProviderId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'mcphappy', password: 'mcphappypass' });
    adminToken = await loginAs('mcphappy', 'mcphappypass');

    const projRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'MCP Happy Path' });
    projectId = projRes.body.id;

    const actorRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/actors')
      .send({ project_id: projectId, name: 'Setup Actor' });
    setupActorId = actorRes.body.id;

    const aiRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Chat Provider',
        provider: 'ollama',
        default_model: 'llama3',
      });
    chatAiProviderId = aiRes.body.id;
  });

  const mcpCall = (toolName: string, args: Record<string, unknown> = {}) => {
    return authenticatedTestClient(adminToken)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      });
  };

  const parseResult = (res: {
    body: {
      result?: {
        content?: Array<{
          text?: unknown;
        }>;
      };
    };
  }) => {
    const text = res.body.result?.content?.[0]?.text;
    if (text == null) {
      return null;
    }

    if (typeof text === 'string') {
      return JSON.parse(text);
    }

    return text;
  };

  const listTools = () => {
    return authenticatedTestClient(adminToken)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} });
  };

  test('create-presigned-url and upload-file-with-token are both exposed', async () => {
    const res = await listTools();
    expect(res.status).toBe(200);
    const names: string[] = (res.body.result?.tools ?? []).map(
      (t: { name: string }) => {
        return t.name;
      }
    );
    expect(names).toContain('create-presigned-url');
    expect(names).toContain('upload-file-with-token');
  });

  // ── Usage ────────────────────────────────────────────────────────────────

  test('get-usage returns an aggregate rollup for a project', async () => {
    const res = await mcpCall('get-usage', {
      project_id: projectId,
      group_by: 'meter_type',
    });
    expect(res.status).toBe(200);
    const result = parseResult(res);
    // MCP responses are snake_case, matching the REST contract. No generation
    // has been metered on this project, so the rollup is empty with zeroed
    // totals — but well-formed.
    expect(result.project_id).toBe(projectId);
    expect(result.group_by).toBe('meter_type');
    expect(Array.isArray(result.groups)).toBe(true);
    expect(result.totals.input_tokens).toBe(0);
    expect(result.totals.cost_usd).toBeNull();
  });

  test('create-, list-, and delete-usage-threshold manage a threshold', async () => {
    const created = parseResult(
      await mcpCall('create-usage-threshold', {
        project_id: projectId,
        metric: 'cost_usd',
        window: 'calendar_month',
        threshold: 250,
      })
    );
    expect(created.id).toMatch(/^uthr_/);
    expect(created.metric).toBe('cost_usd');
    expect(created.window).toBe('calendar_month');
    expect(created.threshold).toBe(250);

    const listed = parseResult(
      await mcpCall('list-usage-thresholds', { project_id: projectId })
    );
    expect(
      listed.data.some((t: { id: string }) => {
        return t.id === created.id;
      })
    ).toBe(true);

    const del = await mcpCall('delete-usage-threshold', {
      threshold_id: created.id,
    });
    expect(del.status).toBe(200);
  });

  test('upload-file-with-token uploads via a presigned token', async () => {
    const presigned = parseResult(
      await mcpCall('create-presigned-url', {
        project_id: projectId,
        prefix: '/mcp',
        filename: 'mcp-token-upload.txt',
      })
    );
    expect(presigned.upload_token).toMatch(/^upt_/);

    const res = await mcpCall('upload-file-with-token', {
      token: presigned.upload_token,
      content: Buffer.from('uploaded via mcp token').toString('base64'),
    });
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(result.id).toBeDefined();
    expect(result.filename).toBe('mcp-token-upload.txt');
  });

  // ── Audit Log ──────────────────────────────────────────────────────────────

  test('list-audit-entries and get-audit-entry expose the audit trail', async () => {
    // A mutating REST call the admin just made produces an audit entry; drain
    // the async writer before querying it back through the MCP surface.
    const secretRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/secrets')
      .send({ project_id: projectId, name: 'MCP_AUDIT', value: 'v' });
    const secretId = secretRes.body.id;
    await flushAuditQueue();

    const listed = parseResult(
      await mcpCall('list-audit-entries', {
        project_id: projectId,
        resource_public_id: secretId,
      })
    );
    // MCP responses are snake_case, matching the REST contract.
    expect(Array.isArray(listed.data)).toBe(true);
    const entry = listed.data.find((e: { action: string }) => {
      return e.action === 'secrets:CreateSecret';
    });
    expect(entry).toBeDefined();
    expect(entry.resource_public_id).toBe(secretId);

    const fetched = parseResult(
      await mcpCall('get-audit-entry', { entry_id: entry.id })
    );
    expect(fetched.id).toBe(entry.id);
    expect(fetched.action).toBe('secrets:CreateSecret');
  });

  // ── Exceptions ───────────────────────────────────────────────────────────

  test('list-exceptions, get-exception, and resolve-exception expose the queue', async () => {
    // No public create endpoint — file one through the lib, the way a producer
    // would, then triage it through the MCP surface.
    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    const filed = await fileException({
      projectId: project!.id as number,
      kind: 'manual',
      title: 'MCP exception',
    });

    const listed = parseResult(
      await mcpCall('list-exceptions', { project_id: projectId })
    );
    expect(Array.isArray(listed.data)).toBe(true);
    expect(
      listed.data.some((e: { id: string }) => {
        return e.id === filed.id;
      })
    ).toBe(true);

    const fetched = parseResult(
      await mcpCall('get-exception', { exception_id: filed.id })
    );
    expect(fetched.id).toBe(filed.id);
    expect(fetched.kind).toBe('manual');

    const resolved = parseResult(
      await mcpCall('resolve-exception', {
        exception_id: filed.id,
        note: 'Handled via MCP.',
      })
    );
    expect(resolved.status).toBe('resolved');
  });

  // ── Activity ─────────────────────────────────────────────────────────────

  test('list-activity exposes the autonomous-execution feed', async () => {
    // No public create endpoint — emit one through the lib, the way a
    // producer would, then read it through the MCP surface.
    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    const emitted = await emitActivityEntry({
      projectId: project!.id as number,
      kind: 'action_executed',
      summary: 'MCP activity entry',
    });

    const listed = parseResult(
      await mcpCall('list-activity', { project_id: projectId })
    );
    expect(Array.isArray(listed.data)).toBe(true);
    expect(
      listed.data.some((e: { id: string }) => {
        return e.id === emitted!.id;
      })
    ).toBe(true);
  });

  // ── Workflows & Tasks ──────────────────────────────────────────────────────

  test('create-workflow, create-task, transition-task, and history via MCP', async () => {
    const workflow = parseResult(
      await mcpCall('create-workflow', {
        project_id: projectId,
        name: 'mcp-pipeline',
        states: [
          { name: 'todo', initial: true },
          { name: 'doing' },
          { name: 'done', terminal: true },
        ],
        transitions: [
          { name: 'start', from: ['todo'], to: 'doing' },
          { name: 'finish', from: ['doing'], to: 'done' },
        ],
      })
    );
    expect(workflow.id).toMatch(/^wfl_/);
    expect(workflow.states).toHaveLength(3);

    const task = parseResult(
      await mcpCall('create-task', {
        project_id: projectId,
        workflow_id: workflow.id,
        title: 'first card',
      })
    );
    expect(task.id).toMatch(/^task_/);
    expect(task.state).toBe('todo');
    expect(task.status).toBe('open');

    const moved = parseResult(
      await mcpCall('transition-task', {
        task_id: task.id,
        transition: 'start',
      })
    );
    expect(moved.state).toBe('doing');

    const closed = parseResult(
      await mcpCall('transition-task', {
        task_id: task.id,
        transition: 'finish',
      })
    );
    expect(closed.state).toBe('done');
    expect(closed.status).toBe('closed');

    const listed = parseResult(
      await mcpCall('list-tasks', {
        project_id: projectId,
        workflow_id: workflow.id,
      })
    );
    expect(
      listed.data.some((t: { id: string }) => {
        return t.id === task.id;
      })
    ).toBe(true);

    // Alternate entry point (#821): `state` places the task directly in a
    // named non-initial state instead of the workflow's `initial` state.
    const midFlow = parseResult(
      await mcpCall('create-task', {
        project_id: projectId,
        workflow_id: workflow.id,
        title: 'skip todo, start doing',
        state: 'doing',
      })
    );
    expect(midFlow.state).toBe('doing');
    expect(midFlow.status).toBe('open');

    const history = parseResult(
      await mcpCall('get-task-history', { task_id: task.id })
    );
    // initial placement + two transitions, oldest first.
    expect(history).toHaveLength(3);
    expect(
      history.map((h: { to_state: string }) => {
        return h.to_state;
      })
    ).toEqual(['todo', 'doing', 'done']);
  });

  // ── Files ────────────────────────────────────────────────────────────────

  describe('Files tools', () => {
    let fileId: string;
    let createFileResult: { id: string; [key: string]: unknown };

    beforeAll(async () => {
      const res = await mcpCall('upload-file-base64', {
        project_id: projectId,
        content: Buffer.from('hello mcp').toString('base64'),
        filename: 'mcp-test.txt',
      });
      createFileResult = parseResult(res);
      fileId = createFileResult.id;
    });

    test('upload-file creates a file', () => {
      expect(createFileResult.id).toBeDefined();
    });

    test('list-files returns data array', async () => {
      const res = await mcpCall('list-files');
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(Array.isArray(result.data)).toBe(true);
    });

    test('get-file returns the file', async () => {
      const res = await mcpCall('get-file', { file_id: fileId });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(fileId);
    });

    test('download-file returns base64 content', async () => {
      const res = await mcpCall('download-file-base64', { file_id: fileId });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.content).toBeDefined();
    });

    test('update-file-metadata renames the file', async () => {
      const res = await mcpCall('update-file-metadata', {
        file_id: fileId,
        filename: 'mcp-renamed.txt',
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(fileId);
    });

    test('create-file registers a file record', async () => {
      const res = await mcpCall('create-file', {
        project_id: projectId,
        filename: 'mcp-registered.txt',
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBeDefined();
    });

    test('delete-file deletes the file', async () => {
      const res = await mcpCall('delete-file', { file_id: fileId });
      expect(res.status).toBe(200);
    });
  });

  // ── Actors ───────────────────────────────────────────────────────────────

  describe('Actors tools', () => {
    let actorId: string;
    let createActorResult: { id: string; [key: string]: unknown };

    beforeAll(async () => {
      const res = await mcpCall('create-actor', {
        project_id: projectId,
        name: 'MCP Actor',
      });
      createActorResult = parseResult(res);
      actorId = createActorResult.id;
    });

    test('create-actor creates an actor', () => {
      expect(createActorResult.id).toBeDefined();
    });

    test('list-actors returns data array', async () => {
      const res = await mcpCall('list-actors');
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(Array.isArray(result.data)).toBe(true);
    });

    test('update-actor updates the name', async () => {
      const res = await mcpCall('update-actor', {
        actor_id: actorId,
        name: 'MCP Actor Updated',
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(actorId);
    });

    test('get-actor returns the actor', async () => {
      const res = await mcpCall('get-actor', { actor_id: actorId });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(actorId);
    });

    test('delete-actor deletes the actor', async () => {
      const res = await mcpCall('delete-actor', { actor_id: actorId });
      expect(res.status).toBe(200);
    });
  });

  // ── Conversations ─────────────────────────────────────────────────────────

  describe('Conversations tools', () => {
    let conversationId: string;
    let createConversationResult: { id: string; [key: string]: unknown };

    beforeAll(async () => {
      const res = await mcpCall('create-conversation', {
        project_id: projectId,
      });
      createConversationResult = parseResult(res);
      conversationId = createConversationResult.id;
    });

    test('create-conversation creates a conversation', () => {
      expect(createConversationResult.id).toBeDefined();
    });

    test('list-conversations returns data array', async () => {
      const res = await mcpCall('list-conversations');
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(Array.isArray(result.data)).toBe(true);
    });

    test('add-conversation-message adds a message', async () => {
      const res = await mcpCall('add-conversation-message', {
        conversation_id: conversationId,
        message: 'hello from mcp',
        role: 'user',
        actor_id: setupActorId,
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.document_id).toBeDefined();
    });

    test('list-conversation-messages returns data array', async () => {
      const res = await mcpCall('list-conversation-messages', {
        conversation_id: conversationId,
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(Array.isArray(result.data)).toBe(true);
    });

    test('list-actors filtered by conversationId returns results', async () => {
      const res = await mcpCall('list-actors', {
        conversation_id: conversationId,
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(Array.isArray(result.data)).toBe(true);
    });

    test('get-conversation returns the conversation', async () => {
      const res = await mcpCall('get-conversation', {
        conversation_id: conversationId,
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(conversationId);
    });

    test('remove-conversation-message removes the message', async () => {
      const addRes = await mcpCall('add-conversation-message', {
        conversation_id: conversationId,
        message: 'message to remove',
        role: 'user',
        actor_id: setupActorId,
      });
      const documentId = parseResult(addRes).document_id;

      const res = await mcpCall('remove-conversation-message', {
        conversation_id: conversationId,
        document_id: documentId,
      });
      expect(res.status).toBe(200);
    });

    test('update-conversation updates the status', async () => {
      const res = await mcpCall('update-conversation', {
        conversation_id: conversationId,
        status: 'closed',
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(conversationId);
    });

    test('delete-conversation deletes the conversation', async () => {
      const res = await mcpCall('delete-conversation', {
        conversation_id: conversationId,
      });
      expect(res.status).toBe(200);
    });
  });

  // ── Documents ────────────────────────────────────────────────────────────

  describe('Documents tools', () => {
    let documentId: string;
    let createDocumentResult: { id: string; [key: string]: unknown };

    beforeAll(async () => {
      const res = await mcpCall('create-document', {
        project_id: projectId,
        content: 'MCP test document content',
      });
      createDocumentResult = parseResult(res);
      documentId = createDocumentResult.id;
    });

    test('create-document creates a document', () => {
      expect(createDocumentResult.id).toBeDefined();
    });

    // A tag key is read back by IAM as a `soat:ResourceTag/<key>` context key, so
    // the MCP surface must preserve it exactly as the REST caseTransform does.
    // `snakeToCamelDeep` would rewrite `cost_center` to `costCenter` on read, so
    // a tag set through one surface would not match a policy written for the
    // other.
    test('create-document preserves multi-word tag keys verbatim', async () => {
      const tags = { cost_center: 'platform', Environment: 'prod' };

      const created = await mcpCall('create-document', {
        project_id: projectId,
        content: 'tagged via mcp',
        tags,
      });
      expect(created.status).toBe(200);
      expect(parseResult(created).tags).toEqual(tags);

      const fetched = await mcpCall('get-document', {
        document_id: parseResult(created).id,
      });
      expect(fetched.status).toBe(200);
      expect(parseResult(fetched).tags).toEqual(tags);
    });

    test('ingest-document ingests a PDF', async () => {
      const uploadRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/files/upload')
        .attach('file', ONE_PAGE_PDF_BUFFER, {
          filename: 'mcp-test.pdf',
          contentType: 'application/pdf',
        })
        .field('project_id', projectId);
      expect(uploadRes.status).toBe(201);
      const pdfFileId = uploadRes.body.id;

      const spy = jest
        .spyOn(pdfModule, 'extractPdfPages')
        .mockResolvedValue(['MCP PDF page 1']);
      try {
        const res = await mcpCall('ingest-document', {
          file_id: pdfFileId,
          project_id: projectId,
        });
        expect(res.status).toBe(200);
        const result = parseResult(res);
        expect(result.id).toBeDefined();
        expect(result.status).toBe('pending');

        // Ingestion is async — poll until ready
        const docId = result.id;
        let doc = result;
        const deadline = Date.now() + 5000;
        while (
          (doc.status === 'pending' || doc.status === 'processing') &&
          Date.now() < deadline
        ) {
          await new Promise((r) => {
            return setTimeout(r, 50);
          });
          const pollRes = await mcpCall('get-document', {
            document_id: docId,
          });
          doc = parseResult(pollRes);
        }
        expect(doc.status).toBe('ready');
        expect(
          (doc.metadata as { chunk_count?: number })?.chunk_count
        ).toBeGreaterThan(0);
      } finally {
        spy.mockRestore();
      }
    });

    test('list-documents returns data array', async () => {
      const res = await mcpCall('list-documents');
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(Array.isArray(result.data)).toBe(true);
    });

    test('update-document updates content', async () => {
      const res = await mcpCall('update-document', {
        document_id: documentId,
        content: 'MCP updated content',
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(documentId);
    });

    test('get-document returns the document', async () => {
      const res = await mcpCall('get-document', { document_id: documentId });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(documentId);
    });

    test('get-document-status returns a lightweight status payload', async () => {
      const res = await mcpCall('get-document-status', {
        document_id: documentId,
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(documentId);
      expect(result.status).toBe('ready');
      // The heavy chunk content must not be present on the status tool.
      expect(result.content).toBeUndefined();
    });

    test('reingest-document re-processes an existing document', async () => {
      const res = await mcpCall('reingest-document', {
        document_id: documentId,
        async: false,
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(documentId);
      expect(result.status).toBe('ready');
    });

    test('search-knowledge returns results', async () => {
      const res = await mcpCall('search-knowledge', {
        project_id: projectId,
        query: 'mcp test',
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result).toBeDefined();
    });

    test('delete-document deletes the document', async () => {
      const res = await mcpCall('delete-document', {
        document_id: documentId,
      });
      expect(res.status).toBe(200);
    });
  });

  // ── Projects ─────────────────────────────────────────────────────────────

  describe('Projects tools', () => {
    test('list-projects returns results', async () => {
      const res = await mcpCall('list-projects');
      expect(res.status).toBe(200);
    });

    test('get-project returns the project', async () => {
      const res = await mcpCall('get-project', { project_id: projectId });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(projectId);
    });

    test('update-project renames the project', async () => {
      const res = await mcpCall('update-project', {
        project_id: projectId,
        name: 'MCP Happy Path Renamed',
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(projectId);
      expect(result.name).toBe('MCP Happy Path Renamed');
    });
  });

  // ── Secrets ──────────────────────────────────────────────────────────────

  describe('Secrets tools', () => {
    let secretId: string;
    let createSecretResult: { id: string; [key: string]: unknown };

    beforeAll(async () => {
      const res = await mcpCall('create-secret', {
        project_id: projectId,
        name: 'mcp-secret',
        value: 'supersecretvalue',
      });
      createSecretResult = parseResult(res);
      secretId = createSecretResult.id;
    });

    test('create-secret creates a secret', () => {
      expect(createSecretResult.id).toBeDefined();
      expect(createSecretResult.has_value).toBe(true);
    });

    test('list-secrets returns array', async () => {
      const res = await mcpCall('list-secrets');
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(Array.isArray(result.data)).toBe(true);
    });

    test('get-secret returns the secret', async () => {
      const res = await mcpCall('get-secret', { secret_id: secretId });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(secretId);
    });

    test('update-secret updates the name', async () => {
      const res = await mcpCall('update-secret', {
        secret_id: secretId,
        name: 'mcp-secret-renamed',
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(secretId);
    });

    test('delete-secret deletes the secret', async () => {
      const res = await mcpCall('delete-secret', { secret_id: secretId });
      expect(res.status).toBe(200);
    });
  });

  // ── AI Providers ──────────────────────────────────────────────────────────

  describe('AI Providers tools', () => {
    let testAiProviderId: string;
    let createAiProviderResult: { id: string; [key: string]: unknown };

    beforeAll(async () => {
      const res = await mcpCall('create-ai-provider', {
        project_id: projectId,
        name: 'Test Provider',
        provider: 'ollama',
        default_model: 'llama3',
      });
      createAiProviderResult = parseResult(res);
      testAiProviderId = createAiProviderResult.id;
    });

    test('create-ai-provider creates a provider', () => {
      expect(createAiProviderResult.id).toBeDefined();
    });

    test('list-ai-providers returns results', async () => {
      const res = await mcpCall('list-ai-providers');
      expect(res.status).toBe(200);
    });

    test('get-ai-provider returns the provider', async () => {
      const res = await mcpCall('get-ai-provider', {
        ai_provider_id: testAiProviderId,
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(testAiProviderId);
    });

    test('update-ai-provider updates the name', async () => {
      const res = await mcpCall('update-ai-provider', {
        ai_provider_id: testAiProviderId,
        name: 'Test Provider Updated',
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(testAiProviderId);
    });

    test('delete-ai-provider deletes the provider', async () => {
      const res = await mcpCall('delete-ai-provider', {
        ai_provider_id: testAiProviderId,
      });
      expect(res.status).toBe(200);
    });
  });

  // ── Chats ─────────────────────────────────────────────────────────────────

  describe('Chats tools', () => {
    let chatId: string;
    let createChatResult: { id: string; [key: string]: unknown };

    beforeAll(async () => {
      const res = await mcpCall('create-chat', {
        project_id: projectId,
        ai_provider_id: chatAiProviderId,
        name: 'MCP Chat',
      });
      createChatResult = parseResult(res);
      chatId = createChatResult.id;
    });

    test('create-chat creates a chat', () => {
      expect(createChatResult.id).toBeDefined();
    });

    test('list-chats returns results', async () => {
      const res = await mcpCall('list-chats');
      expect(res.status).toBe(200);
    });

    test('get-chat returns the chat', async () => {
      const res = await mcpCall('get-chat', { chat_id: chatId });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(chatId);
    });

    test('delete-chat deletes the chat', async () => {
      const res = await mcpCall('delete-chat', { chat_id: chatId });
      expect(res.status).toBe(200);
    });

    // create-chat-completion and create-chat-completion-for-chat are skipped
    // because they require a live AI service.
  });

  // ── Tools ───────────────────────────────────────────────────────────────

  describe('Tools tools', () => {
    let toolId: string;
    let createToolResult: { id: string; [key: string]: unknown };

    beforeAll(async () => {
      const res = await mcpCall('create-tool', {
        project_id: projectId,
        name: 'mcp-test-tool',
        type: 'http',
        description: 'A test tool',
      });
      createToolResult = parseResult(res);
      toolId = createToolResult.id;
    });

    test('create-tool creates a tool', () => {
      expect(createToolResult.id).toBeDefined();
    });

    test('list-tools returns results', async () => {
      const res = await mcpCall('list-tools');
      expect(res.status).toBe(200);
    });

    test('get-tool returns the tool', async () => {
      const res = await mcpCall('get-tool', { tool_id: toolId });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(toolId);
    });

    test('update-tool updates the tool', async () => {
      const res = await mcpCall('update-tool', {
        tool_id: toolId,
        name: 'mcp-test-tool-renamed',
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(toolId);
    });

    test('delete-tool deletes the tool', async () => {
      const res = await mcpCall('delete-tool', { tool_id: toolId });
      expect(res.status).toBe(200);
      const text = res.body.result?.content?.[0]?.text;
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
    });
  });

  // ── Agents ──────────────────────────────────────────────────────────────
  // create-agent-generation is skipped because it requires a live AI service.

  describe('Agents tools', () => {
    let agentId: string;
    let createAgentResult: { id: string; [key: string]: unknown };

    beforeAll(async () => {
      const res = await mcpCall('create-agent', {
        project_id: projectId,
        ai_provider_id: chatAiProviderId,
        name: 'MCP Agent',
      });
      createAgentResult = parseResult(res);
      agentId = createAgentResult.id;
    });

    test('create-agent creates an agent', () => {
      expect(createAgentResult.id).toBeDefined();
    });

    test('list-agents returns results', async () => {
      const res = await mcpCall('list-agents');
      expect(res.status).toBe(200);
    });

    test('get-agent returns the agent', async () => {
      const res = await mcpCall('get-agent', { agent_id: agentId });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(agentId);
    });

    test('update-agent updates the agent', async () => {
      const res = await mcpCall('update-agent', {
        agent_id: agentId,
        name: 'MCP Agent Renamed',
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(agentId);
    });

    test('list-agent-traces returns results', async () => {
      const res = await mcpCall('list-agent-traces');
      expect(res.status).toBe(200);
    });

    test('delete-agent deletes the agent', async () => {
      const res = await mcpCall('delete-agent', { agent_id: agentId });
      expect(res.status).toBe(200);
    });
  });

  // ── Generations ────────────────────────────────────────────────────────
  // create-agent-generation is skipped (needs a live AI service); seed a
  // generation record directly so the read + update tools can be exercised.

  describe('Generations tools', () => {
    let genAgentId: string;
    let mcpGenerationId: string;

    beforeAll(async () => {
      const agentRes = await mcpCall('create-agent', {
        project_id: projectId,
        ai_provider_id: chatAiProviderId,
        name: 'MCP Generations Agent',
      });
      genAgentId = parseResult(agentRes).id;

      const project = await db.Project.findOne({
        where: { publicId: projectId },
      });
      const internalProjectId = project!.id;

      mcpGenerationId = `gen_mcp_${Date.now()}`;
      await createGenerationRecord({
        publicId: mcpGenerationId,
        projectId: internalProjectId,
        agentId: genAgentId,
        traceId: `trc_mcp_gen_${Date.now()}`,
      });
    });

    test('list-generations returns the seeded generation', async () => {
      const res = await mcpCall('list-generations', {
        agent_id: genAgentId,
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(
        result.data.some((g: { id: string }) => {
          return g.id === mcpGenerationId;
        })
      ).toBe(true);
    });

    test('update-generation attaches caller metadata', async () => {
      const res = await mcpCall('update-generation', {
        generation_id: mcpGenerationId,
        metadata: { playbook: 'refunds-v3' },
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(mcpGenerationId);
      expect(result.metadata.playbook).toBe('refunds-v3');
    });
  });

  // ── Webhooks ───────────────────────────────────────────────────────────

  describe('Webhooks tools', () => {
    let webhookId: string;
    let createWebhookResult: {
      id: string;
      name: string;
      secret?: string;
      [key: string]: unknown;
    };

    beforeAll(async () => {
      const res = await mcpCall('create-webhook', {
        project_id: projectId,
        name: 'MCP Webhook',
        url: 'https://example.com/mcp-hook',
        events: ['file.*'],
      });
      createWebhookResult = parseResult(res);
      webhookId = createWebhookResult.id;
    });

    test('create-webhook creates a webhook', () => {
      expect(createWebhookResult.id).toBeDefined();
      expect(createWebhookResult.name).toBe('MCP Webhook');
      expect(createWebhookResult.secret).toBeDefined();
    });

    test('list-webhooks returns results', async () => {
      const res = await mcpCall('list-webhooks', { project_id: projectId });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data.length).toBeGreaterThan(0);
    });

    test('get-webhook returns the webhook', async () => {
      const res = await mcpCall('get-webhook', {
        project_id: projectId,
        webhook_id: webhookId,
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(webhookId);
    });

    test('update-webhook updates the webhook', async () => {
      const res = await mcpCall('update-webhook', {
        project_id: projectId,
        webhook_id: webhookId,
        name: 'MCP Webhook Updated',
        active: false,
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.name).toBe('MCP Webhook Updated');
      expect(result.active).toBe(false);
    });

    test('rotate-webhook-secret returns new secret', async () => {
      const res = await mcpCall('rotate-webhook-secret', {
        project_id: projectId,
        webhook_id: webhookId,
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.secret).toBeDefined();
    });

    test('list-webhook-deliveries returns results', async () => {
      const res = await mcpCall('list-webhook-deliveries', {
        project_id: projectId,
        webhook_id: webhookId,
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.data).toBeDefined();
      expect(Array.isArray(result.data)).toBe(true);
    });

    test('delete-webhook deletes the webhook', async () => {
      const res = await mcpCall('delete-webhook', {
        project_id: projectId,
        webhook_id: webhookId,
      });
      expect(res.status).toBe(200);
    });
  });

  // ── Triggers ───────────────────────────────────────────────────────────────

  describe('Triggers tools', () => {
    let triggerOrchestrationId: string;
    let manualTriggerId: string;
    let createTriggerResult: {
      id: string;
      type: string;
      target_type: string;
      secret?: string;
      [key: string]: unknown;
    };

    beforeAll(async () => {
      // Orchestration target — a single transform node runs synchronously, so a
      // manual fire reaches a terminal state without an LLM/external boundary.
      triggerOrchestrationId = (
        await authenticatedTestClient(adminToken)
          .post('/api/v1/orchestrations')
          .send({
            project_id: projectId,
            name: 'MCP Trigger Orchestration',
            nodes: [
              {
                id: 'start',
                type: 'transform',
                expression: { var: '' },
                state_mapping: { 'state.result': { var: 'output.output' } },
              },
            ],
            edges: [],
          })
      ).body.id;

      const res = await mcpCall('create-trigger', {
        project_id: projectId,
        name: 'MCP Manual Trigger',
        type: 'manual',
        target_type: 'orchestration',
        target_id: triggerOrchestrationId,
        input: { foo: 'bar' },
      });
      createTriggerResult = parseResult(res);
      manualTriggerId = createTriggerResult.id;
    });

    test('create-trigger creates a trigger', () => {
      expect(createTriggerResult.id).toMatch(/^trg_/);
      expect(createTriggerResult.type).toBe('manual');
      expect(createTriggerResult.target_type).toBe('orchestration');
      // Manual triggers have no signing secret.
      expect(createTriggerResult.secret).toBeUndefined();
    });

    test('list-triggers returns results', async () => {
      const res = await mcpCall('list-triggers', { project_id: projectId });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data.length).toBeGreaterThan(0);
    });

    test('get-trigger returns the trigger', async () => {
      const res = await mcpCall('get-trigger', {
        trigger_id: manualTriggerId,
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(manualTriggerId);
      expect(result.name).toBe('MCP Manual Trigger');
    });

    test('fire-trigger runs the target and records a terminal firing', async () => {
      const res = await mcpCall('fire-trigger', {
        trigger_id: manualTriggerId,
        input: { extra: 'value' },
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toMatch(/^trg_fire_/);
      expect(result.source).toBe('manual');
      expect(['succeeded', 'failed']).toContain(result.status);
    });

    test('list-trigger-firings returns results', async () => {
      const res = await mcpCall('list-trigger-firings', {
        trigger_id: manualTriggerId,
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data.length).toBeGreaterThan(0);
    });

    test('get-trigger-firing returns the firing', async () => {
      const list = parseResult(
        await mcpCall('list-trigger-firings', {
          trigger_id: manualTriggerId,
        })
      );
      const firingId = list.data[0].id;
      const res = await mcpCall('get-trigger-firing', { firing_id: firingId });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(firingId);
      expect(result.trigger_id).toBe(manualTriggerId);
    });

    test('update-trigger updates the trigger', async () => {
      const res = await mcpCall('update-trigger', {
        trigger_id: manualTriggerId,
        name: 'MCP Manual Trigger Updated',
        active: false,
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.name).toBe('MCP Manual Trigger Updated');
      expect(result.active).toBe(false);
    });

    test('get-trigger-secret and rotate-trigger-secret work for a webhook trigger', async () => {
      const created = parseResult(
        await mcpCall('create-trigger', {
          project_id: projectId,
          name: 'MCP Webhook Trigger',
          type: 'webhook',
          target_type: 'orchestration',
          target_id: triggerOrchestrationId,
        })
      );
      const webhookTriggerId = created.id;
      // Webhook triggers return a secret on create.
      expect(created.secret).toBeDefined();

      const secret = parseResult(
        await mcpCall('get-trigger-secret', { trigger_id: webhookTriggerId })
      );
      expect(secret.secret).toBeDefined();

      const rotated = parseResult(
        await mcpCall('rotate-trigger-secret', {
          trigger_id: webhookTriggerId,
        })
      );
      expect(rotated.secret).toBeDefined();
      expect(rotated.secret).not.toBe(secret.secret);
    });

    test('delete-trigger deletes the trigger', async () => {
      const res = await mcpCall('delete-trigger', {
        trigger_id: manualTriggerId,
      });
      expect(res.status).toBe(200);
    });
  });

  // ── Sessions ─────────────────────────────────────────────────────────────

  describe('Sessions tools', () => {
    let sessionAgentId: string;
    let sessionId: string;
    let createSessionResult: {
      id: string;
      agent_id: string;
      conversation_id: string;
      [key: string]: unknown;
    };

    beforeAll(async () => {
      const agentRes = await mcpCall('create-agent', {
        project_id: projectId,
        ai_provider_id: chatAiProviderId,
        name: 'MCP Session Agent',
      });
      sessionAgentId = parseResult(agentRes).id;

      const res = await mcpCall('create-session', {
        agent_id: sessionAgentId,
        name: 'MCP Test Session',
      });
      createSessionResult = parseResult(res);
      sessionId = createSessionResult.id;
    });

    test('create-session creates a session', () => {
      expect(createSessionResult.id).toMatch(/^sess_/);
      expect(createSessionResult.agent_id).toBe(sessionAgentId);
      expect(createSessionResult.conversation_id).toBeDefined();
    });

    test('create-session accepts toolContext', async () => {
      const res = await mcpCall('create-session', {
        agent_id: sessionAgentId,
        tool_context: { userId: 'u1' },
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.tool_context).toEqual({ userId: 'u1' });
    });

    // A `toolContext` key is an HTTP header name (`X-Soat-Context-<key>`), not a
    // SOAT field name, so the MCP surface must preserve it verbatim exactly as
    // the REST caseTransform middleware does. `snakeToCamelDeep` would otherwise
    // rewrite `actor_external_id` to `actorExternalId` on read, breaking the
    // read→write round-trip and changing which header the tool receives.
    test('create-session preserves non-camelCase toolContext keys verbatim', async () => {
      const toolContext = {
        actor_external_id: 'snake',
        'actor-external-id': 'kebab',
        PascalKey: 'pascal',
      };

      const created = await mcpCall('create-session', {
        agent_id: sessionAgentId,
        tool_context: toolContext,
      });
      expect(created.status).toBe(200);
      expect(parseResult(created).tool_context).toEqual(toolContext);

      const fetched = await mcpCall('get-session', {
        session_id: parseResult(created).id,
      });
      expect(fetched.status).toBe(200);
      expect(parseResult(fetched).tool_context).toEqual(toolContext);
    });

    test('list-sessions filtered by agentId returns sessions', async () => {
      const res = await mcpCall('list-sessions', {
        agent_id: sessionAgentId,
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data.length).toBeGreaterThan(0);
    });

    test('get-session returns session details', async () => {
      const res = await mcpCall('get-session', {
        session_id: sessionId,
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(sessionId);
      expect(result.name).toBe('MCP Test Session');
    });

    test('add-session-message adds a user message and returns 201 body', async () => {
      const res = await mcpCall('add-session-message', {
        session_id: sessionId,
        message: 'hello from mcp session',
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.role).toBe('user');
      expect(result.content).toBe('hello from mcp session');
    });

    test('delete-session deletes the session', async () => {
      const res = await mcpCall('delete-session', {
        session_id: sessionId,
      });
      expect(res.status).toBe(200);
    });
  });

  // ── Policies ─────────────────────────────────────────────────────────────

  describe('Policies tools', () => {
    let mcpPolicyId: string;
    let createPolicyResult: {
      id: string;
      name: string;
      document: { statement: Array<{ action: string[] }> };
      [key: string]: unknown;
    };

    beforeAll(async () => {
      const res = await mcpCall('create-policy', {
        name: 'MCP Test Policy',
        document: {
          statement: [{ effect: 'Allow', action: ['files:GetFile'] }],
        },
      });
      createPolicyResult = parseResult(res);
      mcpPolicyId = createPolicyResult.id;
    });

    test('create-policy creates a policy', () => {
      expect(createPolicyResult.id).toMatch(/^pol_/);
      expect(createPolicyResult.name).toBe('MCP Test Policy');
      expect(createPolicyResult.document.statement[0].action).toContain(
        'files:GetFile'
      );
    });

    // The MCP surface mirrors caseTransform's outbound pass-through set, so an
    // IAM condition must survive here too: `snakeToCamelDeep` would rewrite the
    // context key `soat:ResourceTag/cost_center` to `soat:ResourceTag/costCenter`
    // on read, so echoing a policy back through update-policy would silently
    // change which tag the condition selects.
    test('policy condition keys survive a read → write round-trip', async () => {
      const condition = {
        StringEquals: { 'soat:ResourceTag/cost_center': 'platform' },
      };

      const created = await mcpCall('create-policy', {
        name: 'MCP Condition Policy',
        document: {
          statement: [
            {
              effect: 'Allow',
              action: ['documents:GetDocument'],
              resource: ['*'],
              condition,
            },
          ],
        },
      });
      expect(created.status).toBe(200);
      const createdPolicy = parseResult(created);
      expect(createdPolicy.document.statement[0].condition).toEqual(condition);

      const fetched = await mcpCall('get-policy', {
        policy_id: createdPolicy.id,
      });
      expect(fetched.status).toBe(200);
      expect(parseResult(fetched).document.statement[0].condition).toEqual(
        condition
      );
    });

    test('list-policies returns results', async () => {
      const res = await mcpCall('list-policies');

      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(Array.isArray(result.data)).toBe(true);
      expect(
        result.data.some((p: { id: string }) => {
          return p.id === mcpPolicyId;
        })
      ).toBe(true);
    });

    test('get-policy returns the policy', async () => {
      const res = await mcpCall('get-policy', { policy_id: mcpPolicyId });

      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(mcpPolicyId);
      expect(result.name).toBe('MCP Test Policy');
    });

    test('update-policy updates the policy', async () => {
      const res = await mcpCall('update-policy', {
        policy_id: mcpPolicyId,
        name: 'MCP Updated Policy',
        document: {
          statement: [
            { effect: 'Allow', action: ['files:GetFile', 'files:DeleteFile'] },
          ],
        },
      });

      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(mcpPolicyId);
      expect(result.name).toBe('MCP Updated Policy');
      expect(result.document.statement[0].action).toContain('files:DeleteFile');
    });

    test('delete-policy deletes the policy', async () => {
      const res = await mcpCall('delete-policy', { policy_id: mcpPolicyId });

      expect(res.status).toBe(200);
    });
  });

  // ── API Keys ──────────────────────────────────────────────────────────────

  describe('API Keys tools', () => {
    let apiKeyPolicyId: string;
    let mcpApiKeyId: string;
    let createApiKeyResult: {
      id: string;
      name: string;
      key?: string;
      [key: string]: unknown;
    };

    beforeAll(async () => {
      const policyRes = await mcpCall('create-policy', {
        name: 'MCP API Key Policy',
        document: {
          statement: [{ effect: 'Allow', action: ['files:GetFile'] }],
        },
      });
      apiKeyPolicyId = parseResult(policyRes).id;

      const res = await mcpCall('create-api-key', {
        name: 'MCP Test Key',
        project_id: projectId,
        policy_ids: [apiKeyPolicyId],
      });
      createApiKeyResult = parseResult(res);
      mcpApiKeyId = createApiKeyResult.id;
    });

    test('create-api-key creates a key', () => {
      expect(createApiKeyResult.id).toMatch(/^key_/);
      expect(createApiKeyResult.name).toBe('MCP Test Key');
      expect(createApiKeyResult.key).toMatch(/^sk_/); // only at creation
    });

    test('get-api-key returns the key', async () => {
      const res = await mcpCall('get-api-key', { api_key_id: mcpApiKeyId });

      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(mcpApiKeyId);
      expect(result.name).toBe('MCP Test Key');
      expect(result.key).toBeUndefined(); // not returned after creation
      expect(result.project_id).toBe(projectId);
      expect(result.policy_ids).toContain(apiKeyPolicyId);
    });

    test('update-api-key updates the key', async () => {
      const res = await mcpCall('update-api-key', {
        api_key_id: mcpApiKeyId,
        name: 'MCP Updated Key',
      });

      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(mcpApiKeyId);
      expect(result.name).toBe('MCP Updated Key');
    });

    test('delete-api-key deletes the key', async () => {
      const res = await mcpCall('delete-api-key', {
        api_key_id: mcpApiKeyId,
      });

      expect(res.status).toBe(200);
    });
  });

  // ── Traces ───────────────────────────────────────────────────────────────

  describe('Traces tools', () => {
    let tracesAgentId: string;
    let tracesProjectDbId: number;
    let mcpTraceId: string;
    let mcpChildTraceId: string;

    beforeAll(async () => {
      const agentRes = await mcpCall('create-agent', {
        project_id: projectId,
        ai_provider_id: chatAiProviderId,
        name: 'MCP Traces Agent',
      });
      tracesAgentId = parseResult(agentRes).id;

      const project = await db.Project.findOne({
        where: { publicId: projectId },
      });
      const internalProjectId = project!.id;
      tracesProjectDbId = internalProjectId;

      mcpTraceId = `trc_mcp_root_${Date.now()}`;
      mcpChildTraceId = `trc_mcp_child_${Date.now()}`;

      await saveTrace({
        traceId: mcpTraceId,
        projectId: internalProjectId,
        projectPublicId: projectId,
        agentId: tracesAgentId,
        steps: [{ type: 'text-delta', text: 'hello' }],
      });

      await saveTrace({
        traceId: mcpChildTraceId,
        projectId: internalProjectId,
        projectPublicId: projectId,
        agentId: tracesAgentId,
        steps: [{ type: 'text-delta', text: 'world' }],
        parentTraceId: mcpTraceId,
        rootTraceId: mcpTraceId,
      });
    });

    test('list-traces returns results after seeding', async () => {
      const res = await mcpCall('list-traces', { project_id: projectId });

      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(Array.isArray(result.data)).toBe(true);
      expect(
        result.data.some((t: { id: string }) => {
          return t.id === mcpTraceId;
        })
      ).toBe(true);
    });

    test('get-trace returns the trace', async () => {
      const res = await mcpCall('get-trace', { trace_id: mcpTraceId });

      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(mcpTraceId);
      expect(result.project_id).toBe(projectId);
    });

    test('get-trace-tree returns tree with child', async () => {
      const res = await mcpCall('get-trace-tree', { trace_id: mcpTraceId });

      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(mcpTraceId);
      expect(Array.isArray(result.children)).toBe(true);
      expect(result.children).toHaveLength(1);
      expect(result.children[0].id).toBe(mcpChildTraceId);
    });

    // Destructive, so it runs on its own trace rather than the shared fixture.
    test('purge-trace-content redacts the trace and returns the skeleton', async () => {
      const purgeTraceId = 'trc_mcp_purge_001';
      await saveTrace({
        traceId: purgeTraceId,
        projectId: tracesProjectDbId,
        projectPublicId: projectId,
        agentId: tracesAgentId,
        steps: [{ type: 'text-delta', text: 'purge me' }],
      });

      const res = await mcpCall('purge-trace-content', {
        trace_id: purgeTraceId,
      });

      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(purgeTraceId);
      expect(result.content_redacted_at).not.toBeNull();
      expect(result.file_id).toBeNull();
      // Skeleton survives — a purged trace is readable, not a 404.
      expect(result.step_count).toBe(1);
    });
  });

  // ── Docs ─────────────────────────────────────────────────────────────────

  describe('Docs tools', () => {
    const MOCK_LLMS_TXT =
      '# SOAT Documentation\n\n- [Agents](https://soat.ttoss.dev/docs/modules/agents)\n';
    const MOCK_PAGE = '# Agents\n\nAgents are the core reasoning units.\n';

    let fetchSpy: jest.SpyInstance;

    beforeEach(() => {
      fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockImplementation(async (url: RequestInfo | URL) => {
          const urlStr = url.toString();
          if (urlStr.endsWith('/llms.txt')) {
            return new Response(MOCK_LLMS_TXT, { status: 200 });
          }
          if (urlStr.includes('soat.ttoss.dev')) {
            return new Response(MOCK_PAGE, { status: 200 });
          }
          return new Response('Not Found', { status: 404 });
        });
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    test('get-docs returns the documentation index', async () => {
      const res = await mcpCall('get-docs');
      expect(res.status).toBe(200);
      const text = res.body.result?.content?.[0]?.text;
      expect(typeof text).toBe('string');
      expect(text).toContain('SOAT Documentation');
    });

    test('get-doc-page returns page content for a valid docs URL', async () => {
      const res = await mcpCall('get-doc-page', {
        url: 'https://soat.ttoss.dev/docs/modules/agents',
      });
      expect(res.status).toBe(200);
      const text = res.body.result?.content?.[0]?.text;
      expect(typeof text).toBe('string');
      expect(text).toContain('Agents');
    });

    test('get-docs returns an error when the fetch fails', async () => {
      fetchSpy.mockImplementation(async () => {
        return new Response('Gone', { status: 503 });
      });
      const res = await mcpCall('get-docs');
      expect(res.status).toBe(200);
      expect(res.body.result?.isError).toBe(true);
    });

    test('get-doc-page returns an error for an invalid URL', async () => {
      const res = await mcpCall('get-doc-page', { url: 'not-a-url' });
      expect(res.status).toBe(200);
      expect(res.body.result?.isError).toBe(true);
    });

    test('get-doc-page returns an error for a URL from a different domain', async () => {
      const res = await mcpCall('get-doc-page', {
        url: 'https://evil.example.com/steal',
      });
      expect(res.status).toBe(200);
      expect(res.body.result?.isError).toBe(true);
    });

    test('get-doc-page returns an error when the page fetch fails', async () => {
      fetchSpy.mockImplementation(async () => {
        return new Response('Not Found', { status: 404 });
      });
      const res = await mcpCall('get-doc-page', {
        url: 'https://soat.ttoss.dev/docs/modules/missing',
      });
      expect(res.status).toBe(200);
      expect(res.body.result?.isError).toBe(true);
    });
  });

  // ── Orchestrations ───────────────────────────────────────────────────────

  describe('Orchestration tools', () => {
    test('validate-orchestration returns valid=true for a sound graph', async () => {
      const res = await mcpCall('validate-orchestration', {
        nodes: [
          {
            id: 'a',
            type: 'transform',
            expression: 1,
            state_mapping: { 'state.step1': { var: 'output.result' } },
          },
          {
            id: 'b',
            type: 'transform',
            expression: 1,
            input_mapping: { val: { var: 'step1' } },
          },
        ],
        edges: [{ from: 'a', to: 'b' }],
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.valid).toBe(true);
    });

    test('validate-orchestration reports errors for an invalid graph', async () => {
      const res = await mcpCall('validate-orchestration', {
        nodes: [{ id: 'a', type: 'agent' }],
        edges: [{ from: 'a', to: 'ghost' }],
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    // Regression: https://github.com/ttoss/soat/issues/375
    // PATCH/DELETE-backed MCP tools surfaced DomainError bodies
    // (`{ error: { code, message } }`) as the unhelpful literal string
    // "[object Object]" instead of the DomainError's readable message —
    // while the equivalent GET tool surfaced it cleanly.
    test('get-orchestration surfaces a readable not-found message', async () => {
      const res = await mcpCall('get-orchestration', {
        orchestration_id: 'orch_doesnotexist',
      });
      expect(res.status).toBe(200);
      expect(res.body.result?.isError).toBe(true);
      const text = res.body.result?.content?.[0]?.text;
      expect(text).not.toContain('[object Object]');
      expect(text).toMatch(/not found/i);
    });

    test('update-orchestration on a nonexistent id surfaces a readable message, not [object Object]', async () => {
      const res = await mcpCall('update-orchestration', {
        orchestration_id: 'orch_doesnotexist',
        name: 'renamed',
      });
      expect(res.status).toBe(200);
      expect(res.body.result?.isError).toBe(true);
      const text = res.body.result?.content?.[0]?.text;
      expect(text).not.toContain('[object Object]');
      expect(text).toMatch(/not found/i);
    });

    test('delete-orchestration on a nonexistent id surfaces a readable message, not [object Object]', async () => {
      const res = await mcpCall('delete-orchestration', {
        orchestration_id: 'orch_doesnotexist',
      });
      expect(res.status).toBe(200);
      expect(res.body.result?.isError).toBe(true);
      const text = res.body.result?.content?.[0]?.text;
      expect(text).not.toContain('[object Object]');
      expect(text).toMatch(/not found/i);
    });
  });

  // ── Ingestion Rules ────────────────────────────────────────────────────────
  describe('Ingestion Rules tools', () => {
    let ruleToolId: string;
    let ruleId: string;
    let createRuleResult: {
      id: string;
      content_type_glob: string;
      tool_id: string;
      [key: string]: unknown;
    };

    beforeAll(async () => {
      const toolRes = await mcpCall('create-tool', {
        project_id: projectId,
        name: 'mcp-ocr-http',
        type: 'http',
        execute: { url: 'https://example.test/ocr', method: 'POST' },
      });
      ruleToolId = parseResult(toolRes).id;

      const res = await mcpCall('create-ingestion-rule', {
        project_id: projectId,
        content_type_glob: 'image/*',
        tool_id: ruleToolId,
        file_delivery: 'base64',
        chunk_strategy: 'whole',
      });
      createRuleResult = parseResult(res);
      ruleId = createRuleResult.id;
    });

    test('create-ingestion-rule creates a rule', () => {
      expect(createRuleResult.id).toMatch(/^igr_/);
      expect(createRuleResult.content_type_glob).toBe('image/*');
      expect(createRuleResult.tool_id).toBe(ruleToolId);
    });

    test('list-ingestion-rules returns the rule', async () => {
      const res = await mcpCall('list-ingestion-rules', {
        project_id: projectId,
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(Array.isArray(result.data)).toBe(true);
      expect(
        result.data.some((r: { id: string }) => {
          return r.id === ruleId;
        })
      ).toBe(true);
    });

    test('get-ingestion-rule returns the rule', async () => {
      const res = await mcpCall('get-ingestion-rule', {
        ingestion_rule_id: ruleId,
      });
      expect(res.status).toBe(200);
      expect(parseResult(res).id).toBe(ruleId);
    });

    test('delete-ingestion-rule removes the rule', async () => {
      const res = await mcpCall('delete-ingestion-rule', {
        ingestion_rule_id: ruleId,
      });
      expect(res.status).toBe(200);
    });
  });

  // ── Discussions ────────────────────────────────────────────────────────────

  describe('discussions', () => {
    let discussionId: string;
    let createDiscussionResult: { id: string; [key: string]: unknown };

    beforeAll(async () => {
      const res = await mcpCall('create-discussion', {
        project_id: projectId,
        name: 'MCP Panel',
        ai_provider_id: chatAiProviderId,
        participants: [{ name: 'A' }, { name: 'B' }],
      });
      createDiscussionResult = parseResult(res);
      discussionId = createDiscussionResult.id;
    });

    test('create-discussion creates a discussion', () => {
      expect(createDiscussionResult.id).toMatch(/^disc_/);
    });

    test('list-discussions returns discussions', async () => {
      const res = await mcpCall('list-discussions', {
        project_id: projectId,
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(Array.isArray(result.data)).toBe(true);
    });

    test('get-discussion returns the discussion', async () => {
      const res = await mcpCall('get-discussion', {
        discussion_id: discussionId,
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(discussionId);
    });

    test('update-discussion updates the discussion', async () => {
      const res = await mcpCall('update-discussion', {
        discussion_id: discussionId,
        name: 'MCP Panel Renamed',
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.name).toBe('MCP Panel Renamed');
    });

    test('create-discussion-run runs the discussion', async () => {
      const spy = jest
        .spyOn(discussionCompletion, 'runDiscussionCompletion')
        .mockResolvedValue('MCP outcome.');
      const res = await mcpCall('create-discussion-run', {
        discussion_id: discussionId,
        topic: 'What next?',
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toMatch(/^drn_/);
      expect(result.status).toBe('completed');
      spy.mockRestore();
    });

    test('list-discussion-runs lists the runs', async () => {
      const spy = jest
        .spyOn(discussionCompletion, 'runDiscussionCompletion')
        .mockResolvedValue('Filler outcome.');
      await mcpCall('create-discussion-run', {
        discussion_id: discussionId,
        topic: 'Filler run for listing.',
      });
      spy.mockRestore();

      const res = await mcpCall('list-discussion-runs', {
        discussion_id: discussionId,
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.total).toBeGreaterThan(0);
    });

    test('get-discussion-run returns the run', async () => {
      const spy = jest
        .spyOn(discussionCompletion, 'runDiscussionCompletion')
        .mockResolvedValue('MCP outcome for get.');
      const createRes = await mcpCall('create-discussion-run', {
        discussion_id: discussionId,
        topic: 'What next?',
      });
      spy.mockRestore();
      const runId = parseResult(createRes).id;

      const res = await mcpCall('get-discussion-run', { run_id: runId });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(runId);
    });

    test('delete-discussion deletes the discussion', async () => {
      const res = await mcpCall('delete-discussion', {
        discussion_id: discussionId,
      });
      expect(res.status).toBe(200);
    });
  });

  // ── Guardrails ─────────────────────────────────────────────────────────────
  // Regression: https://github.com/ttoss/soat/issues/651
  // A guardrail's `document` and an evaluation's `context_snapshot` are
  // free-form, JSON-Logic-bearing bags whose snake_case keys are contract
  // fields (`default_class`, `expires_in`) and fully-qualified var paths
  // (`soat.usage.cost_usd_24h`, `context.max_daily_budget`). The MCP surface
  // must preserve them verbatim, exactly as the REST caseTransform middleware
  // does — the earlier `snakeToCamelDeep` mangled them (`defaultClass`,
  // `costUsd_24h`), breaking read→write round-trips and the audit-key contract.
  describe('Guardrails', () => {
    let guardrailId: string;

    beforeAll(async () => {
      const res = await mcpCall('create-guardrail', {
        project_id: projectId,
        name: 'MCP Guardrail',
        document: {
          class: {
            if: [{ '<': [{ var: 'args.amount' }, 500] }, 'B', 'C'],
          },
          default_class: 'C',
          guard: {
            and: [
              {
                '<=': [
                  { var: 'args.amount' },
                  { var: 'context.max_daily_budget' },
                ],
              },
              { '<': [{ var: 'soat.usage.cost_usd_24h' }, 1000] },
            ],
          },
          expires_in: 259200,
        },
      });
      expect(res.status).toBe(200);
      guardrailId = parseResult(res).id;
    });

    test('get-guardrail preserves document contract keys verbatim (snake_case)', async () => {
      const res = await mcpCall('get-guardrail', {
        guardrail_id: guardrailId,
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      // Contract fields stay snake_case — not camelCased to defaultClass/expiresIn.
      expect(result.document.default_class).toBe('C');
      expect(result.document.expires_in).toBe(259200);
      expect(result.document.defaultClass).toBeUndefined();
      expect(result.document.expiresIn).toBeUndefined();
      // The guardrail's own SOAT fields are snake_case too.
      expect(result.context_mode).toBe('merge');
    });

    test('a document read via MCP can be written back without a 400', async () => {
      const getRes = await mcpCall('get-guardrail', {
        guardrail_id: guardrailId,
      });
      const document = parseResult(getRes).document;
      // Echo the exact document back — with the bug this carried `defaultClass`
      // and was rejected as an unknown field.
      const updRes = await mcpCall('update-guardrail', {
        guardrail_id: guardrailId,
        document,
      });
      expect(updRes.status).toBe(200);
      expect(updRes.body.result?.isError).toBeFalsy();
      const updated = parseResult(updRes);
      expect(updated.document.default_class).toBe('C');
    });

    test('evaluate-guardrail keeps context_snapshot var-path keys verbatim', async () => {
      const res = await mcpCall('evaluate-guardrail', {
        guardrail_id: guardrailId,
        args: { amount: 100 },
        guardrail_context: { max_daily_budget: 500 },
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.class).toBe('B');
      expect(result.decision).toBe('execute');
      const keys = Object.keys(result.context_snapshot);
      // Var paths are a fixed contract — snake_case, matching the soat.* catalog.
      expect(keys).toContain('args.amount');
      expect(keys).toContain('context.max_daily_budget');
      expect(keys).toContain('soat.usage.cost_usd_24h');
      // Not camel-mangled to non-catalog names.
      expect(keys).not.toContain('context.maxDailyBudget');
      expect(keys).not.toContain('soat.usage.costUsd_24h');
    });

    test('delete-guardrail removes the guardrail', async () => {
      const res = await mcpCall('delete-guardrail', {
        guardrail_id: guardrailId,
      });
      expect(res.status).toBe(200);
    });
  });
});

describe('MCP OAuth discovery (RFC 9728)', () => {
  let adminToken: string;

  beforeAll(async () => {
    adminToken = await loginAs('mcphappy', 'mcphappypass');
  });

  test('GET /.well-known/oauth-protected-resource returns protected resource metadata', async () => {
    const res = await testClient.get('/.well-known/oauth-protected-resource');
    expect(res.status).toBe(200);
    expect(typeof res.body.resource).toBe('string');
    expect(Array.isArray(res.body.authorization_servers)).toBe(true);
    expect(res.body.authorization_servers.length).toBeGreaterThan(0);
  });

  test('initialize without a token returns 401 with WWW-Authenticate header', async () => {
    // The handshake itself must be challenged so OAuth-aware clients (e.g.
    // Claude connectors) begin the OAuth flow instead of treating the server
    // as public.
    const res = await testClient
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBeDefined();
  });

  test('notifications/initialized without a token returns 401', async () => {
    const res = await testClient
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBeDefined();
  });

  test('initialize with a valid token returns 200', async () => {
    const res = await authenticatedTestClient(adminToken)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.result.serverInfo.name).toBe('soat');
  });

  test('tools/list without a token returns 401', async () => {
    const res = await testClient
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(401);
  });

  test('accepts an sk_ API key for authentication (#609)', async () => {
    // A valid, working API key (confirmed against REST below) must also
    // authenticate to the MCP endpoint — the documented headless-agent path.
    const keyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/api-keys')
      .send({ name: 'mcp-sk-key' });
    expect(keyRes.status).toBe(201);
    const rawKey = keyRes.body.key as string;
    expect(rawKey).toMatch(/^sk_/);

    // Sanity: the key works against REST.
    const rest = await authenticatedTestClient(rawKey).get('/api/v1/projects');
    expect(rest.status).toBe(200);

    // The same key against /mcp must succeed (previously a blanket 401).
    const res = await testClient
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .set('Authorization', `Bearer ${rawKey}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.result.tools)).toBe(true);
    expect(res.body.result.tools.length).toBeGreaterThan(0);

    // An invalid sk_ key is still rejected.
    const bad = await testClient
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .set('Authorization', 'Bearer sk_deadbeefdeadbeefdeadbeef')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(bad.status).toBe(401);
  });

  test('tools/call without a token returns 401 with WWW-Authenticate header', async () => {
    const res = await testClient
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list-agents', arguments: {} },
      });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBeDefined();
  });

  test('tools/call with an invalid token returns 401', async () => {
    const res = await testClient
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .set('Authorization', 'Bearer invalid.token.here')
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'list-agents', arguments: {} },
      });
    expect(res.status).toBe(401);
  });
});
