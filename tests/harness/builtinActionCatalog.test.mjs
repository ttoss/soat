import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './sourceText.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

/** Source with comments dropped, so prose naming a symbol is not a hit. */
const code = (file) => {
  return stripComments(fs.readFileSync(file, 'utf-8'));
};

const sourceFiles = (dir) => {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
};

/**
 * Which actions a `builtin` tool may name is the deployment's catalog's one
 * answer (`findBuiltinAction`): a site reading the native list itself would
 * offer an action the catalog withholds.
 */
describe('builtin action catalog chokepoint', () => {
  test('the native action list is read only where the catalog is built', () => {
    const readers = sourceFiles(srcDir)
      .filter((file) => {
        return /(?<![/.])\bsoatTools\b(?!['"])/.test(code(file));
      })
      .map((file) => {
        return path.relative(srcDir, file);
      })
      .sort();
    assert.deepEqual(
      readers,
      [
        // The catalog itself.
        'lib/builtinActionCatalog.ts',
        // The exclusion is a property of a native action, read with its list.
        'lib/soatAgentActions.ts',
        'lib/soatTools.ts',
      ].sort()
    );
  });
});
