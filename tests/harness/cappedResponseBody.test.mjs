import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

/**
 * Reads whose host this deployment's operator chose or that is fixed in code,
 * so the body is trusted not to be unbounded.
 */
const TRUSTED_HOST_READS = [
  // `getDocsBaseUrl()`, and pages checked to be on its host.
  'lib/docs.ts',
  // Anthropic's own token endpoint, a constant.
  'lib/anthropicFederation.ts',
  // Forwards an outgoing request's body, not an answer.
  'lib/egressFetch.ts',
];

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

const tsFiles = (dir) => {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
};

/**
 * A body read whole is as large as the host answering makes it, so every
 * other read goes through `lib/cappedBody.ts`.
 */
describe('capped response body chokepoint', () => {
  test('only trusted-host reads buffer a body whole', () => {
    const hits = tsFiles(srcDir)
      .filter((file) => {
        return /\.(text|json|arrayBuffer|blob|formData)\(\)/.test(code(file));
      })
      .map((file) => {
        return path.relative(srcDir, file);
      })
      .sort();
    assert.deepEqual(hits, [...TRUSTED_HOST_READS].sort());
  });
});
