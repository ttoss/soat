import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every page is cut from the `where` and `order` `paginatedList` hands its
 * `query`: the caller's `where` ANDed with the position after the cursor, and
 * the caller's `order` made total by the tiebreak. A `query` that writes its
 * own `order:` or `where:` sorts or filters without them, so pages repeat or
 * skip rows. Static, so the list function nobody has written yet is held to it
 * too.
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
): Array<{ line: number; body: string; start: number; end: number }> => {
  const calls: Array<{
    line: number;
    body: string;
    start: number;
    end: number;
  }> = [];
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
      start,
      end,
    });
  }
  return calls;
};

/** The `query` callback's source: from `query:` to the next top-level key. */
const queryCallback = (body: string): string => {
  const start = body.indexOf('query:');
  if (start === -1) return '';
  const rest = body.slice(start);
  const next = rest.search(/\n\s{4}(?:map|limit|cursor|order|tiebreak):/);
  return next === -1 ? rest : rest.slice(0, next);
};

describe('paginatedList order', () => {
  const calls = collectSourceFiles(SRC_DIR)
    .filter((file) => {
      return !file.endsWith(join('lib', 'pagination.ts'));
    })
    .flatMap((file) => {
      return paginatedListCalls(readFileSync(file, 'utf-8')).map((call) => {
        return {
          ...call,
          at: `${file.slice(SRC_DIR.length + 1)}:${call.line}`,
        };
      });
    });

  test('finds the call sites it guards', () => {
    expect(calls.length).toBeGreaterThan(40);
  });

  test('every call states its order, where and filters to paginatedList', () => {
    const offenders = calls
      .filter((call) => {
        const own = call.body.replace(queryCallback(call.body), '');
        return !['order', 'where', 'filters'].every((key) => {
          return new RegExp(`\\n\\s*${key}[:,]`).test(own);
        });
      })
      .map((call) => {
        return call.at;
      });
    expect(offenders).toEqual([]);
  });

  test('every query reads the where and order it is handed, never its own', () => {
    const offenders = calls
      .filter((call) => {
        const query = queryCallback(call.body);
        const params = /query:\s*(?:async\s*)?\(\{([^}]*)\}/.exec(query);
        return (
          !params ||
          !/\bwhere\b/.test(params[1]) ||
          !/\border\b/.test(params[1]) ||
          /\border:/.test(query) ||
          /\boffset\b/.test(query) ||
          /\bfindAndCountAll\(/.test(query)
        );
      })
      .map((call) => {
        return call.at;
      });
    expect(offenders).toEqual([]);
  });

  // A count per page is what keyset paging exists to drop.
  test('nothing in src counts and lists in one call', () => {
    const offenders = collectSourceFiles(SRC_DIR).filter((file) => {
      return /\bfindAndCountAll\(/.test(readFileSync(file, 'utf-8'));
    });
    expect(offenders).toEqual([]);
  });
});
