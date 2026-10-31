import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const routesDir = fileURLToPath(
  new URL('../../packages/server/src/rest/v1/', import.meta.url)
);

/**
 * A route compiles a read filter through `compileReadPolicy`
 * (`rest/v1/readPolicy.ts`), which spans every project in scope when the
 * caller names none. A direct `compilePolicy` call reads one project's policy.
 */
const CHOKEPOINT = 'readPolicy.ts';

test('routes compile read filters only through compileReadPolicy', () => {
  const offenders = fs
    .readdirSync(routesDir, { recursive: true })
    .filter((entry) => {
      return entry.endsWith('.ts') && entry !== CHOKEPOINT;
    })
    .filter((entry) => {
      return /\bcompilePolicy\b/.test(
        fs.readFileSync(path.join(routesDir, entry), 'utf-8')
      );
    })
    .sort();

  assert.deepEqual(offenders, []);
});
