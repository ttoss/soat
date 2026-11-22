import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './sourceText.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

/** The processes that serve requests or run work, each validating at boot. */
const ENTRYPOINTS = ['server.ts', 'worker.ts'];

/**
 * Settings validated when read throw a plain `Error` naming the variable; read
 * on a request, a malformed one is a `500` instead of a failed boot.
 */
const ENV_ERROR = /throw new Error\(\s*[`'"]\$?\{?\s*([A-Z][A-Z0-9_]{3,})\b/g;

const code = (file) => {
  return stripComments(fs.readFileSync(path.join(srcDir, file), 'utf-8'));
};

const libFiles = () => {
  return fs.readdirSync(path.join(srcDir, 'lib')).filter((file) => {
    return file.endsWith('.ts');
  });
};

/** The exported function a throw sits in: the last one declared before it. */
const readerBefore = (source, index) => {
  const declared = [
    ...source.slice(0, index).matchAll(/export const (\w+) = \(/g),
  ];
  return declared.at(-1)?.[1];
};

/** Each `SOAT_*` setting `file` throws on, with the function that reads it. */
const envErrorsIn = (file) => {
  const source = code(path.join('lib', file));
  return [...source.matchAll(ENV_ERROR)]
    .filter((match) => {
      return match[1].startsWith('SOAT_');
    })
    .map((match) => {
      return {
        file,
        name: match[1],
        reader: readerBefore(source, match.index),
      };
    });
};

describe('boot config chokepoint', () => {
  test('every entrypoint loads the boot config, and only through loadBootConfigOrExit', () => {
    for (const entry of ENTRYPOINTS) {
      const source = code(entry);
      assert.match(source, /\bloadBootConfigOrExit\(\)/, entry);
      assert.doesNotMatch(
        source,
        /\b(initDeploymentRegistrations|readEmbeddingInputTokenPriceUsd)\(/,
        `${entry} validates a setting outside loadBootConfig`
      );
    }
  });

  test('a function throwing on a malformed SOAT_* setting is read by loadBootConfig', () => {
    const boot = code('lib/bootConfig.ts');
    const unchecked = libFiles()
      .flatMap(envErrorsIn)
      .filter(({ reader }) => {
        return !reader || !new RegExp(`\\b${reader}\\(`).test(boot);
      });
    assert.deepEqual(unchecked, []);
  });
});
