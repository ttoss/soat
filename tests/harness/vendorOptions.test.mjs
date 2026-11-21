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
 * A stored or served message never carries `providerOptions`: they are lifted
 * beside it by `splitVendorOptions` and rejoined only where a model call is
 * built (`lib/vendorOptions.ts`).
 */
describe('vendor options', () => {
  test('a public message shape is produced only by splitVendorOptions', () => {
    assert.deepEqual(filesMatching(/\bas PublicMessages\b/), [
      'lib/vendorOptions.ts',
    ]);
  });

  test('providerOptions is named only where a model call is built', () => {
    assert.deepEqual(filesMatching(/\bproviderOptions\b/), [
      // The system message's cache breakpoint, lifted into `instructions`.
      'lib/modelMessages.ts',
      // Cache breakpoints, placed on the call's messages.
      'lib/promptCaching.ts',
      'lib/vendorOptions.ts',
    ]);
  });

  test('stored vendor options rejoin a message only in a conversation replay', () => {
    assert.deepEqual(filesMatching(/\bjoinVendorOptions\(/), [
      'lib/conversationGeneration.ts',
    ]);
  });
});
