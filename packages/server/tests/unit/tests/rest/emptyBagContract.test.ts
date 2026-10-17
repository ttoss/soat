import { getMergedOpenApiSpec } from 'src/lib/openapiSpec';

/**
 * A record whose `tags` or `metadata` bag is unset leaves the field out; it is
 * never `null`. One answer for every record, so a client reads "no bag" the
 * same way on a memory as on an actor, and a filter written against one
 * resource's records does not need a null branch for the next.
 *
 * `null` stays meaningful on the way in — a full-replacement update clears a
 * bag with it — so the nullable components remain for request bodies. This
 * walks only what a `2xx` answers.
 */

const BAG_FIELDS = new Set(['tags', 'metadata']);

const NULLABLE_BAGS = new Set(['NullableTagBag', 'NullableMetadataBag']);

/**
 * Schemas a response echoes as the caller wrote them, so `null` there is the
 * caller's value rather than the record's answer.
 */
const CALLER_DOCUMENTS: ReadonlyMap<string, string> = new Map([
  ['FormationTemplate', 'a formation template is returned as written'],
]);

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const spec = getMergedOpenApiSpec();

const refName = (value: Record<string, unknown>): string | undefined => {
  return typeof value.$ref === 'string'
    ? value.$ref.split('/').pop()
    : undefined;
};

/** Whether a property schema reads as nullable, directly or through its refs. */
const isNullableBag = (schema: unknown): boolean => {
  if (!isRecord(schema)) return false;
  if (schema.nullable === true) return true;
  const name = refName(schema);
  if (name) return NULLABLE_BAGS.has(name);
  const { allOf } = schema;
  return Array.isArray(allOf) && allOf.some(isNullableBag);
};

/** Every bag property reachable from a schema, named by where it sits. */
const collectNullableBags = (args: {
  schema: unknown;
  where: string;
  seen: Set<string>;
  found: Set<string>;
}): void => {
  const { schema, where, seen, found } = args;
  if (Array.isArray(schema)) {
    for (const item of schema) {
      collectNullableBags({ ...args, schema: item });
    }
    return;
  }
  if (!isRecord(schema)) return;

  const name = refName(schema);
  if (name) {
    if (seen.has(name) || CALLER_DOCUMENTS.has(name)) return;
    seen.add(name);
    collectNullableBags({
      ...args,
      schema: spec.components.schemas[name],
      where: name,
    });
    return;
  }

  const { properties } = schema;
  if (isRecord(properties)) {
    for (const [field, property] of Object.entries(properties)) {
      if (BAG_FIELDS.has(field) && isNullableBag(property)) {
        found.add(`${where}.${field}`);
      }
    }
  }

  for (const value of Object.values(schema)) {
    collectNullableBags({ ...args, schema: value });
  }
};

const responseSchemas = (): Array<{ where: string; schema: unknown }> => {
  return Object.entries(spec.paths).flatMap(([path, pathItem]) => {
    if (!isRecord(pathItem)) return [];
    return Object.entries(pathItem).flatMap(([method, operation]) => {
      if (!HTTP_METHODS.has(method) || !isRecord(operation)) return [];
      const { responses } = operation;
      if (!isRecord(responses)) return [];
      return Object.entries(responses).flatMap(([status, response]) => {
        if (!status.startsWith('2') || !isRecord(response)) return [];
        const { content } = response;
        if (!isRecord(content)) return [];
        return Object.values(content).flatMap((media) => {
          if (!isRecord(media)) return [];
          return [
            {
              where: `${method.toUpperCase()} ${path} ${status}`,
              schema: media.schema,
            },
          ];
        });
      });
    });
  });
};

describe('an unset bag on a record is absent', () => {
  test('no response declares a nullable tags or metadata bag', () => {
    const found = new Set<string>();
    for (const { where, schema } of responseSchemas()) {
      collectNullableBags({ schema, where, seen: new Set(), found });
    }

    expect([...found].sort()).toEqual([]);
  });
});
