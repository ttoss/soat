import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const modelsDir = path.join(repoRoot, 'packages/postgresdb/src/models');
const srcDir = path.join(repoRoot, 'packages/server/src');

/**
 * A principal pair that stores no acts_for columns of its own, with the reason.
 * Keyed `<Model>.<prefix>` (`''` for a bare `principalType`).
 */
const ACTS_FOR_ELSEWHERE = {
  'Generation.startedBy': "served from the turn's stored `authority`",
  'Generation.actedAs': "served from the turn's stored `authority`",
  'TriggerFiring.actedAs': "served from the firing's stored `authority`",
  'PrincipalRevocation.': 'names the revoked principal, not one that acted',
};

/** Sites writing a prefixed principal column outside `principals.ts`. */
const WRITERS_ELSEWHERE = {
  'lib/approvals.ts': '`DecisionOutput` is a node result, not a record',
  'lib/triggerDispatch.ts':
    "`acted_as` reads acts_for off the firing's authority",
};

const tsFiles = (dir) => {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
};

/**
 * Every record naming who acted stores whom that principal acted for (an IAM
 * token's or `On-Behalf-Of` principal) beside it, written together through
 * `principalColumns` (`lib/principals.ts`).
 */
describe('records name whom their principal acted for', () => {
  test('every principal column pair has its acts_for pair', () => {
    const missing = [];
    for (const file of fs.readdirSync(modelsDir).sort()) {
      if (!file.endsWith('.ts')) continue;
      const model = file.replace(/\.ts$/, '');
      const source = fs.readFileSync(path.join(modelsDir, file), 'utf-8');
      for (const match of source.matchAll(
        /declare (\w*?)(?:PrincipalType|principalType)\b/g
      )) {
        const prefix = match[1];
        if (ACTS_FOR_ELSEWHERE[`${model}.${prefix}`]) continue;
        const actsFor = prefix ? `${prefix}ActsFor` : 'actsFor';
        for (const column of [`${actsFor}Type`, `${actsFor}Id`]) {
          if (!source.includes(`declare ${column}:`)) {
            missing.push(`${model}.${column}`);
          }
        }
      }
    }
    assert.deepEqual(missing, []);
  });

  test('a prefixed principal column is written only by principalColumns', () => {
    const writers = tsFiles(srcDir)
      .filter((file) => {
        return /(\b\w+By|\bactedAs)PrincipalType(: (?!string\b)|\s*=[^=>])/.test(
          fs.readFileSync(file, 'utf-8')
        );
      })
      .map((file) => {
        return path.relative(srcDir, file);
      })
      .filter((file) => {
        return file !== 'lib/principals.ts' && !WRITERS_ELSEWHERE[file];
      });
    assert.deepEqual(writers, []);
  });
});
