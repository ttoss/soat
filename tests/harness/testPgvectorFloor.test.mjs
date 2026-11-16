import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { assertPgvectorFloor } from '../../packages/server/tests/unit/testDatabase.ts';

/**
 * Searches run `SET LOCAL hnsw.iterative_scan`, which pgvector below 0.8
 * rejects; `globalSetup` stops on this check before any suite runs.
 */
describe('test database pgvector floor', () => {
  for (const version of ['0.5', '0.6.0', '0.7.4']) {
    test(`stops on pgvector ${version}`, () => {
      assert.throws(
        () => {
          return assertPgvectorFloor({ version });
        },
        { message: `needs pgvector >= 0.8, found ${version}` }
      );
    });
  }

  test('stops when pgvector is not available', () => {
    assert.throws(
      () => {
        return assertPgvectorFloor({ version: undefined });
      },
      { message: 'needs pgvector >= 0.8, found none' }
    );
  });

  for (const version of ['0.8.0', '0.8.2', '0.10.1', '1.0.0']) {
    test(`accepts pgvector ${version}`, () => {
      assert.doesNotThrow(() => {
        return assertPgvectorFloor({ version });
      });
    });
  }
});
