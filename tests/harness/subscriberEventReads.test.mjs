import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

/** Source with comments dropped, so prose naming a symbol is not a hit. */
const code = (file) => {
  return fs
    .readFileSync(path.join(srcDir, file), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      return !/^\s*\/\//.test(line);
    })
    .join('\n');
};

const sourceFiles = fs
  .readdirSync(srcDir, { recursive: true })
  .filter((entry) => {
    return entry.endsWith('.ts');
  })
  .sort();

const filesMatching = (pattern) => {
  return sourceFiles.filter((entry) => {
    return pattern.test(code(entry));
  });
};

/**
 * Each module that stores an event subscription, with the file whose writes
 * refuse a filter wider than the subscriber's `policy_ids` read.
 */
const SUBSCRIBERS = {
  'lib/triggers.ts': 'lib/triggerValidation.ts',
  'lib/webhooks.ts': 'lib/webhooks.ts',
};

describe('subscriber event reads', () => {
  test('every module storing an event subscription is registered', () => {
    assert.deepEqual(
      filesMatching(/\bstoredEventFilter\(/),
      Object.keys(SUBSCRIBERS).sort()
    );
  });

  test('every registered subscriber write asserts it reads its events', () => {
    for (const checker of Object.values(SUBSCRIBERS)) {
      assert.match(code(checker), /\bassertSubscriberReadsEvents\(/, checker);
    }
  });

  test('the readable-namespace check is reached only through the assertion', () => {
    assert.deepEqual(filesMatching(/\bunreadEventNamespaces\(/), [
      'lib/eventMatching.ts',
    ]);
  });
});
