import { db } from '../db';
import { type Transaction } from './dbTransaction';

// Reuses an existing Trace (same publicId/project) or creates one, scoped to
// the caller's transaction so a subsequent Generation.create failure rolls
// the (newly-created) Trace back too — see createGenerationRecord (soat#815).
export const findOrCreateTrace = async (args: {
  traceId: string;
  projectId: number;
  agentDbId: number;
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
      parentTraceId: null,
      rootTraceId: null,
    },
    { transaction: args.transaction }
  );
};
