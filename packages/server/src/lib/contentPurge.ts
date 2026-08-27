import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { redactEvalResultOutputs } from './evaluationPurge';
import { emitResourceEvent } from './eventBus';
import { deleteStorageObjects } from './fileStorage';
import { getGeneration, type PersistedGeneration } from './generations';
import { makeResourceAccessor } from './resourceAccessor';
import type { SoatEventTypeFor, SoatResourceType } from './soatEvents';
import {
  PURGED_GENERATION_CONTENT,
  PURGED_TRACE_CONTENT,
} from './traceContentPolicy';
import { getTrace, type Trace } from './traces';

const log = createDebug('soat:content-purge');

// Lean accessors: both purge paths mutate the row's own columns and re-read the
// mapped resource through `getGeneration` / `getTrace` afterwards, so only the
// scoped `where` is borrowed — never the includes.
const generations = makeResourceAccessor<
  InstanceType<(typeof db)['Generation']>
>({
  model: () => {
    return db.Generation;
  },
  label: 'Generation',
});

const traces = makeResourceAccessor<InstanceType<(typeof db)['Trace']>>({
  model: () => {
    return db.Trace;
  },
  label: 'Trace',
});

/**
 * The principal that performed a purge, resolved from the request's auth
 * context by the route handler — never read off a request body. Mirrors the
 * shape `Generation.startedByPrincipal*` already uses.
 */
export type RedactionPrincipal = {
  principalType: string;
  principalId: string;
};

const redactionColumns = (args: {
  principal: RedactionPrincipal;
  redactedAt: Date;
}) => {
  return {
    contentRedactedAt: args.redactedAt,
    contentRedactedByPrincipalType: args.principal.principalType,
    contentRedactedByPrincipalId: args.principal.principalId,
  };
};

// Fire-and-forget, matching every other emit site: a webhook subscriber must
// never be able to fail the purge that already committed.
const emitPurgeEvent = <R extends SoatResourceType>(args: {
  type: SoatEventTypeFor<R>;
  projectId: number;
  resourceType: R;
  resourceId: string;
  data: Record<string, unknown>;
}): void => {
  emitResourceEvent({
    type: args.type,
    projectId: args.projectId,
    resourceType: args.resourceType,
    resourceId: args.resourceId,
    data: args.data,
  });
};

/**
 * Clears a single generation's content in place, leaving the auditable
 * skeleton. Idempotent — an already-redacted generation keeps its original
 * `contentRedactedAt`.
 *
 * This does not reach the trace's steps file, which holds this generation's
 * content alongside its siblings', so purging one generation is not a complete
 * erasure of the run; purge the trace for that. Returns null when the
 * generation is out of the caller's scope.
 */
export const purgeGenerationContent = async (args: {
  publicId: string;
  projectIds?: number[];
  principal: RedactionPrincipal;
}): Promise<PersistedGeneration | null> => {
  log('purgeGenerationContent: publicId=%s', args.publicId);

  const gen = await generations.findByPublicId({
    id: args.publicId,
    projectIds: args.projectIds,
  });
  if (!gen) return null;

  const alreadyRedacted = gen.contentRedactedAt !== null;

  await gen.update({
    ...PURGED_GENERATION_CONTENT,
    ...(alreadyRedacted
      ? {}
      : redactionColumns({
          principal: args.principal,
          redactedAt: new Date(),
        })),
  });

  // The generation's content also lives as a copy on any eval result that
  // scored it; a purge that left those behind would not be a purge.
  await redactEvalResultOutputs({ generationDbIds: [gen.id as number] });

  const purged = await getGeneration({
    publicId: args.publicId,
    projectIds: args.projectIds,
  });

  if (purged && !alreadyRedacted) {
    emitPurgeEvent({
      type: 'generations.content_purged',
      projectId: gen.projectId,
      resourceType: 'generation',
      resourceId: gen.publicId,
      data: purged,
    });
  }

  return purged;
};

/**
 * Every trace in the purge set: the named trace plus all of its descendants.
 *
 * The cascade is required for the erasure to mean anything. A child trace holds
 * its own steps file covering the same run, so purging only the named trace
 * would leave that content readable through the child — the same "deleted but
 * still reachable" gap #835 was about.
 *
 * Descendants are found via `rootTraceId`, then filtered down the parent chain,
 * so purging a mid-tree trace does not touch its siblings or its parent.
 */
const collectTraceSubtree = async (args: {
  target: InstanceType<(typeof db)['Trace']>;
  projectIds?: number[];
}): Promise<InstanceType<(typeof db)['Trace']>[]> => {
  const targetId = args.target.id as number;
  const rootDbId = (args.target.rootTraceId ?? targetId) as number;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = {
    [Op.or]: [{ id: rootDbId }, { rootTraceId: rootDbId }],
  };
  if (args.projectIds !== undefined) where.projectId = args.projectIds;

  const candidates = await db.Trace.findAll({ where });

  const byParent = new Map<number, InstanceType<(typeof db)['Trace']>[]>();
  for (const row of candidates) {
    const parentId = row.parentTraceId;
    if (parentId === null) continue;
    const siblings = byParent.get(parentId) ?? [];
    siblings.push(row);
    byParent.set(parentId, siblings);
  }

  const subtree = [args.target];
  const queue = [targetId];
  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const child of byParent.get(current) ?? []) {
      subtree.push(child);
      queue.push(child.id as number);
    }
  }

  return subtree;
};

/**
 * The transactional half of a trace purge: clear the trace and generation
 * content columns and destroy the File rows, all or nothing. The skeleton and
 * its generations must commit together — a partial purge would leave content
 * readable through the generations API after the trace claimed erasure.
 */
const commitTracePurge = async (args: {
  traceDbIds: number[];
  fileDbIds: number[];
  principal: RedactionPrincipal;
  redactedAt: Date;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction: any;
}): Promise<void> => {
  const redaction = redactionColumns({
    principal: args.principal,
    redactedAt: args.redactedAt,
  });

  await db.Trace.update(
    { ...PURGED_TRACE_CONTENT, ...redaction },
    {
      where: { id: args.traceDbIds, contentRedactedAt: null },
      transaction: args.transaction,
    }
  );

  // Already-redacted traces keep their original timestamps but still drop any
  // pointer a later write could have reattached.
  await db.Trace.update(PURGED_TRACE_CONTENT, {
    where: { id: args.traceDbIds },
    transaction: args.transaction,
  });

  const [purgedGenerations] = await db.Generation.update(
    { ...PURGED_GENERATION_CONTENT, ...redaction },
    {
      where: { traceId: args.traceDbIds, contentRedactedAt: null },
      transaction: args.transaction,
    }
  );
  log(
    'commitTracePurge: traces=%d generations=%d',
    args.traceDbIds.length,
    purgedGenerations
  );

  // Same cascade as the single-generation purge, for every generation in the
  // subtree — an eval result's copied output is content, wherever it was
  // erased from.
  const generationRows = await db.Generation.findAll({
    where: { traceId: args.traceDbIds },
    attributes: ['id'],
    transaction: args.transaction,
  });
  await redactEvalResultOutputs({
    generationDbIds: generationRows.map((row) => {
      return row.id as number;
    }),
    transaction: args.transaction,
  });

  if (args.fileDbIds.length > 0) {
    await db.File.destroy({
      where: { id: args.fileDbIds },
      transaction: args.transaction,
    });
  }
};

/**
 * Purges a trace's content — deletes the steps object from storage, clears the
 * content columns, and cascades to descendant traces and their generations.
 *
 * Storage-aware delete order per #835/#841: collect locations, commit the DB
 * changes in a transaction, then delete the bytes best-effort, so a concurrent
 * read never references content mid-delete. Idempotent — already-redacted
 * traces keep their timestamps. Null when the trace is out of scope.
 */
export const purgeTraceContent = async (args: {
  traceId: string;
  projectIds?: number[];
  principal: RedactionPrincipal;
}): Promise<Trace | null> => {
  log('purgeTraceContent: traceId=%s', args.traceId);

  const target = await traces.findByPublicId({
    id: args.traceId,
    projectIds: args.projectIds,
  });
  if (!target) return null;

  const subtree = await collectTraceSubtree({
    target,
    projectIds: args.projectIds,
  });
  const traceDbIds = subtree.map((row) => {
    return row.id as number;
  });
  const fileIds = subtree
    .map((row) => {
      return row.fileId;
    })
    .filter((fileId): fileId is number => {
      return fileId !== null;
    });

  // Read the storage locations before the transaction clears the pointers.
  const files =
    fileIds.length > 0
      ? await db.File.findAll({
          where: { id: fileIds },
          attributes: ['id', 'storagePath', 'storageType'],
        })
      : [];

  await db.sequelize.transaction(async (transaction) => {
    return commitTracePurge({
      traceDbIds,
      fileDbIds: files.map((file) => {
        return file.id as number;
      }),
      principal: args.principal,
      redactedAt: new Date(),
      transaction,
    });
  });

  // After commit: the rows no longer reference these objects, so deleting the
  // bytes cannot strand a live pointer.
  await deleteStorageObjects(
    files.map((file) => {
      return {
        storagePath: file.storagePath,
        storageType: file.storageType,
      };
    })
  );

  const purged = await getTrace({
    traceId: args.traceId,
    projectIds: args.projectIds,
  });

  emitPurgeEvent({
    type: 'traces.content_purged',
    projectId: target.projectId,
    resourceType: 'trace',
    resourceId: target.publicId,
    data: {
      ...purged,
      purged_trace_count: traceDbIds.length,
    },
  });

  return purged;
};
