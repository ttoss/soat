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

const countIn = (file, pattern) => {
  return [...code(path.join(srcDir, file)).matchAll(pattern)].length;
};

/**
 * An agent turn's tool calls and content reads are authorized by one gate
 * (`lib/turnAuthority.ts`, `lib/toolCallGate.ts`) through the request's own
 * evaluator: no path evaluates an agent's `policy_ids` on its own.
 */
describe('agent turn gate', () => {
  test('policy documents are evaluated only by the request evaluator', () => {
    assert.deepEqual(filesMatching(/\bevaluatePolicies(MultiResource)?\(/), [
      'lib/permissions.ts',
    ]);
  });

  test('no separate agent-policy evaluator remains', () => {
    assert.deepEqual(
      filesMatching(
        /\b(isSoatActionAllowedByAgentPolicy|isBoundaryAllowed|assertBoundaryAllowed|isAgentPolicyAllowed|assertAgentPolicyAllowed|findBoundaryDeniedMemoryWriteAction|findAgentDeniedMemoryWriteAction|soatActionAgentRefusal|boundaryNeedsResourceScope|assertUseAllowed)\b/
      ),
      []
    );
  });

  test('every agent tool resolves through the gate', () => {
    assert.equal(
      countIn('lib/agentToolResolver.ts', /\bresolveUngatedToolByType\(/g),
      1
    );
    assert.deepEqual(filesMatching(/\bresolveUngatedToolByType\(/), [
      'lib/agentToolResolver.ts',
    ]);
  });

  test('both tool-call surfaces cross the same gate', () => {
    assert.deepEqual(filesMatching(/\bgateToolCall\(/), [
      'lib/agentToolResolver.ts',
      'lib/toolsCall.ts',
    ]);
  });

  test('content an agent reads or writes is checked by the gate', () => {
    for (const file of [
      'lib/agentKnowledge.ts',
      'lib/messageContent.ts',
      'lib/oauthConnectionTokens.ts',
    ]) {
      assert.ok(
        countIn(file, /\bassertAllowedUnder\(/g) > 0,
        `${file} checks through assertAllowedUnder`
      );
    }
    assert.ok(
      countIn('lib/agentKnowledgeScopes.ts', /\bauthUserUnder\(/g) > 0,
      'knowledge search reads under the gate authority'
    );
  });
});
