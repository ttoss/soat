import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { getEffectivePrice } from './priceBook';
import { computeComponentCostUsd, sumComponentCostUsd } from './priceCompute';
import { evaluateProjectThresholds } from './usageThresholds';

const log = createDebug('soat:usage');

// Two components per event: the day's sampled gigabytes, and the indexed rows
// behind them. Bytes alone cannot price a vector corpus — an HNSW element costs
// a whole 8 KiB page whatever the chunk's text weighs, and no `pg_column_size`
// can see it — so what a byte figure reports drifts by ~3× with a chunking
// parameter the caller picks, in whichever direction the proxy happens to lean
// (#1232). The count is the term that fixed per-row cost is charged against.
//
// A separate meterType and idempotency namespace from tokens/compute, so a
// day's snapshot never collides with another meter's key.
const STORAGE_PROVIDER = 'soat';
const STORAGE_MODEL = 'gb-day';
const GB_DAY_COMPONENT = 'gb_day';
const CHUNK_COUNT_COMPONENT = 'chunk_count';
const COUNT_UNIT = 'count';
const BYTES_PER_GB = 1_000_000_000;

// UTC calendar day (YYYY-MM-DD) — the snapshot granularity and the idempotency
// scope: at most one storage event per project per day, so a re-run of the same
// day's snapshot upserts into a no-op instead of double-counting.
const utcDateKey = (now: Date): string => {
  return now.toISOString().slice(0, 10);
};

/**
 * What a project stores, split by where it lives so the debug line names each
 * term: a term that reads zero is the only visible symptom of one this meter
 * stopped reaching (#1221).
 *
 * Bytes and rows are read in one statement, so the two components of an event
 * can never describe two different moments of the same corpus.
 */
type StoredFootprint = {
  bytes: {
    files: number;
    documentChunks: number;
    memoryEntries: number;
    total: number;
  };
  counts: {
    documentChunks: number;
    memoryEntries: number;
    total: number;
  };
};

// Every term is an aggregate over a one-row derived table, so the statement
// always returns exactly one row whose columns are numeric (never null) and can
// be read without defensive branching. `numeric` and `bigint` arrive as strings.
const readStoredFootprint = (rows: unknown[]): StoredFootprint => {
  const [row] = rows as Array<{
    file_bytes: string | number;
    chunk_bytes: string | number;
    chunk_rows: string | number;
    memory_bytes: string | number;
    memory_rows: string | number;
  }>;
  const files = Number(row.file_bytes);
  const chunkBytes = Number(row.chunk_bytes);
  const memoryBytes = Number(row.memory_bytes);
  const chunkRows = Number(row.chunk_rows);
  const memoryRows = Number(row.memory_rows);
  return {
    bytes: {
      files,
      documentChunks: chunkBytes,
      memoryEntries: memoryBytes,
      total: files + chunkBytes + memoryBytes,
    },
    counts: {
      documentChunks: chunkRows,
      memoryEntries: memoryRows,
      total: chunkRows + memoryRows,
    },
  };
};

/**
 * Aggregated at snapshot time rather than tracked incrementally — a daily
 * sample is the accepted granularity here.
 *
 * Both vector-bearing tables are measured with `pg_column_size`, which reads
 * the stored width of the value itself rather than deriving it from
 * `EMBEDDING_DIMENSIONS`, so the figure cannot drift when that moves or when
 * the column's type changes. It reads the tuple's inline TOAST pointer and
 * never fetches the out-of-line value, which is what keeps a term dominated by
 * ~4 KB vectors as cheap as the text sums beside it.
 *
 * The inner `COALESCE` is load-bearing: an un-embedded row's `pg_column_size`
 * is null, and `text + null` would discard that row's *content* too.
 *
 * Each vector-bearing term is counted by the same scan that sums it, so the
 * count costs no extra pass over either table.
 *
 * What the byte figure deliberately excludes is physical overhead — index
 * pages, TOAST chunk headers, tuple headers and bloat. None of it is
 * attributable to one project, and it moves with vacuum state; the byte term is
 * the logical bytes a project put there, and the row counts beside it are what
 * the per-row half of that overhead is priced against. Documented on
 * `modules/usage.md`.
 */
const projectStoredFootprint = async (
  projectId: number
): Promise<StoredFootprint> => {
  const [rows] = await db.sequelize.query(
    `SELECT files.file_bytes,
            chunks.chunk_bytes,
            chunks.chunk_rows,
            memories.memory_bytes,
            memories.memory_rows
       FROM (SELECT COALESCE(SUM(f."size"), 0) AS file_bytes
               FROM "files" f
              WHERE f."project_id" = :projectId) files
       CROSS JOIN
            (SELECT COALESCE(SUM(
                      OCTET_LENGTH(dc."content")
                      + COALESCE(pg_column_size(dc."embedding"), 0)
                    ), 0) AS chunk_bytes,
                    COUNT(*) AS chunk_rows
               FROM "document_chunks" dc
               JOIN "documents" d ON dc."document_id" = d."id"
               JOIN "files" f ON d."file_id" = f."id"
              WHERE f."project_id" = :projectId) chunks
       CROSS JOIN
            (SELECT COALESCE(SUM(
                      OCTET_LENGTH(me."content")
                      + COALESCE(pg_column_size(me."embedding"), 0)
                    ), 0) AS memory_bytes,
                    COUNT(*) AS memory_rows
               FROM "memory_entries" me
               JOIN "memories" m ON me."memory_id" = m."id"
              WHERE m."project_id" = :projectId) memories`,
    { replacements: { projectId } }
  );
  return readStoredFootprint(rows);
};

/** One measured dimension of a day's snapshot, before pricing. */
type StorageComponent = {
  component: string;
  unit: string;
  quantity: number;
};

type PricedStorageComponent = StorageComponent & {
  unitPrice: string | null;
  costUsd: string | null;
  priceId: number | null;
};

/**
 * A zero-quantity component is written like any other, unlike the token path
 * that drops one: a snapshot is a daily series a rollup sums over a window, so
 * a day left out would read as a day nobody measured rather than a day the
 * project stored nothing.
 */
const storageComponents = (footprint: StoredFootprint): StorageComponent[] => {
  return [
    {
      component: GB_DAY_COMPONENT,
      unit: GB_DAY_COMPONENT,
      quantity: footprint.bytes.total / BYTES_PER_GB,
    },
    {
      component: CHUNK_COUNT_COMPONENT,
      unit: COUNT_UNIT,
      quantity: footprint.counts.total,
    },
  ];
};

// Each component carries its own price row under the one storage SKU, so a
// deployment can price bytes, rows, or both — an unpriced one records its
// quantity with `cost_usd = null` rather than blocking the other.
const priceStorageComponents = async (args: {
  projectId: number;
  components: StorageComponent[];
  at: Date;
}): Promise<PricedStorageComponent[]> => {
  return Promise.all(
    args.components.map(async (component) => {
      const price = await getEffectivePrice({
        provider: STORAGE_PROVIDER,
        model: STORAGE_MODEL,
        component: component.component,
        aiProviderId: null,
        projectId: args.projectId,
        at: args.at,
      });
      return {
        ...component,
        unitPrice: price ? String(price.unitPrice) : null,
        costUsd: computeComponentCostUsd({
          quantity: component.quantity,
          unitPrice: price ? Number(price.unitPrice) : null,
        }),
        priceId: price?.id ?? null,
      };
    })
  );
};

// Atomic + idempotent on the storage key: a re-run of the same UTC day finds the
// event already present and writes nothing.
const persistStorageEvent = async (args: {
  projectId: number;
  idempotencyKey: string;
  components: PricedStorageComponent[];
  costUsd: string | null;
}): Promise<boolean> => {
  return db.sequelize.transaction(async (transaction) => {
    const [event, created] = await db.UsageEvent.findOrCreate({
      where: { idempotencyKey: args.idempotencyKey },
      defaults: {
        publicId: generatePublicId(PUBLIC_ID_PREFIXES.usageEvent),
        projectId: args.projectId,
        orchestrationRunId: null,
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

    await db.UsageComponent.bulkCreate(
      args.components.map((component) => {
        return {
          publicId: generatePublicId(PUBLIC_ID_PREFIXES.usageComponent),
          usageEventId: event.id,
          component: component.component,
          quantity: String(component.quantity),
          unit: component.unit,
          billable: true,
          unitPrice: component.unitPrice,
          costUsd: component.costUsd,
          priceId: component.priceId,
        };
      }),
      { transaction }
    );
    return true;
  });
};

/**
 * Writes one `storage` usage event for a project's current footprint, sampled
 * for `now`'s UTC day: a `gb_day` component whose quantity is bytes ÷ 1e9, and a
 * `chunk_count` component whose quantity is the indexed rows behind them. Each
 * is priced at write time from its own `soat`/`gb-day` price-book row when one
 * is effective (`cost_usd = null` otherwise), and the event's cost is their sum.
 * Idempotent on `storage:{project}:{YYYY-MM-DD}` — a re-run for the same day is
 * a no-op. Returns whether this call wrote the event. Callers wrap per project
 * so one failure never aborts the whole snapshot.
 */
export const snapshotProjectStorage = async (args: {
  projectId: number;
  projectPublicId: string;
  now?: Date;
}): Promise<boolean> => {
  const now = args.now ?? new Date();
  const footprint = await projectStoredFootprint(args.projectId);

  const components = await priceStorageComponents({
    projectId: args.projectId,
    components: storageComponents(footprint),
    at: now,
  });
  const costUsd = sumComponentCostUsd(
    components.map((component) => {
      return component.costUsd;
    })
  );
  const idempotencyKey = `storage:${args.projectPublicId}:${utcDateKey(now)}`;

  const created = await persistStorageEvent({
    projectId: args.projectId,
    idempotencyKey,
    components,
    costUsd,
  });
  log(
    'snapshotProjectStorage: project=%s bytes=%d files=%d chunks=%d memories=%d rows=%d chunkRows=%d memoryRows=%d created=%s costUsd=%s',
    args.projectPublicId,
    footprint.bytes.total,
    footprint.bytes.files,
    footprint.bytes.documentChunks,
    footprint.bytes.memoryEntries,
    footprint.counts.total,
    footprint.counts.documentChunks,
    footprint.counts.memoryEntries,
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
