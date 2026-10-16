import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const libDir = path.join(repoRoot, 'packages/server/src/lib');

/**
 * Ordering a graph and finding its cycles is answered once, in `dag.ts`, so
 * every module orders by declaration within a level and names a cycle's
 * members. A module counting in-degrees or tracking a DFS stack of its own is
 * a second answer to the same question.
 */
test('only dag.ts orders a graph or finds its cycles', () => {
  const owners = fs
    .readdirSync(libDir, { recursive: true })
    .filter((entry) => {
      return (
        entry.endsWith('.ts') &&
        /\b(indegree|inDegree|depCount|inStack)\b/.test(
          fs.readFileSync(path.join(libDir, entry), 'utf-8')
        )
      );
    })
    .sort();

  assert.deepEqual(owners, ['dag.ts']);
});
