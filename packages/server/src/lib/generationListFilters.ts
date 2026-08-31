/**
 * Resolving the public-id filters `list-generations` accepts into the internal
 * ids a `where` clause needs.
 *
 * Its own module because it only serves the list query: `generations.ts` writes
 * and updates generation records, and holding both jobs is what pushed that file
 * past its size ceiling.
 */
import { db } from '../db';

// Resolves a project-scoped parent (agent/trace) publicId to its internal id
// for use as a generation list filter. Returns null when it does not exist in
// scope (caller yields an empty page).
const resolveScopedId = async (
  find: (where: {
    publicId: string;
    projectId?: number[];
  }) => Promise<{ id?: number } | null>,
  publicId: string,
  projectIds?: number[]
): Promise<number | null> => {
  const where: { publicId: string; projectId?: number[] } = { publicId };
  if (projectIds !== undefined) where.projectId = projectIds;
  const row = await find(where);
  return row?.id ?? null;
};

// Resolves agent/trace publicId filters into `where` (mutating it). Returns
// false when a referenced agent/trace does not exist in scope.
export const applyGenerationScopeFilters = async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  where: Record<string, any>,
  args: {
    agentId?: string;
    traceId?: string;
    initiatorGenerationId?: string;
    projectIds?: number[];
  }
): Promise<boolean> => {
  if (args.agentId !== undefined) {
    const agentId = await resolveScopedId(
      (w) => {
        return db.Agent.findOne({ where: w });
      },
      args.agentId,
      args.projectIds
    );
    if (agentId === null) return false;
    where.agentId = agentId;
  }
  if (args.traceId !== undefined) {
    const traceId = await resolveScopedId(
      (w) => {
        return db.Trace.findOne({ where: w });
      },
      args.traceId,
      args.projectIds
    );
    if (traceId === null) return false;
    where.traceId = traceId;
  }
  if (args.initiatorGenerationId !== undefined) {
    const initiatorId = await resolveScopedId(
      (w) => {
        return db.Generation.findOne({ where: w });
      },
      args.initiatorGenerationId,
      args.projectIds
    );
    if (initiatorId === null) return false;
    where.initiatorGenerationId = initiatorId;
  }
  return true;
};
