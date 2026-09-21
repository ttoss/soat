import { defineMigration } from '@ttoss/postgresdb';

/**
 * An event trigger's firing is owned by the database from the moment it is
 * matched, not by whichever process happened to be handling the write that
 * emitted the event.
 *
 * Four columns carry that: `idempotency_key` so a redelivered event cannot run
 * a target twice, `causation_chain` so a firing recovered outside the emitting
 * request still knows the cycle it is part of, and `attempts` +
 * `lease_expires_at` so the sweep can tell an interrupted firing from one that
 * is still running.
 *
 * `sync` creates missing tables and never alters an existing one, so these are
 * a migration. Every column is nullable or defaulted: a firing written before
 * they exist had no key, no stored chain and no lease, which is exactly what
 * those values say. The two indexes the models declare over the new columns
 * are built by the sync the entrypoint runs once every migration has, and
 * `schemaDrift.test.ts` is what holds it to that.
 */
export const durableEventFirings = defineMigration({
  name: '2026-09-21-durable-event-firings',
  description:
    'trigger_firings gains idempotency_key, causation_chain, attempts and lease_expires_at, so an event firing survives the process that matched it.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'trigger_firings' }))) return true;
    return context.columnExists({
      table: 'trigger_firings',
      column: 'lease_expires_at',
    });
  },
  up: async (context) => {
    context.say('adding trigger_firings durability columns');

    // One multi-statement string: Postgres runs a simple query's statements in
    // a single implicit transaction, so the row is never observed carrying a
    // key with no lease to redeliver it under. Separate `run` calls would lose
    // that — they can land on different pooled connections.
    await context.run({
      sql: `
        ALTER TABLE trigger_firings
          ADD COLUMN IF NOT EXISTS idempotency_key varchar(255),
          ADD COLUMN IF NOT EXISTS causation_chain jsonb,
          ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS lease_expires_at timestamp with time zone;
      `,
    });
  },
});
