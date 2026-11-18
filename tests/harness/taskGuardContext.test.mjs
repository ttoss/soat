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
 * A guard, an `on_complete` rule and a `payload_writes` mapping read one
 * `task`, so a field one of them can name the others can too.
 */
describe('task guard context chokepoint', () => {
  test('only taskGuardContext and the wire mapper spell a task row as `last_result`', () => {
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
    assert.deepEqual(builders, ['lib/taskGuardContext.ts', 'lib/tasks.ts']);
  });
});
