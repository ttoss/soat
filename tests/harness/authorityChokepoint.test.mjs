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

const CHOKEPOINT = 'middleware/authority.ts';

/**
 * What a request may do is computed in one place: every credential kind and
 * every narrowing hands `buildAuthority` its pinned project and the policy
 * sets it adds, so a new kind cannot cap a request a second way.
 */
describe('effective authority chokepoint', () => {
  test('only the chokepoint builds a request authorizer', () => {
    assert.deepEqual(
      filesMatching(/\bcreatePolicySetsIsAllowed\(/),
      // A subscriber's read guard: an identity with no request behind it.
      ['lib/eventMatching.ts', CHOKEPOINT]
    );
  });

  test('only the chokepoint builds a project resolver', () => {
    assert.deepEqual(filesMatching(/\bresolveReachableProjectIds\(/), [
      CHOKEPOINT,
    ]);
  });

  test('admin is a grant: only the user grant reads the role', () => {
    assert.deepEqual(
      filesMatching(
        /\brole\s*[!=]==?\s*'admin'|'admin'\s*[!=]==?\s*\w*\.?role\b/
      ),
      ['middleware/authScopedBoundary.ts', 'middleware/authTerms.ts']
    );
  });

  test('no grant or cap is stated outside the credential resolvers', () => {
    assert.deepEqual(
      filesMatching(/\b(holder:\s*'\w+'|kind:\s*'(key_policies|other)')( as const)?,/),
      [
        'lib/workAuthority.ts',
        'middleware/auth.ts',
        'middleware/authScopedBoundary.ts',
        'middleware/authTerms.ts',
      ]
    );
  });

  test('only the chokepoint defines an authority member', () => {
    assert.deepEqual(
      filesMatching(
        /\b(isAllowed|getPolicies|resolveProjectIds)\s*[:=]\s*async\b|AuthUser\['(isAllowed|getPolicies|resolveProjectIds)'\]\s*=/
      ),
      // Observers: they record and attribute the answer, never change it.
      ['middleware/audit.ts', CHOKEPOINT, 'middleware/requestAttribution.ts']
    );
  });

  test('an observer wraps the authorizer keeping who refused', () => {
    assert.deepEqual(
      filesMatching(/\.isAllowed\s*=(?!\s*wrapIsAllowed\()/),
      []
    );
  });

  test('the credential resolver hands every kind to the chokepoint', () => {
    const auth = code(path.join(srcDir, 'middleware/auth.ts'));
    assert.doesNotMatch(auth, /\bisAllowed\s*:/);
    assert.doesNotMatch(auth, /\bgetPolicies\s*:/);
    assert.doesNotMatch(auth, /\bresolveProjectIds\s*:/);
  });
});
