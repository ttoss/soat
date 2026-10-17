import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

/** Request-path code; `errors/` describes the default to the reader. */
const SCANNED = ['lib', 'rest', 'mcp', 'middleware', 'oauth'];

/** Source with comments dropped, so prose naming a header is not a hit. */
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
 * Every header SOAT names goes through `soatHeader` (`lib/headerPrefix.ts`),
 * so `SOAT_HEADER_PREFIX` renames all of them; a literal is one it misses.
 */
describe('header prefix chokepoint', () => {
  test('no header name is written as a literal outside headerPrefix.ts', () => {
    // Lowercase only where a header is read: `x-soat-*` is also the specs'
    // extension namespace.
    const literal = (source) => {
      return (
        /['"`]X-Soat-/.test(source) ||
        /(headers\[|\.get\()\s*['"`]x-soat-/i.test(source)
      );
    };
    const hits = SCANNED.flatMap((dir) => {
      return tsFiles(path.join(srcDir, dir));
    })
      .filter((file) => {
        return literal(code(file));
      })
      .map((file) => {
        return path.relative(srcDir, file);
      });
    assert.deepEqual(hits, ['lib/headerPrefix.ts']);
  });
});
