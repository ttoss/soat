import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');

/**
 * Every bulk read of the corpus is one mechanism: `lib/ndjsonExport.ts` pages
 * it, `rest/v1/ndjsonResponse.ts` answers with it, and each module supplies
 * only the query and the mapper its own listing already uses.
 *
 * A site that answers any of that for itself is how that stops being true: it
 * is the site that picks its own batch size, its own ordering, or its own
 * answer to what a concurrent write does to a page boundary — and a cursor
 * drawn on `created_at` alone re-emits every row written in the same
 * millisecond, which no test of one export would catch.
 */
describe('NDJSON exports', () => {
  /** Source with comments dropped, so prose naming the type is not a hit. */
  const code = (file) => {
    return fs
      .readFileSync(file, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => {
        return !/^\s*(\/\/|\*)/.test(line);
      })
      .join('\n');
  };

  /** The module that declares the media type, for everything else to import. */
  const DECLARES_THE_TYPE = 'lib/ndjsonExport.ts';

  /** Files that stream an export, by the call that makes them one. */
  const exporters = () => {
    return fs
      .readdirSync(srcDir, { recursive: true })
      .filter((entry) => {
        return (
          typeof entry === 'string' &&
          entry.endsWith('.ts') &&
          entry !== DECLARES_THE_TYPE &&
          /\bstreamNdjson\(/.test(code(path.join(srcDir, entry)))
        );
      })
      .sort();
  };

  test('every exporter resumes through the shared cursor', () => {
    const rolledTheirOwn = exporters().filter((entry) => {
      return !/\bwhereAfterCursor\(/.test(code(path.join(srcDir, entry)));
    });

    assert.deepEqual(rolledTheirOwn, []);
  });

  test('one module spells the media type', () => {
    const spelling = fs
      .readdirSync(srcDir, { recursive: true })
      .filter((entry) => {
        return (
          typeof entry === 'string' &&
          entry.endsWith('.ts') &&
          entry !== DECLARES_THE_TYPE
        );
      })
      .filter((entry) => {
        return /application\/x-ndjson/.test(code(path.join(srcDir, entry)));
      })
      .sort();

    assert.deepEqual(spelling, []);
  });
});
