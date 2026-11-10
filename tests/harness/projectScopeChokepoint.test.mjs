import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const routesDir = fileURLToPath(
  new URL('../../packages/server/src/rest/v1/', import.meta.url)
);
const libDir = fileURLToPath(
  new URL('../../packages/server/src/lib/', import.meta.url)
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

/**
 * A lib compiles a `ProjectScope` into a `where` only through
 * `projectScopeWhere`, so `undefined` (no filter) and `[]` (no project) mean
 * the same thing in every list.
 */
const HAND_ROLLED = /projectId\s*(?::|=(?!=))\s*(?:args\.)?projectIds(?![\w[])/;

test('libs compile the read scope through projectScopeWhere', () => {
  const offenders = fs
    .readdirSync(libDir, { recursive: true })
    .filter((entry) => {
      return entry.endsWith('.ts') && entry !== 'projectScope.ts';
    })
    .flatMap((entry) => {
      return fs
        .readFileSync(path.join(libDir, entry), 'utf-8')
        .split('\n')
        .flatMap((line, index) => {
          return HAND_ROLLED.test(line) ? [`${entry}:${index + 1}`] : [];
        });
    })
    .sort();

  assert.deepEqual(offenders, []);
});
