# @soat/postgresdb

Database models and operations for SOAT packages using [@ttoss/postgresdb](https://ttoss.dev/docs/modules/packages/postgresdb/).

## Installation

This package is part of the SOAT monorepo. To use it in other packages:

```json
{
  "dependencies": {
    "@soat/postgresdb": "workspace:*",
    "@ttoss/postgresdb": "^0.1.0"
  }
}
```

## Usage

### Initialize Database

```typescript
import { initializeDatabase } from '@soat/postgresdb';

const db = await initializeDatabase();
// or with custom config
const db = await initialize({ models /* other sequelize options */ });
```

### Models

You can access the defined models as follows:

```typescript
import { models } from '@soat/postgresdb';

const { File } = models;
```

### Sync Database Schema

To sync the database schema, you need to define a `env.<your_environment>` file with your database connection settings. Then run:

```bash
pnpm run sync -e <your_environment>
```

To alter the schema, add the flag `--alter`. Check the [@ttoss/postgresdb sync documentation](https://ttoss.dev/docs/modules/packages/postgresdb-cli/#sync) for more details.

### Migrations `sync` cannot perform

`sequelize.sync()` creates missing tables and never alters an existing one: it
will not change a column's type, rename a table, or backfill a value. Even
with `alter`, a foreign-key column keeps its nullability: the models' set of
`NOT NULL` foreign keys is pinned by `tests/unit/tests/foreignKeyNullability.test.ts`,
so changing one fails until a migration makes the same change. Those
changes are **versioned migrations** in `src/migrations/`, run by the ledger
runner in [`@ttoss/postgresdb`](https://ttoss.dev/docs/modules/packages/postgresdb/)
and recorded in a `schema_migrations` table it maintains itself.

The flow they follow is
[PostgreSQL Migrations](https://ttoss.dev/docs/engineering/guidelines/postgres-migrations).

| Migration                                   | Change                                                                                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `2026-09-11-memory-tags-to-jsonb`           | `memories.tags` and `memory_entries.tags` from `text[]` to key-value `jsonb`                                                                 |
| `2026-09-16-memories-rename-and-provenance` | `memories` -> `memory_stores` and `memory_entries` -> `memories`, `source_conversation_id`/`source_generation_id` collapsed into `source_id` |
| `2026-09-16-memory-assertions-and-shared-content` | `memories.content`/`embedding` moved to a shared `memory_contents` row, `memory_assertions` added, `generations.conversation_id` and the `memory_stores` threshold pair added |
| `2026-09-16-memory-rules-from-agent-extraction` | `memory_rules` added, `memory_assertions.rule_id` made a foreign key into it, and each agent's `knowledge_config.extraction` moved to a rule on its write store |
| `2026-09-18-activity-entry-generation-id` | `activity_entries.generation_id` promoted from the `detail` blob to an indexed column |
| `2026-09-18-orchestration-run-idempotency-key` | `orchestration_runs.idempotency_key`, unique per project |
| `2026-09-22-tag-bag-gin-indexes` | a GIN index with `jsonb_path_ops` over every `tags` column, so a containment match is a lookup rather than a scan |
| `2026-09-24-generation-idempotency-key` | `generations.idempotency_key`, unique per project, and `generations.idempotency_digest` |
| `2026-09-24-api-key-sha256` | `api_keys.key_hash_sha256`, unique, the SHA-256 a key is verified by; `api_keys.key_hash` nullable |
| `2026-09-24-foreign-key-nullability` | `agents.ai_provider_id`, `chats.ai_provider_id`, `api_keys.project_id` and `conversation_messages.actor_id` nullable, as their models declare |
| `2026-09-24-orchestration-output-mapping` | `orchestrations.output_mapping`, the declared shape of a run's `output` |
| `2026-09-25-usage-event-generation-public-id` | `usage_events.generation_public_id`, the durable generation id `totals.distinct.generations` counts, backfilled from the generation or from a standalone generation's idempotency key |
| `2026-09-26-usage-event-durable-public-ids` | a public id beside every other attribution FK on `usage_events` (`agent`, `trace`, `orchestration_run`, `actor`, `session`, `ai_provider`, `tool`), which `totals.distinct` counts, backfilled from the rows the FKs still name |

Run them from the server package, which owns the entrypoint:

```bash
node packages/server/dist/migrate.mjs status     # every migration, and when it ran
node packages/server/dist/migrate.mjs run --dry-run
node packages/server/dist/migrate.mjs run        # apply what is pending, then sync
```

#### Migrations run BEFORE the sync, not after

The guideline's default order is `sync` then `migrate`. This package inverts it,
and the entrypoint enforces it: a migration here renames a table the models
already describe under its new name, so a sync running first would create an
empty `memory_stores` beside the populated `memories` and then fail building an
index over a column the old table has not got. A migration that needs the
models' indexes mid-way calls `context.sync()` itself.

#### Adding one

1. A module in `src/migrations/`, built with `defineMigration`, named
   `YYYY-MM-DD-<change>` — the date it is written. Both the file and the
   migration's `name` carry it, so `ls` and `migrate status` read in the order
   they run.
2. Append it to `MIGRATIONS` in `src/migrations/index.ts`. **That array is the
   order**, not the prefix; a test fails if the two disagree. Order is a
   contract, and a name is permanent identity once merged — renaming or
   deleting one that has run anywhere makes the runner refuse to start.
3. Write `isApplied`. It reads the migration's own change back out of the
   schema, so a database that already carries it — one `sync` has just built,
   or one an operator brought to the same shape by hand — records it instead of
   replaying it. `tests/unit/tests/migrations.test.ts` fails on a migration
   without one, which is what keeps a new install from ever needing an operator
   `baseline`.
4. Make it idempotent. The ledger records what _finished_: a migration that
   throws leaves no row and is retried from the top.
5. There is no `down`. Roll forward with a new migration.

Never import a model into a migration: the models describe the schema the
migration is in the middle of changing.

#### Two traps all three migrations here hit

**A step that must not half-land goes in one `context.run`.** `run` executes
through the pool, so two calls can land on different connections and `BEGIN` /
`COMMIT` across them is not a transaction. One multi-statement string is atomic
— Postgres wraps a simple query's statements in an implicit transaction — and
takes no `values`, because bind parameters force the single-statement protocol.

**Every `isApplied` runs before any `up`.** A probe answers for the database as
it stands now, not as an earlier pending migration will leave it.
`2026-09-16-memory-assertions-and-shared-content` has to test
`memory_entries` first for exactly this reason: on a database the rename has
not reached, `memories` is still the container and has no `content` column,
which would otherwise read as "already applied" and skip the databases that
need it.

## Development

### Building

```bash
pnpm build
```

### Testing

```bash
pnpm test
```

The suite runs against `dist`, so build first (`turbo run test` already depends on `build`).

### Adding New Models

1. Create a new model file in `src/models/`
2. Export it from `src/models/index.ts`
3. Register the model's `publicId` prefix in `src/utils/publicId.ts`
4. Declare unique constraints as **named indexes** (see below)
5. Update consuming packages as needed

### Unique Constraints Must Be Named Indexes

Never use column-level `unique: true` or the `@Unique` decorator. Declare every unique constraint as an entry in the model's `indexes` array with an explicit `name`:

```ts
@Table({
  tableName: 'agents',
  indexes: [
    {
      name: 'agents_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
  ],
})
export class Agent extends Model {
  @Column({ type: DataType.STRING(32), allowNull: false })
  declare publicId: string;
}
```

Column-level `unique` emits a bare `UNIQUE` in the column DDL instead of an index Sequelize can recognize later, so every `sync({ alter: true })` re-adds the same constraint until a name collision crashes boot with `42P07`. A named index is matched against the catalog by name and left alone on subsequent syncs.

The name must be explicit: Sequelize derives one from the table and field list when it is omitted, and a derived name silently exceeds Postgres's 63-character identifier limit on wider indexes — Postgres truncates what it stores, the derived name stops matching, and the re-add loop starts over.

Convention: `<table>_<field>_..._unique`, using snake_case column names (models are `underscored`). `tests/unit/tests/modelIndexes.test.ts` enforces all of this.

### Every Index Name Is Written, Never Derived

The same rule applies to **non-unique** indexes, suffixed `_idx`:

```ts
{ name: 'usage_events_project_id_created_at_idx', fields: ['project_id', 'created_at'] }
```

Omitting `name:` does not leave the index unnamed — Sequelize derives one from the table and field list. That derived name is a _function of the fields_, so editing the fields renames the index, and `sync({ alter: true })` responds to a rename by creating the new name and keeping the old one forever. The diff that causes it shows no rename at all, only a changed `fields:` array.

The test compares each name against the one Sequelize would derive, so a name that merely looks explicit does not pass.

### Never Use the `@Index` Decorator

**`@Index` is silently inert in this package.** The models ship compiled, and the bundler's `__decorate` helper invokes property decorators with a third `descriptor` argument; in that call shape sequelize-typescript registers nothing. The decorator reads as an index in review and produces none in the database — seven had accumulated, leaving `traces.agent_id`, `traces.parent_trace_id`, `traces.root_trace_id`, and `usage_events.ai_provider_id` unindexed.

Declare every index in `@Table`, where it demonstrably works.

### Renaming or Removing an Index Strands the Old One

`sync({ alter: true })` has no teardown step for indexes: it creates what the models declare and **never drops** what they stopped declaring. There is no automated cleanup — renaming or removing an index leaves the old one in the catalog of every database the schema has ever been synced against, and it stays there until somebody drops it by hand.

That matters most when a rename **widens a unique index**: the narrower predecessor survives and goes on rejecting rows the new index exists to allow, citing a name that appears nowhere in this repo.

So a rename is a schema change with a manual follow-up. In the same change, write down the previous name — in the PR description and, if the environment is long-lived, wherever your team tracks operational steps. Then drop it in each environment:

```sql
-- a plain index
DROP INDEX CONCURRENTLY IF EXISTS <old_name>;
-- an index owned by a UNIQUE constraint
ALTER TABLE <table> DROP CONSTRAINT IF EXISTS <old_name>;
```

Never use `CASCADE`: a constraint something else depends on should fail loudly rather than take its dependents with it.

Use the name **Postgres actually stored**, which is not always the one you wrote:

| How the index was declared      | Catalog name                                      |
| ------------------------------- | ------------------------------------------------- |
| `@Column({ unique: true })`     | `<table>_<column>_key` (named by Postgres)        |
| `indexes` entry with no `name:` | `<table>_<field>_<field>…`, truncated at 63 chars |
| `indexes` entry with `name:`    | the name as written                               |

`tests/unit/tests/schemaDrift.test.ts` is what finds the leftovers. Run against a **real, long-lived** database it reports every index no model declares — which is exactly the set someone still has to drop. Against a fresh database it passes trivially, since the abandoned predecessor never existed there, so a rename is not something CI can catch for you. It syncs, then asserts no index is undeclared, no two indexes are exact duplicates, a second sync adds nothing, and every index covers the columns its model declares. It starts a container by default, or reuses a running server when `TEST_DB_HOST` is set:

```bash
TEST_DB_HOST=127.0.0.1 TEST_DB_USERNAME=postgres TEST_DB_PASSWORD=postgres \
  TEST_DB_NAME=soat_drift pnpm test
```

The other suites in this package need neither, so they still run with no database available.

### Running Database for Development

To start a PostgreSQL database for development, follow these steps:

1. Create a `.env.dev` file ([why .env.dev?](https://ttoss.dev/docs/modules/packages/postgresdb-cli/#sync)) in the `packages/postgresdb` directory based on `.env.example` and set your database configuration.

2. Start the database using Docker Compose:

```bash
pnpm db-dev:start
```

3. Sync the database schema:

```bash
pnpm sync -e dev
```

4. Stop the database when done:

```bash
pnpm db-dev:stop
```

If you need to remove containers and volumes, use:

```bash
pnpm db-dev:rm
```

## License

MIT
