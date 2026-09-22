import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { load } from 'js-yaml';

/**
 * The metadata bag is one contract, so it is declared once — `metadata.yaml` —
 * and every module references it. Re-inlining `type: object` is not a style
 * slip: it is a second definition of the v1 contract that can drift from the
 * first, and it already had. Of the thirty-five copies this replaced, some
 * declared `additionalProperties: true` and some did not, for the same bag.
 *
 * A static check because nothing else notices. Every consumer keeps working on
 * an inlined copy — the server, the SDK, the docs pages and the CLI render the
 * same shape either way, since a schema with no `properties` is free-form
 * whatever else it says. Only the number of places it is defined changes, and
 * that is exactly what nothing else measures.
 */

const SPECS_DIR = join(__dirname, '../../../../src/rest/openapi/v1');
const SHARED_SPEC = 'metadata.yaml';

/** Specs that declare the shared shapes, or a bag-shaped thing that is not one. */
const NOT_MODULES = new Set([
  SHARED_SPEC,
  // The structured filter grammar — `{ gte: 3 }` is an operator, not a value.
  'metadata-filters.yaml',
]);

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

/** An object schema with no declared fields: the shape a bag was written as. */
const isInlineBag = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (value.type !== 'object') return false;
  return !isRecord(value.properties);
};

/** A reference to the shared file, bare or wrapped in a single-member `allOf`. */
const referencesShared = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (typeof value.$ref === 'string' && value.$ref.includes(SHARED_SPEC)) {
    return true;
  }
  const { allOf } = value;
  return Array.isArray(allOf) && allOf.some(referencesShared);
};

type Finding = { file: string; where: string };

/** Every `properties.metadata` a spec declares, wherever it is nested. */
const eachMetadataProperty = (args: {
  node: unknown;
  path: string[];
  file: string;
  visit: (finding: Finding, schema: unknown) => void;
}): void => {
  const { node, path, file, visit } = args;

  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) {
      eachMetadataProperty({
        node: item,
        path: [...path, String(index)],
        file,
        visit,
      });
    }
    return;
  }
  if (!isRecord(node)) return;

  const { properties } = node;
  if (isRecord(properties) && 'metadata' in properties) {
    visit(
      { file, where: [...path, 'properties', 'metadata'].join('.') },
      properties.metadata
    );
  }

  for (const [key, value] of Object.entries(node)) {
    eachMetadataProperty({ node: value, path: [...path, key], file, visit });
  }
};

const moduleSpecs = () => {
  return readdirSync(SPECS_DIR)
    .filter((file) => {
      return file.endsWith('.yaml') && !NOT_MODULES.has(file);
    })
    .sort()
    .map((file) => {
      return { file, spec: load(readFileSync(join(SPECS_DIR, file), 'utf-8')) };
    });
};

describe('the metadata bag is declared once', () => {
  test('no module spec inlines a metadata bag', () => {
    const inlined: string[] = [];

    for (const { file, spec } of moduleSpecs()) {
      eachMetadataProperty({
        node: spec,
        path: [],
        file,
        visit: (finding, schema) => {
          if (isInlineBag(schema))
            inlined.push(`${finding.file}: ${finding.where}`);
        },
      });
    }

    expect(inlined).toEqual([]);
  });

  test('every metadata property references a shared file', () => {
    const unreferenced: string[] = [];

    for (const { file, spec } of moduleSpecs()) {
      eachMetadataProperty({
        node: spec,
        path: [],
        file,
        visit: (finding, schema) => {
          // The knowledge search filter points at `metadata-filters.yaml`
          // instead: it reads a bag rather than declaring one.
          const shared =
            referencesShared(schema) ||
            JSON.stringify(schema).includes('metadata-filters.yaml');
          if (!shared) unreferenced.push(`${finding.file}: ${finding.where}`);
        },
      });
    }

    expect(unreferenced).toEqual([]);
  });

  test('the shared spec declares no paths, so it is not a module', () => {
    const spec = load(readFileSync(join(SPECS_DIR, SHARED_SPEC), 'utf-8'));

    expect(isRecord(spec)).toBe(true);
    expect(isRecord(spec) && spec.paths).toEqual({});
  });
});
