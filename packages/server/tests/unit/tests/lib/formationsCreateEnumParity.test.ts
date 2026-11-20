import { schemaNameForResourceType } from 'src/lib/formation-modules/defineFormationModule';
import { loadModuleSpec } from 'src/lib/formation-modules/formationSpecLoader';
import {
  builtInResourceTypes,
  getFormationModule,
} from 'src/lib/formationsRegistry';
import {
  getMergedOpenApiSpec,
  getRouteRequestSchema,
  resolveSchemaRef,
} from 'src/lib/openapiSpec';

// A template field the create route constrains to an enum carries the same
// enum in its `*ResourceProperties` schema, where `pushFieldEnumErrors` checks
// it; without it `validate` and create accept a value the apply then fails on.

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

/** Each create body field's enum, following a field-level `$ref`. */
const createEnums = (route: string): Record<string, unknown[]> => {
  const schema = getRouteRequestSchema({ method: 'post', path: route });
  const properties = schema?.properties;
  if (typeof properties !== 'object' || properties === null) return {};
  return Object.fromEntries(
    Object.entries(properties).flatMap(([field, fieldSchema]) => {
      const values = resolveSchemaRef(fieldSchema)?.enum;
      return Array.isArray(values) ? [[field, values]] : [];
    })
  );
};

const RESOURCE_TYPES = [...builtInResourceTypes()].sort();

describe('formation enums match the create route', () => {
  test.each(RESOURCE_TYPES)(
    '%s constrains every enum field the create route constrains',
    (resourceType) => {
      const route = createRouteFor(resourceType);
      if (route === null) return;
      const template = loadModuleSpec({
        schemaName: schemaNameForResourceType(resourceType),
      });

      const divergent = Object.entries(createEnums(route)).flatMap(
        ([field, allowed]) => {
          const declared = template.fieldSpecs[field];
          if (!declared) return [];
          const extra = (declared.enumValues ?? []).filter((value) => {
            return value !== null && !allowed.includes(value);
          });
          return declared.enumValues && extra.length === 0
            ? []
            : [
                `${field}: template ${JSON.stringify(declared.enumValues)}, create ${JSON.stringify(allowed)}`,
              ];
        }
      );

      expect(divergent).toEqual([]);
    }
  );
});
