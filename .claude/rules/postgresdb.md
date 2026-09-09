---
paths:
  - 'packages/postgresdb/**'
---

# PostgresDB

Docs: https://ttoss.dev/docs/modules/packages/postgresdb/. After a schema
change, `pnpm test` in `packages/postgresdb` must pass, then
`pnpm --filter @soat/postgresdb build` so dependents see the new types.

## Public ID

Every model has `publicId` (`src/utils/publicId.ts`); it is the only id exposed
externally. The UUID `id` is for joins only. New model: register a prefix in
`PUBLIC_ID_PREFIXES` and generate it in `beforeValidate` via `generatePublicId`.

## Indexes

- Every index, unique or not, is an entry in `@Table({ indexes })` with an
  explicit `name`: `<table>_<field>_..._unique` or `..._idx`, snake_case
  columns. Enforced by `tests/unit/tests/modelIndexes.test.ts`.
- Never column-level `unique: true` / `@Unique` (re-added on every
  `sync({ alter: true })` until `42P07`), never an unnamed entry (derived names
  can exceed 63 chars and silently rename), never `@Index` (inert under
  `__decorate`).
- `sync({ alter: true })` never drops an index. When renaming or removing one,
  state the previous name in the PR description for a manual
  `DROP INDEX CONCURRENTLY IF EXISTS <name>` (or `ALTER TABLE … DROP CONSTRAINT
  IF EXISTS <name>`; never `CASCADE`). Use the name Postgres stored: column
  `unique` is `<table>_<column>_key`, unnamed entries are the field list
  truncated at 63. See `packages/postgresdb/README.md`; `schemaDrift.test.ts`
  only catches leftovers on a long-lived database.
