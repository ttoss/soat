import * as fs from 'node:fs';
import * as path from 'node:path';

import { API_KEY_RAW_PREFIX, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import { load } from 'js-yaml';

/**
 * WS7 drift guardrail — pure validation with no REST entry point.
 *
 * Every string `example:` value in the OpenAPI specs that looks like a
 * Stripe-style public ID must start with a prefix the runtime actually
 * generates (`PUBLIC_ID_PREFIXES` in packages/postgresdb/src/utils/publicId.ts),
 * or one of the documented non-entity prefixes (`sk_` raw API keys). This stops
 * the "docs/spec use a prefix the runtime never emits" drift class from
 * re-accumulating (agt_ vs agent_, trc_ vs trace_, act_ vs actor_, ...).
 */

const SPEC_DIR = path.resolve(__dirname, '../../../../src/rest/openapi/v1');

// Valid prefixes: every runtime entity prefix plus documented non-entity ones.
const VALID_PREFIXES: string[] = [
  ...Object.values(PUBLIC_ID_PREFIXES),
  API_KEY_RAW_PREFIX, // sk_
];

// Heuristic for "this example value is a public-id-shaped token".
// Matches: lowercase-led prefix of 2-11 chars, an underscore, then an id body.
// Deliberately excludes hyphens/colons/uppercase so model names (`gpt-4o`),
// SRNs (`srn:...`), timestamps, and human-readable names are not treated as IDs.
const ID_LIKE = /^[a-z][a-z0-9_]{1,10}_[A-Za-z0-9]+$/;

const collectExampleStrings = (node: unknown, out: string[]): void => {
  if (Array.isArray(node)) {
    for (const item of node) collectExampleStrings(item, out);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'example' && typeof value === 'string') {
        out.push(value);
      }
      collectExampleStrings(value, out);
    }
  }
};

const loadExamples = (): { file: string; value: string }[] => {
  const files = fs
    .readdirSync(SPEC_DIR)
    .filter((f) => {
      return f.endsWith('.yaml');
    })
    .sort();

  const examples: { file: string; value: string }[] = [];
  for (const file of files) {
    const spec = load(fs.readFileSync(path.join(SPEC_DIR, file), 'utf-8'));
    const values: string[] = [];
    collectExampleStrings(spec, values);
    for (const value of values) examples.push({ file, value });
  }
  return examples;
};

describe('OpenAPI example ID prefixes', () => {
  test('spec directory is discovered', () => {
    expect(fs.existsSync(SPEC_DIR)).toBe(true);
    expect(loadExamples().length).toBeGreaterThan(0);
  });

  test('every id-shaped example value uses a runtime prefix', () => {
    const offenders = loadExamples()
      .filter(({ value }) => {
        return ID_LIKE.test(value);
      })
      .filter(({ value }) => {
        return !VALID_PREFIXES.some((p) => {
          return value.startsWith(p);
        });
      });

    // Include the offending file+value in the failure message for fast triage.
    expect({ offenders }).toEqual({ offenders: [] });
  });
});
