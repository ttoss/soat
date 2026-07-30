---
paths:
  - 'packages/postgresdb/**'
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

## Every Index Must Be Declared in `@Table` With an Explicit Name

This applies to **non-unique** indexes too, suffixed `_idx`:

```ts
{ name: 'usage_events_project_id_created_at_idx', fields: ['project_id', 'created_at'] }
```

Omitting `name:` does not leave the index unnamed — Sequelize derives one from the field list, so editing the fields silently renames the index and strands the old one in every existing database.

**Never use the `@Index` decorator.** It is silently inert here: the bundled models invoke decorators through `__decorate`, which passes a third `descriptor` argument, and sequelize-typescript registers nothing in that call shape. It reads as an index and creates none.

## Renaming or Removing an Index Requires a Manual Drop

`sync({ alter: true })` never drops an index the models stopped declaring, and there is no automated cleanup. A rename leaves the old index in every existing database until someone removes it by hand — still enforcing the old grain if it was unique, which is how a widened uniqueness constraint can go on rejecting rows it was changed to allow.

When you rename or remove an index, **state the previous name in the PR description** so the drop can be applied to each environment (`DROP INDEX CONCURRENTLY IF EXISTS <name>`, or `ALTER TABLE <table> DROP CONSTRAINT IF EXISTS <name>` when a UNIQUE constraint owns it — never `CASCADE`).

Use the name Postgres stored, not the one you wrote: a column-level `unique` is `<table>_<column>_key`, an unnamed `indexes` entry is `<table>_<field>_<field>…` truncated at 63 characters. See the "Renaming or Removing an Index Strands the Old One" section of `packages/postgresdb/README.md`. `schemaDrift.test.ts` reports leftovers when run against a real, long-lived database; against a fresh one it cannot see them, so CI will not catch a forgotten drop.

## Rebuilding After Model Changes

After adding or modifying a model, rebuild the package so dependents (e.g., `@soat/server`) pick up the updated types:

```bash
pnpm --filter @soat/postgresdb build
```

Without this step, TypeScript in the server package will report errors like `Property 'User' does not exist on type`.
