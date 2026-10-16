import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const libDir = path.join(repoRoot, 'packages/server/src/lib');

const read = (file) => {
  return fs.readFileSync(path.join(libDir, file), 'utf-8');
};

/**
 * What a resource records when its work fails is answered once, by
 * `toStoredError`: a `DomainError` keeps its code, message and meta, anything
 * else records an opaque registered code and reaches the log only. These are
 * the modules that record a failure on a run, firing, decision, execution or
 * export.
 */
const RECORDERS = [
  'decisionBackends.ts',
  'orchestrationNodeRecorder.ts',
  'playbookExecutionSettle.ts',
  'playbookExportRender.ts',
  'triggerDispatch.ts',
  'triggerEventDispatch.ts',
];

/**
 * Formations still record a bare `Error`'s message under `UNKNOWN`: their
 * resource handlers throw actionable failures as bare errors, so they move
 * once those throw `DomainError`s.
 */
const PENDING = ['formationsTypes.ts'];

test('every recorder of a failure goes through toStoredError', () => {
  const missing = RECORDERS.filter((file) => {
    return !/\btoStoredError\(/.test(read(file));
  });

  assert.deepEqual(missing, []);
});

test('no module invents an unregistered error code for a raw throw', () => {
  const inventing = fs
    .readdirSync(libDir)
    .filter((file) => {
      return (
        file.endsWith('.ts') && /code: 'INTERNAL'|: 'UNKNOWN'/.test(read(file))
      );
    })
    .sort();

  assert.deepEqual(inventing, PENDING);
});
