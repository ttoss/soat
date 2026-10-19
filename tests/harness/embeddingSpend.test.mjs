import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const routesDir = path.join(repoRoot, 'packages/server/src/rest/v1');

/**
 * A route that embeds on a caller's behalf spends some project's embedding
 * budget, so it answers who may spend it the one way `lib/embeddingSpend.ts`
 * does: `embeddings:CreateEmbeddings` on the project billed. A route that bills
 * an embedding without naming that rule is the case where a read permission
 * would spend another project's budget.
 */
describe('embedding spend', () => {
  const SPENDS = /\bprojectEmbeddingBilling\(|\bcreateEmbeddings\(/;
  const CHECKS = /\bEMBEDDING_SPEND\b|\bresolveEmbeddingSpendProjectId\(/;

  const routes = fs.readdirSync(routesDir).filter((entry) => {
    return entry.endsWith('.ts') && entry !== 'helpers.ts';
  });

  test('finds the routes that embed', () => {
    const spending = routes.filter((entry) => {
      return SPENDS.test(fs.readFileSync(path.join(routesDir, entry), 'utf-8'));
    });
    assert.deepEqual(spending.sort(), ['embeddings.ts', 'knowledge.ts']);
  });

  test('every route that embeds checks the spend permission', () => {
    const unchecked = routes.filter((entry) => {
      const source = fs.readFileSync(path.join(routesDir, entry), 'utf-8');
      return SPENDS.test(source) && !CHECKS.test(source);
    });
    assert.deepEqual(unchecked, []);
  });
});
