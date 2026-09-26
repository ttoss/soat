import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * `insertUsageEvent` (`src/lib/usageEventWrite.ts`) is the one insert path for
 * a usage event, because it is where every attribution FK gets the public id
 * `totals.distinct` counts. A meter that inserts on its own writes the FK alone,
 * and its entities drop out of the count the moment they are deleted. The model
 * validator refuses that write at runtime; this refuses it in review, including
 * for a meter no test exercises yet.
 */

const SRC_DIR = join(__dirname, '../../../../src');
const DEFINITION_SITE = join('lib', 'usageEventWrite.ts');
const DIRECT_INSERT =
  /\bUsageEvent\.(create|findOrCreate|bulkCreate|upsert|findCreateFind)\(/;

const collectSourceFiles = (dir: string): string[] => {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return collectSourceFiles(full);
    return entry.endsWith('.ts') ? [full] : [];
  });
};

test('only usageEventWrite.ts inserts usage events', () => {
  const offenders = collectSourceFiles(SRC_DIR)
    .map((file) => {
      return relative(SRC_DIR, file);
    })
    .filter((file) => {
      return (
        file !== DEFINITION_SITE &&
        DIRECT_INSERT.test(readFileSync(join(SRC_DIR, file), 'utf8'))
      );
    });

  expect(offenders).toEqual([]);
});
