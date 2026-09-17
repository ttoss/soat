import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The retrieval eval seeds its corpus from committed fixtures, never from a
 * file it reads out of the repository at seed time.
 *
 * The baseline must be a function of ranking code alone. A fixture whose text
 * is read from a live module doc makes it a function of documentation too: a
 * docs edit moves the numbers, and a ranking change that documents itself
 * cannot read its own eval diff.
 *
 * `parseGoldenSet` holds the data half — a fixture cannot name a file. This is
 * the code half: one `readFileSync` reaching up out of `tests/eval` re-couples
 * the corpus without touching `golden.json` at all.
 *
 * Static, because the failure is silent. A corpus seeded from live prose still
 * seeds, still scores and still passes; nothing goes red until an unrelated
 * edit moves a rank, where the number reads as a ranking regression.
 */

const EVAL_DIR = join(__dirname, '../../../eval');

const SOURCE_FILE = /\.(?:ts|mjs|cjs)$/;

type EvalSource = { file: string; lines: string[] };

const evalSources = (): EvalSource[] => {
  return readdirSync(EVAL_DIR, { withFileTypes: true, recursive: true })
    .filter((entry) => {
      return entry.isFile() && SOURCE_FILE.test(entry.name);
    })
    .map((entry) => {
      const absolute = join(entry.parentPath, entry.name);
      return {
        file: relative(EVAL_DIR, absolute),
        lines: readFileSync(absolute, 'utf8').split('\n'),
      };
    });
};

/** A path into a workspace package: no corpus fixture may name one. */
const PACKAGE_PATH = /packages\/[a-z][a-z-]*\//;

/**
 * A quoted path that climbs out of its own directory: `'../…'`, `'a/../b'`.
 *
 * Matched as one construct rather than by enumerating string literals, which a
 * regex cannot do over TypeScript: an apostrophe in a comment ("the corpus's
 * store") opens a literal that swallows the rest of the file, hiding every real
 * path literal after it. Newlines are excluded so a stray quote cannot span
 * lines and hide the next one.
 */
const CLIMBING_PATH = /['"`][^'"`\n]*\.\.\//;

/**
 * Only files that reach the filesystem are checked for a climbing path. The
 * others carry `..` for reasons that move no corpus: `jest.config.ts` points
 * Jest at the unit suite's database lifecycle, and several modules import a
 * sibling as `'../updateBaseline'`.
 */
const readsTheFilesystem = (args: { source: EvalSource }): boolean => {
  return args.source.lines.some((line) => {
    return line.includes(`from 'node:fs'`);
  });
};

const offendingLines = (args: {
  source: EvalSource;
  pattern: RegExp;
}): string[] => {
  return args.source.lines.flatMap((line, index) => {
    return args.pattern.test(line)
      ? [`${args.source.file}:${index + 1}: ${line.trim()}`]
      : [];
  });
};

describe('the knowledge eval corpus is decoupled from the repository', () => {
  const sources = evalSources();

  const readers = sources.filter((source) => {
    return readsTheFilesystem({ source });
  });

  test('the walk reaches the eval sources that read the filesystem', () => {
    // A walk that silently found nothing would pass every check below.
    expect(
      readers
        .map((source) => {
          return source.file;
        })
        .sort()
    ).toEqual([
      join('knowledge', 'goldenSet.ts'),
      join('knowledge', 'report.ts'),
    ]);
  });

  test('no eval source names a path into a workspace package', () => {
    const offenders = sources.flatMap((source) => {
      return offendingLines({ source, pattern: PACKAGE_PATH });
    });

    expect(offenders).toEqual([]);
  });

  test('no path an eval source reads climbs out of the eval tree', () => {
    const offenders = readers.flatMap((source) => {
      return offendingLines({ source, pattern: CLIMBING_PATH });
    });

    expect(offenders).toEqual([]);
  });

  test('no eval source anchors a path it reads on the working directory', () => {
    // `process.cwd()` is the one way out of the directory that needs no `..`.
    const offenders = readers.flatMap((source) => {
      return offendingLines({ source, pattern: /process\.cwd\(/ });
    });

    expect(offenders).toEqual([]);
  });
});
