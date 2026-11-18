import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './sourceText.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

/** Source with comments dropped, so prose naming a symbol is not a hit. */
const code = (file) => {
  return stripComments(fs.readFileSync(file, 'utf-8'));
};

const sourceFiles = fs
  .readdirSync(srcDir, { recursive: true })
  .filter((entry) => {
    return entry.endsWith('.ts');
  });

const filesMatching = (pattern) => {
  return sourceFiles
    .filter((entry) => {
      return pattern.test(code(path.join(srcDir, entry)));
    })
    .sort();
};

/**
 * Every bus subscriber that declares which events it wants filters through
 * `subscriberReceivesEvent` (`lib/eventMatching.ts`): the type, resource and
 * data match, then the read guard against its `policy_ids`.
 */
describe('event filter chokepoint', () => {
  test('the matcher and the read guard are called only by the shared filter', () => {
    assert.deepEqual(
      filesMatching(
        /\b(matchesEvent|matchesEventFilter|mayReadEventResource)\(|EVENT_READ_ACTIONS\[/
      ),
      ['lib/eventMatching.ts']
    );
  });

  test('every subscriber storing an event filter receives through it', () => {
    const readsFilter = filesMatching(/\.eventResources\b/);
    const subscribers = filesMatching(/\bonEvent\(/).filter((file) => {
      return readsFilter.includes(file);
    });
    assert.deepEqual(subscribers, [
      'lib/triggerEventDispatch.ts',
      'lib/webhookDispatcher.ts',
    ]);
    for (const file of subscribers) {
      assert.match(
        code(path.join(srcDir, file)),
        /\bsubscriberReceivesEvent\(/,
        file
      );
    }
  });
});
