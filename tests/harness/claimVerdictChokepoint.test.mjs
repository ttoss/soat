import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const ROOT = new URL('../..', import.meta.url).pathname;
const LIB = `${ROOT}packages/server/src/lib/`;

/**
 * A claim's verdict per agent version has one home,
 * `agentVersionClaims.ts`: the promotion gate reads it there and never
 * queries eval runs itself, and no other module combines a run's reasons with
 * anything else. Settlement (`evaluationRunExecution.ts`) writes the reasons and the run reads map them.
 */
const REASON_READERS = new Set([
  'agentVersionClaims.ts',
  'evaluationRunExecution.ts',
  'evaluationRunReads.ts',
]);

/** Every module under `lib/`, subfolders included, as a path from it. */
const libFiles = () => {
  return readdirSync(LIB, { recursive: true }).filter((file) => {
    return file.endsWith('.ts');
  });
};

describe('the claim verdict has one home', () => {
  test('the promotion gate queries no eval run', () => {
    const source = readFileSync(`${LIB}agentPromotionGate.ts`, 'utf-8');
    assert.doesNotMatch(source, /db\.EvalRun\b/);
  });

  test('only the claims module, settlement and the run reads touch verdictReasons', () => {
    const readers = libFiles().filter((file) => {
      return /\bverdictReasons\b/.test(readFileSync(`${LIB}${file}`, 'utf-8'));
    });
    for (const file of readers) {
      assert.ok(REASON_READERS.has(file), `${file} reads verdictReasons`);
    }
    assert.ok(readers.includes('agentVersionClaims.ts'));
  });

  // A version served for months holds hundreds of runs per eval; loading
  // them all to keep the newest grows every claims read and every promotion.
  test('the speaking runs of a version are picked in SQL, one per eval', () => {
    const source = readFileSync(`${LIB}agentVersionClaims.ts`, 'utf-8');
    assert.match(source, /DISTINCT ON \(r\."eval_id"\)/);
    assert.doesNotMatch(source, /EvalRun\.findAll\(\{\s*where: \{\s*agentPublicId/);
  });
});
