import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildOperationDescriptions,
  checkOperationDescriptions,
} from '../../scripts/docs-lint.mjs';

/**
 * Check 8: every REST operation carries a description no other operation
 * repeats.
 *
 * Check 7 enforces the same rule on authored pages, but the 283 reference pages
 * under `docs/api/` are generated and gitignored, so it drops them — and their
 * front matter `description` is copied straight from the spec. A description
 * shared by four operations therefore ships four pages competing for one
 * snippet with nothing to catch it. Reading the specs instead of the generated
 * pages keeps the check deterministic in a fresh clone.
 */
describe('docs-lint checkOperationDescriptions', () => {
  test('passes operations with distinct descriptions', () => {
    const violations = checkOperationDescriptions([
      { spec: 'actors', operationId: 'getActor', description: 'Reads one.' },
      { spec: 'files', operationId: 'getFile', description: 'Reads a file.' },
    ]);
    assert.deepEqual(violations, []);
  });

  test('flags a shared description on every operation that repeats it', () => {
    const violations = checkOperationDescriptions([
      { spec: 'actors', operationId: 'mergeActorTags', description: 'Merges.' },
      { spec: 'files', operationId: 'mergeFileTags', description: 'Merges.' },
      { spec: 'files', operationId: 'getFileTags', description: 'Reads.' },
    ]);
    assert.equal(violations.length, 2);
    for (const violation of violations) {
      assert.match(violation, /duplicate operation description/);
      assert.match(violation, /"Merges\."/);
    }
    assert.match(violations[0], /actors\.yaml.*mergeActorTags/);
    assert.match(violations[1], /files\.yaml.*mergeFileTags/);
  });

  test('names the operations a description is shared with', () => {
    const [first] = checkOperationDescriptions([
      { spec: 'actors', operationId: 'a', description: 'Same.' },
      { spec: 'files', operationId: 'b', description: 'Same.' },
    ]);
    assert.match(first, /shared with files\.yaml b/);
  });
});

describe('docs-lint buildOperationDescriptions', () => {
  const operations = buildOperationDescriptions();

  test('reads one entry per documented operation', () => {
    assert.ok(
      operations.length > 200,
      `expected the whole v1 surface, got ${operations.length}`
    );
    for (const operation of operations) {
      assert.ok(operation.operationId, 'every entry names its operation');
      assert.ok(operation.description, `${operation.operationId} has text`);
    }
  });

  test('every operation description in the specs is unique', () => {
    assert.deepEqual(checkOperationDescriptions(operations), []);
  });
});
