import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { load } from 'js-yaml';
import { PRINCIPAL_TYPES } from 'src/lib/principals';

/**
 * Who did a thing is one shape on every record: a `<verb>_by_principal_type`
 * plus `<verb>_by_principal_id` pair, or a bare `principal_type` /
 * `principal_id` where the record is about the principal itself. A `*_by`
 * field holding a bare id cannot name an API key, a system sweep or an
 * automation, and an enum written per field drifts from the others, so every
 * principal type `$ref`s the one in `principals.yaml`.
 */

const SPECS_DIR = join(__dirname, '../../../../src/rest/openapi/v1');
const SHARED_REF = './principals.yaml#/components/schemas/PrincipalType';

/** `*_by` names that do not name who acted. */
const NOT_A_PRINCIPAL: Record<string, string> = {
  group_by: 'the key a rollup buckets on',
  blocked_by: 'the playbook nodes a node waits on',
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const referencesShared = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (value.$ref === SHARED_REF) return true;
  const { allOf } = value;
  return (
    Array.isArray(allOf) &&
    allOf.length === 1 &&
    isRecord(allOf[0]) &&
    allOf[0].$ref === SHARED_REF
  );
};

type Field = { file: string; where: string; name: string; schema: unknown };

/** Every schema property and every parameter, with the schema it declares. */
const collectFields = (args: {
  node: unknown;
  path: string[];
  file: string;
  fields: Field[];
}): void => {
  const { node, path, file, fields } = args;
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) {
      collectFields({
        node: item,
        path: [...path, String(index)],
        file,
        fields,
      });
    }
    return;
  }
  if (!isRecord(node)) return;

  if (typeof node.name === 'string' && typeof node.in === 'string') {
    fields.push({
      file,
      where: [...path, node.name].join('.'),
      name: node.name,
      schema: node.schema,
    });
  }
  if (isRecord(node.properties)) {
    for (const [name, schema] of Object.entries(node.properties)) {
      fields.push({
        file,
        where: [...path, 'properties', name].join('.'),
        name,
        schema,
      });
    }
  }
  for (const [key, value] of Object.entries(node)) {
    collectFields({ node: value, path: [...path, key], file, fields });
  }
};

const allFields = (): Field[] => {
  const fields: Field[] = [];
  for (const file of readdirSync(SPECS_DIR).sort()) {
    if (!file.endsWith('.yaml')) continue;
    const spec = load(readFileSync(join(SPECS_DIR, file), 'utf-8'));
    collectFields({ node: spec, path: [], file, fields });
  }
  return fields;
};

const located = (field: Field): string => {
  return `${field.file}: ${field.where}`;
};

describe('who did it is one shape', () => {
  const fields = allFields();

  test('no `*_by` field holds a bare id', () => {
    const bare = fields.filter((field) => {
      if (!field.name.endsWith('_by')) return false;
      if (NOT_A_PRINCIPAL[field.name]) return false;
      // A closed set names a party (`publisher`), never a principal's id.
      return !(isRecord(field.schema) && Array.isArray(field.schema.enum));
    });

    expect(bare.map(located)).toEqual([]);
  });

  test('every principal type references the shared enum', () => {
    const typed = fields.filter((field) => {
      return /(^|_)principal_type$/.test(field.name);
    });

    expect(typed.length).toBeGreaterThan(0);
    expect(
      typed
        .filter((field) => {
          return !referencesShared(field.schema);
        })
        .map(located)
    ).toEqual([]);
  });

  test('a principal is never a kind', () => {
    expect(
      fields
        .filter((field) => {
          return /principal_kind$/.test(field.name);
        })
        .map(located)
    ).toEqual([]);
  });

  test('every `<verb>_by_principal_*` field has its pair', () => {
    const names = new Set(
      fields.map((field) => {
        return `${field.file}: ${field.where}`;
      })
    );
    const unpaired = fields
      .filter((field) => {
        return /_by_principal_(type|id)$/.test(field.name);
      })
      .filter((field) => {
        const sibling = field.where.endsWith('_type')
          ? field.where.replace(/_type$/, '_id')
          : field.where.replace(/_id$/, '_type');
        return !names.has(`${field.file}: ${sibling}`);
      });

    expect(unpaired.map(located)).toEqual([]);
  });

  test('the shared enum is the vocabulary the server writes', () => {
    const spec = load(
      readFileSync(join(SPECS_DIR, 'principals.yaml'), 'utf-8')
    ) as { paths: unknown; components: { schemas: Record<string, unknown> } };

    expect(spec.paths).toEqual({});
    expect(spec.components.schemas.PrincipalType).toMatchObject({
      type: 'string',
      enum: [...PRINCIPAL_TYPES],
    });
  });
});
