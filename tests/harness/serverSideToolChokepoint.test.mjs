import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

/** Source with comments dropped, so prose naming a type is not a hit. */
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
 * Which tool types a server-side caller can run, and which need an action, is
 * answered by `serverSideToolProblem` in `lib/toolsCallDispatch.ts`; a caller
 * maps its answer to its own error rather than re-deriving it.
 */
describe('server-side tool chokepoint', () => {
  test('only the dispatcher and the agent surface test for a client tool', () => {
    assert.deepEqual(filesMatching(/[tT]ype\s*[!=]==?\s*'client'/), [
      // An agent hands a client tool back to its caller instead of running it.
      'lib/agentClientToolReHandoff.ts',
      'lib/agentToolResolver.ts',
      'lib/toolsCallDispatch.ts',
    ]);
  });

  test('only the dispatcher decides that a tool type needs an action', () => {
    assert.deepEqual(
      filesMatching(/'(?:mcp|builtin)'\)?\s*&&\s*!\s*[\w.]*\baction\b/),
      []
    );
  });
});
