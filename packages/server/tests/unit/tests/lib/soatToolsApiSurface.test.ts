import { soatTools } from 'src/lib/soatTools';

/**
 * The generated client surfaces — MCP tools, the SDK, the CLI — wrap the REST
 * API, which lives entirely under `/api/v1`.
 *
 * `oauth.yaml` describes endpoints that do not: `/authorize`, `/token`,
 * `/register` and the two `.well-known` documents are mounted at the root by
 * `@ttoss/auth-core`, with paths the RFCs fix. They are in a spec so that a
 * client can *find* the flow (#1099), and wrapping them would be wrong rather
 * than merely useless: `/authorize` is a browser redirect with no response body
 * to return, and `/token` takes a form-encoded body that a JSON-shaped
 * generated caller cannot send. An agent handed a `soat`-namespaced tool for
 * either would be handed a broken one.
 *
 * So the rule is the path prefix, and it is checked rather than remembered —
 * the next spec that describes a root-level protocol endpoint inherits it.
 */
describe('generated tool surface covers the REST API only', () => {
  test('every tool targets a path under /api/v1', () => {
    const offenders = soatTools
      .filter((tool) => {
        return !tool.path({}).startsWith('/api/v1/');
      })
      .map((tool) => {
        return `${tool.name} → ${tool.method} ${tool.path({})}`;
      });

    expect(offenders).toEqual([]);
  });

  test('no tool is generated for the OAuth protocol endpoints', () => {
    const names = soatTools.map((tool) => {
      return tool.name;
    });

    for (const excluded of [
      'get-oauth-authorization-server-metadata',
      'get-oauth-protected-resource-metadata',
      'register-oauth-client',
      'authorize-oauth-client',
      'create-oauth-token',
    ]) {
      expect(names).not.toContain(excluded);
    }
  });
});
