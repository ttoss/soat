import { authenticatedTestClient, loginAs, testClient } from '../testClient';

describe('MCP tools/list', () => {
  test('registers the expected tools', async () => {
    const res = await testClient
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

    expect(res.status).toBe(200);
    const tools: { name: string }[] = res.body.result.tools;
    const names = tools.map((t) => {
      return t.name;
    });
    expect(names).toContain('list-files');
    expect(names).toContain('get-file');
    expect(names).toContain('create-file');
    expect(names).toContain('delete-file');
    expect(names).toContain('update-actor');
    expect(names).toContain('upload-file');
    expect(names).toContain('download-file');
    expect(names).toContain('update-file-metadata');
  });
});

describe('MCP get-* tools with nonexistent ids', () => {
  let adminToken: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'mcpadmin', password: 'mcppass' });
    adminToken = await loginAs('mcpadmin', 'mcppass');
  });

  const mcpCall = (
    token: string,
    toolName: string,
    args: Record<string, string>
  ) => {
    return authenticatedTestClient(token)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      });
  };

  test('get-document with nonexistent id returns structured JSON error', async () => {
    const res = await mcpCall(adminToken, 'get-document', {
      id: 'doc_nonexistent_xyz',
    });
    expect(res.status).toBe(200);
    const text = res.body.result?.content?.[0]?.text;
    expect(text).toBeDefined();
    const parsed = JSON.parse(text);
    expect(parsed.error).toBe('not_found');
  });

  test('get-actor with nonexistent id returns structured JSON error', async () => {
    const res = await mcpCall(adminToken, 'get-actor', {
      id: 'actor_nonexistent_xyz',
    });
    expect(res.status).toBe(200);
    const text = res.body.result?.content?.[0]?.text;
    expect(text).toBeDefined();
    const parsed = JSON.parse(text);
    expect(parsed.error).toBe('not_found');
  });

  test('get-conversation with nonexistent id returns structured JSON error', async () => {
    const res = await mcpCall(adminToken, 'get-conversation', {
      id: 'conv_nonexistent_xyz',
    });
    expect(res.status).toBe(200);
    const text = res.body.result?.content?.[0]?.text;
    expect(text).toBeDefined();
    const parsed = JSON.parse(text);
    expect(parsed.error).toBe('not_found');
  });
});
