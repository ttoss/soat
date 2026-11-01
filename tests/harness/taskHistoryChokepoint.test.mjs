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
 * History lists by `createdAt`, so its order holds only while every row is
 * stamped after the task's latest one; `appendTaskHistory` is where that is.
 */
describe('task history chokepoint', () => {
  test('a history row is written only by appendTaskHistory', () => {
    const writers = tsFiles(srcDir)
      .filter((file) => {
        return /TaskTransition\.(create|bulkCreate|upsert)\(/.test(
          fs.readFileSync(file, 'utf-8')
        );
      })
      .map((file) => {
        return path.relative(srcDir, file);
      });
    assert.deepEqual(writers, ['lib/taskHistory.ts']);
  });
});
