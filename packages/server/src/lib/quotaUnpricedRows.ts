import { Op } from '@ttoss/postgresdb';

import { db } from '../db';
import { DEFAULT_METER_TYPE } from './priceCompute';
import { EMBEDDING_USAGE_SOURCE } from './usageEmbeddingRecording';

/**
 * Naming what a pricing blackout is actually missing.
 *
 * Kept out of `quotaEnforcement.ts` so the window scope has one definition: the
 * aggregate that detects a blackout and the lookup that explains it must select
 * the same events, or a refusal would name rows from a window the verdict never
 * read.
 */

/** One `(provider, model, component)` a window metered and no price row covered. */
export type UnpricedRow = {
  provider: string;
  model: string;
  component: string;
};

/** The events one quota evaluation is about: a project, a window, and its scope narrowing. */
export type WindowScope = {
  projectId: number;
  agentId: number | null;
  actorId: number | null;
  windowStart: Date;
};

export const windowScopeWhere = (
  args: WindowScope
): Record<string | symbol, unknown> => {
  const where: Record<string | symbol, unknown> = {
    projectId: args.projectId,
    createdAt: { [Op.gte]: args.windowStart },
  };
  if (args.agentId != null) where.agentId = args.agentId;
  if (args.actorId != null) where.actorId = args.actorId;
  return where;
};

/** Past this many, the answer is a price book to build rather than a row to add. */
const MAX_REPORTED_ROWS = 10;

/**
 * The rows an operator creates to clear a blackout.
 *
 * Read only when a refusal is actually being raised, so the ordinary path pays
 * nothing for it. Two components are left out because pricing them would move
 * no aggregate: one that measured zero, and a non-billable detail. Embeddings
 * are left out because they have no price row to create at all — their rate is
 * deployment configuration (`embeddingPrice.ts`), so naming one would send the
 * operator to a route that cannot fix it.
 */
export const unpricedRowsInWindow = async (
  args: WindowScope
): Promise<UnpricedRow[]> => {
  const events = await db.UsageEvent.findAll({
    where: { ...windowScopeWhere(args), meterType: DEFAULT_METER_TYPE },
    attributes: ['provider', 'model', 'source', 'costUsd'],
    include: [
      {
        model: db.UsageComponent,
        as: 'components',
        attributes: ['component', 'quantity', 'billable', 'costUsd'],
      },
    ],
  });

  const rows = new Map<string, UnpricedRow>();
  for (const event of events) {
    if (event.costUsd != null) continue;
    if (event.source === EMBEDDING_USAGE_SOURCE) continue;
    /* istanbul ignore next -- the include above always attaches components */
    for (const component of event.components ?? []) {
      if (!component.billable) continue;
      if (component.costUsd != null) continue;
      if (Number(component.quantity) <= 0) continue;
      rows.set(
        [event.provider, event.model, component.component].join('\u0000'),
        {
          provider: event.provider,
          model: event.model,
          component: component.component,
        }
      );
    }
  }

  // Sorted on the identity that deduplicated them, so the order is stable
  // without a second definition of what makes one row distinct from another.
  return [...rows.entries()]
    .sort(([a], [b]) => {
      return a.localeCompare(b);
    })
    .slice(0, MAX_REPORTED_ROWS)
    .map(([, row]) => {
      return row;
    });
};
