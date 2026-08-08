import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `MAX_LIST_LIMIT` is enforced in exactly one function — `resolvePagination`,
 * reached through `paginatedList` and `emptyPage`. A list function that
 * hand-rolls `const limit = args.limit ?? 50` therefore has no upper bound at
 * all: nothing upstream compensates, because `parsePagination`
 * (`rest/v1/helpers.ts`) only parses the query value and passes it through.
 *
 * That is how `GET /actors?limit=1000000` came to attempt a full-table read with
 * an `include` fan-out across four associations while `GET /tools?limit=1000000`
 * correctly returned 100 (#904). Same contract, same envelope, different bound,
 * decided by which lib function the route happened to call.
 *
 * Static on purpose, and the reason this is the durable half of the fix: a
 * per-route integration test only catches the routes someone remembered to
 * write one for, and `webhooks.ts` — which used `paginatedList` in one function
 * and hand-rolled in another — is the evidence that "remembering" does not
 * scale. Reading the source catches the class, including the 14th list function
 * nobody has written yet.
 */

const SRC_DIR = join(__dirname, '../../../../src');

const collectSourceFiles = (dir: string): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectSourceFiles(full));
      continue;
    }
    if (entry.endsWith('.ts')) files.push(full);
  }
  return files;
};

/**
 * A default applied to `args.limit` outside `pagination.ts` — the shape that
 * bypasses the clamp. Deliberately narrow: it matches the assignment of a
 * fallback to a `limit` argument, not every arithmetic use of the word.
 */
const UNCLAMPED_LIMIT = /\b(?:const|let)\s+limit\s*=\s*args\.limit\s*\?\?/;

describe('list limit clamp', () => {
  test('no lib function applies its own limit default', () => {
    const offenders: string[] = [];

    for (const file of collectSourceFiles(join(SRC_DIR, 'lib'))) {
      // `pagination.ts` is where the default and the clamp are *defined*.
      if (file.endsWith(join('lib', 'pagination.ts'))) continue;

      const source = readFileSync(file, 'utf-8');
      for (const [index, line] of source.split('\n').entries()) {
        if (UNCLAMPED_LIMIT.test(line)) {
          offenders.push(`${file.slice(SRC_DIR.length + 1)}:${index + 1}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test('every list function returning a page uses the shared envelope', () => {
    // A hardcoded `limit`/`offset` in a returned envelope is the early-return
    // twin of the bug: it reports a page size the request never asked for.
    const offenders: string[] = [];

    for (const file of collectSourceFiles(join(SRC_DIR, 'lib'))) {
      if (file.endsWith(join('lib', 'pagination.ts'))) continue;

      const source = readFileSync(file, 'utf-8');
      for (const [index, line] of source.split('\n').entries()) {
        if (/data: \[\],\s*total: 0,\s*limit: \d/.test(line)) {
          offenders.push(`${file.slice(SRC_DIR.length + 1)}:${index + 1}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
