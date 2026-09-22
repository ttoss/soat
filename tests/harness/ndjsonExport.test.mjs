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
 * A route that sets the media type for itself is how that stops being true: it
 * is the site that then picks its own batch size, its own ordering and its own
 * answer to what a concurrent write does to a page boundary. The media type is
 * the cheap thing to hold, and holding it holds the rest.
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
