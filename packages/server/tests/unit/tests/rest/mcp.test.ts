import type http from 'node:http';

import { app } from 'src/app';
import { db } from 'src/db';
import * as discussionCompletion from 'src/lib/discussionCompletion';
import * as pdfModule from 'src/lib/pdf';
import { saveTrace } from 'src/lib/traces';

import { ONE_PAGE_PDF_BUFFER } from '../../fixtures/pdf';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

let httpServer: http.Server;

beforeAll(async () => {
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

  test('upload-file-with-token uploads via a presigned token', async () => {
    const presigned = parseResult(
      await mcpCall('create-presigned-url', {
        projectId,
        prefix: '/mcp',
        filename: 'mcp-token-upload.txt',
      })
    );
    expect(presigned.uploadToken).toMatch(/^upt_/);

    const res = await mcpCall('upload-file-with-token', {
      token: presigned.uploadToken,
      content: Buffer.from('uploaded via mcp token').toString('base64'),
    });
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(result.id).toBeDefined();
    expect(result.filename).toBe('mcp-token-upload.txt');
  });

  // ── Files ────────────────────────────────────────────────────────────────

  describe('Files tools', () => {
    let fileId: string;
    let createFileResult: { id: string; [key: string]: unknown };

    beforeAll(async () => {
      const res = await mcpCall('upload-file-base64', {
        projectId,
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
      const res = await mcpCall('get-file', { fileId });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(fileId);
    });

    test('download-file returns base64 content', async () => {
      const res = await mcpCall('download-file-base64', { fileId });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.content).toBeDefined();
    });

    test('update-file-metadata renames the file', async () => {
      const res = await mcpCall('update-file-metadata', {
        fileId,
        filename: 'mcp-renamed.txt',
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(fileId);
    });

    test('create-file registers a file record', async () => {
      const res = await mcpCall('create-file', {
        projectId,
        filename: 'mcp-registered.txt',
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBeDefined();
    });

    test('delete-file deletes the file', async () => {
      const res = await mcpCall('delete-file', { fileId });
      expect(res.status).toBe(200);
    });
  });

  // ── Actors ───────────────────────────────────────────────────────────────

  describe('Actors tools', () => {
    let actorId: string;
    let createActorResult: { id: string; [key: string]: unknown };

    beforeAll(async () => {
      const res = await mcpCall('create-actor', {
        projectId,
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
        actorId,
        name: 'MCP Actor Updated',
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(actorId);
    });

    test('get-actor returns the actor', async () => {
      const res = await mcpCall('get-actor', { actorId });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(actorId);
    });

    test('delete-actor deletes the actor', async () => {
      const res = await mcpCall('delete-actor', { actorId });
      expect(res.status).toBe(200);
    });
  });

  // ── Conversations ─────────────────────────────────────────────────────────

  describe('Conversations tools', () => {
    let conversationId: string;
    let createConversationResult: { id: string; [key: string]: unknown };

    beforeAll(async () => {
      const res = await mcpCall('create-conversation', { projectId });
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
        conversationId,
        message: 'hello from mcp',
        role: 'user',
        actorId: setupActorId,
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.documentId).toBeDefined();
    });

    test('list-conversation-messages returns data array', async () => {
      const res = await mcpCall('list-conversation-messages', {
        conversationId,
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(Array.isArray(result.data)).toBe(true);
    });

    test('list-actors filtered by conversationId returns results', async () => {
      const res = await mcpCall('list-actors', {
        conversationId,
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(Array.isArray(result.data)).toBe(true);
    });

    test('get-conversation returns the conversation', async () => {
      const res = await mcpCall('get-conversation', { conversationId });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(conversationId);
    });

    test('remove-conversation-message removes the message', async () => {
      const addRes = await mcpCall('add-conversation-message', {
        conversationId,
        message: 'message to remove',
        role: 'user',
        actorId: setupActorId,
      });
      const documentId = parseResult(addRes).documentId;

      const res = await mcpCall('remove-conversation-message', {
        conversationId,
        documentId,
      });
      expect(res.status).toBe(200);
    });

    test('update-conversation updates the status', async () => {
      const res = await mcpCall('update-conversation', {
        conversationId,
        status: 'closed',
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(conversationId);
    });

    test('delete-conversation deletes the conversation', async () => {
      const res = await mcpCall('delete-conversation', { conversationId });
      expect(res.status).toBe(200);
    });
  });

  // ── Documents ────────────────────────────────────────────────────────────

  describe('Documents tools', () => {
    let documentId: string;
    let createDocumentResult: { id: string; [key: string]: unknown };

    beforeAll(async () => {
      const res = await mcpCall('create-document', {
        projectId,
        content: 'MCP test document content',
      });
      createDocumentResult = parseResult(res);
      documentId = createDocumentResult.id;
    });

    test('create-document creates a document', () => {
      expect(createDocumentResult.id).toBeDefined();
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
          fileId: pdfFileId,
          projectId,
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
          const pollRes = await mcpCall('get-document', { documentId: docId });
          doc = parseResult(pollRes);
        }
        expect(doc.status).toBe('ready');
        expect(
          (doc.metadata as { chunkCount?: number })?.chunkCount
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
        documentId,
        content: 'MCP updated content',
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(documentId);
    });

    test('get-document returns the document', async () => {
      const res = await mcpCall('get-document', { documentId });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(documentId);
    });

    test('get-document-status returns a lightweight status payload', async () => {
      const res = await mcpCall('get-document-status', { documentId });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(documentId);
      expect(result.status).toBe('ready');
      // The heavy chunk content must not be present on the status tool.
      expect(result.content).toBeUndefined();
    });

    test('reingest-document re-processes an existing document', async () => {
      const res = await mcpCall('reingest-document', {
        documentId,
        async: false,
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(documentId);
      expect(result.status).toBe('ready');
    });

    test('search-documents returns results', async () => {
      const res = await mcpCall('search-documents', { query: 'mcp test' });
      expect(res.status).toBe(200);
    });

    test('delete-document deletes the document', async () => {
      const res = await mcpCall('delete-document', { documentId });
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
      const res = await mcpCall('get-project', { projectId });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(projectId);
    });

    test('update-project renames the project', async () => {
      const res = await mcpCall('update-project', {
        projectId,
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
        projectId,
        name: 'mcp-secret',
        value: 'supersecretvalue',
      });
      createSecretResult = parseResult(res);
      secretId = createSecretResult.id;
    });

    test('create-secret creates a secret', () => {
      expect(createSecretResult.id).toBeDefined();
      expect(createSecretResult.hasValue).toBe(true);
    });

    test('list-secrets returns array', async () => {
      const res = await mcpCall('list-secrets');
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(Array.isArray(result)).toBe(true);
    });

    test('get-secret returns the secret', async () => {
      const res = await mcpCall('get-secret', { secretId });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(secretId);
    });

    test('update-secret updates the name', async () => {
      const res = await mcpCall('update-secret', {
        secretId,
        name: 'mcp-secret-renamed',
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(secretId);
    });

    test('delete-secret deletes the secret', async () => {
      const res = await mcpCall('delete-secret', { id: secretId });
      expect(res.status).toBe(200);
    });
  });

  // ── AI Providers ──────────────────────────────────────────────────────────

  describe('AI Providers tools', () => {
    let testAiProviderId: string;
    let createAiProviderResult: { id: string; [key: string]: unknown };

    beforeAll(async () => {
      const res = await mcpCall('create-ai-provider', {
        projectId,
        name: 'Test Provider',
        provider: 'ollama',
        defaultModel: 'llama3',
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
        aiProviderId: testAiProviderId,
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(testAiProviderId);
    });

    test('update-ai-provider updates the name', async () => {
      const res = await mcpCall('update-ai-provider', {
        aiProviderId: testAiProviderId,
        name: 'Test Provider Updated',
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(testAiProviderId);
    });

    test('delete-ai-provider deletes the provider', async () => {
      const res = await mcpCall('delete-ai-provider', { id: testAiProviderId });
      expect(res.status).toBe(200);
    });
  });

  // ── Chats ─────────────────────────────────────────────────────────────────

  describe('Chats tools', () => {
    let chatId: string;
    let createChatResult: { id: string; [key: string]: unknown };

    beforeAll(async () => {
      const res = await mcpCall('create-chat', {
        projectId,
        aiProviderId: chatAiProviderId,
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
      const res = await mcpCall('get-chat', { chatId });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(chatId);
    });

    test('delete-chat deletes the chat', async () => {
      const res = await mcpCall('delete-chat', { chatId });
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
        projectId,
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
      const res = await mcpCall('get-tool', { toolId });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(toolId);
    });

    test('update-tool updates the tool', async () => {
      const res = await mcpCall('update-tool', {
        toolId,
        name: 'mcp-test-tool-renamed',
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(toolId);
    });

    test('delete-tool deletes the tool', async () => {
      const res = await mcpCall('delete-tool', { toolId });
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
        projectId,
        aiProviderId: chatAiProviderId,
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
      const res = await mcpCall('get-agent', { agentId });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(agentId);
    });

    test('update-agent updates the agent', async () => {
      const res = await mcpCall('update-agent', {
        agentId,
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
      const res = await mcpCall('delete-agent', { agentId });
      expect(res.status).toBe(200);
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
        projectId,
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
      const res = await mcpCall('list-webhooks', { projectId });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    });

    test('get-webhook returns the webhook', async () => {
      const res = await mcpCall('get-webhook', { projectId, webhookId });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(webhookId);
    });

    test('update-webhook updates the webhook', async () => {
      const res = await mcpCall('update-webhook', {
        projectId,
        webhookId,
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
        projectId,
        webhookId,
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.secret).toBeDefined();
    });

    test('list-webhook-deliveries returns results', async () => {
      const res = await mcpCall('list-webhook-deliveries', {
        projectId,
        webhookId,
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.data).toBeDefined();
      expect(Array.isArray(result.data)).toBe(true);
    });

    test('delete-webhook deletes the webhook', async () => {
      const res = await mcpCall('delete-webhook', { projectId, webhookId });
      expect(res.status).toBe(200);
    });
  });

  // ── Sessions ─────────────────────────────────────────────────────────────

  describe('Sessions tools', () => {
    let sessionAgentId: string;
    let sessionId: string;
    let createSessionResult: {
      id: string;
      agentId: string;
      conversationId: string;
      [key: string]: unknown;
    };

    beforeAll(async () => {
      const agentRes = await mcpCall('create-agent', {
        projectId,
        aiProviderId: chatAiProviderId,
        name: 'MCP Session Agent',
      });
      sessionAgentId = parseResult(agentRes).id;

      const res = await mcpCall('create-session', {
        agentId: sessionAgentId,
        name: 'MCP Test Session',
      });
      createSessionResult = parseResult(res);
      sessionId = createSessionResult.id;
    });

    test('create-session creates a session', () => {
      expect(createSessionResult.id).toMatch(/^sess_/);
      expect(createSessionResult.agentId).toBe(sessionAgentId);
      expect(createSessionResult.conversationId).toBeDefined();
    });

    test('create-session accepts toolContext', async () => {
      const res = await mcpCall('create-session', {
        agentId: sessionAgentId,
        toolContext: { userId: 'u1' },
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.toolContext).toEqual({ userId: 'u1' });
    });

    test('list-sessions filtered by agentId returns sessions', async () => {
      const res = await mcpCall('list-sessions', {
        agentId: sessionAgentId,
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data.length).toBeGreaterThan(0);
    });

    test('get-session returns session details', async () => {
      const res = await mcpCall('get-session', {
        sessionId,
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(sessionId);
      expect(result.name).toBe('MCP Test Session');
    });

    test('add-session-message adds a user message and returns 201 body', async () => {
      const res = await mcpCall('add-session-message', {
        sessionId,
        message: 'hello from mcp session',
      });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.role).toBe('user');
      expect(result.content).toBe('hello from mcp session');
    });

    test('delete-session deletes the session', async () => {
      const res = await mcpCall('delete-session', {
        sessionId,
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

    test('list-policies returns results', async () => {
      const res = await mcpCall('list-policies');

      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(Array.isArray(result)).toBe(true);
      expect(
        result.some((p: { id: string }) => {
          return p.id === mcpPolicyId;
        })
      ).toBe(true);
    });

    test('get-policy returns the policy', async () => {
      const res = await mcpCall('get-policy', { policyId: mcpPolicyId });

      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(mcpPolicyId);
      expect(result.name).toBe('MCP Test Policy');
    });

    test('update-policy updates the policy', async () => {
      const res = await mcpCall('update-policy', {
        policyId: mcpPolicyId,
        name: 'MCP Updated Policy',
        document: {
          statement: [
            { effect: 'Allow', action: ['files:GetFile', 'files:ListFiles'] },
          ],
        },
      });

      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(mcpPolicyId);
      expect(result.name).toBe('MCP Updated Policy');
      expect(result.document.statement[0].action).toContain('files:ListFiles');
    });

    test('delete-policy deletes the policy', async () => {
      const res = await mcpCall('delete-policy', { policyId: mcpPolicyId });

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
        projectId,
        policyIds: [apiKeyPolicyId],
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
      const res = await mcpCall('get-api-key', { apiKeyId: mcpApiKeyId });

      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(mcpApiKeyId);
      expect(result.name).toBe('MCP Test Key');
      expect(result.key).toBeUndefined(); // not returned after creation
      expect(result.projectId).toBe(projectId);
      expect(result.policyIds).toContain(apiKeyPolicyId);
    });

    test('update-api-key updates the key', async () => {
      const res = await mcpCall('update-api-key', {
        apiKeyId: mcpApiKeyId,
        name: 'MCP Updated Key',
      });

      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(mcpApiKeyId);
      expect(result.name).toBe('MCP Updated Key');
    });

    test('delete-api-key deletes the key', async () => {
      const res = await mcpCall('delete-api-key', { apiKeyId: mcpApiKeyId });

      expect(res.status).toBe(200);
    });
  });

  // ── Traces ───────────────────────────────────────────────────────────────

  describe('Traces tools', () => {
    let tracesAgentId: string;
    let mcpTraceId: string;
    let mcpChildTraceId: string;

    beforeAll(async () => {
      const agentRes = await mcpCall('create-agent', {
        projectId,
        aiProviderId: chatAiProviderId,
        name: 'MCP Traces Agent',
      });
      tracesAgentId = parseResult(agentRes).id;

      const project = await db.Project.findOne({
        where: { publicId: projectId },
      });
      const internalProjectId = project!.id;

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
      const res = await mcpCall('list-traces', { projectId });

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
      const res = await mcpCall('get-trace', { traceId: mcpTraceId });

      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(mcpTraceId);
      expect(result.projectId).toBe(projectId);
    });

    test('get-trace-tree returns tree with child', async () => {
      const res = await mcpCall('get-trace-tree', { traceId: mcpTraceId });

      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(mcpTraceId);
      expect(Array.isArray(result.children)).toBe(true);
      expect(result.children).toHaveLength(1);
      expect(result.children[0].id).toBe(mcpChildTraceId);
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
            outputMapping: { result: 'state.step1' },
          },
          {
            id: 'b',
            type: 'transform',
            expression: 1,
            inputMapping: { val: { var: 'step1' } },
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
        orchestrationId: 'orch_doesnotexist',
      });
      expect(res.status).toBe(200);
      expect(res.body.result?.isError).toBe(true);
      const text = res.body.result?.content?.[0]?.text;
      expect(text).not.toContain('[object Object]');
      expect(text).toMatch(/not found/i);
    });

    test('update-orchestration on a nonexistent id surfaces a readable message, not [object Object]', async () => {
      const res = await mcpCall('update-orchestration', {
        orchestrationId: 'orch_doesnotexist',
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
        orchestrationId: 'orch_doesnotexist',
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
      contentTypeGlob: string;
      toolId: string;
      [key: string]: unknown;
    };

    beforeAll(async () => {
      const toolRes = await mcpCall('create-tool', {
        projectId,
        name: 'mcp-ocr-http',
        type: 'http',
        execute: { url: 'https://example.test/ocr', method: 'POST' },
      });
      ruleToolId = parseResult(toolRes).id;

      const res = await mcpCall('create-ingestion-rule', {
        projectId,
        contentTypeGlob: 'image/*',
        toolId: ruleToolId,
        fileDelivery: 'base64',
        chunkStrategy: 'whole',
      });
      createRuleResult = parseResult(res);
      ruleId = createRuleResult.id;
    });

    test('create-ingestion-rule creates a rule', () => {
      expect(createRuleResult.id).toMatch(/^igr_/);
      expect(createRuleResult.contentTypeGlob).toBe('image/*');
      expect(createRuleResult.toolId).toBe(ruleToolId);
    });

    test('list-ingestion-rules returns the rule', async () => {
      const res = await mcpCall('list-ingestion-rules', { projectId });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(Array.isArray(result)).toBe(true);
      expect(
        result.some((r: { id: string }) => {
          return r.id === ruleId;
        })
      ).toBe(true);
    });

    test('get-ingestion-rule returns the rule', async () => {
      const res = await mcpCall('get-ingestion-rule', {
        ingestionRuleId: ruleId,
      });
      expect(res.status).toBe(200);
      expect(parseResult(res).id).toBe(ruleId);
    });

    test('delete-ingestion-rule removes the rule', async () => {
      const res = await mcpCall('delete-ingestion-rule', {
        ingestionRuleId: ruleId,
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
        projectId,
        name: 'MCP Panel',
        aiProviderId: chatAiProviderId,
        participants: [{ name: 'A' }, { name: 'B' }],
      });
      createDiscussionResult = parseResult(res);
      discussionId = createDiscussionResult.id;
    });

    test('create-discussion creates a discussion', () => {
      expect(createDiscussionResult.id).toMatch(/^disc_/);
    });

    test('list-discussions returns discussions', async () => {
      const res = await mcpCall('list-discussions', { projectId });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(Array.isArray(result.data)).toBe(true);
    });

    test('get-discussion returns the discussion', async () => {
      const res = await mcpCall('get-discussion', { discussionId });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(discussionId);
    });

    test('update-discussion updates the discussion', async () => {
      const res = await mcpCall('update-discussion', {
        discussionId,
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
        discussionId,
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
        discussionId,
        topic: 'Filler run for listing.',
      });
      spy.mockRestore();

      const res = await mcpCall('list-discussion-runs', { discussionId });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.total).toBeGreaterThan(0);
    });

    test('get-discussion-run returns the run', async () => {
      const spy = jest
        .spyOn(discussionCompletion, 'runDiscussionCompletion')
        .mockResolvedValue('MCP outcome for get.');
      const createRes = await mcpCall('create-discussion-run', {
        discussionId,
        topic: 'What next?',
      });
      spy.mockRestore();
      const runId = parseResult(createRes).id;

      const res = await mcpCall('get-discussion-run', { runId });
      expect(res.status).toBe(200);
      const result = parseResult(res);
      expect(result.id).toBe(runId);
    });

    test('delete-discussion deletes the discussion', async () => {
      const res = await mcpCall('delete-discussion', { discussionId });
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
