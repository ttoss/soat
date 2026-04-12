import { testClient } from '../testClient';

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
