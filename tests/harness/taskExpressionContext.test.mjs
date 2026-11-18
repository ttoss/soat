import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

const tsFiles = (dir) => {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
};

/**
 * Guards, `on_enter` input mappings, `on_complete` rules and `payload_writes`
 * read one `task`, so a field one of them can name the others can too.
 */
describe('task expression context chokepoint', () => {
  test('only taskExpressionContext and the wire mapper spell a task row as `last_result`', () => {
    const builders = tsFiles(srcDir)
      .filter((file) => {
        return /last_result:\s*\w+\.lastResult/.test(
          fs.readFileSync(file, 'utf-8')
        );
      })
      .map((file) => {
        return path.relative(srcDir, file);
      })
      .sort();
    assert.deepEqual(builders, [
      'lib/taskExpressionContext.ts',
      'lib/tasks.ts',
    ]);
  });
});
