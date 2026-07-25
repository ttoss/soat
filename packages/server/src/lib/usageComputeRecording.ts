import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { getEffectivePrice } from './priceBook';
import { computeComponentCostUsd } from './priceCompute';
import { evaluateProjectThresholds } from './usageThresholds';

const log = createDebug('soat:usage');

// The platform SKU a compute_execution event is billed against: the vendor slug
// is `soat` (a platform meter type, not an AI provider) and the billed unit is
// the compute-second. A compute event carries exactly one `compute_second`
// component whose quantity is the node's wall-clock seconds.
const COMPUTE_PROVIDER = 'soat';
const COMPUTE_MODEL = 'compute-second';
const COMPUTE_COMPONENT = 'compute_second';

// Atomic + idempotent on the resolved key: a redelivered node execution finds
// the compute event already present and writes nothing. Distinct from the
// llm_tokens key namespace so an agent node's token and compute events never
// collide on the shared unique `idempotency_key`.
const persistComputeEvent = async (args: {
  projectId: number;
  runId: number | null;
  nodeId: string;
  idempotencyKey: string;
  quantitySeconds: number;
  unitPrice: string | null;
  costUsd: string | null;
  priceId: number | null;
}): Promise<boolean> => {
  return db.sequelize.transaction(async (transaction) => {
    const [event, created] = await db.UsageEvent.findOrCreate({
      where: { idempotencyKey: args.idempotencyKey },
      defaults: {
        publicId: generatePublicId(PUBLIC_ID_PREFIXES.usageEvent),
        projectId: args.projectId,
        runId: args.runId,
        nodeId: args.nodeId,
        agentId: null,
        generationId: null,
        traceId: null,
        aiProviderId: null,
        triggerId: null,
        actionId: null,
        meterType: 'compute_execution',
        provider: COMPUTE_PROVIDER,
        model: COMPUTE_MODEL,
        costUsd: args.costUsd,
        idempotencyKey: args.idempotencyKey,
      },
      transaction,
    });

    if (!created) return false;

    await db.UsageComponent.create(
      {
        publicId: generatePublicId(PUBLIC_ID_PREFIXES.usageComponent),
        usageEventId: event.id,
        component: COMPUTE_COMPONENT,
        quantity: String(args.quantitySeconds),
        unit: COMPUTE_COMPONENT,
        billable: true,
        unitPrice: args.unitPrice,
        costUsd: args.costUsd,
        priceId: args.priceId,
      },
      { transaction }
    );
    return true;
  });
};

/**
 * Writes one `compute_execution` usage event for a finished orchestration node
 * execution: a single `compute_second` component whose quantity is the node's
 * wall-clock seconds (`completedAt - startedAt`), attributed to the run + node.
 * Priced at write time from a `soat`/`compute-second` price-book row when one is
 * effective (`cost_usd = null` otherwise). Idempotent on
 * `compute:{run}:node:{node}:attempt:{n}` — a redelivered execution is a no-op.
 * Never throws: metering is an observability side effect and must not fail the
 * run it measures.
 */
export const recordComputeUsage = async (args: {
  projectId: number;
  runId: number | null;
  runPublicId: string;
  nodeId: string;
  attempt: number;
  startedAt: Date;
  completedAt: Date;
}): Promise<void> => {
  try {
    const quantitySeconds = Math.max(
      0,
      (args.completedAt.getTime() - args.startedAt.getTime()) / 1000
    );
    const price = await getEffectivePrice({
      provider: COMPUTE_PROVIDER,
      model: COMPUTE_MODEL,
      component: COMPUTE_COMPONENT,
      aiProviderId: null,
      projectId: args.projectId,
      at: args.completedAt,
    });
    const unitPrice = price ? Number(price.unitPrice) : null;
    const costUsd = computeComponentCostUsd({
      quantity: quantitySeconds,
      unitPrice,
    });
    const idempotencyKey = `compute:${args.runPublicId}:node:${args.nodeId}:attempt:${args.attempt}`;

    const created = await persistComputeEvent({
      projectId: args.projectId,
      runId: args.runId,
      nodeId: args.nodeId,
      idempotencyKey,
      quantitySeconds,
      unitPrice: price ? String(price.unitPrice) : null,
      costUsd,
      priceId: price?.id ?? null,
    });
    log(
      'recordComputeUsage: run=%s node=%s attempt=%d seconds=%s created=%s costUsd=%s',
      args.runPublicId,
      args.nodeId,
      args.attempt,
      quantitySeconds,
      created,
      costUsd
    );

    // A newly written compute event adds to the windowed spend, so re-evaluate
    // thresholds at the write choke point (an idempotent no-op never re-fires).
    if (created) {
      await evaluateProjectThresholds({ projectId: args.projectId });
    }
  } catch (error) {
    log(
      'recordComputeUsage: failed run=%s node=%s error=%s',
      args.runPublicId,
      args.nodeId,
      error instanceof Error ? error.message : String(error)
    );
  }
};
