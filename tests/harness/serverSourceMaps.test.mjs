import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import * as url from 'node:url';

import { checkSourceMap } from '../../packages/server/scripts/checkSourceMaps.mjs';

/**
 * Production resolves stack frames through `dist/*.mjs.map`; a build plugin
 * that rewrites a chunk without a map leaves frames naming the wrong files.
 * The server's `build` fails on such a map, so no image ships one.
 */

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const SERVER = path.resolve(__dirname, '../../packages/server');

const BASE64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const vlq = (value) => {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = '';
  do {
    let digit = rest & 31;
    rest >>>= 5;
    if (rest > 0) digit |= 32;
    out += BASE64[digit];
  } while (rest > 0);
  return out;
};

/** A map sending every identifier of `source` to itself. */
const identityMap = (source) => {
  let previousLine = 0;
  let previousColumn = 0;
  const lines = source.split('\n').map((line, lineNumber) => {
    let generatedColumn = 0;
    return [...line.matchAll(/[A-Za-z_$][\w$]*/g)]
      .map(({ index }) => {
        const segment =
          vlq(index - generatedColumn) +
          vlq(0) +
          vlq(lineNumber - previousLine) +
          vlq(index - previousColumn);
        generatedColumn = index;
        previousLine = lineNumber;
        previousColumn = index;
        return segment;
      })
      .join(',');
  });
  return {
    version: 3,
    sources: ['../src/a.ts'],
    sourcesContent: [source],
    names: [],
    mappings: lines.join(';'),
  };
};

const SOURCE = [
  'const policyInvalid = (reason) => new Error(reason);',
  'export const parsePolicy = (input) => {',
  '  if (!input) throw policyInvalid(input);',
  '  return input;',
  '};',
].join('\n');

describe('server source maps', () => {
  test('a map describing its bundle passes', () => {
    const { ratio } = checkSourceMap({
      code: SOURCE,
      map: identityMap(SOURCE),
    });
    assert.equal(ratio, 1);
  });

  test('a map left behind by a chunk rewrite fails', () => {
    const rewritten = `/* banner */\n${SOURCE.replace(/ {2}/g, '\t')}`;
    const { ratio } = checkSourceMap({
      code: rewritten,
      map: identityMap(SOURCE),
    });
    assert.ok(ratio < 0.95, `ratio ${ratio}`);
  });

  test('the server build runs the check after bundling', () => {
    const { scripts } = JSON.parse(
      fs.readFileSync(path.join(SERVER, 'package.json'), 'utf8')
    );
    assert.match(
      scripts.build,
      /^tsdown && node scripts\/checkSourceMaps\.mjs dist$/
    );
  });
});
