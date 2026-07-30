import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { Sequelize } from '@ttoss/postgresdb';
import { initialize } from '@ttoss/postgresdb';

// `dist`, not `src`: Babel's TypeScript transform rejects a decorated `declare`
// field, so the models are only loadable from the compiled artifact — which is
// also what `initialize()` loads in production. `turbo run test` depends on
// `build`.
import {
  dropRetiredIndexes,
  models,
  RETIRED_INDEX_NAMES,
} from '../../../dist/index.cjs';

/**
 * What `modelIndexes.test.ts` structurally cannot see.
 *
 * That suite reads model metadata and never opens a connection, so it can prove
 * the models declare well-formed names — and nothing at all about the objects
 * an actual database holds. The failure this file exists for lives exactly
 * there: `sync({ alter: true })` creates what the models declare and **never
 * drops** what they no longer declare, so a database accumulates one index per
 * naming generation and keeps enforcing grains the models retired.
 *
 * Everything here therefore runs against a real Postgres: sync the schema, then
 * interrogate `pg_index` / `pg_constraint`.
 */
jest.setTimeout(180_000);

// Same key the server's boot sync uses (`SCHEMA_SYNC_LOCK_KEY` in
// `packages/server/src/db.ts`). Nothing else contends for it here; it is passed
// through so the tested call is shaped exactly like the boot call.
const SCHEMA_SYNC_LOCK_KEY = 0x50a7_5c_00;

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

/**
 * The index name Postgres cited when rejecting a write, or `null` if the write
 * succeeded.
 *
 * Sequelize collapses every unique violation to the message "Validation error",
 * so asserting on `toThrow(name)` would pass for the wrong index — and *which*
 * index rejected the row is the entire question here. The driver error under
 * `original` carries the real `constraint`.
 */
const violatedConstraint = async (
  write: () => Promise<unknown>
): Promise<string | null> => {
  try {
    await write();
    return null;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'original' in error) {
      const original: unknown = error.original;

      if (
        typeof original === 'object' &&
        original !== null &&
        'constraint' in original &&
        typeof original.constraint === 'string'
      ) {
        return original.constraint;
      }
    }

    throw error;
  }
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

describe('dropRetiredIndexes', () => {
  const RETIRED_CONSTRAINT = 'users_username_key';
  const RETIRED_INDEX = 'usage_events_idempotency_key';

  const indexExists = async (name: string) => {
    return (await listCatalogIndexes()).some((index) => {
      return index.name === name;
    });
  };

  /**
   * Recreate the two shapes a retired name can have in a real database: the
   * Postgres-named constraint left by a column-level `unique` (generation 1),
   * and the plain index left by an `indexes` entry that had no `name`
   * (generation 2). Both are duplicates of a live, model-declared index.
   */
  beforeEach(async () => {
    await sequelize.query(
      `ALTER TABLE users ADD CONSTRAINT ${RETIRED_CONSTRAINT} UNIQUE (username)`
    );
    await sequelize.query(
      `CREATE UNIQUE INDEX ${RETIRED_INDEX} ON usage_events (idempotency_key)`
    );
  });

  afterEach(async () => {
    await sequelize.query(
      `ALTER TABLE users DROP CONSTRAINT IF EXISTS ${RETIRED_CONSTRAINT}`
    );
    await sequelize.query(`DROP INDEX IF EXISTS ${RETIRED_INDEX}`);
  });

  test('drops a retired constraint and a retired index', async () => {
    const result = await dropRetiredIndexes({
      sequelize,
      advisoryLockKey: SCHEMA_SYNC_LOCK_KEY,
    });

    expect(result.failed).toEqual([]);
    expect(result.dropped.sort()).toEqual(
      [RETIRED_CONSTRAINT, RETIRED_INDEX].sort()
    );
    expect(await indexExists(RETIRED_CONSTRAINT)).toBe(false);
    expect(await indexExists(RETIRED_INDEX)).toBe(false);
  });

  test('leaves the live model-declared indexes in place', async () => {
    await dropRetiredIndexes({
      sequelize,
      advisoryLockKey: SCHEMA_SYNC_LOCK_KEY,
    });

    // The generation-3 names that replaced the two dropped above. Uniqueness
    // enforcement has to survive the cleanup — that is the whole difference
    // between dropping a redundant constraint and dropping a guarantee.
    expect(await indexExists('users_username_unique')).toBe(true);
    expect(await indexExists('usage_events_idempotency_key_unique')).toBe(true);
  });

  test('is idempotent — a second run drops nothing', async () => {
    await dropRetiredIndexes({
      sequelize,
      advisoryLockKey: SCHEMA_SYNC_LOCK_KEY,
    });

    const second = await dropRetiredIndexes({
      sequelize,
      advisoryLockKey: SCHEMA_SYNC_LOCK_KEY,
    });

    // Every boot after the first issues no DDL at all.
    expect(second).toEqual({ dropped: [], failed: [] });
  });

  test('sync does not re-create a dropped retired name', async () => {
    await dropRetiredIndexes({
      sequelize,
      advisoryLockKey: SCHEMA_SYNC_LOCK_KEY,
    });

    await sequelize.sync({ alter: true });

    // If a retired name were still model-declared, `sync` would put it back and
    // the two would fight forever, one DROP and one CREATE per boot.
    expect(await indexExists(RETIRED_CONSTRAINT)).toBe(false);
    expect(await indexExists(RETIRED_INDEX)).toBe(false);
  });

  test('reports a failed drop instead of throwing', async () => {
    // A retired *constraint* another object depends on cannot be dropped
    // without CASCADE, which this deliberately never uses. Boot must survive
    // that: the service has been running with the stale object all along, so
    // failing startup over it would be strictly worse than leaving it.
    //
    // The live `activity_entries_public_id_unique` index has to go first: a
    // foreign key binds to whichever unique index Postgres picks, so while both
    // exist the dependency might land on the live one and the retired
    // constraint would drop cleanly. Removing it leaves exactly one candidate.
    await sequelize.query(
      'DROP INDEX IF EXISTS activity_entries_public_id_unique'
    );
    await sequelize.query(`
      ALTER TABLE activity_entries
        ADD CONSTRAINT activity_entries_public_id_key UNIQUE (public_id)
    `);
    await sequelize.query(`
      CREATE TABLE drift_dependent (
        public_id VARCHAR(32) REFERENCES activity_entries (public_id)
      )
    `);

    try {
      const result = await dropRetiredIndexes({
        sequelize,
        advisoryLockKey: SCHEMA_SYNC_LOCK_KEY,
      });

      expect(result.failed).toEqual([
        {
          name: 'activity_entries_public_id_key',
          error: expect.stringContaining('depend on it'),
        },
      ]);
      // The other retired objects are still dropped — one failure does not
      // abort the sweep.
      expect(result.dropped.sort()).toEqual(
        [RETIRED_CONSTRAINT, RETIRED_INDEX].sort()
      );
    } finally {
      await sequelize.query('DROP TABLE IF EXISTS drift_dependent');
      await sequelize.query(`
        ALTER TABLE activity_entries
          DROP CONSTRAINT IF EXISTS activity_entries_public_id_key
      `);
      // Put the live index back so later tests see the real schema.
      await sequelize.sync({ alter: true });
    }
  });
});

/**
 * The bug the retired list exists to fix, reproduced end to end.
 *
 * #561 widened the `price_books` uniqueness grain to include `component`. The
 * 5-column predecessor was never dropped and kept enforcing the old grain, so
 * the ordinary component-normalized case — an `input_tokens` row and an
 * `output_tokens` row for one fully-scoped SKU — was rejected with `23505`,
 * citing an index name that appears nowhere in the codebase.
 */
describe('price_books stale uniqueness grain', () => {
  const STALE_INDEX =
    'price_books_ai_provider_id_project_id_provider_model_effective_';

  const EFFECTIVE_FROM = '2026-01-01T00:00:00Z';

  const insertPriceBook = async (args: {
    publicId: string;
    component: string;
  }) => {
    await sequelize.query(
      `INSERT INTO price_books
         (public_id, ai_provider_id, project_id, meter_type, provider, model,
          component, unit, unit_price, effective_from, created_at)
       VALUES
         (:publicId, :aiProviderId, :projectId, 'llm_tokens', 'openai',
          'gpt-4o', :component, 'token', 0.000001, :effectiveFrom, NOW())`,
      {
        replacements: {
          publicId: args.publicId,
          // Both scope columns non-NULL: the stale index is NULLS DISTINCT, so
          // it only engages once neither is null. That is why the bug stayed
          // latent — no production row had both set.
          aiProviderId: 1,
          projectId: 1,
          component: args.component,
          effectiveFrom: EFFECTIVE_FROM,
        },
      }
    );
  };

  beforeAll(async () => {
    // Seed the two FK targets the price rows point at.
    await sequelize.query(`
      INSERT INTO projects (id, public_id, name, created_at, updated_at)
      VALUES (1, 'prj_drift', 'drift', NOW(), NOW())
      ON CONFLICT DO NOTHING
    `);
    await sequelize.query(`
      INSERT INTO ai_providers
        (id, public_id, project_id, name, provider, default_model,
         created_at, updated_at)
      VALUES (1, 'aip_drift', 1, 'drift', 'openai', 'gpt-4o', NOW(), NOW())
      ON CONFLICT DO NOTHING
    `);
  });

  beforeEach(async () => {
    await sequelize.query('DELETE FROM price_books');
    // Recreate the pre-#561 index exactly as production held it: the 5-column
    // grain under its truncated generation-2 name.
    await sequelize.query(`
      CREATE UNIQUE INDEX ${STALE_INDEX}
        ON price_books
        (ai_provider_id, project_id, provider, model, effective_from)
    `);
  });

  afterEach(async () => {
    await sequelize.query(`DROP INDEX IF EXISTS ${STALE_INDEX}`);
    await sequelize.query('DELETE FROM price_books');
  });

  test('the stale index rejects two rows differing only by component', async () => {
    await insertPriceBook({ publicId: 'prc_in', component: 'input_tokens' });

    const violated = await violatedConstraint(() => {
      return insertPriceBook({
        publicId: 'prc_out',
        component: 'output_tokens',
      });
    });

    // The exact production symptom: rejected by a name that appears nowhere in
    // the codebase.
    expect(violated).toBe(STALE_INDEX);
  });

  test('dropping it lets the component-normalized rows insert', async () => {
    const result = await dropRetiredIndexes({
      sequelize,
      advisoryLockKey: SCHEMA_SYNC_LOCK_KEY,
    });

    expect(result.dropped).toContain(STALE_INDEX);

    await insertPriceBook({ publicId: 'prc_in', component: 'input_tokens' });
    await insertPriceBook({ publicId: 'prc_out', component: 'output_tokens' });

    const [rows] = await sequelize.query('SELECT * FROM price_books');
    expect(rows).toHaveLength(2);
  });

  test('the live 6-column index still rejects an exact duplicate', async () => {
    // Dropping the stale grain must not drop the guarantee: the same
    // (scope, sku, component, effective_from) twice is still a conflict.
    await dropRetiredIndexes({
      sequelize,
      advisoryLockKey: SCHEMA_SYNC_LOCK_KEY,
    });

    await insertPriceBook({ publicId: 'prc_in', component: 'input_tokens' });

    const violated = await violatedConstraint(() => {
      return insertPriceBook({
        publicId: 'prc_dup',
        component: 'input_tokens',
      });
    });

    expect(violated).toBe('price_books_scope_sku_component_effective_uk');
  });

  test('every retired name is a name no model declares', () => {
    // Belt and braces against the one way this file could do damage: if a live
    // index name ever entered the list, the tests above would still pass while
    // every boot dropped an index `sync` immediately re-created.
    const overlap = RETIRED_INDEX_NAMES.filter((name: string) => {
      return declaredIndexNames.has(name);
    });

    expect(overlap).toEqual([]);
  });
});
