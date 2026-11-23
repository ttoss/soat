import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './sourceText.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

const filesMatching = (pattern) => {
  return fs
    .readdirSync(srcDir, { recursive: true })
    .filter((entry) => {
      return (
        entry.endsWith('.ts') &&
        pattern.test(
          stripComments(fs.readFileSync(path.join(srcDir, entry), 'utf-8'))
        )
      );
    })
    .sort();
};

/**
 * A memory's change and the assertion recording it commit together through
 * `writeAssertedMemory`; an assertion written anywhere else could commit apart
 * from the change it records.
 */
describe('memory assertion writes', () => {
  test('only the funnel writes an assertion', () => {
    assert.deepEqual(
      filesMatching(/\bMemoryAssertion\.(create|bulkCreate|upsert|update)\(/),
      ['lib/memoryAssertions.ts']
    );
  });

  test('the funnel writes it inside its transaction', () => {
    const source = stripComments(
      fs.readFileSync(path.join(srcDir, 'lib/memoryAssertions.ts'), 'utf-8')
    );
    assert.match(
      source,
      /sequelize\.transaction\(async \(transaction\) => \{[\s\S]*MemoryAssertion\.create\([\s\S]*\{ transaction \}/
    );
  });
});
