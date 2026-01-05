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

## Development

### Building

```bash
pnpm build
```

### Testing

```bash
pnpm test
```

### Adding New Models

1. Create a new model file in `src/models/`
2. Export it from `src/models/index.ts`
3. Update consuming packages as needed

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

## License

MIT
