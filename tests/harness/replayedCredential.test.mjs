import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

/** Source with comments dropped, so prose naming a header is not a hit. */
const code = (file) => {
  return fs
    .readFileSync(file, 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      return !/^\s*\/\//.test(line);
    })
    .join('\n');
};

const READS_AUTHORIZATION =
  /headers\??\.(authorization\b|\[\s*['"]authorization['"])|headers\[\s*['"]authorization['"]|\.get\(\s*['"]authorization['"]/i;

/**
 * Work a request starts runs on `replayedAuthHeader`, never on the raw
 * header: a request an `On-Behalf-Of` assertion capped would otherwise hand
 * its work the key's full grant.
 */
describe('replayed credential chokepoint', () => {
  test('only the credential resolver and the chokepoint read Authorization', () => {
    const readers = fs
      .readdirSync(srcDir, { recursive: true })
      .filter((entry) => {
        return (
          entry.endsWith('.ts') &&
          READS_AUTHORIZATION.test(code(path.join(srcDir, entry)))
        );
      })
      .sort();

    assert.deepEqual(readers, [
      'lib/replayedCredential.ts',
      'middleware/auth.ts',
    ]);
  });
});
