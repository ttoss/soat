import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `makeResourceAccessor` (`src/lib/resourceAccessor.ts`) owns the four queries
 * every resource module in `src/lib` used to write out by hand: the scoped
 * `where`, the scoped lookup, its throwing counterpart, and the
 * reload-after-write.
 *
 * The helper landing was never the fix on its own. #916 names the failure mode
 * directly — *"a half-migrated helper is worse than no helper, because it makes
 * the correct path look optional"* — and the epic's own defects are the
 * evidence: an allowlist that dropped an entry (#900), a normalization four of
 * twenty-four modules skipped (#901). Both were rules stated in more than one
 * place, and both diverged in the copy nobody re-read.
 *
 * So this test is the half that lasts. It is static for the same reason
 * `listLimitContract.test.ts` is: a per-module integration test only covers the
 * modules someone remembered to write one for, while reading the source catches
 * the class — including the twenty-fifth resource module nobody has written yet.
 *
 * Neither pattern below concerns a **field name**. The accessor moves whole rows
 * and builds a `where` out of column names, so `case-convention.md`'s
 * prohibition on key-rewriting is untouched by anything this test asks for.
 */

const SRC_DIR = join(__dirname, '../../../../src');
const LIB_DIR = join(SRC_DIR, 'lib');

/** The one file allowed to contain both patterns: it is where they are defined. */
const DEFINITION_SITE = join('lib', 'resourceAccessor.ts');

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

const relative = (file: string, source: string, index: number): string => {
  return `${file.slice(SRC_DIR.length + 1)}:${source.slice(0, index).split('\n').length}`;
};

/**
 * A `where` seeded with a `publicId` and then narrowed by the caller's
 * credential scope — `accessor.scopedWhere` / `accessor.getByPublicId`.
 *
 * Deliberately requires **both** halves. A `where` built from `projectId`
 * alone is a *list* filter over a collection, which the accessor does not
 * cover and which this test must not flag; `paginatedList` is that path's
 * shared helper.
 *
 * Equally excluded: a `publicId` bound to a **plural** (`args.publicIds`,
 * `args.ids`). That is a bulk `findAll` resolving many ids at once, not the
 * single-row lookup the accessor models — `knowledgeMemory.ts` and
 * `secrets.ts` both do it legitimately.
 */
const HAND_ROLLED_SCOPED_WHERE =
  /const\s+where[^\n]*=\s*\{[^}]*\bpublicId:(?!\s*\w+\.\w*[Ii]ds\b)[^}]*\}[^\n]*;\n(?:\s*(?:\/\/|\/\*)[^\n]*\n)*\s*if \(args\.projectIds\b/;

/**
 * The reload-after-write: re-reading a just-written row by its internal id
 * with the module's includes attached, so the module's mapper sees the
 * associations — `accessor.reload`.
 */
const HAND_ROLLED_RELOAD =
  /findOne\(\{\s*\n?\s*where: \{ id: \w+\.id \},\s*\n?\s*include:/;

const scanFor = (pattern: RegExp): string[] => {
  const offenders: string[] = [];

  for (const file of collectSourceFiles(LIB_DIR)) {
    if (file.endsWith(DEFINITION_SITE)) continue;

    const source = readFileSync(file, 'utf-8');
    const global = new RegExp(pattern.source, `${pattern.flags}g`);
    let match = global.exec(source);
    while (match !== null) {
      offenders.push(relative(file, source, match.index));
      match = global.exec(source);
    }
  }

  return offenders.sort();
};

describe('resource accessor adoption', () => {
  test('no lib module hand-rolls the scoped-by-publicId where', () => {
    expect(scanFor(HAND_ROLLED_SCOPED_WHERE)).toEqual([]);
  });

  test('no lib module hand-rolls the reload-after-write', () => {
    expect(scanFor(HAND_ROLLED_RELOAD)).toEqual([]);
  });
});
