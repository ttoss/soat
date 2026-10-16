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
 * the modules that record a failure on a run, firing, decision, execution,
 * export or formation.
 */
const RECORDERS = [
  'decisionBackends.ts',
  'formationsTypes.ts',
  'orchestrationNodeRecorder.ts',
  'playbookExecutionSettle.ts',
  'playbookExportRender.ts',
  'triggerDispatch.ts',
  'triggerEventDispatch.ts',
];

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

  assert.deepEqual(inventing, []);
});

/**
 * A formation records what its resources throw through `formationFailure`, so
 * a bare `Error` thrown while applying or tearing one down reads as an opaque
 * internal failure. Bare errors stay only where nothing is applied: loading the
 * spec and the type config, and registering modules at boot.
 */
const FORMATION_BOOT_MODULES = [
  'formation-modules/defineFormationModule.ts',
  'formation-modules/formationSpecLoader.ts',
  'formationResourceTypeConfig.ts',
  'formationsHelpers.ts',
  'formationsRegistry.ts',
];

test('formation apply paths throw DomainErrors only', () => {
  const throwing = fs
    .readdirSync(libDir, { recursive: true })
    .filter((file) => {
      return (
        /^formation/.test(file) &&
        file.endsWith('.ts') &&
        /throw new Error\(/.test(read(file))
      );
    })
    .sort();

  assert.deepEqual(throwing, FORMATION_BOOT_MODULES);
});
