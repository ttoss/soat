import { db } from '../db';
import { type Transaction } from './dbTransaction';

/** The internal id of a trace named by public id, for a lineage write. */
export const findTraceDbId = async (args: {
  traceId?: string | null;
  transaction: Transaction;
}): Promise<number | null> => {
  if (!args.traceId) return null;
  const trace = await db.Trace.findOne({
    where: { publicId: args.traceId },
    transaction: args.transaction,
  });
  return (trace?.id as number | undefined) ?? null;
};

// Reuses an existing Trace (same publicId/project) or creates one, scoped to
// the caller's transaction so a subsequent Generation.create failure rolls
// the (newly-created) Trace back too — see createGenerationRecord (soat#815).
export const findOrCreateTrace = async (args: {
  traceId: string;
  projectId: number;
  agentDbId: number;
  // Written at creation, not left for the completion write: an in-flight or
  // failed turn belongs to its chain too, and the chain budget counts rows.
  parentTraceDbId?: number | null;
  rootTraceDbId?: number | null;
  transaction: Transaction;
}): Promise<InstanceType<typeof db.Trace>> => {
  const existingTrace = await db.Trace.findOne({
    where: { publicId: args.traceId, projectId: args.projectId },
    transaction: args.transaction,
  });

  if (existingTrace) {
    return existingTrace;
  }

  return db.Trace.create(
    {
      publicId: args.traceId,
      projectId: args.projectId,
      agentId: args.agentDbId,
      fileId: null,
      stepCount: 0,
      parentTraceId: args.parentTraceDbId ?? null,
      rootTraceId: args.rootTraceDbId ?? null,
    },
    { transaction: args.transaction }
  );
};
