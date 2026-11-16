import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

const CHOKEPOINT = 'errors/errorBody.ts';

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
 * `SOAT_OMIT_ERROR_HINTS` holds on every surface only while `errorBody` is the
 * one writer of `hint` and `docs_url`: a body serialised around it would carry
 * them whatever the deployment set.
 */
describe('error hint chokepoint', () => {
  test(`only ${CHOKEPOINT} resolves or writes hint and docs_url`, () => {
    const hits = tsFiles(srcDir)
      .filter((file) => {
        return /\bdocs_url\b|\bresolutionFor\(|\bdocsUrlFor\(/.test(code(file));
      })
      .map((file) => {
        return path.relative(srcDir, file);
      });
    assert.deepEqual(hits, [CHOKEPOINT]);
  });

  /**
   * A deployment renders hints under its own route prefix only while hints
   * name routes as tokens (`errors/hintRoutes.ts`); a literal path would name
   * a route the deployment does not serve.
   */
  test('no hint names a route as a literal /api/v1/ path', () => {
    const hints = code(path.join(srcDir, 'errors/resolutions.ts'));
    const literal = hints.split('\n').filter((line) => {
      return line.includes('/api/v1/');
    });
    assert.deepEqual(literal, []);
  });
});
