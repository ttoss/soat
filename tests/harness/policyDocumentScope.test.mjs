import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const libDir = path.join(repoRoot, 'packages/server/src/lib');

const read = (file) => {
  return fs.readFileSync(path.join(libDir, file), 'utf-8');
};

const LOADS_POLICY_ROWS = /\bdb\.Policy\.(findAll|findOne|findByPk)\(/;

/**
 * A project policy's `Allow` without `resource` grants its project only, a
 * meaning the stored document does not carry: every evaluation of a stored
 * policy reads it through `scopePolicyDocument`.
 */
describe('stored policy documents are evaluated scoped', () => {
  test('only the known modules load policy rows', () => {
    const loaders = fs
      .readdirSync(libDir, { recursive: true })
      .filter((entry) => {
        return entry.endsWith('.ts') && LOADS_POLICY_ROWS.test(read(entry));
      })
      .sort();
    // Evaluation: attachedPolicies.ts (scoped here), policyGrantCoverage.ts
    // (scoped by `withinProject`). The rest read ids or write documents.
    assert.deepEqual(loaders, [
      'attachedPolicies.ts',
      'groups.ts',
      'iamTokens.ts',
      'policies.ts',
      'policyGrantCoverage.ts',
      'usageRenameBackfill.ts',
      'writerRule.ts',
    ]);
  });

  test('the evaluation loader scopes every document', () => {
    assert.match(read('attachedPolicies.ts'), /\bscopePolicyDocument\(/);
  });
});
