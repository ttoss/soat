import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const ROOT = new URL('../..', import.meta.url).pathname;
const LIB = `${ROOT}packages/server/src/lib/`;

/**
 * A queued run is executed and settled by what it recorded when it was
 * created (`agentPublicId`, `definition`), never by its Eval, which stays
 * editable while the run is in flight. The worker and the execution path it
 * calls may read an Eval only for its immutable project and id.
 */
const RUN_PATH_FILES = ['evaluationWorker.ts', 'evaluationRunExecution.ts'];

const MUTABLE_EVAL_FIELDS = [
  'scorers',
  'passThreshold',
  'groupBy',
  'agentId',
  'datasetId',
];

const evalReads = (source) => {
  return [...source.matchAll(/db\.Eval\.(\w+)\(([\s\S]*?)\);/g)];
};

describe('the eval run worker reads no mutable Eval field', () => {
  for (const file of RUN_PATH_FILES) {
    const source = readFileSync(`${LIB}${file}`, 'utf-8');

    test(`${file}: every Eval read selects only projectId and publicId`, () => {
      for (const [call, method, callArgs] of evalReads(source)) {
        assert.equal(method, 'findByPk', `${file}: ${call}`);
        assert.match(
          callArgs,
          /attributes:\s*\[\s*'projectId',\s*'publicId'\s*\]/,
          `${file}: ${call} must select attributes ['projectId', 'publicId']`
        );
      }
    });

    test(`${file}: names no mutable Eval field`, () => {
      for (const field of MUTABLE_EVAL_FIELDS) {
        assert.doesNotMatch(
          source,
          new RegExp(`\\bevaluation\\??\\.${field}\\b`),
          `${file} reads evaluation.${field}; read the run's own copy`
        );
      }
      assert.doesNotMatch(
        source,
        /model:\s*db\.Agent,\s*as:\s*'agent'/,
        `${file} loads the Eval's agent; load the run's agentPublicId`
      );
    });
  }

  test('the worker reads the Eval at all, so the first check is not vacuous', () => {
    const source = readFileSync(`${LIB}evaluationWorker.ts`, 'utf-8');
    assert.ok(evalReads(source).length > 0);
  });
});
