import { isObjectRecord } from 'src/lib/openapiSchemaFields';
import { getMergedOpenApiSpec } from 'src/lib/openapiSpec';

/**
 * A request body's `project_id` selects a project only for a credential that
 * does not name one; a project-scoped key names its own, and the route
 * resolves it (`resolveWriteProjectId`). A schema that requires the field
 * refuses that key before the route runs, so none may.
 */

const requiresProjectId = (schema: unknown): boolean => {
  return (
    isObjectRecord(schema) &&
    Array.isArray(schema.required) &&
    schema.required.includes('project_id')
  );
};

/** Every request body schema of one operation, `$ref`s resolved. */
const bodySchemasOf = (args: {
  operation: unknown;
  schemas: Record<string, unknown>;
}): unknown[] => {
  if (!isObjectRecord(args.operation)) return [];
  const body = args.operation.requestBody;
  if (!isObjectRecord(body) || !isObjectRecord(body.content)) return [];
  return Object.values(body.content).map((media) => {
    const schema = isObjectRecord(media) ? media.schema : null;
    return isObjectRecord(schema) && typeof schema.$ref === 'string'
      ? args.schemas[schema.$ref.split('/').pop() ?? '']
      : schema;
  });
};

describe('request bodies and project_id', () => {
  test('no request body requires project_id', async () => {
    const spec = await getMergedOpenApiSpec();
    const schemas = isObjectRecord(spec.components)
      ? (spec.components.schemas as Record<string, unknown>)
      : {};

    const offenders = Object.entries(spec.paths ?? {}).flatMap(
      ([path, item]) => {
        if (!isObjectRecord(item)) return [];
        return Object.entries(item)
          .filter(([, operation]) => {
            return bodySchemasOf({ operation, schemas }).some(
              requiresProjectId
            );
          })
          .map(([method]) => {
            return `${method.toUpperCase()} ${path}`;
          });
      }
    );

    expect(offenders).toEqual([]);
  });
});
