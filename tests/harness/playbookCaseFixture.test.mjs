import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './sourceText.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const testsDir = path.join(repoRoot, 'packages/server/tests');
const FIXTURE = 'unit/fixtures/playbookCase.ts';

/** Source with comments dropped, so prose naming the route is not a hit. */
const code = (file) => {
  return stripComments(fs.readFileSync(file, 'utf-8'));
};

/**
 * A case creation: the REST URL `/playbooks/${id}/cases` closing its
 * template, or the MCP tool name `create-playbook-case`.
 */
export const CASE_CREATION =
  /\/playbooks\/\$\{[^}]+\}\/cases`|['"`]create-playbook-case['"`]/;

/** Test sources outside the fixture that create a case. */
export const directCaseCreations = (dir) => {
  return fs
    .readdirSync(dir, { recursive: true })
    .filter((entry) => {
      return entry.endsWith('.ts') && entry !== FIXTURE;
    })
    .filter((entry) => {
      return CASE_CREATION.test(code(path.join(dir, entry)));
    })
    .sort();
};

/**
 * Creating a case starts its cascade in the background, so a test that acts
 * on the case before it settles races it: every test creates cases through
 * `createPlaybookCase`, which settles it.
 */
describe('playbook case creation in tests', () => {
  test('only the fixture creates a case, over REST or MCP', () => {
    assert.deepEqual(directCaseCreations(testsDir), []);
  });
});
