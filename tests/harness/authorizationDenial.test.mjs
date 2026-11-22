import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './sourceText.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

/** Source with comments dropped, so prose naming the refusal is not a hit. */
const code = (file) => {
  return stripComments(fs.readFileSync(file, 'utf-8'));
};

const filesMatching = (pattern) => {
  return fs
    .readdirSync(srcDir, { recursive: true })
    .filter((entry) => {
      return entry.endsWith('.ts');
    })
    .filter((entry) => {
      return pattern.test(code(path.join(srcDir, entry)));
    })
    .sort();
};

/**
 * Every `FORBIDDEN` is built by `lib/authorizationDenial.ts`, which names the
 * action, the resource and whose policies denied it, so no site words its own
 * refusal or answers a bare `Forbidden`.
 */
describe('authorization denial chokepoint', () => {
  test('is the only place a FORBIDDEN is raised', () => {
    assert.deepEqual(filesMatching(/['"]FORBIDDEN['"]/), [
      'lib/authorizationDenial.ts',
    ]);
  });

  test('is the only place an ACTION_NOT_HELD is raised', () => {
    assert.deepEqual(filesMatching(/['"]ACTION_NOT_HELD['"]/), [
      'lib/authorizationDenial.ts',
    ]);
  });

  test('is the only place the refusal is worded', () => {
    assert.deepEqual(
      filesMatching(/policies deny|boundary policy|policy denies/),
      ['lib/authorizationDenial.ts']
    );
  });
});
