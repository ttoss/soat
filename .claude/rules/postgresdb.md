---
paths:
  - "packages/postgresdb/**"
---

# PostgresDB Package Instructions

Check `#fetch https://ttoss.dev/docs/modules/packages/postgresdb/` for the official documentation of the `@ttoss/postgresdb` package used in this module.

If you modify the database schema, ensure to make the tests pass by running `pnpm test` in the `packages/postgresdb`.

## Public ID

All models must have a `publicId` column (see `src/utils/publicId.ts`). The `publicId` is the only identifier exposed to external consumers. The internal `id` (UUID primary key) is for database-level joins only and must never be returned through any API or tool.

When adding a new model, register a corresponding prefix in `src/utils/publicId.ts` (e.g., `user: 'usr_'`) and use it in the model's `beforeValidate` hook via `generatePublicId`.

## Unique Constraints

Never use column-level `unique: true` or the `@Unique` decorator. Every unique constraint must be an entry in the model's `@Table` `indexes` array with an explicit `name`:

```ts
@Table({
  tableName: 'agents',
  indexes: [
    { name: 'agents_public_id_unique', unique: true, fields: ['public_id'] },
  ],
})
```

Column-level `unique` makes `sync({ alter: true })` re-add the same constraint on every boot until it crashes with `42P07`, and an omitted `name` lets Sequelize derive one that can exceed Postgres's 63-character identifier limit. Name indexes `<table>_<field>_..._unique` with snake_case columns (models are `underscored`). `packages/postgresdb/tests/unit/tests/modelIndexes.test.ts` enforces this.

## Rebuilding After Model Changes

After adding or modifying a model, rebuild the package so dependents (e.g., `@soat/server`) pick up the updated types:

```bash
pnpm --filter @soat/postgresdb build
```

Without this step, TypeScript in the server package will report errors like `Property 'User' does not exist on type`.
