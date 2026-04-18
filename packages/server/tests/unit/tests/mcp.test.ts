import type http from 'node:http';

import { app } from 'src/app';

import { authenticatedTestClient, loginAs, testClient } from '../testClient';

let httpServer: http.Server;

beforeAll((done) => {
  httpServer = app.listen(5047, done);
});

afterAll((done) => {
  httpServer?.close(done);
});

describe('MCP tools - happy path', () => {
  let adminToken: string;
  let projectId: string;
  let setupActorId: string;
  let chatAiProviderId: string;

  let fileId: string;
  let actorId: string;
  let conversationId: string;
  let messageDocumentId: string;
  let documentId: string;
  let secretId: string;
  let testAiProviderId: string;
  let chatId: string;

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
      .send({ projectId, name: 'Setup Actor' });
    setupActorId = actorRes.body.id;

    const aiRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        projectId,
        name: 'Chat Provider',
        provider: 'ollama',
        defaultModel: 'llama3',
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
    body: { result?: { content?: [{ text: string }] } };
  }) => {
    const text = res.body.result?.content?.[0]?.text;
    return text ? JSON.parse(text) : null;
  };

  // ── Files ────────────────────────────────────────────────────────────────

  test('upload-file creates a file', async () => {
    const res = await mcpCall('upload-file', {
      projectId,
      content: Buffer.from('hello mcp').toString('base64'),
      filename: 'mcp-test.txt',
    });
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(result.id).toBeDefined();
    fileId = result.id;
  });

  test('list-files returns data array', async () => {
    const res = await mcpCall('list-files');
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(Array.isArray(result.data)).toBe(true);
  });

  test('get-file returns the file', async () => {
    const res = await mcpCall('get-file', { id: fileId });
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(result.id).toBe(fileId);
  });

  test('download-file returns base64 content', async () => {
    const res = await mcpCall('download-file', { id: fileId });
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(result.content).toBeDefined();
  });

  test('update-file-metadata renames the file', async () => {
    const res = await mcpCall('update-file-metadata', {
      id: fileId,
      filename: 'mcp-renamed.txt',
    });
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(result.id).toBe(fileId);
  });

  test('create-file registers a file record', async () => {
    const res = await mcpCall('create-file', {
      projectId,
      storageType: 'local',
      storagePath: '/tmp/mcp-registered.txt',
      filename: 'mcp-registered.txt',
    });
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(result.id).toBeDefined();
  });

  test('delete-file deletes the file', async () => {
    const res = await mcpCall('delete-file', { id: fileId });
    expect(res.status).toBe(200);
  });

  // ── Actors ───────────────────────────────────────────────────────────────

  test('create-actor creates an actor', async () => {
    const res = await mcpCall('create-actor', {
      projectId,
      name: 'MCP Actor',
    });
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(result.id).toBeDefined();
    actorId = result.id;
  });

  test('list-actors returns data array', async () => {
    const res = await mcpCall('list-actors');
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(Array.isArray(result.data)).toBe(true);
  });

  test('update-actor updates the name', async () => {
    const res = await mcpCall('update-actor', {
      id: actorId,
      name: 'MCP Actor Updated',
    });
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(result.id).toBe(actorId);
  });

  test('get-actor returns the actor', async () => {
    const res = await mcpCall('get-actor', { id: actorId });
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(result.id).toBe(actorId);
  });

  test('delete-actor deletes the actor', async () => {
    const res = await mcpCall('delete-actor', { id: actorId });
    expect(res.status).toBe(200);
  });

  // ── Conversations ─────────────────────────────────────────────────────────

  test('create-conversation creates a conversation', async () => {
    const res = await mcpCall('create-conversation', { projectId });
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(result.id).toBeDefined();
    conversationId = result.id;
  });

  test('list-conversations returns data array', async () => {
    const res = await mcpCall('list-conversations');
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(Array.isArray(result.data)).toBe(true);
  });

  test('add-conversation-message adds a message', async () => {
    const res = await mcpCall('add-conversation-message', {
      id: conversationId,
      message: 'hello from mcp',
      actorId: setupActorId,
    });
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(result.documentId).toBeDefined();
    messageDocumentId = result.documentId;
  });

  test('list-conversation-messages returns data array', async () => {
    const res = await mcpCall('list-conversation-messages', {
      id: conversationId,
    });
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(Array.isArray(result.data)).toBe(true);
  });

  test('list-conversation-actors returns results', async () => {
    const res = await mcpCall('list-conversation-actors', {
      id: conversationId,
    });
    expect(res.status).toBe(200);
  });

  test('get-conversation returns the conversation', async () => {
    const res = await mcpCall('get-conversation', { id: conversationId });
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(result.id).toBe(conversationId);
  });

  test('remove-conversation-message removes the message', async () => {
    const res = await mcpCall('remove-conversation-message', {
      id: conversationId,
      documentId: messageDocumentId,
    });
    expect(res.status).toBe(200);
  });

  test('update-conversation updates the status', async () => {
    const res = await mcpCall('update-conversation', {
      id: conversationId,
      status: 'closed',
    });
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(result.id).toBe(conversationId);
  });

  test('delete-conversation deletes the conversation', async () => {
    const res = await mcpCall('delete-conversation', { id: conversationId });
    expect(res.status).toBe(200);
  });

  // ── Documents ────────────────────────────────────────────────────────────

  test('create-document creates a document', async () => {
    const res = await mcpCall('create-document', {
      projectId,
      content: 'MCP test document content',
    });
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(result.id).toBeDefined();
    documentId = result.id;
  });

  test('list-documents returns data array', async () => {
    const res = await mcpCall('list-documents');
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(Array.isArray(result.data)).toBe(true);
  });

  test('update-document updates content', async () => {
    const res = await mcpCall('update-document', {
      id: documentId,
      content: 'MCP updated content',
    });
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(result.id).toBe(documentId);
  });

  test('get-document returns the document', async () => {
    const res = await mcpCall('get-document', { id: documentId });
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(result.id).toBe(documentId);
  });

  test('search-documents returns results', async () => {
    const res = await mcpCall('search-documents', { query: 'mcp test' });
    expect(res.status).toBe(200);
  });

  test('delete-document deletes the document', async () => {
    const res = await mcpCall('delete-document', { id: documentId });
    expect(res.status).toBe(200);
  });

  // ── Projects ─────────────────────────────────────────────────────────────

  test('list-projects returns results', async () => {
    const res = await mcpCall('list-projects');
    expect(res.status).toBe(200);
  });

  test('get-project returns the project', async () => {
    const res = await mcpCall('get-project', { id: projectId });
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(result.id).toBe(projectId);
  });

  // ── Secrets ──────────────────────────────────────────────────────────────

  test('create-secret creates a secret', async () => {
    const res = await mcpCall('create-secret', {
      projectId,
      name: 'mcp-secret',
      value: 'supersecretvalue',
    });
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(result.id).toBeDefined();
    expect(result.hasValue).toBe(true);
    secretId = result.id;
  });

  test('list-secrets returns array', async () => {
    const res = await mcpCall('list-secrets');
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(Array.isArray(result)).toBe(true);
  });

  test('get-secret returns the secret', async () => {
    const res = await mcpCall('get-secret', { id: secretId });
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(result.id).toBe(secretId);
  });

  test('update-secret updates the name', async () => {
    const res = await mcpCall('update-secret', {
      id: secretId,
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

  // ── AI Providers ──────────────────────────────────────────────────────────

  test('create-ai-provider creates a provider', async () => {
    const res = await mcpCall('create-ai-provider', {
      projectId,
      name: 'Test Provider',
      provider: 'ollama',
      defaultModel: 'llama3',
    });
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(result.id).toBeDefined();
    testAiProviderId = result.id;
  });

  test('create-ai-provider with apiKey auto-creates a secret', async () => {
    const res = await mcpCall('create-ai-provider', {
      projectId,
      name: 'xAI Provider',
      provider: 'xai',
      defaultModel: 'grok-3-mini',
      apiKey: 'xai-test-key-12345',
    });
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(result.id).toBeDefined();
    expect(result.secretId).toBeDefined();
    // clean up
    await mcpCall('delete-ai-provider', { id: result.id });
  });

  test('create-ai-provider rejects when both secretId and apiKey are provided', async () => {
    const res = await mcpCall('create-ai-provider', {
      projectId,
      name: 'Conflict Provider',
      provider: 'xai',
      defaultModel: 'grok-3-mini',
      secretId: 'sec_fake',
      apiKey: 'xai-test-key-12345',
    });
    expect(res.status).toBe(200);
    expect(res.body.result?.isError).toBe(true);
    const result = parseResult(res);
    expect(result.error).toBe('Provide either secretId or apiKey, not both.');
  });

  test('list-ai-providers returns results', async () => {
    const res = await mcpCall('list-ai-providers');
    expect(res.status).toBe(200);
  });

  test('get-ai-provider returns the provider', async () => {
    const res = await mcpCall('get-ai-provider', { id: testAiProviderId });
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(result.id).toBe(testAiProviderId);
  });

  test('update-ai-provider updates the name', async () => {
    const res = await mcpCall('update-ai-provider', {
      id: testAiProviderId,
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

  // ── Chats ─────────────────────────────────────────────────────────────────

  test('create-chat creates a chat', async () => {
    const res = await mcpCall('create-chat', {
      projectId,
      aiProviderId: chatAiProviderId,
      name: 'MCP Chat',
    });
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(result.id).toBeDefined();
    chatId = result.id;
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

  // ── Agents ──────────────────────────────────────────────────────────────

  let agentToolId: string;
  let agentId: string;

  test('create-agent-tool creates a tool', async () => {
    const res = await mcpCall('create-agent-tool', {
      projectId,
      name: 'mcp-test-tool',
      type: 'http',
      description: 'A test tool',
    });
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(result.id).toBeDefined();
    agentToolId = result.id;
  });

  test('list-agent-tools returns results', async () => {
    const res = await mcpCall('list-agent-tools');
    expect(res.status).toBe(200);
  });

  test('get-agent-tool returns the tool', async () => {
    const res = await mcpCall('get-agent-tool', { toolId: agentToolId });
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(result.id).toBe(agentToolId);
  });

  test('update-agent-tool updates the tool', async () => {
    const res = await mcpCall('update-agent-tool', {
      toolId: agentToolId,
      name: 'mcp-test-tool-renamed',
    });
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(result.id).toBe(agentToolId);
  });

  test('create-agent creates an agent', async () => {
    const res = await mcpCall('create-agent', {
      projectId,
      aiProviderId: chatAiProviderId,
      name: 'MCP Agent',
    });
    expect(res.status).toBe(200);
    const result = parseResult(res);
    expect(result.id).toBeDefined();
    agentId = result.id;
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

  test('delete-agent-tool deletes the tool', async () => {
    const res = await mcpCall('delete-agent-tool', { toolId: agentToolId });
    expect(res.status).toBe(200);
  });

  // create-agent-generation is skipped because it requires a live AI service.
});
