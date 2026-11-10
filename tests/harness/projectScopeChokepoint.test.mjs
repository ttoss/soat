import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const routesDir = fileURLToPath(
  new URL('../../packages/server/src/rest/v1/', import.meta.url)
);

/**
 * `resolveReadProjectIds` answers `undefined` for an unrestricted admin's
 * unscoped read: no project filter. A route passes it through to a lib that
 * takes a `ProjectScope` (`lib/projectScope.ts`); `?? []` turns it into a
 * filter that matches no row.
 */
const COERCION = /(^|[^.\w])projectIds \?\? \[\]/;

test('routes pass the read scope through without coercing it to []', () => {
  const offenders = fs
    .readdirSync(routesDir, { recursive: true })
    .filter((entry) => {
      return entry.endsWith('.ts');
    })
    .filter((entry) => {
      return COERCION.test(
        fs.readFileSync(path.join(routesDir, entry), 'utf-8')
      );
    })
    .sort();

  assert.deepEqual(offenders, []);
});
