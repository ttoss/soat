import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const serverDir = path.join(repoRoot, 'packages/server');
const libDir = path.join(serverDir, 'src/lib');

/**
 * Durable work persists the principal that started it, and a later drive
 * re-mints a run token from it. `resolveStartingPrincipal` is the one rule for
 * that principal, so `StartingPrincipal` is a brand only its module produces:
 * every writer requires the brand, and `pnpm typecheck` refuses a caller that
 * hands one a `RequestPrincipal` instead. A cast anywhere else is the bypass.
 */
describe('StartingPrincipal brand', () => {
  const RESOLVER = path.join(libDir, 'orchestrationRunToken.ts');
  const DECLARER = path.join(libDir, 'principals.ts');

  /** Source with comments dropped, so prose naming the type is not a hit. */
  const code = (file) => {
    return fs
      .readFileSync(file, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => {
        return !/^\s*(\/\/|\*)/.test(line);
      })
      .join('\n');
  };

  const tsFiles = (dir) => {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return entry.name === 'node_modules' ? [] : tsFiles(full);
      }
      return /\.tsx?$/.test(entry.name) ? [full] : [];
    });
  };

  const CAST = /\bas\s+StartingPrincipal\b|<StartingPrincipal>/;
  const BRAND_KEY = /\bstartingPrincipalBrand\b/;

  test('the brand is declared and the resolver constructs it', () => {
    assert.match(
      code(DECLARER),
      /declare const startingPrincipalBrand: unique symbol/
    );
    assert.match(code(RESOLVER), CAST);
  });

  test('no module but the resolver constructs the brand', () => {
    const offenders = [
      ...tsFiles(path.join(serverDir, 'src')),
      ...tsFiles(path.join(serverDir, 'tests')),
    ]
      .filter((file) => {
        if (file === RESOLVER) return false;
        const source = code(file);
        return (
          CAST.test(source) || (file !== DECLARER && BRAND_KEY.test(source))
        );
      })
      .map((file) => {
        return path.relative(repoRoot, file);
      });

    assert.deepEqual(offenders, []);
  });
});
