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

### Retiring an Index

`sync({ alter: true })` has no teardown step for indexes: it creates what the models declare and **never drops** what they stopped declaring. Renaming an index therefore leaves the old name in the catalog permanently, in every database the schema has ever been synced against — the two indexes then coexist, and if the rename widened a unique index the narrower predecessor keeps rejecting rows the new one is meant to allow.

So a rename is two edits, in the same change:

```ts
// 1. src/models/PriceBook.ts — the new name
{ name: 'price_books_scope_sku_component_effective_uk', unique: true, fields: [...] }
```

```ts
// 2. src/retiredIndexes.ts — the name it replaces
const RETIRED_BY_RENAME_NAMES = [
  'price_books_provider_model_effective_uk',
] as const;
```

Names listed there are dropped idempotently at boot (`dropRetiredIndexes`, called from the server's `syncSchemaWithAdvisoryLock`), so every environment converges instead of only the database someone cleaned by hand. Dropping is best-effort: a failure is logged and boot continues.

Use the name **Postgres actually stored**, which is not always the one you wrote:

| How the index was declared      | Catalog name                                      |
| ------------------------------- | ------------------------------------------------- |
| `@Column({ unique: true })`     | `<table>_<column>_key` (named by Postgres)        |
| `indexes` entry with no `name:` | `<table>_<field>_<field>…`, truncated at 63 chars |
| `indexes` entry with `name:`    | the name as written                               |

`tests/unit/tests/schemaDrift.test.ts` runs the whole thing against a real Postgres: it syncs, then asserts no index is undeclared, no two indexes are exact duplicates, a second sync adds nothing, and no retired name is one a model still declares. It starts a container by default, or reuses a running server when `TEST_DB_HOST` is set:

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
