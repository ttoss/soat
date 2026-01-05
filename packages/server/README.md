# @soat/server

SOAT Server Package

## Development

1. Clone and Install

```bash
git clone https://github.com/ttoss/soat.git
cd soat/packages/server
pnpm install
```

2. Start database for development following instructions in [packages/postgresdb](../postgresdb/README.md) package.

3. Create a `.env` file in the `packages/server` directory based on the `.env.example` file and configure necessary environment variables (database environment variables must match with the ones used in the step above).

4. Start development server

```bash
pnpm dev
```

## License

MIT
