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

/**
 * A JSON Logic `var` inside `map`/`filter`/`some`/... reads the element, not
 * the expression's data, so every walk that collects vars goes through
 * `lib/jsonLogicVars.ts`. `jsonLogicMapping.ts` only tests a top-level value.
 */
describe('JSON Logic var walk', () => {
  test('only the shared walk tells a var node apart', () => {
    const hits = fs
      .readdirSync(srcDir, { recursive: true })
      .filter((entry) => {
        return entry.endsWith('.ts');
      })
      .filter((entry) => {
        return /[!=]==\s*'var'|'var'\s+in\b|\['var'\]/.test(
          code(path.join(srcDir, entry))
        );
      })
      .sort();
    assert.deepEqual(hits, ['lib/jsonLogicMapping.ts', 'lib/jsonLogicVars.ts']);
  });
});
