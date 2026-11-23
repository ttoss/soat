import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Every path segment is a kebab-case literal or a `{snake_case}` parameter:
 * a derived read is a noun under its collection (`/tasks/graph`), an action a
 * verb under its resource (`/approvals/{approval_id}/approve`), never a
 * `:verb` suffix (`.claude/rules/server.md` § Paths).
 */

const serverRoot = fileURLToPath(
  new URL('../../packages/server', import.meta.url)
);
const { load } = createRequire(path.join(serverRoot, 'package.json'))(
  'js-yaml'
);
const specDir = path.join(serverRoot, 'src/rest/openapi/v1');

const SEGMENT = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*|\{[a-z][a-z0-9_]*\})$/;

/** RFC 8615 fixes this segment's spelling. */
const WELL_KNOWN = '.well-known';

const specPaths = () => {
  return fs
    .readdirSync(specDir)
    .filter((file) => {
      return file.endsWith('.yaml');
    })
    .flatMap((file) => {
      const spec = load(fs.readFileSync(path.join(specDir, file), 'utf8'));
      return Object.keys(spec?.paths ?? {}).map((route) => {
        return { file, route };
      });
    });
};

test('every path segment is a kebab-case literal or a {snake_case} parameter', () => {
  const routes = specPaths();
  assert.ok(routes.length > 0, 'no spec paths found');
  const offenders = routes.filter(({ route }) => {
    return route
      .split('/')
      .filter(Boolean)
      .some((segment, index) => {
        if (index === 0 && segment === WELL_KNOWN) return false;
        return !SEGMENT.test(segment);
      });
  });
  assert.deepEqual(
    offenders.map(({ file, route }) => {
      return `${file}: ${route}`;
    }),
    []
  );
});

test('a ":verb" suffix is refused', () => {
  assert.equal(SEGMENT.test('{api_key_id}:rotate'), false);
  assert.equal(SEGMENT.test('graph'), true);
  assert.equal(SEGMENT.test('trigger-firings'), true);
});
