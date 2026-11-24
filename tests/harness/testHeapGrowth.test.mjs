import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  heapGrowth,
  MAX_GROWTH_MB_PER_FILE,
} from '../../packages/server/scripts/checkTestHeap.mjs';

/**
 * A handle a server test file never closes roots its module graph in the jest
 * worker, and `getActiveResourcesInfo()` misses unref'd ones, so only the heap
 * shows it. `test:heap` measures it; CI runs it on every PR and in the queue.
 */

const ROOT = new URL('../..', import.meta.url).pathname;

const outputOf = (heaps) => {
  return heaps
    .map((heap, index) => {
      const timing = index === 0 ? '5.4 s, ' : '';
      return `PASS Unit Tests tests/unit/tests/rest/heapCheck${index}.heap-check.test.ts (${timing}${heap} MB heap size)`;
    })
    .join('\n');
};

describe('test:heap', () => {
  test('reads the heap after every file, in run order', () => {
    const { heaps } = heapGrowth({ output: outputOf([384, 460, 462, 458]) });
    assert.deepEqual(heaps, [384, 460, 462, 458]);
  });

  test('a file that roots its module graph is over the limit', () => {
    const { perFile } = heapGrowth({
      output: outputOf([379, 456, 503, 549, 596, 643, 689, 736]),
    });
    assert.ok(perFile > MAX_GROWTH_MB_PER_FILE);
  });

  test('a flat heap after the first file is under the limit', () => {
    const { perFile } = heapGrowth({
      output: outputOf([384, 460, 462, 462, 462, 463, 462, 458]),
    });
    assert.ok(perFile <= MAX_GROWTH_MB_PER_FILE);
  });

  test('too few measurements are never a pass', () => {
    const { perFile } = heapGrowth({ output: outputOf([384, 460]) });
    assert.ok(Number.isNaN(perFile));
  });

  test('pr.yml runs it', () => {
    const workflow = readFileSync(`${ROOT}.github/workflows/pr.yml`, 'utf-8');
    assert.match(workflow, /run: pnpm --filter @soat\/server run test:heap\n/);
  });
});
