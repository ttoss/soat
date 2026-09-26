import { USAGE_EVENT_DURABLE_IDS } from '@soat/postgresdb';

import { db } from '../db';
import type { Transaction } from './dbTransaction';
import { asSqlRow } from './sqlRow';

type DurablePair = (typeof USAGE_EVENT_DURABLE_IDS)[number];

type ForeignKeyValues = { [K in DurablePair['foreignKey']]?: number | null };

/**
 * What a meter writes. The public ids of `USAGE_EVENT_DURABLE_IDS` are read
 * from the row each FK names ({@link withDurablePublicIds}), so no meter derives
 * one that could disagree with its FK. `generationPublicId` alone may be given:
 * an embedding made before its generation's row commits names the generation
 * by public id with no FK yet.
 */
export type UsageEventDefaults = ForeignKeyValues & {
  projectId: number;
  generationPublicId?: string | null;
  nodeId?: string | null;
  triggerId?: string | null;
  actionId?: string | null;
  source?: string | null;
  outcome?: string | null;
  guardrailIds?: string[] | null;
  meterType: string;
  provider: string;
  model: string;
  costUsd: string | null;
  idempotencyKey: string;
};

/**
 * `values` plus the public id of every attribution FK it sets, read in one
 * query. Every write that sets an FK on a usage event goes through here, which
 * is what keeps `totals.distinct` counting an entity after it is deleted.
 */
export const withDurablePublicIds = async <T extends ForeignKeyValues>(args: {
  values: T;
  transaction?: Transaction;
}): Promise<T & Record<string, unknown>> => {
  const set = USAGE_EVENT_DURABLE_IDS.filter((pair) => {
    return typeof args.values[pair.foreignKey] === 'number';
  });
  if (set.length === 0) return args.values;

  const selects = set.map((pair) => {
    return `(SELECT public_id FROM ${pair.table} WHERE id = :${pair.foreignKey}) AS "${pair.publicId}"`;
  });
  const [rows] = await db.sequelize.query(`SELECT ${selects.join(', ')}`, {
    replacements: Object.fromEntries(
      set.map((pair) => {
        return [pair.foreignKey, args.values[pair.foreignKey]];
      })
    ),
    transaction: args.transaction,
  });
  return { ...args.values, ...asSqlRow(rows[0]) };
};

/** The one insert path for a usage event, idempotent on `idempotencyKey`. */
export const insertUsageEvent = async (args: {
  defaults: UsageEventDefaults;
  transaction: Transaction;
}): Promise<[InstanceType<(typeof db)['UsageEvent']>, boolean]> => {
  return db.UsageEvent.findOrCreate({
    where: { idempotencyKey: args.defaults.idempotencyKey },
    defaults: await withDurablePublicIds({
      values: args.defaults,
      transaction: args.transaction,
    }),
    transaction: args.transaction,
  });
};
