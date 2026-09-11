import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `compilePolicy` keys its clause with Sequelize operator **symbols**
 * (`Op.and`), which `Object.keys` does not report. Every guard of the shape
 * `Object.keys(policyWhere).length > 0` was therefore always false: three list
 * surfaces built a correct access filter and then dropped it, returning rows
 * the caller's policy excluded. Nothing failed, nothing logged — the only
 * visible symptom was a result set that was too large.
 *
 * A static check because the failure is a *missing* restriction: the code
 * typechecks, the compiler's own unit tests pass, and only an integration test
 * that asserts a row is **absent** notices. `hasPolicyConstraints`
 * (`src/lib/policyWhere.ts`) counts symbol keys and is the supported reader.
 */

const SRC = join(__dirname, '../../../../src');

const collectTsFiles = (dir: string): string[] => {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return collectTsFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
};

test('no source file measures a compiled policy clause with Object.keys', () => {
  const offenders: string[] = [];

  for (const file of collectTsFiles(SRC)) {
    if (file.endsWith('policyWhere.ts')) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      if (/Object\.(keys|entries)\([^)]*policyWhere/i.test(line)) {
        offenders.push(`${file.slice(SRC.length + 1)}:${index + 1}`);
      }
    }
  }

  expect(offenders).toEqual([]);
});
