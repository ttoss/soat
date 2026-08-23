import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { load as parseYaml } from 'js-yaml';

import { testClient } from '../../testClient';

/**
 * The OAuth endpoints are the one part of this server's HTTP surface that no
 * handler in `src/rest/v1/` declares: `@ttoss/auth-core` mounts them at the
 * root (`app.ts`, `oauthAuthorizationServer.routes()`), so they were never
 * written into a module spec and were invisible to every generated artifact —
 * `/api/v1/openapi.json`, the published `/openapi.json`, the reference pages.
 *
 * An agent looking for the OAuth flow finds it exactly one way, by reading a
 * description; prose in `docs/modules/oauth.md` is not one. An external
 * readiness audit read the published bundle and reported "OAuth mentioned but
 * no standard endpoints found" (#1099, item 1) — correctly.
 *
 * Declaring them in a spec is only half a fix, because a hand-written spec for
 * routes a dependency owns is exactly the kind that goes stale on a bump. So
 * the two halves are pinned against each other here: the spec must declare the
 * endpoints, and the metadata the server actually serves must advertise those
 * same paths. A dependency that moves `/token` breaks this test rather than
 * quietly making the published description wrong.
 */

const SPEC_FILE = join(__dirname, '../../../../src/rest/openapi/v1/oauth.yaml');

type SpecDocument = {
  paths?: Record<string, Record<string, unknown>>;
  components?: {
    schemas?: Record<
      string,
      { properties?: Record<string, { example?: unknown }> }
    >;
  };
};

const spec = parseYaml(readFileSync(SPEC_FILE, 'utf-8')) as SpecDocument;

const declaredPaths = Object.keys(spec.paths ?? {});

/** The path an issuer-absolute metadata URL points at. */
const pathOf = (args: { url: string; issuer: string }): string => {
  return args.url.startsWith(args.issuer)
    ? args.url.slice(args.issuer.length)
    : args.url;
};

describe('OAuth spec contract', () => {
  test.each([
    ['/.well-known/oauth-authorization-server', 'get'],
    ['/.well-known/oauth-protected-resource', 'get'],
    ['/authorize', 'get'],
    ['/token', 'post'],
    ['/register', 'post'],
  ])('the spec declares %s (%s)', (path, method) => {
    expect(declaredPaths).toContain(path);
    expect(spec.paths?.[path]?.[method]).toBeDefined();
  });

  test('every declared operation carries an operationId', () => {
    const missing: string[] = [];

    for (const [path, item] of Object.entries(spec.paths ?? {})) {
      for (const [method, operation] of Object.entries(item)) {
        const operationId =
          typeof operation === 'object' &&
          operation !== null &&
          'operationId' in operation
            ? operation.operationId
            : undefined;
        if (typeof operationId !== 'string' || operationId.length === 0) {
          missing.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  test('the served RFC 8414 metadata advertises the paths the spec declares', async () => {
    const res = await testClient.get('/.well-known/oauth-authorization-server');

    expect(res.status).toBe(200);

    const issuer: string = res.body.issuer;

    for (const endpoint of [
      res.body.authorization_endpoint,
      res.body.token_endpoint,
      res.body.registration_endpoint,
    ]) {
      expect(typeof endpoint).toBe('string');
      expect(declaredPaths).toContain(pathOf({ url: endpoint, issuer }));
    }
  });

  test('the spec documents every scope the server supports', async () => {
    const res = await testClient.get('/.well-known/oauth-authorization-server');

    expect(Array.isArray(res.body.scopes_supported)).toBe(true);

    // The scopes are not a request field, so the only place a reader can learn
    // them from the description is the metadata schema's example.
    const documented =
      spec.components?.schemas?.OauthAuthorizationServerMetadata?.properties
        ?.scopes_supported?.example;

    expect(documented).toEqual(
      expect.arrayContaining(res.body.scopes_supported)
    );
  });
});
