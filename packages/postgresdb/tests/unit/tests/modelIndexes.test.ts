import { Sequelize } from '@ttoss/postgresdb';

// The built output, not `src`: Babel rejects a decorated `declare` field, and
// `dist` is what both consumers and `sync` load — so this asserts against the
// artifact that actually reaches the database. Run `pnpm build` first.
import { models } from '../../../dist/index.cjs';

/**
 * Every unique constraint in this package must be declared as an explicitly
 * named entry in the model's `indexes` array.
 *
 * Column-level `unique: true` emits a bare `UNIQUE` in the column DDL rather
 * than an index Sequelize can recognize later. Postgres names the constraint
 * itself, so on the next `sync({ alter: true })` Sequelize believes the column
 * is not unique yet and re-issues it — every boot adding another until the name
 * collision crashes startup with `42P07`.
 *
 * The name has to be explicit, not merely present: Sequelize derives one from
 * the table and field list, and that derived name silently exceeds Postgres's
 * 63-character identifier limit on wider indexes, so it stops matching what
 * Postgres stored and the same re-add loop starts over.
 */
const modelList = Object.values(models);

// Registering the models is what resolves decorator metadata into
// `options.indexes`. `underscored` mirrors `initialize()` so attributes map to
// production's columns. No connection is opened.
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

/**
 * The name Sequelize derives for an index that declares none: the table
 * followed by every field, joined with `_`. Comparing against it is the exact
 * test for "was this name written by a human", with no suffix convention to
 * agree on.
 */
const derivedNameOf = (args: { table: string; index: ModelIndex }) => {
  const fields = (
    Array.isArray(args.index.fields) ? args.index.fields : []
  ).map((field) => {
    return typeof field === 'string'
      ? field
      : ((field as { name?: string }).name ?? '');
  });

  return [args.table, ...fields].join('_');
};

describe('every index name is written, not derived', () => {
  /**
   * The rule that closes the loop this package kept going round.
   *
   * A derived name is a function of the field list, so *editing the fields
   * renames the index* — and `sync({ alter: true })` responds to a rename by
   * creating the new name and keeping the old one forever, while the diff shows
   * only a changed `fields:` array. #508 and #561 both landed that way.
   *
   * With an explicit name the change is visible, and `schemaDrift.test.ts`
   * catches it against a real catalog if it is missed.
   */
  test('no index name equals the one Sequelize would derive', () => {
    const offenders: string[] = [];

    for (const { model, table, indexes } of modelEntries) {
      for (const index of indexes) {
        if (index.name === derivedNameOf({ table, index })) {
          offenders.push(`${model}: ${index.name}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test('every non-unique index name ends in `_idx`', () => {
    // Unique names end in `_unique`/`_uk` (asserted below), so a suffix on the
    // rest makes "is this an index name?" answerable by looking at it — in a
    // Postgres error, a slow-query log, or a review diff.
    const offenders: string[] = [];

    for (const { model, indexes } of modelEntries) {
      for (const index of indexes) {
        if (!index.unique && !index.name?.endsWith('_idx')) {
          offenders.push(`${model}: ${index.name}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test('no model uses the `@Index` decorator', () => {
    // `@Index` is silently inert: the bundled models invoke decorators through
    // `__decorate`, whose third argument makes sequelize-typescript register
    // nothing — so it reads as an index and produces none. Seven had
    // accumulated, leaving four columns unindexed. Asserts on the effect rather
    // than grepping source: what reaches `options.indexes` is real.
    const declaredFieldSets = new Set(
      modelEntries.flatMap(({ table, indexes }) => {
        return indexes.map((index) => {
          return derivedNameOf({ table, index });
        });
      })
    );

    // Every column that a `@ForeignKey` points at and that the models intend to
    // index must appear in some declared index. This pins the four that were
    // silently missing.
    const mustBeIndexed = [
      'traces_agent_id',
      'traces_parent_trace_id',
      'traces_root_trace_id',
      'usage_events_ai_provider_id',
    ];

    const missing = mustBeIndexed.filter((name) => {
      return !declaredFieldSets.has(name);
    });

    expect(missing).toEqual([]);
  });
});

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
