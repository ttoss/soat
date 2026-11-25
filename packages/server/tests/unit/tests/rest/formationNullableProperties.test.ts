import { schemaNameForResourceType } from 'src/lib/formation-modules/defineFormationModule';
import { loadModuleSchema } from 'src/lib/formation-modules/formationSpecLoader';
import {
  builtInResourceTypes,
  clearablePropertiesOf,
  getFormationModule,
} from 'src/lib/formationsRegistry';
import { resolveSchemaRef } from 'src/lib/openapiSpec';

import {
  nextSeed,
  planChange,
  setupFormationModuleFixtures,
  templateOf,
} from '../../fixtures/formationModules';
import {
  DECLARATIONS,
  NOT_CLEARABLE_ALONE,
  type NullableFixtures,
  setupNullableFixtures,
} from '../../fixtures/nullableDeclarations';
import { authenticatedTestClient } from '../../testClient';

// A property its `<Type>ResourceProperties` marks nullable is one a template
// clears by dropping it, which reaches the module's update as `null`. Every
// updatable built-in type must take that `null` and read back as a resource
// that never declared the property, or as `null`.

const UPDATABLE_TYPES = [...builtInResourceTypes()].filter((type) => {
  const authorization = getFormationModule({
    resourceType: type,
  })?.authorization;
  return (
    authorization !== undefined &&
    'update' in authorization &&
    authorization.update !== undefined
  );
});

const CLEAR_CASES = UPDATABLE_TYPES.flatMap((type) => {
  return [...clearablePropertiesOf(type)]
    .filter((field) => {
      return !(field in (NOT_CLEARABLE_ALONE[type] ?? {}));
    })
    .map((field) => {
      return { type, field };
    });
});

let fx: NullableFixtures;

beforeAll(async () => {
  fx = await setupNullableFixtures(
    await setupFormationModuleFixtures({ prefix: 'fmnull' })
  );
});

const sets = (properties: Record<string, unknown>, field: string) => {
  return properties[field] !== null && properties[field] !== undefined;
};

/** The smallest declaration setting `field`, so no sibling depends on it. */
const declarationFor = (args: { type: string; field: string }) => {
  const [declare] = (DECLARATIONS[args.type] ?? [])
    .filter((candidate) => {
      return sets(candidate(fx, 'probe'), args.field);
    })
    .sort((a, b) => {
      return (
        Object.keys(a(fx, 'probe')).length - Object.keys(b(fx, 'probe')).length
      );
    });
  return declare;
};

describe('a nullable property is clearable', () => {
  test.each(UPDATABLE_TYPES)('%s, through a $ref too', (type) => {
    const { properties } = loadModuleSchema({
      schemaName: schemaNameForResourceType(type),
    });
    const nullable = Object.keys(properties).filter((field) => {
      return resolveSchemaRef(properties[field])?.nullable === true;
    });

    expect([...clearablePropertiesOf(type)].sort()).toEqual(nullable.sort());
  });
});

describe('the declarations set every nullable property', () => {
  test.each(UPDATABLE_TYPES)('%s', (type) => {
    const uncovered = [...clearablePropertiesOf(type)].filter((field) => {
      return (
        !(field in (NOT_CLEARABLE_ALONE[type] ?? {})) &&
        declarationFor({ type, field }) === undefined
      );
    });
    expect(uncovered).toEqual([]);
  });
});

const deploy = async (args: {
  type: string;
  properties: Record<string, unknown>;
}) => {
  const res = await authenticatedTestClient(fx.adminToken)
    .post('/api/v1/formations')
    .send({
      project_id: fx.projectId,
      name: `nullable-${nextSeed()}`,
      template: templateOf(args.type, args.properties),
    });
  expect(res.body.error).toBeNull();
  expect(res.status).toBe(201);
  return res.body.id as string;
};

const readField = async (args: {
  formationId: string;
  type: string;
  properties: Record<string, unknown>;
  field: string;
}) => {
  const change = await planChange({
    fx,
    formationId: args.formationId,
    template: templateOf(args.type, args.properties),
  });
  const deleted = await authenticatedTestClient(fx.adminToken).delete(
    `/api/v1/formations/${args.formationId}`
  );
  expect(deleted.status).toBe(200);
  return change.diff.current[args.field];
};

describe('PUT /api/v1/formations/:formation_id — a nullable property set to null', () => {
  test.each(CLEAR_CASES)('$type.$field', async ({ type, field }) => {
    const declare = declarationFor({ type, field });
    const { [field]: _dropped, ...undeclared } = declare(fx, nextSeed());
    const neverDeclared = await readField({
      formationId: await deploy({ type, properties: undeclared }),
      type,
      properties: undeclared,
      field,
    });

    const declared = declare(fx, nextSeed());
    const formationId = await deploy({ type, properties: declared });
    const cleared = { ...declared, [field]: null };
    const updated = await authenticatedTestClient(fx.adminToken)
      .put(`/api/v1/formations/${formationId}`)
      .send({ template: templateOf(type, cleared) });
    expect(updated.body.error).toBeNull();
    expect(updated.status).toBe(200);

    // A cleared default (`max_steps`) may read as `null` where a resource
    // created without it reads the default.
    expect([neverDeclared, null, undefined]).toContainEqual(
      await readField({ formationId, type, properties: cleared, field })
    );
  });
});
