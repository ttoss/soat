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
    .readFileSync(file, 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      return !/^\s*\/\//.test(line);
    })
    .join('\n');
};

const filesMatching = (pattern) => {
  return fs
    .readdirSync(srcDir, { recursive: true })
    .filter((entry) => {
      return (
        entry.endsWith('.ts') && pattern.test(code(path.join(srcDir, entry)))
      );
    })
    .sort();
};

/**
 * A generation segment's usage event names the model and provider it is
 * priced by. Both are read off the model the segment ran on by
 * `recordSegmentUsage`, so no path answers either for itself.
 */
describe('usage chokepoints', () => {
  test('a generation usage event is written only through recordSegmentUsage', () => {
    assert.deepEqual(filesMatching(/\brecordGenerationUsage\(/), [
      'lib/generationLifecycle.ts',
    ]);
  });
});
