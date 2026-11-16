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
 * A provider's `model_aliases` resolve in `buildModel`, so a language model
 * built anywhere else would call the vendor with the alias and answer its id.
 */
describe('vendor model chokepoint', () => {
  test('only agentModel.ts builds a vendor language model', () => {
    assert.deepEqual(
      filesMatching(/from '@ai-sdk\/(?!provider)/),
      [
        // Embedding models only: operator settings, never a provider row.
        'lib/embedding.ts',
        'lib/agentModel.ts',
      ].sort()
    );
  });

  test('buildModel takes the provider row, not its fields', () => {
    const offenders = filesMatching(/\bbuildModel\(\{\s*provider:/);
    assert.deepEqual(offenders, []);
  });
});
