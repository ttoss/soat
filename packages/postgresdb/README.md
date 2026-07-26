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
