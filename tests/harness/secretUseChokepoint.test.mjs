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

const ASKS_SECRET_USE = /\bassert(Tool)?SecretUseAllowed\(/;

const withoutSecretUse = (files) => {
  return files.filter((entry) => {
    return !ASKS_SECRET_USE.test(code(path.join(srcDir, entry)));
  });
};

/**
 * A write that stores a secret the server later sends outward asks
 * `secrets:UseSecret` through `lib/secretUse.ts`, so a new carrier cannot
 * store one without stating who may use it.
 */
describe('secrets:UseSecret chokepoint', () => {
  test('is the only place the action is checked', () => {
    assert.deepEqual(filesMatching(/'secrets:UseSecret'/), [
      'lib/secretUse.ts',
    ]);
  });

  test('every write that stores a resolvable secret ref asks it', () => {
    assert.deepEqual(
      withoutSecretUse(filesMatching(/\bassertSecretRefsExist\(/)),
      // Its only caller, `updateTool`, asks before calling it.
      ['lib/toolWriteValidation.ts']
    );
  });

  test('every write of a tool definition asks it', () => {
    assert.deepEqual(
      withoutSecretUse(filesMatching(/\bvalidateToolDefinition\(/)),
      // Inline pipeline steps: the owning tool's ask walks its `pipeline`.
      ['lib/pipelineTools.ts']
    );
  });

  test('every write linking a secret to an AI provider asks it', () => {
    assert.deepEqual(
      withoutSecretUse(filesMatching(/AiProvider\.create\(|\.secretId = /)),
      []
    );
  });
});
