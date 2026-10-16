import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const libDir = path.join(repoRoot, 'packages/server/src/lib');

/**
 * A row held by its project's pause carries the project's pause time and
 * reason and the `pausedByProject` mark the project's resume lifts. Every
 * driver adopting the pause writes those columns through `adoptProjectPause`,
 * so a run and a task cannot record the same pause two ways.
 */
test('only projectPause.ts marks a row as held by its project', () => {
  const writers = fs
    .readdirSync(libDir)
    .filter((entry) => {
      return (
        entry.endsWith('.ts') &&
        fs
          .readFileSync(path.join(libDir, entry), 'utf-8')
          .split('\n')
          .some((line) => {
            return /pausedByProject: true/.test(line) && !/where:/.test(line);
          })
      );
    })
    .sort();

  assert.deepEqual(writers, ['projectPause.ts']);
});
