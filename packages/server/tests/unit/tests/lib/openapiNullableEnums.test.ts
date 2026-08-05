import * as fs from 'node:fs';
import * as path from 'node:path';

import { load } from 'js-yaml';

/**
 * Drift guardrail (#861) — pure validation with no REST entry point.
 *
 * A property declared `nullable: true` **and** given an `enum` that omits
 * `null` generates a non-nullable SDK type: hey-api derives the type from the
 * enum members, and `nullable: true` does not add `null` back. The spec says
 * the field can be null, the generated client says it cannot, and the mismatch
 * is invisible until a null reaches a caller that TypeScript told was safe.
 *
 * The rule is therefore: if a field is nullable, `null` belongs in its enum.
 *
 * Fixing a violation is a two-way decision, so this test deliberately does not
 * suggest one — check what the server actually returns for the field:
 *
 * - it can be null  → add `null` to the enum (keeps the documented domain and
 *   generates `'a' | 'b' | null`)
 * - it is never null → drop `nullable: true` instead
 *
 * Blanket-adding `null` would paper over spec bugs of the second kind.
 */

const SPEC_DIR = path.resolve(__dirname, '../../../../src/rest/openapi/v1');

type Violation = { file: string; path: string; enum: unknown[] };

const isObjectRecord = (node: unknown): node is Record<string, unknown> => {
  return typeof node === 'object' && node !== null && !Array.isArray(node);
};

/**
 * Walks every node of a parsed spec. A schema node is flagged when it is
 * `nullable: true`, carries an `enum` array, and no member of that enum is
 * `null`. `path` is a JSON-pointer-ish trail so a failure names the property
 * without the reader having to grep for the enum values.
 */
const collectViolations = (args: {
  node: unknown;
  trail: string;
  out: Violation[];
  file: string;
}): void => {
  const { node, trail, out, file } = args;

  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) {
      collectViolations({ node: item, trail: `${trail}/${i}`, out, file });
    }
    return;
  }

  if (!isObjectRecord(node)) return;

  if (
    node.nullable === true &&
    Array.isArray(node.enum) &&
    !node.enum.some((member) => {
      return member === null;
    })
  ) {
    out.push({ file, path: trail || '/', enum: node.enum });
  }

  for (const [key, value] of Object.entries(node)) {
    collectViolations({ node: value, trail: `${trail}/${key}`, out, file });
  }
};

const loadViolations = (): Violation[] => {
  const files = fs
    .readdirSync(SPEC_DIR)
    .filter((f) => {
      return f.endsWith('.yaml');
    })
    .sort();

  const out: Violation[] = [];
  for (const file of files) {
    const spec = load(fs.readFileSync(path.join(SPEC_DIR, file), 'utf-8'));
    collectViolations({ node: spec, trail: '', out, file });
  }
  return out;
};

describe('OpenAPI nullable enums', () => {
  test('spec directory is discovered', () => {
    expect(fs.existsSync(SPEC_DIR)).toBe(true);
    expect(fs.readdirSync(SPEC_DIR).length).toBeGreaterThan(0);
  });

  test('a nullable enum lists null among its members', () => {
    // The file + property path + enum members are in the failure message so a
    // violation can be triaged without re-running anything.
    expect({ violations: loadViolations() }).toEqual({ violations: [] });
  });
});
