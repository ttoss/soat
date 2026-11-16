---
paths:
  - 'packages/postgresdb/**'
---

# PostgresDB

## Every migration keeps the previous release working, and every expand is contracted in the next release

**Hard rule.** While release N deploys, release N−1 keeps serving on the
schema N's migrations and sync leave, from the migrate step until N's task is
healthy. A schema change N−1 cannot read or write answers 5xx in production on
every deploy. The same holds one release later: N keeps serving while N+1's
contract runs.

- **Never in the release that changes the code:** drop or rename a column or
  table, change a column's type, or convert stored values in place (e.g. an
  integer id to a public id string). Removing an attribute from a model is not
  a drop: `SCHEMA_SYNC_OPTIONS` never drops a column.
- **Expand (release N).** The migration adds the new shape beside the old and
  backfills it into the new column or table, never over the old one. The old
  shape keeps working for N−1: its column stays, nullable or defaulted if N
  stops writing it, and a trigger (or a view under the old table name) keeps
  it equal to the new one when N−1 needs to read what N writes. N's code reads
  and writes only the new shape and never names the old column or table, so
  the contract can drop it under N. N's code may read old values only inside
  a column that survives the contract. Mark each such line, and its tests,
  with a comment `expand-contract: <expand migration name>`.
- **Register every expand** in `PENDING_CONTRACTIONS`
  (`src/migrations/pendingContractions.ts`): the migration, the old shape and
  every file carrying its marker.
- **Contract (release N+1, the release right after the expand ships).
  Mandatory, and the step that matters most.** One change: a migration drops
  the old column or table and its trigger or view, rewrites any old values
  left in a surviving column, and the code deletes every marked line —
  fallbacks, compatibility branches and their tests — and the
  `PENDING_CONTRACTIONS` entry. An expand is not done until its contract
  merges. Never leave a shim "for now" or contract "later".
- **Name the contract when you write the expand:** at the expand's handoff,
  file the contract's Flow task, held (`blocks`) by the soat release step that
  ships the expand.
- **Checks.** `tests/harness/pendingContractions.test.mjs` fails when an
  entry's expand shipped in a release before the latest (the contract is
  overdue), when a marker and the registry disagree, and when a sync in `src`
  does not use `SCHEMA_SYNC_OPTIONS`. Run it from the workspace root:
  `node --test tests/harness/pendingContractions.test.mjs` (or
  `pnpm run test:harness`). The `previous-release-smoke` job in `pr.yml`
  boots the latest published image on its own schema, runs this checkout's
  `migrate.mjs run` against it, then runs that release's smoke tests; locally
  `pnpm run smoke-tests:previous-release`.

## Docs

Docs: https://ttoss.dev/docs/modules/packages/postgresdb/. After a schema
change: `pnpm test` in `packages/postgresdb`, then
`pnpm --filter @soat/postgresdb build` for dependents' types.

## Public ID

- Expose only `publicId` (`src/utils/publicId.ts`); the UUID `id` is for joins.
- New model: register a prefix in `PUBLIC_ID_PREFIXES`; generate it in
  `beforeValidate` via `generatePublicId`.

## Migrations

A change `sync` cannot make is a migration in `src/migrations/`, appended to
`MIGRATIONS` in its `index.ts` (README _Migrations `sync` cannot perform_):
runs **before** sync, declares `isApplied`, a step that must not half-land is
one `context.run`, the name is permanent once merged.

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

## JSON or JSONB

By role (README _JSON or JSONB_): key order matters → `JSON`; queried or
indexed → `JSONB`. Classify a new column in `tests/harness/jsonColumnRoles.test.mjs`.
