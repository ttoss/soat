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

const sourceFiles = fs
  .readdirSync(srcDir, { recursive: true })
  .filter((entry) => {
    return entry.endsWith('.ts');
  });

const filesMatching = (pattern) => {
  return sourceFiles
    .filter((entry) => {
      return pattern.test(code(path.join(srcDir, entry)));
    })
    .sort();
};

/**
 * Every tool an agent's model is offered passes the guardrail gate. The turn's
 * tool set is assembled in one place, `mergeBindingTools`, which accepts only
 * `GatedTools`; only the gate mints that type, so a tool built anywhere else
 * cannot reach the model without passing it.
 */
describe('tool surface gate', () => {
  test('only the gate mints GatedTools', () => {
    assert.deepEqual(filesMatching(/\bas\s+GatedTools\b/), [
      'lib/agentToolGuardrail.ts',
    ]);
  });

  test('a binding carries GatedTools, never a bare tool record', () => {
    const names = code(path.join(srcDir, 'lib/agentToolNames.ts'));
    assert.match(names, /tools:\s*GatedTools;/);
  });

  test('the turn is assembled only by the tool surface', () => {
    assert.deepEqual(filesMatching(/\bmergeBindingTools\s*\(/), [
      'lib/agentToolSurface.ts',
    ]);
  });
});
