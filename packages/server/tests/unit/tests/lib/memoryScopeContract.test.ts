import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * "Which memories still hold" is one question, and a reader that answers it for
 * itself answers it differently the day validity gains a second producer —
 * which shows up as a retracted fact still reachable from whichever reader was
 * missed, on the one request that happens to use it.
 *
 * So every reader narrows through `memoryValidity.ts`. Static because the
 * failure is an absent predicate: a reader that never excludes invalidated
 * memories passes every test that does not happen to retire one first.
 */

const LIB_DIR = join(__dirname, '../../../../src/lib');
const VALIDITY_MODULE = 'memoryValidity.ts';

/** The helper every read of currently-valid memories narrows itself with. */
const VALID_SCOPE = 'validMemoryWhere';

/** The predicate that helper is. */
const VALIDITY_LITERAL = 'invalidatedAt: null';

/**
 * The reads that decide which memories a request may see, and so owe the
 * exclusion.
 *
 * `memories.ts` is the listing; `knowledgeMemory.ts` builds the predicate every
 * memory search carries; `memoryWrite.ts` picks the dedup candidate, where a
 * retired fact must never win — restating it lands as a new memory rather than
 * reviving the row that stopped holding. A read by id is deliberately absent: an
 * invalidated memory stays addressable, which is what makes its history
 * readable.
 */
const VALIDITY_READERS = [
  'memories.ts',
  'knowledgeMemory.ts',
  'memoryWrite.ts',
];

/** Blanks comments while preserving offsets, so prose is never a match. */
const code = (path: string): string => {
  return readFileSync(path, 'utf-8').replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (match) => {
      return match.replace(/[^\n]/g, ' ');
    }
  );
};

describe('memory scope contract', () => {
  test.each(VALIDITY_READERS)('%s narrows through the helper', (module) => {
    expect(code(join(LIB_DIR, module))).toContain(`${VALID_SCOPE}(`);
  });

  /**
   * The predicate belongs to the helper. A module spelling it inline would be a
   * second definition of what "still holds" means, and would keep working right
   * up until the helper's changed.
   */
  test('no module spells the predicate for itself', () => {
    const inlined = readdirSync(LIB_DIR, { recursive: true })
      .filter((entry): entry is string => {
        return typeof entry === 'string' && entry.endsWith('.ts');
      })
      .filter((entry) => {
        return code(join(LIB_DIR, entry)).includes(VALIDITY_LITERAL);
      })
      .sort();

    expect(inlined).toEqual([VALIDITY_MODULE]);
  });

  test('the helper lives in one module', () => {
    const owners = readdirSync(LIB_DIR)
      .filter((entry) => {
        return (
          entry.endsWith('.ts') &&
          new RegExp(`export const ${VALID_SCOPE}\\b`).test(
            code(join(LIB_DIR, entry))
          )
        );
      })
      .sort();

    expect(owners).toEqual([VALIDITY_MODULE]);
  });
});
