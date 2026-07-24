import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { getEffectivePrice } from './priceBook';
import { computeComponentCostUsd } from './priceCompute';
import { evaluateProjectThresholds } from './usageThresholds';

const log = createDebug('soat:usage');

// A storage event is billed against the platform `soat`/`gb-day` SKU: one
// `gb_day` component whose quantity is the project's stored gigabytes sampled
// for the day (bytes ÷ 1e9). Distinct meterType and idempotency namespace from
// tokens/compute so a day's snapshot never collides with another meter's key.
const STORAGE_PROVIDER = 'soat';
const STORAGE_MODEL = 'gb-day';
const STORAGE_COMPONENT = 'gb_day';
const BYTES_PER_GB = 1_000_000_000;

// UTC calendar day (YYYY-MM-DD) — the snapshot granularity and the idempotency
// scope: at most one storage event per project per day, so a re-run of the same
// day's snapshot upserts into a no-op instead of double-counting.
const utcDateKey = (now: Date): string => {
  return now.toISOString().slice(0, 10);
};

// `db.sequelize.query` returns rows as loosely-typed objects; narrow the single
// aggregate row to its `bytes` column (null/absent → 0).
const readBytes = (rows: unknown[]): number => {
  const row = rows[0] as { bytes?: string | number } | undefined;
  const value = row?.bytes;
  return value == null ? 0 : Number(value);
};

// Total stored bytes for a project: uploaded file sizes plus the chunked
// document text the platform holds for retrieval. Aggregated at snapshot time
// (a SUM per source) rather than tracked incrementally — the daily sample is
// the accepted v1 granularity (event-driven byte accounting is a noted future
// refinement).
const projectStoredBytes = async (projectId: number): Promise<number> => {
  const [fileRows] = await db.sequelize.query(
    `SELECT COALESCE(SUM("size"), 0) AS bytes FROM "files" WHERE "project_id" = :projectId`,
    { replacements: { projectId } }
  );
  const [chunkRows] = await db.sequelize.query(
    `SELECT COALESCE(SUM(OCTET_LENGTH("content")), 0) AS bytes
       FROM "document_chunks" dc
       JOIN "documents" d ON dc."document_id" = d."id"
       JOIN "files" f ON d."file_id" = f."id"
      WHERE f."project_id" = :projectId`,
    { replacements: { projectId } }
  );
  return readBytes(fileRows) + readBytes(chunkRows);
};

// Atomic + idempotent on the storage key: a re-run of the same UTC day finds the
// event already present and writes nothing.
const persistStorageEvent = async (args: {
  projectId: number;
  idempotencyKey: string;
  quantityGbDay: number;
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
        meterType: 'storage',
        provider: STORAGE_PROVIDER,
        model: STORAGE_MODEL,
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
        component: STORAGE_COMPONENT,
        quantity: String(args.quantityGbDay),
        unit: STORAGE_COMPONENT,
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
 * Writes one `storage` usage event for a project's current stored bytes, sampled
 * for `now`'s UTC day: a single `gb_day` component whose quantity is
 * bytes ÷ 1e9. Priced at write time from a `soat`/`gb-day` price-book row when
 * one is effective (`cost_usd = null` otherwise). Idempotent on
 * `storage:{project}:{YYYY-MM-DD}` — a re-run for the same day is a no-op.
 * Returns whether this call wrote the event. Callers wrap per project so one
 * failure never aborts the whole snapshot.
 */
export const snapshotProjectStorage = async (args: {
  projectId: number;
  projectPublicId: string;
  now?: Date;
}): Promise<boolean> => {
  const now = args.now ?? new Date();
  const bytes = await projectStoredBytes(args.projectId);
  const quantityGbDay = bytes / BYTES_PER_GB;

  const price = await getEffectivePrice({
    provider: STORAGE_PROVIDER,
    model: STORAGE_MODEL,
    component: STORAGE_COMPONENT,
    aiProviderId: null,
    projectId: args.projectId,
    at: now,
  });
  const unitPrice = price ? Number(price.unitPrice) : null;
  const costUsd = computeComponentCostUsd({
    quantity: quantityGbDay,
    unitPrice,
  });
  const idempotencyKey = `storage:${args.projectPublicId}:${utcDateKey(now)}`;

  const created = await persistStorageEvent({
    projectId: args.projectId,
    idempotencyKey,
    quantityGbDay,
    unitPrice: price ? String(price.unitPrice) : null,
    costUsd,
    priceId: price?.id ?? null,
  });
  log(
    'snapshotProjectStorage: project=%s bytes=%d gbDay=%s created=%s costUsd=%s',
    args.projectPublicId,
    bytes,
    quantityGbDay,
    created,
    costUsd
  );

  // Only a newly written event can move the windowed total across a threshold,
  // so a re-run (idempotent no-op) never re-fires. Best-effort — never throws.
  if (created) {
    await evaluateProjectThresholds({ projectId: args.projectId });
  }
  return created;
};

/**
 * The daily snapshot sweep: writes one `storage` event per project for `now`'s
 * UTC day. Returns the number of projects newly metered this run. Never throws —
 * a per-project failure is logged and skipped so one bad project can't stall the
 * sweep. This is the scheduler tick's only caller (no HTTP entry point).
 */
export const runStorageSnapshot = async (args?: {
  now?: Date;
}): Promise<number> => {
  const now = args?.now ?? new Date();
  const projects = await db.Project.findAll({ attributes: ['id', 'publicId'] });

  let metered = 0;
  for (const project of projects) {
    try {
      const created = await snapshotProjectStorage({
        projectId: project.id as number,
        projectPublicId: project.publicId,
        now,
      });
      if (created) metered += 1;
    } catch (error) {
      log('runStorageSnapshot: project=%s failed %o', project.publicId, error);
    }
  }
  log('runStorageSnapshot: projects=%d metered=%d', projects.length, metered);
  return metered;
};
