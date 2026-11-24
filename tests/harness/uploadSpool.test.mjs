import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './sourceText.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

const tsFiles = (dir) => {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
};

const filesMatching = (pattern) => {
  return tsFiles(srcDir)
    .filter((file) => {
      return pattern.test(stripComments(fs.readFileSync(file, 'utf-8')));
    })
    .map((file) => {
      return path.relative(srcDir, file);
    })
    .sort();
};

/**
 * An uploaded file is as large as the upload ceiling, so it is spooled to disk
 * and streamed to storage; a backend is only ever handed a `StorageBody`.
 */
describe('upload spool', () => {
  test('no upload is buffered in memory', () => {
    assert.deepEqual(filesMatching(/memoryStorage\s*\(/), []);
  });

  test('a storage body is minted only in lib/storageBody.ts', () => {
    assert.deepEqual(filesMatching(/as\s+StorageBody\b/), [
      'lib/storageBody.ts',
    ]);
  });
});
