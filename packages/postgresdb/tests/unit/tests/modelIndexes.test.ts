import { Sequelize } from '@ttoss/postgresdb';

// The built output, not `src`: Babel's TypeScript transform rejects a decorated
// `declare` field, so the model sources cannot be transpiled by `babel-jest`.
// `dist` is compiled by tsdown with real TypeScript decorators and is what both
// consumers and `ttoss-postgresdb sync` load, so asserting against it checks the
// artifact that actually reaches the database. `turbo run test` depends on
// `build`; run `pnpm build` first when running this suite directly.
import { models } from '../../../dist/index.cjs';

/**
 * Every unique constraint in this package must be declared as an explicitly
 * named entry in the model's `indexes` array.
 *
 * Column-level `unique: true` (and the `@Unique` decorator) emits a bare
 * `UNIQUE` in the column DDL rather than an index Sequelize can recognize
 * later. Postgres names the resulting constraint itself, so on the next
 * `sync({ alter: true })` Sequelize sees a column it believes is not unique yet
 * and re-issues the constraint — every boot adds another one until the name
 * collision crashes startup with `42P07`. An entry in `indexes` is compared
 * against the catalog by name, so an explicitly named index is recognized as
 * already present and left alone.
 *
 * The name has to be explicit, not merely present: Sequelize derives one from
 * the table and field list when it is omitted, and that derived name silently
 * exceeds Postgres's 63-character identifier limit on wider indexes. Postgres
 * truncates what it stores, the derived name stops matching, and the same
 * re-add loop starts over.
 */
const modelList = Object.values(models);

// Registering the models with a Sequelize instance is what resolves the
// decorator metadata into `rawAttributes` / `options.indexes`. `underscored`
// mirrors `initialize()` in @ttoss/postgresdb so attribute names map to the same
// columns as in production. No connection is opened — nothing here talks to a
// database.
new Sequelize({
  dialect: 'postgres',
  define: { underscored: true },
  models: modelList,
});

type ModelIndex = {
  name?: string;
  unique?: boolean;
  fields?: unknown;
};

type ModelMeta = {
  model: string;
  table: string;
  attributes: [string, { unique?: unknown }][];
  indexes: readonly ModelIndex[];
};

const modelEntries: ModelMeta[] = modelList.map((model) => {
  return {
    model: model.name,
    table: model.tableName,
    attributes: Object.entries(model.rawAttributes),
    indexes: model.options.indexes ?? [],
  };
});

const uniqueIndexes = modelEntries.flatMap(({ model, table, indexes }) => {
  return indexes
    .filter((index) => {
      return index.unique;
    })
    .map((index) => {
      return { model, table, index };
    });
});

/**
 * Sequelize fills in a derived `name` for every unnamed index during `init`, so
 * the mere presence of `name` proves nothing. What distinguishes a hand-written
 * name is the suffix: a derived name is `<table>_<field>_<field>` and never ends
 * in `_unique` or `_uk`.
 */
const EXPLICIT_UNIQUE_NAME = /_(unique|uk)$/;

describe('model unique constraints', () => {
  test('the model list resolves to real tables', () => {
    expect(modelEntries.length).toBeGreaterThan(0);
    expect(uniqueIndexes.length).toBeGreaterThan(0);

    for (const { model, table, attributes } of modelEntries) {
      expect(model).toBeTruthy();
      expect(table).toBeTruthy();
      expect(attributes.length).toBeGreaterThan(0);
    }
  });

  test('no column declares `unique` — use a named index instead', () => {
    const offenders: string[] = [];

    for (const { model, attributes } of modelEntries) {
      for (const [attribute, definition] of attributes) {
        if (definition.unique) {
          offenders.push(`${model}.${attribute}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test('every unique index carries a hand-written name', () => {
    const offenders = uniqueIndexes
      .filter(({ index }) => {
        return !EXPLICIT_UNIQUE_NAME.test(index.name ?? '');
      })
      .map(({ model, index }) => {
        return `${model}: ${index.name} ${JSON.stringify(index.fields)}`;
      });

    expect(offenders).toEqual([]);
  });

  test('every unique index name is prefixed with its table name', () => {
    const offenders = uniqueIndexes
      .filter(({ table, index }) => {
        return !index.name?.startsWith(`${table}_`);
      })
      .map(({ model, index }) => {
        return `${model}: ${index.name}`;
      });

    expect(offenders).toEqual([]);
  });

  test('every model with a publicId column has a unique index on it', () => {
    const offenders: string[] = [];

    for (const { model, attributes, indexes } of modelEntries) {
      const hasPublicId = attributes.some(([attribute]) => {
        return attribute === 'publicId';
      });

      if (!hasPublicId) {
        continue;
      }

      const hasIndex = indexes.some((index) => {
        return (
          index.unique &&
          Array.isArray(index.fields) &&
          index.fields.length === 1 &&
          index.fields[0] === 'public_id'
        );
      });

      if (!hasIndex) {
        offenders.push(model);
      }
    }

    expect(offenders).toEqual([]);
  });

  test('index names fit Postgres’s 63-character identifier limit', () => {
    const offenders: string[] = [];

    for (const { model, indexes } of modelEntries) {
      for (const index of indexes) {
        if (index.name && index.name.length > 63) {
          offenders.push(`${model}: ${index.name} (${index.name.length})`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test('index names are unique across all models', () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];

    for (const { model, indexes } of modelEntries) {
      for (const index of indexes) {
        if (!index.name) {
          continue;
        }

        const owner = seen.get(index.name);

        if (owner) {
          collisions.push(`${index.name}: ${owner} and ${model}`);
        } else {
          seen.set(index.name, model);
        }
      }
    }

    expect(collisions).toEqual([]);
  });
});
