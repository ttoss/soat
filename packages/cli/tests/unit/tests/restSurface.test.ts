import { routes } from '../../../src/generated/routes';

/**
 * The CLI wraps the REST API, which lives entirely under `/api/v1`.
 *
 * The specs it generates from also describe the OAuth 2.1 protocol endpoints,
 * whose paths the RFCs fix and which `@ttoss/auth-core` mounts at the root, so
 * a client can discover the flow without a live host to probe (#1099). A
 * command for them would be broken, not merely unused.
 *
 * `scripts/generate.ts` drops them by path prefix; this asserts the drop
 * happened, since a stale filter would surface as a command that fails at its
 * first request rather than as a generation error.
 */
describe('generated command surface covers the REST API only', () => {
  test('no command wraps an OAuth protocol endpoint', () => {
    const operationIds = Object.values(routes).map((route) => {
      return route.operationId;
    });

    for (const excluded of [
      'getOauthAuthorizationServerMetadata',
      'getOauthProtectedResourceMetadata',
      'registerOauthClient',
      'authorizeOauthClient',
      'createOauthToken',
    ]) {
      expect(operationIds).not.toContain(excluded);
    }
  });

  test('the manifest is not empty', () => {
    // Guards the assertion above from passing because generation produced
    // nothing at all.
    expect(Object.keys(routes).length).toBeGreaterThan(100);
  });
});
