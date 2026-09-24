import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every page is cut from the order `paginatedList` hands its `query` — the
 * caller's `order` with the primary key appended, so a tie on the caller's key
 * breaks the same way on every page. A `query` that writes its own `order:`
 * sorts without that tie-breaker, and one that writes none sorts nothing at
 * all; both repeat and drop rows across page boundaries. Static, so the list
 * function nobody has written yet is held to it too.
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

/** The source of each `paginatedList(...)` call, with its line number. */
const paginatedListCalls = (
  source: string
): Array<{ line: number; body: string }> => {
  const calls: Array<{ line: number; body: string }> = [];
  for (const match of source.matchAll(/\bpaginatedList\(/g)) {
    const start = match.index;
    let depth = 1;
    let end = start + match[0].length;
    while (depth > 0 && end < source.length) {
      if (source[end] === '(') depth += 1;
      if (source[end] === ')') depth -= 1;
      end += 1;
    }
    calls.push({
      line: source.slice(0, start).split('\n').length,
      body: source.slice(start, end),
    });
  }
  return calls;
};

/** The `query` callback's source: from `query:` to the next top-level key. */
const queryCallback = (body: string): string => {
  const start = body.indexOf('query:');
  if (start === -1) return '';
  const rest = body.slice(start);
  const next = rest.search(/\n\s{4}(?:map|limit|offset|order):/);
  return next === -1 ? rest : rest.slice(0, next);
};

describe('paginatedList order', () => {
  const calls = collectSourceFiles(SRC_DIR)
    .filter((file) => {
      return !file.endsWith(join('lib', 'pagination.ts'));
    })
    .flatMap((file) => {
      return paginatedListCalls(readFileSync(file, 'utf-8')).map((call) => {
        return { ...call, at: `${file.slice(SRC_DIR.length + 1)}:${call.line}` };
      });
    });

  test('finds the call sites it guards', () => {
    expect(calls.length).toBeGreaterThan(40);
  });

  test('every call states its order to paginatedList', () => {
    const offenders = calls
      .filter((call) => {
        return !/\n\s*order:/.test(call.body.replace(queryCallback(call.body), ''));
      })
      .map((call) => {
        return call.at;
      });
    expect(offenders).toEqual([]);
  });

  test('every query sorts by the order it is handed, never its own', () => {
    const offenders = calls
      .filter((call) => {
        const query = queryCallback(call.body);
        return /\border:/.test(query) || !/\border\b/.test(query);
      })
      .map((call) => {
        return call.at;
      });
    expect(offenders).toEqual([]);
  });
});
