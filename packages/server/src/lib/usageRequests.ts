import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { getEffectivePrice } from './priceBook';
import { computeComponentCostUsd } from './priceCompute';
import { evaluateProjectThresholds } from './usageThresholds';

const log = createDebug('soat:usage');

// API-request events are billed against the platform `soat`/`request` SKU: one
// `request` component whose quantity is the count served in the flush window.
const REQUEST_PROVIDER = 'soat';
const REQUEST_MODEL = 'request';
const REQUEST_COMPONENT = 'request';

/**
 * Resolves the stable per-process identity folded into the idempotency key so
 * two server instances flushing the same (project, api_key, window) each write
 * their own row instead of colliding into one (which would silently drop an
 * instance's count). Prefers an explicit `SOAT_INSTANCE_ID`, falls back to the
 * container `HOSTNAME`, then a constant — correct for a single instance too.
 * Takes `env` so the fallback chain is unit-testable.
 */
export const resolveInstanceId = (
  env: NodeJS.ProcessEnv = process.env
): string => {
  return env.SOAT_INSTANCE_ID ?? env.HOSTNAME ?? 'default';
};

const INSTANCE_ID = resolveInstanceId();

// Never one row per request (that would turn every agent tool loop into meter
// writes). Requests aggregate in memory per (project, api_key) and flush one
// row per counter per window. The map is swapped out atomically at flush time.
type RequestCounter = {
  projectId: number;
  apiKeyPublicId: string;
  count: number;
};

let counters = new Map<string, RequestCounter>();
let windowStart = new Date();

const counterKey = (projectId: number, apiKeyPublicId: string): string => {
  return `${projectId}::${apiKeyPublicId}`;
};

/**
 * Records one served API request against its (project, api_key) counter. Pure
 * in-memory increment — no I/O — so it adds no latency to the request path. The
 * accumulated counts are persisted by {@link flushRequestCounters}.
 */
export const incrementRequestCount = (args: {
  projectId: number;
  apiKeyPublicId: string;
}): void => {
  const key = counterKey(args.projectId, args.apiKeyPublicId);
  const existing = counters.get(key);
  if (existing) {
    existing.count += 1;
    return;
  }
  counters.set(key, {
    projectId: args.projectId,
    apiKeyPublicId: args.apiKeyPublicId,
    count: 1,
  });
};

// Atomic + idempotent on the flush-window key: a re-flush of the same window
// (e.g. a manual flush racing the timer) finds the event present and writes
// nothing.
const persistRequestEvent = async (args: {
  projectId: number;
  idempotencyKey: string;
  count: number;
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
        runId: null,
        nodeId: null,
        agentId: null,
        generationId: null,
        traceId: null,
        aiProviderId: null,
        triggerId: null,
        actionId: null,
        meterType: 'api_request',
        provider: REQUEST_PROVIDER,
        model: REQUEST_MODEL,
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
        component: REQUEST_COMPONENT,
        quantity: String(args.count),
        unit: REQUEST_COMPONENT,
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

const writeCounter = async (
  counter: RequestCounter,
  windowStartIso: string,
  at: Date
): Promise<boolean> => {
  const price = await getEffectivePrice({
    provider: REQUEST_PROVIDER,
    model: REQUEST_MODEL,
    component: REQUEST_COMPONENT,
    aiProviderId: null,
    projectId: counter.projectId,
    at,
  });
  const unitPrice = price ? Number(price.unitPrice) : null;
  const costUsd = computeComponentCostUsd({
    quantity: counter.count,
    unitPrice,
  });
  const idempotencyKey = `api_request:${counter.projectId}:${counter.apiKeyPublicId}:${windowStartIso}:${INSTANCE_ID}`;

  const created = await persistRequestEvent({
    projectId: counter.projectId,
    idempotencyKey,
    count: counter.count,
    unitPrice: price ? String(price.unitPrice) : null,
    costUsd,
    priceId: price?.id ?? null,
  });
  if (created) {
    await evaluateProjectThresholds({ projectId: counter.projectId });
  }
  return created;
};

/**
 * Flushes the accumulated request counters into `api_request` usage events —
 * one per (project, api_key) counter for the window that just closed. Swaps the
 * counter map out synchronously (before any await) so increments arriving
 * mid-flush land in the next window rather than being lost. Priced at write time
 * from a `soat`/`request` row (`cost_usd = null` otherwise). Returns the number
 * of events written. Never throws — a per-counter failure is logged and skipped.
 * Scheduler tick and graceful shutdown are its only callers (no HTTP entry).
 */
export const flushRequestCounters = async (args?: {
  now?: Date;
}): Promise<number> => {
  if (counters.size === 0) return 0;

  // Synchronous swap: everything below runs against the detached batch, and new
  // increments accumulate in the fresh map under the next window's start.
  const batch = counters;
  const windowStartIso = windowStart.toISOString();
  const now = args?.now ?? new Date();
  counters = new Map();
  windowStart = now;

  let written = 0;
  for (const counter of batch.values()) {
    try {
      const created = await writeCounter(counter, windowStartIso, now);
      if (created) written += 1;
    } catch (error) {
      log(
        'flushRequestCounters: project=%d failed %o',
        counter.projectId,
        error
      );
    }
  }
  log('flushRequestCounters: counters=%d written=%d', batch.size, written);
  return written;
};

/** Test-only: clears buffered counters and resets the window. */
export const resetRequestCounters = (): void => {
  counters = new Map();
  windowStart = new Date();
};
