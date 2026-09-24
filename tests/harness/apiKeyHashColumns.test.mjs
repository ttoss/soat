import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

/**
 * How an API key is stored and how a bearer is checked against it is one
 * rule: `lib/apiKeys.ts` writes the hashes, `lib/apiKeyVerifier.ts` reads them.
 * A third reader of the columns is a second verifier, and two verifiers drift
 * on what a match is or when a legacy row is upgraded.
 */
describe('API key hash columns', () => {
  const ALLOWED = ['lib/apiKeyVerifier.ts', 'lib/apiKeys.ts'];

  const HASH_COLUMN = /\bkeyHash(Sha256)?\b|\bkey_hash(_sha256)?\b/;

  /** Source with comments dropped, so prose naming a column is not a hit. */
  const code = (file) => {
    return fs
      .readFileSync(file, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => {
        return !/^\s*(\/\/|\*)/.test(line);
      })
      .join('\n');
  };

  const readers = fs
    .readdirSync(srcDir, { recursive: true })
    .filter((entry) => {
      return typeof entry === 'string' && entry.endsWith('.ts');
    })
    .map((entry) => {
      return entry.split(path.sep).join('/');
    })
    .filter((entry) => {
      return HASH_COLUMN.test(code(path.join(srcDir, entry)));
    })
    .sort();

  test('only the minter and the verifier touch the hash columns', () => {
    assert.deepEqual(readers, [...ALLOWED].sort());
  });
});
