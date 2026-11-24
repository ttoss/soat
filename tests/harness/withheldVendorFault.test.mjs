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
 * A vendor fault rethrown without the vendor's body is built only by
 * `withheldVendorFault`, so it keeps the refusal cause `REPLAY_REFUSED` reads.
 */
describe('withheld vendor fault chokepoint', () => {
  test('is the only place a vendor fault is constructed', () => {
    assert.deepEqual(
      filesMatching(/new (APICallError|SharedProviderFailure|Fault)\(/),
      ['lib/replayRefusal.ts']
    );
  });
});
