import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

/** Source with comments dropped, so prose naming the refusal is not a hit. */
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
      return entry.endsWith('.ts');
    })
    .filter((entry) => {
      return pattern.test(code(path.join(srcDir, entry)));
    })
    .sort();
};

/**
 * Every refusal by an agent's `policy_ids` is worded by
 * `lib/agentPolicyDenial.ts`, so a new tool path cannot word it its own way.
 */
describe('agent policy denial chokepoint', () => {
  test('is the only place the refusal is worded', () => {
    assert.deepEqual(filesMatching(/policies deny|boundary policy/), [
      'lib/agentPolicyDenial.ts',
    ]);
  });
});
