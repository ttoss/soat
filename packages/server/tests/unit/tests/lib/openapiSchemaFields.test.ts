import {
  deriveSchemaFields,
  hasProperties,
  isObjectRecord,
} from 'src/lib/openapiSchemaFields';

describe('openapiSchemaFields', () => {
  describe('isObjectRecord', () => {
    test('accepts plain objects, rejects arrays and null', () => {
      expect(isObjectRecord({ a: 1 })).toBe(true);
      expect(isObjectRecord([])).toBe(false);
      expect(isObjectRecord(null)).toBe(false);
      expect(isObjectRecord('x')).toBe(false);
    });
  });

  describe('hasProperties', () => {
    test('is true only when properties is an object', () => {
      expect(hasProperties({ properties: { a: {} } })).toBe(true);
      expect(hasProperties({ properties: [] })).toBe(false);
      expect(hasProperties({})).toBe(false);
      expect(hasProperties(null)).toBe(false);
    });
  });

  describe('deriveSchemaFields', () => {
    const schema = {
      properties: {
        project_id: { type: 'string' },
        max_steps: { type: 'integer' },
        boundary_policy: { type: 'object', nullable: true },
        tags: { type: 'array' },
      },
      required: ['project_id', 42],
    };

    test('keeps snake_case keys with the default identity transform', () => {
      const fields = deriveSchemaFields({ schema });

      expect([...fields.allowedFields].sort()).toEqual([
        'boundary_policy',
        'max_steps',
        'project_id',
        'tags',
      ]);
      // non-string required entries are filtered out
      expect([...fields.requiredFields]).toEqual(['project_id']);
    });

    test('applies a key transform to every derived key', () => {
      const toCamel = (key: string) => {
        return key.replace(/_([a-z])/g, (_m, c: string) => {
          return c.toUpperCase();
        });
      };
      const fields = deriveSchemaFields({ schema, transformKey: toCamel });

      expect(fields.allowedFields.has('projectId')).toBe(true);
      expect(fields.allowedFields.has('boundaryPolicy')).toBe(true);
      expect([...fields.requiredFields]).toEqual(['projectId']);
      // fieldSpecs are keyed by the transformed name too
      expect(fields.fieldSpecs.maxSteps?.type).toBe('integer');
    });

    test('derives type and nullable per field', () => {
      const fields = deriveSchemaFields({ schema });

      expect(fields.fieldSpecs.project_id).toEqual({
        type: 'string',
        nullable: false,
      });
      expect(fields.fieldSpecs.boundary_policy).toEqual({
        type: 'object',
        nullable: true,
      });
    });

    test('tolerates a non-object property schema and a missing required array', () => {
      const fields = deriveSchemaFields({
        schema: { properties: { weird: 'not-a-schema' } },
      });

      expect(fields.fieldSpecs.weird).toEqual({
        type: undefined,
        nullable: false,
      });
      expect(fields.requiredFields.size).toBe(0);
    });
  });
});
