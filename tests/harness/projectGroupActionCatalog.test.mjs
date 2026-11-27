import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './sourceText.mjs';

const srcDir = fileURLToPath(
  new URL('../../packages/server/src', import.meta.url)
);

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
 * Which actions are project group actions is answered once, built-in and
 * registered together, by `findProjectGroupActionResourceTypes`; a site
 * reading the built-in table alone would refuse or ignore registered ones.
 */
describe('project group action catalog', () => {
  test('only the lookup reads the built-in table', () => {
    assert.deepEqual(filesMatching(/\bPROJECT_GROUP_ACTION_RESOURCE_TYPES\b/), [
      'lib/iamRegistrations.ts',
      'lib/projectGroupActions.ts',
    ]);
  });

  test("the owner's grant names every project group action through the lookup", () => {
    assert.deepEqual(filesMatching(/'project-groups:\*'/), [
      'lib/iamRegistrations.ts',
    ]);
  });
});
