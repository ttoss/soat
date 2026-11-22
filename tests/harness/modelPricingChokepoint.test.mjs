import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './sourceText.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

const code = (file) => {
  return stripComments(fs.readFileSync(file, 'utf-8'));
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
 * `require_priced_model` is answered where a provider row's language model is
 * built, so a model built anywhere else would reach the provider unchecked.
 */
describe('model pricing chokepoint', () => {
  test('only modelPricingGate.ts builds a provider row’s language model', () => {
    assert.deepEqual(filesMatching(/\bbuildModel\(/), [
      'lib/modelPricingGate.ts',
    ]);
  });

  test('only modelPricingGate.ts imports buildModel', () => {
    assert.deepEqual(
      filesMatching(/import\s*\{[^}]*\bbuildModel\b[^}]*\}\s*from/),
      ['lib/modelPricingGate.ts']
    );
  });
});
