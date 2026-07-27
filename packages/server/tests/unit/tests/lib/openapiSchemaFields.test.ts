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

    test('keys every derived set by the spec name verbatim', () => {
      // There is deliberately no key-transform hook: a validator compares
      // against the spec's own names, so a field name can never be rewritten on
      // its way from the spec to the check that uses it.
      const fields = deriveSchemaFields({ schema });

      expect(fields.allowedFields.has('project_id')).toBe(true);
      expect(fields.allowedFields.has('boundary_policy')).toBe(true);
      expect(fields.allowedFields.has('projectId')).toBe(false);
      expect(fields.allowedFields.has('boundaryPolicy')).toBe(false);
      expect([...fields.requiredFields]).toEqual(['project_id']);
      expect(fields.fieldSpecs.max_steps?.type).toBe('integer');
      expect(fields.fieldSpecs.maxSteps).toBeUndefined();
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
