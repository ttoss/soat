import * as fs from 'node:fs';
import * as path from 'node:path';

import { load } from 'js-yaml';
import {
  getFormationModule,
  supportedResourceTypes,
} from 'src/lib/formationsRegistry';
import { validateFormationTemplate } from 'src/lib/formationsValidation';
import { camelToSnakeKey } from 'src/lib/resource-inputs/normalizers';

// ── About this file ─────────────────────────────────────────────────────────
//
// Two rules that used to be restated per resource type, and drifted:
//
//   1. The set of resource types a template may declare (#900). It was a
//      hand-written literal that had fallen one entry behind the registry, so
//      `model_route` was unreachable through the API.
//   2. camelCase property keys are accepted (#901). Twenty modules called
//      `normalizePropertyKeys`; four did not.
//
// Both are now derived — from the registry and from the module-dispatch seam
// respectively — so these tests are table-driven over *every registered type*.
// A 25th module cannot reintroduce either gap without failing here.
//
// Pure validation over the full resource-type table: a `lib/` test per the
// keep-list rule in `.claude/rules/tests.md` (large input space, and a bare
// "Unknown field" through REST would not say which type regressed).

const SPEC_PATH = path.resolve(
  __dirname,
  '../../../../src/rest/openapi/v1/formations.yaml'
);

type PropertiesSchema = {
  type?: string;
  properties?: Record<string, { type?: string; nullable?: boolean }>;
  required?: string[];
};

const spec = load(fs.readFileSync(SPEC_PATH, 'utf-8')) as {
  components?: { schemas?: Record<string, PropertiesSchema> };
};

/**
 * `model_route` → `ModelRouteResourceProperties`. The naming rule every
 * formation module already follows; asserted below for every registered type,
 * so the derivation used by these tests cannot silently mismatch the spec.
 */
const schemaNameFor = (resourceType: string): string => {
  const pascal = resourceType
    .split('_')
    .map((part) => {
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join('');
  return `${pascal}ResourceProperties`;
};

const RESOURCE_TYPES = [...supportedResourceTypes()].sort();

// ── #900 — the type allowlist is the registry ───────────────────────────────

describe('supported formation resource types', () => {
  test('every registered module is a declarable resource type', () => {
    // The literal that used to live in `formationsTypes.ts` omitted
    // `model_route`; deriving the set from the registry is what makes
    // registration the single step to add a type.
    expect(RESOURCE_TYPES).toContain('model_route');
    for (const resourceType of RESOURCE_TYPES) {
      expect(getFormationModule({ resourceType })).toBeDefined();
    }
  });

  test('a model_route resource validates', () => {
    const result = validateFormationTemplate({
      resources: {
        Route: {
          type: 'model_route',
          properties: { name: 'primary', model: 'gpt-4o' },
        },
      },
    });
    expect(
      result.errors.filter((error) => {
        return error.message.includes('Unsupported resource type');
      })
    ).toEqual([]);
  });

  test('an unregistered resource type is still rejected', () => {
    const result = validateFormationTemplate({
      resources: {
        Nope: { type: 'not_a_resource', properties: { name: 'x' } },
      },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((error) => {
        return error.message.startsWith(
          'Unsupported resource type: not_a_resource'
        );
      })
    ).toBe(true);
  });
});

// ── #901 — camelCase keys are accepted for every resource type ──────────────

const SAMPLE_VALUE: Record<string, unknown> = {
  string: 'sample',
  boolean: true,
  integer: 1,
  number: 1,
  array: [],
  object: {},
};

/**
 * A snake_case field from the type's own spec that carries an underscore, so
 * its camelCase spelling is a genuinely different key, paired with a value of
 * the declared type (so a type error can never masquerade as the unknown-field
 * error under test). Types whose every field is a single word — nothing to
 * camelCase — yield `undefined` and are skipped.
 */
const camelCasableField = (
  resourceType: string
): { field: string; value: unknown } | undefined => {
  const schema = spec.components?.schemas?.[schemaNameFor(resourceType)];
  for (const [field, fieldSpec] of Object.entries(schema?.properties ?? {})) {
    if (!field.includes('_')) continue;
    const value = fieldSpec.type ? SAMPLE_VALUE[fieldSpec.type] : undefined;
    if (value === undefined) continue;
    return { field, value };
  }
  return undefined;
};

describe('camelCase property keys', () => {
  test.each(RESOURCE_TYPES)(
    '%s declares a spec schema under the shared naming rule',
    (resourceType) => {
      expect(
        spec.components?.schemas?.[schemaNameFor(resourceType)]
      ).toBeDefined();
    }
  );

  test.each(RESOURCE_TYPES)(
    '%s accepts a camelCase spelling of a declared field',
    (resourceType) => {
      const sample = camelCasableField(resourceType);
      if (!sample) return;
      const camelField = sample.field.replace(
        /_([a-z])/g,
        (_, char: string) => {
          return char.toUpperCase();
        }
      );
      expect(camelToSnakeKey(camelField)).toBe(sample.field);

      const result = validateFormationTemplate({
        resources: {
          Res: {
            type: resourceType,
            properties: { [camelField]: sample.value },
          },
        },
      });

      // Only the unknown-field verdict for *this key* is under test; missing
      // required fields elsewhere in the bag are expected and ignored.
      const unknownFieldErrors = result.errors.filter((error) => {
        return error.message.includes(`'${camelField}'`);
      });
      expect(unknownFieldErrors).toEqual([]);
    }
  );
});
