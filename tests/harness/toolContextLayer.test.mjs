import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './sourceText.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

const code = (file) => {
  return stripComments(fs.readFileSync(path.join(srcDir, file), 'utf-8'));
};

const sourceFiles = fs
  .readdirSync(srcDir, { recursive: true })
  .filter((entry) => {
    return entry.endsWith('.ts');
  });

const filesMatching = (pattern) => {
  return sourceFiles
    .filter((entry) => {
      return pattern.test(code(entry));
    })
    .sort();
};

/**
 * An IAM token's `tool_context` layer is stamped where a bag enters a tool
 * call: `callResolvedTool` for a direct call, `resolveAgentToolBindings` for
 * a generation's. A new entry stamping elsewhere, or not at all, fails here.
 */
describe('tool_context layer chokepoint', () => {
  test('the layer is stamped at the two tool-call entries only', () => {
    assert.deepEqual(filesMatching(/\bstampToolContextLayer\(/), [
      'lib/agentToolResolver.ts',
      'lib/toolsCall.ts',
    ]);
  });

  test('every site that pins the calling project stamps the layer too', () => {
    assert.deepEqual(
      filesMatching(/\bpinCallingProject\(/).filter((entry) => {
        return !/\bstampToolContextLayer\(/.test(code(entry));
      }),
      []
    );
  });

  test('only a token claim, a stored authority or a sealed assertion is read as a layer', () => {
    assert.deepEqual(filesMatching(/\breadToolContextLayer\(/), [
      'lib/assertionAuthority.ts',
      'lib/workAuthority.ts',
      'middleware/authBound.ts',
    ]);
  });

  test('an On-Behalf-Of callback takes its layer from the assertion', () => {
    assert.deepEqual(filesMatching(/\bcallbackToolContextLayer\(/), [
      'middleware/authOnBehalfOf.ts',
    ]);
  });
});
