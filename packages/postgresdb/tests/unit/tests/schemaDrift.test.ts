import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { Sequelize } from '@ttoss/postgresdb';
import { initialize } from '@ttoss/postgresdb';

// `dist`, not `src`: Babel's TypeScript transform rejects a decorated `declare`
// field, so the models are only loadable from the compiled artifact — which is
// also what `initialize()` loads in production. `turbo run test` depends on
// `build`.
import { models } from '../../../dist/index.cjs';

/**
 * What `modelIndexes.test.ts` structurally cannot see.
 *
 * That suite reads model metadata and never opens a connection, so it can prove
 * the models declare well-formed names — and nothing at all about the objects
 * an actual database holds. The failure this file exists for lives exactly
 * there: `sync({ alter: true })` creates what the models declare and **never
 * drops** what they no longer declare, so a database accumulates one index per
 * naming generation and can keep enforcing a grain the models have widened.
 *
 * Everything here therefore runs against a real Postgres: sync the schema, then
 * interrogate `pg_index` / `pg_constraint`.
 */
jest.setTimeout(180_000);

let sequelize: Sequelize;
let container: StartedPostgreSqlContainer | undefined;

const modelList = Object.values(models);

// Populated in `beforeAll`: `options.indexes` only exists once `initialize()`
// has registered the models with a Sequelize instance, which is what resolves
// the decorator metadata (and fills in the names Sequelize derives for entries
// that omit `name:`).
const declaredIndexNames = new Set<string>();

const selectRows = async (sql: string, replacements?: object) => {
  const [rows] = await sequelize.query(sql, { replacements });
  return rows;
};

/**
 * Every index in the current schema, with the primary keys separated out — a PK
 * index is named by Postgres (`<table>_pkey`) and is not declared in the models,
 * so it is never drift.
 */
const CATALOG_INDEXES_SQL = `
  SELECT idx.relname AS name, tbl.relname AS table, i.indisprimary AS is_primary
    FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_class tbl ON tbl.oid = i.indrelid
    JOIN pg_namespace ns ON ns.oid = idx.relnamespace
   WHERE ns.nspname = current_schema()
`;

type CatalogIndex = { name: string; table: string; is_primary: boolean };

const isCatalogIndex = (row: unknown): row is CatalogIndex => {
  if (typeof row !== 'object' || row === null) {
    return false;
  }

  const candidate: Record<string, unknown> = { ...row };

  return (
    typeof candidate.name === 'string' &&
    typeof candidate.table === 'string' &&
    typeof candidate.is_primary === 'boolean'
  );
};

const listCatalogIndexes = async (): Promise<CatalogIndex[]> => {
  return (await selectRows(CATALOG_INDEXES_SQL)).filter(isCatalogIndex);
};

beforeAll(async () => {
  let config: {
    username: string;
    password: string;
    database: string;
    host: string;
    port: number;
  };

  // Same escape hatch the server suite uses: point at an already-running
  // Postgres with TEST_DB_HOST, otherwise start a container.
  if (process.env.TEST_DB_HOST) {
    config = {
      username: process.env.TEST_DB_USERNAME ?? 'postgres',
      password: process.env.TEST_DB_PASSWORD ?? '',
      database: process.env.TEST_DB_NAME ?? 'soat_test',
      host: process.env.TEST_DB_HOST,
      port: Number(process.env.TEST_DB_PORT ?? 5432),
    };
  } else {
    container = await new PostgreSqlContainer(
      'pgvector/pgvector:0.8.2-pg18-trixie'
    ).start();

    config = {
      username: container.getUsername(),
      password: container.getPassword(),
      database: container.getDatabase(),
      host: container.getHost(),
      port: container.getPort(),
    };
  }

  const db = await initialize({
    models,
    createVectorExtension: true,
    logging: false,
    ...config,
  });

  sequelize = db.sequelize;

  for (const model of modelList) {
    for (const index of model.options.indexes ?? []) {
      if (index.name) {
        declaredIndexNames.add(index.name);
      }
    }
  }

  await sequelize.sync({ alter: true });
});

afterAll(async () => {
  await sequelize?.close();
  await container?.stop();
});

describe('schema drift after sync({ alter: true })', () => {
  test('every model-declared index exists in the database', async () => {
    const present = new Set(
      (await listCatalogIndexes()).map((index) => {
        return index.name;
      })
    );

    const missing = [...declaredIndexNames].filter((name) => {
      return !present.has(name);
    });

    expect(missing).toEqual([]);
  });

  test('every non-primary-key index is declared by a model', async () => {
    // The drift assertion. An index here that no model declares is an object
    // `sync` will never touch again: a rename's abandoned predecessor, or the
    // Postgres-named constraint of a column-level `unique`.
    const undeclared = (await listCatalogIndexes())
      .filter((index) => {
        return !index.is_primary && !declaredIndexNames.has(index.name);
      })
      .map((index) => {
        return `${index.table}.${index.name}`;
      });

    expect(undeclared).toEqual([]);
  });

  test('every index covers exactly the columns its model declares', async () => {
    // `sync({ alter: true })` matches an index by name only, so editing the
    // field list of an already-named index silently does nothing — the database
    // keeps indexing the old columns under a name promising different ones.
    // Only the catalog reveals it.
    const declaredColumns = new Map<string, string>();

    for (const model of modelList) {
      for (const index of model.options.indexes ?? []) {
        if (!index.name) {
          continue;
        }

        const fields = (index.fields ?? []).map((field: unknown) => {
          return typeof field === 'string'
            ? field
            : ((field as { name?: string }).name ?? '');
        });

        declaredColumns.set(index.name, fields.join(','));
      }
    }

    const actual = await selectRows(`
      SELECT idx.relname AS name,
             (SELECT string_agg(att.attname, ',' ORDER BY key.ord)
                FROM unnest(i.indkey) WITH ORDINALITY AS key(attnum, ord)
                JOIN pg_attribute att
                  ON att.attrelid = i.indrelid AND att.attnum = key.attnum
             ) AS columns
        FROM pg_index i
        JOIN pg_class idx ON idx.oid = i.indexrelid
        JOIN pg_namespace ns ON ns.oid = idx.relnamespace
       WHERE ns.nspname = current_schema() AND NOT i.indisprimary
    `);

    const mismatched: string[] = [];

    for (const row of actual) {
      if (typeof row !== 'object' || row === null) {
        continue;
      }

      const { name, columns } = row as { name?: string; columns?: string };

      if (typeof name !== 'string' || !declaredColumns.has(name)) {
        continue;
      }

      const declared = declaredColumns.get(name);

      if (columns !== declared) {
        mismatched.push(`${name}: declared (${declared}), actual (${columns})`);
      }
    }

    expect(mismatched).toEqual([]);
  });

  test('a second sync adds no indexes', async () => {
    // Pins the #710 regression directly: before it, three consecutive alter
    // passes took the index count 150 -> 205 -> 260, because a column-level
    // `unique` is re-added every time Sequelize fails to recognize it.
    const before = (await listCatalogIndexes()).length;

    await sequelize.sync({ alter: true });

    expect((await listCatalogIndexes()).length).toBe(before);
  });

  test('no two indexes are exact duplicates', async () => {
    // Grouped on everything that makes two indexes interchangeable — table,
    // access method, column list, operator class, collation, and predicate.
    // This is the query that found 66 duplicate groups in production.
    const duplicates = await selectRows(`
      SELECT tbl.relname AS table,
             array_agg(idx.relname ORDER BY idx.relname) AS names
        FROM pg_index i
        JOIN pg_class idx ON idx.oid = i.indexrelid
        JOIN pg_class tbl ON tbl.oid = i.indrelid
        JOIN pg_namespace ns ON ns.oid = idx.relnamespace
       WHERE ns.nspname = current_schema()
       GROUP BY tbl.relname,
                i.indrelid,
                idx.relam,
                i.indkey,
                i.indclass,
                i.indcollation,
                COALESCE(i.indexprs::text, ''),
                COALESCE(i.indpred::text, '')
      HAVING COUNT(*) > 1
    `);

    expect(duplicates).toEqual([]);
  });
});
