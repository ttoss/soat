import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A caller's `metadata` bag has one reader: `lib/metadataBag.ts`. A route that
 * reads `body.metadata` for itself is how that stops being true, and nothing
 * else notices — the column is JSONB, so a bag that is not an object is stored
 * rather than refused, and the drift only surfaces when a consumer trusts the
 * type it was promised.
 *
 * Five routes were doing exactly that before this check existed, and the two
 * modules that did validate had each written the rule out again.
 */

const ROUTES_DIR = join(__dirname, '../../../../src/rest/v1');

/** The readers that answer "is this bag an object?" in one place. */
const CHOKEPOINT = [
  'parseMetadataBag',
  'readNullableMetadataBag',
  'parseMetadataBagField',
  'validateMetadataBag',
  'toNullableMetadataBag',
];

/**
 * Routes that name `metadata` without taking a caller's bag to store.
 * Each reads one rather than keeping one, so the chokepoint does not apply.
 */
const NOT_INGRESSES = new Set([
  // Takes the structured filter grammar over stored bags: `{ gte: 3 }` here is
  // an operator, not a value.
  'knowledge.ts',
  // Its answer *is* a verdict on a bag, so it reports one rather than refusing
  // the request.
  'metadataSchemas.ts',
]);

/** Source with comments and string literals dropped, so prose is not a hit. */
const code = (file: string): string => {
  return readFileSync(join(ROUTES_DIR, file), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
};

describe('a caller metadata bag has one reader', () => {
  const routeFiles = () => {
    return readdirSync(ROUTES_DIR)
      .filter((file) => {
        return file.endsWith('.ts') && !NOT_INGRESSES.has(file);
      })
      .sort();
  };

  test('no route reads `body.metadata` without going through it', () => {
    const offenders: string[] = [];

    for (const file of routeFiles()) {
      const source = code(file);
      const readsBag = /\bbody\.metadata\b/.test(source);
      if (!readsBag) continue;

      const viaChokepoint = CHOKEPOINT.some((reader) => {
        return new RegExp(`\\b${reader}\\s*\\(`).test(source);
      });
      if (!viaChokepoint) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });

  test('the routes that take a bag are still found', () => {
    // Guards the assertion above from passing because the scan matched nothing.
    const reading = routeFiles().filter((file) => {
      return /\bbody\.metadata\b/.test(code(file));
    });

    expect(reading.length).toBeGreaterThanOrEqual(6);
  });
});
