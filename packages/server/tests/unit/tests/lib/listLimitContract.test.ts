import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Pagination has one parser and one resolver. `parsePagination`
 * (`rest/v1/helpers.ts`) is the only reader of `limit`/`offset` off a query
 * string, and `resolvePagination` (`lib/pagination.ts`) the only place a
 * default, the ceiling or the `400` is applied. A route or lib function that
 * does either itself answers the same request differently from every other
 * list. Static, so it also holds the list nobody has written yet.
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

/** Every `src/` file but `owner`, comments blanked, as `[path, lines]`. */
const sourceLinesExcept = (owner: string): [string, string[]][] => {
  return collectSourceFiles(SRC_DIR)
    .filter((file) => {
      return !file.endsWith(owner);
    })
    .map((file) => {
      const source = readFileSync(file, 'utf-8').replace(
        /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
        (match) => {
          return match.replace(/[^\n]/g, ' ');
        }
      );
      return [file.slice(SRC_DIR.length + 1), source.split('\n')];
    });
};

const offendersOf = (args: { pattern: RegExp; owner: string }): string[] => {
  return sourceLinesExcept(args.owner).flatMap(([file, lines]) => {
    return lines.flatMap((line, index) => {
      return args.pattern.test(line) ? [`${file}:${index + 1}`] : [];
    });
  });
};

describe('list pagination', () => {
  test('no route reads limit or offset off the query itself', () => {
    expect(
      offendersOf({
        pattern: /query\s*(\.\s*|\[\s*['"])(limit|offset)\b/,
        owner: join('rest', 'v1', 'helpers.ts'),
      })
    ).toEqual([]);
  });

  test('no route destructures limit or offset off the query', () => {
    const destructure = /\{([^}]*)\}\s*=\s*ctx\.query\b/g;
    const offenders = sourceLinesExcept(join('rest', 'v1', 'helpers.ts'))
      .filter(([, lines]) => {
        return [...lines.join('\n').matchAll(destructure)].some((match) => {
          return /\b(limit|offset)\b/.test(match[1]);
        });
      })
      .map(([file]) => {
        return file;
      });
    expect(offenders).toEqual([]);
  });

  test('no module applies a page default or ceiling of its own', () => {
    expect(
      offendersOf({
        pattern:
          /\b(DEFAULT_LIST_LIMIT|MAX_LIST_LIMIT)\b|\b(limit|offset)\s*\?\?\s*\d/,
        owner: join('lib', 'pagination.ts'),
      })
    ).toEqual([]);
  });

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
