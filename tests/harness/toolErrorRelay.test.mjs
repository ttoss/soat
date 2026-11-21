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
  return stripComments(fs.readFileSync(path.join(srcDir, file), 'utf-8'));
};

const filesMatching = (pattern) => {
  return fs
    .readdirSync(srcDir, { recursive: true })
    .filter((entry) => {
      return entry.endsWith('.ts') && pattern.test(code(entry));
    })
    .sort();
};

/**
 * A tool's structured error is read once, by `lib/toolErrorRelay.ts`, and
 * relayed by who registered the tool: a site that reads it for itself, or
 * a relay keyed by one code, lets a stored tool's answer steer this API.
 */
describe('tool error relay chokepoint', () => {
  test('every relayed tool error goes through toolCallError', () => {
    assert.deepEqual(filesMatching(/\btoolCallError\(/), [
      'lib/mcpProtocol.ts',
    ]);
  });

  test('upstream_* meta is written only by toolErrorRelay.ts', () => {
    assert.deepEqual(filesMatching(/\bupstream_code\s*:/), [
      'lib/toolErrorRelay.ts',
    ]);
  });

  test('no relay branches on one error code', () => {
    const keyed = /\bcode\s*[!=]==?\s*['"][A-Z]|case\s+['"][A-Z][A-Z_]+['"]/;
    for (const file of ['lib/toolErrorRelay.ts', 'lib/mcpProtocol.ts']) {
      assert.doesNotMatch(code(file), keyed, file);
    }
  });
});
