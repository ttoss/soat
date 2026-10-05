import { dispatchMcpApiRequest } from 'src/mcp/dispatchApi';

/**
 * Outside an MCP request `getApiHeaders()` is `{}`, so the dispatch carries an
 * empty credential rather than none. No entry point reaches this: every MCP
 * tool handler runs inside a request whose bearer token the endpoint already
 * verified. What it pins is that sharing a process never lends authority —
 * the in-process call is refused by the same auth middleware as a wire call,
 * and the refusal's own message, not a bare status, is what surfaces.
 */
describe('dispatchMcpApiRequest outside an MCP request', () => {
  test('is refused by auth with the API error message', async () => {
    const call = dispatchMcpApiRequest({
      method: 'GET',
      url: '/api/v1/agents',
    });

    await expect(call).rejects.toThrow(Error);
    await expect(call).rejects.not.toThrow(/^HTTP \d{3}$/);
  });
});
