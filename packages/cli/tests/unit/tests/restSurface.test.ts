import { routes } from '../../../src/generated/routes';

/**
 * The CLI wraps the REST API, which lives entirely under `/api/v1`.
 *
 * The specs it generates from also describe the OAuth 2.1 protocol endpoints —
 * `/authorize`, `/token`, `/register` and the two `.well-known` documents, whose
 * paths the RFCs fix and which `@ttoss/auth-core` mounts at the root. They are
 * described so a client can discover the flow without a live host to probe
 * (#1099); a command for them would be broken, not merely unused. `/authorize`
 * is a browser redirect, `/token` takes a form-encoded body the manifest has no
 * way to send, and `soat register` reads as a SOAT sign-up rather than OAuth
 * client registration.
 *
 * `scripts/generate.ts` drops them by path prefix; this is the assertion that
 * the drop actually happened, since a stale filter would surface as a command
 * that fails at the first request rather than as a generation error.
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
