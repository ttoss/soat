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
 * A project policy's `Allow` without `resource` grants its project only, and a
 * project group policy's `Allow` only its project group: a meaning the stored
 * document does not carry. Every evaluation of a stored policy reads it through
 * `grantedPolicyDocuments`, which scopes both.
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
    // (project policies scoped by `withinProject`, project group ones here).
    // The rest read ids or write documents.
    assert.deepEqual(loaders, [
      'attachedPolicies.ts',
      'iamTokens.ts',
      'policies.ts',
      'policyGrantCoverage.ts',
      'projectGroups.ts',
      'usageRenameBackfill.ts',
      'writerRule.ts',
    ]);
  });

  test('the evaluation loaders scope every document', () => {
    assert.match(read('attachedPolicies.ts'), /\bgrantedPolicyDocuments\(/);
    assert.match(read('policyGrantCoverage.ts'), /\bgrantedPolicyDocuments\(/);
    const granted = read('projectGroupPolicies.ts');
    assert.match(granted, /\bscopePolicyDocument\(/);
    assert.match(granted, /\bscopeProjectGroupPolicyDocument\(/);
  });
});
