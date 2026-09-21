import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * "Which documents exist for this read" is one question, and the moment two
 * readers answer it for themselves they answer it differently — which shows up
 * as a withdrawn document still reachable from whichever reader was missed,
 * on the one request that happens to use it.
 *
 * So both readers go through `systemPathScope.ts`, and this test is what keeps
 * a third from writing its own. Static because the failure is an absent
 * predicate: a reader that never excludes withdrawn documents passes every
 * test that does not happen to withdraw one first.
 */

const LIB_DIR = join(__dirname, '../../../../src/lib');
const SCOPE_MODULE = 'systemPathScope.ts';

/** The helper every default document read narrows itself with. */
const LIVE_SCOPE = 'liveDocumentWhere';

/** The status value that helper tests for. */
const WITHDRAWN_LITERAL = "'withdrawn'";

/**
 * The readers that decide which documents a collection read returns, and so
 * owe the exclusion.
 *
 * `documents.ts` is the listing; `knowledgeDocuments.ts` builds the document
 * predicate every chunk query carries. A read by id is deliberately absent: a
 * withdrawn document stays addressable, which is what makes its history
 * readable and its restore possible.
 */
const COLLECTION_READERS = ['documents.ts', 'knowledgeDocuments.ts'];

/** Blanks comments while preserving offsets, so prose is never a match. */
const code = (path: string): string => {
  return readFileSync(path, 'utf-8').replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (match) => {
      return match.replace(/[^\n]/g, ' ');
    }
  );
};

describe('document scope contract', () => {
  test.each(COLLECTION_READERS)('%s narrows through the helper', (module) => {
    expect(code(join(LIB_DIR, module))).toContain(`${LIVE_SCOPE}(`);
  });

  /**
   * The status is a projection of the current version, so exactly one module
   * may decide a document holds it: two writers is how the status and the
   * version it projects come apart.
   */
  test('only the withdrawal path writes the status', () => {
    const writers = readdirSync(LIB_DIR, { recursive: true })
      .filter((entry): entry is string => {
        return typeof entry === 'string' && entry.endsWith('.ts');
      })
      .filter((entry) => {
        return /status:\s*WITHDRAWN_STATUS|status:\s*'withdrawn'/.test(
          code(join(LIB_DIR, entry))
        );
      })
      .sort();

    expect(writers).toEqual(['documentWithdrawal.ts']);
  });

  /**
   * The literal belongs to the helper. A reader that spelled it inline would
   * be a second definition of what "withdrawn" means, and would keep working
   * right up until the helper's changed.
   */
  test('no reader spells the status for itself', () => {
    const inlined = COLLECTION_READERS.filter((module) => {
      return code(join(LIB_DIR, module)).includes(WITHDRAWN_LITERAL);
    });

    expect(inlined).toEqual([]);
  });

  test('the helper and the status live in one module', () => {
    const owners = readdirSync(LIB_DIR)
      .filter((entry) => {
        return (
          entry.endsWith('.ts') &&
          new RegExp(`export const ${LIVE_SCOPE}\\b`).test(
            code(join(LIB_DIR, entry))
          )
        );
      })
      .sort();

    expect(owners).toEqual([SCOPE_MODULE]);
  });
});
