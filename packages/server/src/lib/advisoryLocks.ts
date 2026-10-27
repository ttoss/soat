import createDebug from 'debug';

import type { SequelizeInstance, Transaction } from './dbTransaction';

const log = createDebug('soat:advisory-locks');

/**
 * The first key of a two-key `pg_advisory_xact_lock`, one per kind of row a
 * lock serializes writes on; the second key is that row's id. Distinct values
 * keep two kinds from contending on one id, and none equals the schema-sync
 * key (`SCHEMA_SYNC_LOCK_KEY` in `db.ts`).
 */
const ADVISORY_LOCK_NAMESPACES = {
  projectConcurrency: 0x50a7_c000,
  conversationWrites: 0x50a7_c001,
  firstAdminBootstrap: 0x50a7_c002,
} as const;

/**
 * Blocks until this transaction holds the lock on `id` within `namespace`;
 * Postgres releases it when the transaction commits or rolls back.
 */
export const lockForTransaction = async (args: {
  sequelize: SequelizeInstance;
  transaction: Transaction;
  namespace: keyof typeof ADVISORY_LOCK_NAMESPACES;
  id: number;
}): Promise<void> => {
  log('lockForTransaction: namespace=%s id=%d', args.namespace, args.id);
  await args.sequelize.query('SELECT pg_advisory_xact_lock(:ns, :id)', {
    replacements: { ns: ADVISORY_LOCK_NAMESPACES[args.namespace], id: args.id },
    transaction: args.transaction,
  });
};
