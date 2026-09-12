import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { load } from 'js-yaml';

/**
 * The tag bag is one contract, so it is declared once — `tags.yaml` — and every
 * tagged resource references it. Re-inlining
 * `type: object, additionalProperties: { type: string }` is not a style slip:
 * it is a second definition of the v1 contract that can drift from the first,
 * which is how the shape ended up written out thirty times.
 *
 * A static check because nothing else notices. Every consumer keeps working on
 * an inlined copy — the server, the SDK, the docs pages and the CLI all render
 * the same shape either way; only the number of places it is defined changes.
 */

const SPECS_DIR = join(__dirname, '../../../../src/rest/openapi/v1');
const SHARED_SPEC = 'tags.yaml';

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const isInlineTagBag = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (value.type !== 'object') return false;
  const additional = value.additionalProperties;
  return isRecord(additional) && additional.type === 'string';
};

/** A reference to the shared file, bare or wrapped in a single-member `allOf`. */
const referencesSharedTags = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (typeof value.$ref === 'string' && value.$ref.includes(SHARED_SPEC)) {
    return true;
  }
  const { allOf } = value;
  return Array.isArray(allOf) && allOf.some(referencesSharedTags);
};

type Finding = { file: string; where: string };

const walk = (args: {
  node: unknown;
  path: string[];
  file: string;
  inlined: Finding[];
}): void => {
  const { node, path, file, inlined } = args;

  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) {
      if (isRecord(item) && item.name === 'tags' && item.in === 'query') {
        inlined.push({ file, where: [...path, String(index)].join('.') });
      }
      walk({ node: item, path: [...path, String(index)], file, inlined });
    }
    return;
  }
  if (!isRecord(node)) return;

  for (const [key, value] of Object.entries(node)) {
    if (key === 'tags' && isInlineTagBag(value)) {
      inlined.push({ file, where: [...path, key].join('.') });
    }
    walk({ node: value, path: [...path, key], file, inlined });
  }
};

const moduleSpecs = () => {
  return readdirSync(SPECS_DIR)
    .filter((file) => {
      return file.endsWith('.yaml') && file !== SHARED_SPEC;
    })
    .sort()
    .map((file) => {
      return { file, spec: load(readFileSync(join(SPECS_DIR, file), 'utf-8')) };
    });
};

describe('the tag bag is declared once', () => {
  test('no module spec inlines a tag bag or the tags query parameter', () => {
    const inlined: Finding[] = [];
    for (const { file, spec } of moduleSpecs()) {
      walk({ node: spec, path: [], file, inlined });
    }

    expect(
      inlined.map((finding) => {
        return `${finding.file}: ${finding.where}`;
      })
    ).toEqual([]);
  });

  test('every tags property references the shared file', () => {
    const unreferenced: string[] = [];

    const check = (node: unknown, path: string[], file: string): void => {
      if (Array.isArray(node)) {
        for (const [index, item] of node.entries()) {
          check(item, [...path, String(index)], file);
        }
        return;
      }
      if (!isRecord(node)) return;
      for (const [key, value] of Object.entries(node)) {
        if (key === 'tags' && isRecord(value) && !Array.isArray(value)) {
          // `tags` is also OpenAPI's own operation-grouping key, an array of
          // strings; only a schema object is a tag bag.
          const isSchema = '$ref' in value || 'allOf' in value;
          if (isSchema && !referencesSharedTags(value)) {
            unreferenced.push(`${file}: ${[...path, key].join('.')}`);
          }
        }
        check(value, [...path, key], file);
      }
    };

    for (const { file, spec } of moduleSpecs()) {
      check(spec, [], file);
    }

    expect(unreferenced).toEqual([]);
  });

  test('the shared spec declares no paths, so it is not a module', () => {
    const spec = load(readFileSync(join(SPECS_DIR, SHARED_SPEC), 'utf-8'));

    expect(isRecord(spec)).toBe(true);
    expect(isRecord(spec) && spec.paths).toEqual({});
  });
});
