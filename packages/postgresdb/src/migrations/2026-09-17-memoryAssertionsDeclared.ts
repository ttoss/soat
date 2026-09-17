import { defineMigration } from '@ttoss/postgresdb';

/**
 * `memory_assertions.declared` separates a supersede the caller named from one
 * the thresholds chose.
 *
 * `sync` creates missing tables and never alters one that exists, so the column
 * is a migration. `similarity` cannot carry the distinction: it is null
 * whenever there is nothing to compare against, which a convention there would
 * make indistinguishable from a declaration. The `false` default is the right
 * answer for every row already in the table — a supersede nobody declared.
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
