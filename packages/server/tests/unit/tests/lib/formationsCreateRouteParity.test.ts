import { schemaNameForResourceType } from 'src/lib/formation-modules/defineFormationModule';
import { loadModuleSchema } from 'src/lib/formation-modules/formationSpecLoader';
import {
  builtInResourceTypes,
  getFormationModule,
} from 'src/lib/formationsRegistry';
import { validateFormationTemplate } from 'src/lib/formationsValidation';
import { isObjectRecord } from 'src/lib/openapiSchemaFields';
import {
  getMergedOpenApiSpec,
  getRouteRequestSchema,
  resolveSchemaRef,
} from 'src/lib/openapiSpec';
import { isOpenOrAmbiguous } from 'src/lib/openapiUnknownFields';

// A template field the create route constrains to an enum, at any depth,
// carries the same enum in its `*ResourceProperties` schema, and `validate`
// refuses a value outside it; otherwise `validate` and create accept a value
// the apply then fails on.

/** Types whose create action names no single `POST` route. */
const CREATE_ROUTES: Record<string, string | null> = {
  dataset: '/api/v1/datasets',
  dataset_item: '/api/v1/datasets/{dataset_id}/items',
  session: '/api/v1/sessions',
  // Prices are written through `PUT`, which takes no enum field.
  project_price: null,
};

const createRouteFor = (resourceType: string): string | null => {
  if (resourceType in CREATE_ROUTES) return CREATE_ROUTES[resourceType];

  const authorization = getFormationModule({ resourceType })?.authorization;
  const action =
    authorization && 'create' in authorization
      ? authorization.create
      : undefined;
  const routes = Object.entries(getMergedOpenApiSpec().paths).filter(
    ([, pathItem]) => {
      const post =
        typeof pathItem === 'object' && pathItem !== null && 'post' in pathItem
          ? pathItem.post
          : undefined;
      return (
        typeof post === 'object' &&
        post !== null &&
        'x-iam-action' in post &&
        post['x-iam-action'] === action
      );
    }
  );
  if (routes.length !== 1) {
    throw new Error(
      `${resourceType}: ${routes.length} POST routes carry ${String(action)}; name its create route in CREATE_ROUTES`
    );
  }
  return routes[0][0];
};

/**
 * Each enum a schema declares, keyed by its dotted path, at every closed object
 * level the template walk descends (an array of objects as index `0`).
 */
const enumsByPath = (
  schema: unknown,
  prefix = '',
  seen: ReadonlySet<unknown> = new Set()
): Record<string, unknown[]> => {
  const level = resolveSchemaRef(schema);
  if (!level || seen.has(level) || isOpenOrAmbiguous(level)) return {};
  const properties = level.properties;
  if (!isObjectRecord(properties)) return {};

  const inner = new Set([...seen, level]);
  return Object.fromEntries(
    Object.entries(properties).flatMap(([field, fieldSchema]) => {
      const path = prefix ? `${prefix}.${field}` : field;
      const resolved = resolveSchemaRef(fieldSchema);
      if (Array.isArray(resolved?.enum)) return [[path, resolved.enum]];
      const items = resolveSchemaRef(resolved?.items);
      return Object.entries(
        items
          ? enumsByPath(items, `${path}.0`, inner)
          : enumsByPath(resolved, path, inner)
      );
    })
  );
};

/** Properties carrying `value` at a dotted path (`0` is an array index). */
const propertiesAt = (path: string, value: unknown): unknown => {
  return path
    .split('.')
    .reverse()
    .reduce<unknown>((inner, segment) => {
      return segment === '0' ? [inner] : { [segment]: inner };
    }, value);
};

const RESOURCE_TYPES = [...builtInResourceTypes()].sort();

const templateSchema = (resourceType: string) => {
  return loadModuleSchema({
    schemaName: schemaNameForResourceType(resourceType),
  });
};

const templateEnums = (resourceType: string) => {
  return enumsByPath(templateSchema(resourceType));
};

/** Whether the schema declares every segment of a dotted path. */
const declaresPath = (schema: unknown, path: string): boolean => {
  let level = resolveSchemaRef(schema);
  for (const segment of path.split('.')) {
    if (!level) return false;
    if (segment === '0') {
      level = resolveSchemaRef(level.items);
      continue;
    }
    const properties = level.properties;
    if (!isObjectRecord(properties) || !(segment in properties)) return false;
    level = resolveSchemaRef(properties[segment]);
  }
  return level !== null;
};

describe('formation enums match the create route', () => {
  test.each(RESOURCE_TYPES)(
    '%s constrains every enum field the create route constrains',
    (resourceType) => {
      const route = createRouteFor(resourceType);
      if (route === null) return;
      const declaredEnums = templateEnums(resourceType);
      const createSchema = getRouteRequestSchema({
        method: 'post',
        path: route,
      });

      const divergent = Object.entries(enumsByPath(createSchema)).flatMap(
        ([field, allowed]) => {
          if (!declaresPath(templateSchema(resourceType), field)) return [];
          const declared = declaredEnums[field];
          const extra = (declared ?? []).filter((value) => {
            return value !== null && !allowed.includes(value);
          });
          return declared && extra.length === 0
            ? []
            : [
                `${field}: template ${JSON.stringify(declared)}, create ${JSON.stringify(allowed)}`,
              ];
        }
      );

      expect(divergent).toEqual([]);
    }
  );

  test.each(RESOURCE_TYPES)(
    '%s validate refuses a value outside every enum it declares',
    (resourceType) => {
      const unchecked = Object.keys(templateEnums(resourceType)).filter(
        (path) => {
          const { errors } = validateFormationTemplate({
            resources: {
              R: {
                type: resourceType,
                properties: propertiesAt(path, 'not-an-enum-member'),
              },
            },
          });
          return !errors.some((error) => {
            return error.path === `resources.R.properties.${path}`;
          });
        }
      );

      expect(unchecked).toEqual([]);
    }
  );
});

/**
 * The component a property schema names through `$ref`, directly or as the one
 * member of an `allOf` that carries the property's own wording, or null.
 */
const refName = (schema: unknown): string | null => {
  if (!isObjectRecord(schema)) return null;
  if (Array.isArray(schema.allOf) && schema.allOf.length === 1) {
    return refName(schema.allOf[0]);
  }
  if (typeof schema.$ref !== 'string') return null;
  return schema.$ref.split('/').pop() ?? null;
};

// A field the create route defines by `$ref` has one definition; a template
// copy of it drifts from the route's shape and description. A template may
// take the component's `Nullable` variant, which an update clears with.
describe('formation properties share the create route definitions', () => {
  test.each(RESOURCE_TYPES)(
    '%s $refs every component the create route $refs',
    (resourceType) => {
      const route = createRouteFor(resourceType);
      if (route === null) return;
      const createProperties = getRouteRequestSchema({
        method: 'post',
        path: route,
      })?.properties;
      if (!isObjectRecord(createProperties)) return;
      const templateProperties = templateSchema(resourceType).properties;

      const copied = Object.entries(createProperties).flatMap(
        ([field, fieldSchema]) => {
          const shared = refName(fieldSchema);
          if (!shared || !(field in templateProperties)) return [];
          const declared = refName(templateProperties[field]);
          return declared === shared || declared === `Nullable${shared}`
            ? []
            : [field];
        }
      );

      expect(copied).toEqual([]);
    }
  );
});
