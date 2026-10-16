import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const libDir = path.join(repoRoot, 'packages/server/src/lib');

/** Source with comments dropped, so prose naming a symbol is not a hit. */
const code = (file) => {
  return fs
    .readFileSync(path.join(libDir, file), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      return !/^\s*\/\//.test(line);
    })
    .join('\n');
};

const filesMatching = (pattern, prefix = '') => {
  return fs
    .readdirSync(libDir)
    .filter((entry) => {
      return (
        entry.startsWith(prefix) &&
        entry.endsWith('.ts') &&
        pattern.test(code(entry))
      );
    })
    .sort();
};

/**
 * A case answers three questions the same way for every reader and writer:
 * which values count as set (each input's schema), which lock orders writes
 * (the case's, before any of its rows), and which revision an entry takes (the
 * case's one counter). `playbookCases.ts` answers each once; a new site doing
 * the work by hand is the one that would answer differently.
 */
describe('playbook case chokepoints', () => {
  test('node states are computed only by caseNodeStates', () => {
    assert.deepEqual(filesMatching(/\bplaybookNodeStates\(/), [
      'playbookCases.ts',
    ]);
  });

  test('a case row is locked only by lockCase', () => {
    assert.deepEqual(filesMatching(/\bLOCK\.UPDATE\b/, 'playbook'), [
      // `lockCase` itself, and the settle's lock on the execution row it
      // takes after the case.
      'playbookCases.ts',
      'playbookExecutionSettle.ts',
    ]);
    assert.doesNotMatch(
      code('playbookExecutionSettle.ts'),
      /PlaybookCase\.\w+\([^)]*LOCK/s
    );
  });

  test('an entry is written only by appendEntries', () => {
    assert.deepEqual(filesMatching(/PlaybookEntry\.(create|bulkCreate)\(/), [
      'playbookCases.ts',
    ]);
  });
});
