import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');
const CHOKEPOINT = path.join(srcDir, 'lib/signedTokens.ts');

/**
 * Signs with a Google service account's private key, for Google: not a token
 * this server accepts.
 */
const OUTBOUND_SIGNERS = new Set([path.join(srcDir, 'lib/toolAuthGcp.ts')]);

/** Source with comments dropped, so prose naming a symbol is not a hit. */
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
    if (entry.isDirectory()) return tsFiles(full);
    return /\.ts$/.test(entry.name) ? [full] : [];
  });
};

const offendersOf = (pattern, exempt = new Set()) => {
  return tsFiles(srcDir)
    .filter((file) => {
      return file !== CHOKEPOINT && !exempt.has(file);
    })
    .filter((file) => {
      return pattern.test(code(file));
    })
    .map((file) => {
      return path.relative(repoRoot, file);
    });
};

/**
 * Every JWT the server signs states its kind in `typ`, and every verifier
 * names the kinds it accepts. Both hold only while one module signs and
 * verifies with the server's secret.
 */
describe('signed tokens', () => {
  test('signToken requires a typ and an expiry', () => {
    const source = code(CHOKEPOINT);
    assert.match(
      source,
      /export const signToken = \(args: \{\s*typ: TokenType;/
    );
    assert.match(source, /expiresIn: TokenTtl;/);
  });

  test('verifyToken requires the kinds it accepts', () => {
    assert.match(
      code(CHOKEPOINT),
      /export const verifyToken = <T extends TokenType>\(args: \{\s*token: string;\s*accept: readonly T\[\];/
    );
  });

  test('no other module signs a token', () => {
    assert.deepEqual(
      offendersOf(/\bjwt\.sign\(|\bsignJwt\b/, OUTBOUND_SIGNERS),
      []
    );
  });

  test('no other module verifies a token or reads the secret', () => {
    assert.deepEqual(
      offendersOf(
        /\bjwt\.verify\(|\bverifyJwt\b|\bJWT_SECRET\b|process\.env\.JWT_SECRET/
      ),
      []
    );
  });
});
