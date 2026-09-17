import { defineMigration } from '@ttoss/postgresdb';

/**
 * The ledger learns to say *why* a supersede happened: a caller naming the
 * memory it replaces, or the bands choosing the top match.
 *
 * `sync` cannot add it — it creates missing tables and never alters one that
 * exists — and `similarity` could not carry the distinction: it is already null
 * whenever there was nothing to compare against, so every write made before the
 * column existed reads `false`, which is exactly what it was.
 */
const DECLARED_SQL = `
  ALTER TABLE memory_assertions
    ADD COLUMN IF NOT EXISTS declared boolean NOT NULL DEFAULT false;
`;

export const memoryAssertionsDeclared = defineMigration({
  name: '2026-09-17-memory-assertions-declared',
  description:
    'memory_assertions.declared records whether a supersede was declared by the caller or chosen by the thresholds.',
  /**
   * Every probe runs before any `up`, so this answers for the database as it
   * stands, not as an earlier pending migration will leave it — which is why
   * the absent-table case splits in two:
   *
   * - No `agents` either: a database `sync` will build from the models, and
   *   migrations run before that sync. The column arrives with the table, so
   *   this is recorded rather than replayed, and a new install never needs an
   *   operator `baseline`.
   * - `agents` but no `memory_assertions`: the ledger migration ahead of this
   *   one is about to create the table *without* the column, so this still has
   *   work to do.
   */
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'agents' }))) {
      return true;
    }
    if (!(await context.tableExists({ table: 'memory_assertions' }))) {
      return false;
    }
    return context.columnExists({
      table: 'memory_assertions',
      column: 'declared',
    });
  },
  up: async (context) => {
    context.say('adding memory_assertions.declared');
    await context.run({ sql: DECLARED_SQL });
  },
});
