import createDebug from 'debug';

import { db } from '../db';
import { parseOrchestrationGraph } from './orchestrationGraphWire';
import type { OrchestrationEdge, OrchestrationNode } from './orchestrations';

const log = createDebug('soat:orchestrations');

/**
 * Resolves the graph a run executes (issue #872).
 *
 * A run is pinned to an orchestration version at `start-orchestration-run` and
 * every later execution — the first drive of a queued run, a wake from
 * `sleeping`, a human or approval resume, a redrive after a lease expiry —
 * resolves its topology through this module rather than reading the live
 * `Orchestration` row. That is the whole fix: `update-orchestration` can rewire
 * or delete nodes freely, and a run parked for days still finishes on the graph
 * it started on.
 *
 * The single seam matters as much as the pinning. Before this, four call sites
 * each did `orch.nodes as OrchestrationNode[]`, so getting one of them right and
 * missing another would look correct in review and still leave the bug in the
 * path that matters least often — which is exactly the path a run parks in.
 */

export type RunGraph = {
  nodes: OrchestrationNode[];
  edges: OrchestrationEdge[];
};

/** The live graph, as persisted on the orchestration row (already camelCase). */
const liveGraph = (
  orchestration: InstanceType<typeof db.Orchestration>
): RunGraph => {
  return {
    nodes: orchestration.nodes as OrchestrationNode[],
    edges: orchestration.edges as OrchestrationEdge[],
  };
};

/**
 * The graph at one archived version of an orchestration, or `null` when that
 * version was never archived.
 *
 * The archive stores the graph wire-shaped, so it comes back through the same
 * snake_case → camelCase boundary an inbound request uses.
 */
const findArchivedGraph = async (args: {
  orchestrationDbId: number;
  version: number;
}): Promise<RunGraph | null> => {
  const archived = await db.OrchestrationVersion.findOne({
    where: { orchestrationId: args.orchestrationDbId, version: args.version },
  });
  if (!archived) return null;

  const config = archived.config;
  /* istanbul ignore next -- the column is JSONB NOT NULL and only ever written
     from buildOrchestrationConfigSnapshot, so no entry point can produce a
     non-object here; the narrowing exists to keep the return type honest. */
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return null;
  }

  const { nodes, edges } = config as Record<string, unknown>;
  return parseOrchestrationGraph({ nodes, edges });
};

/**
 * The graph a run must execute: its pinned version's, falling back to the live
 * row when there is no pinned version to resolve.
 *
 * The fallback covers exactly one real case — a run created before pinning
 * existed, whose `orchestrationVersion` is null. Those runs behave as they did
 * before #872 because the live row is the only graph they ever had; there is
 * nothing better to give them, and refusing to drive them would strand every
 * run that was in flight across the deploy.
 *
 * A pinned version whose archive row is missing degrades the same way rather
 * than failing the run. It is unreachable through the API — a version is
 * archived before any run can pin it, and versions are only deleted with their
 * orchestration, which deletes its runs in the same transaction — so this is a
 * guard against an out-of-band deletion, not a supported state. Failing the run
 * instead would turn a bookkeeping inconsistency into lost work, and the log
 * line names it either way.
 */
export const resolveRunGraph = async (args: {
  run: InstanceType<typeof db.OrchestrationRun>;
  orchestration: InstanceType<typeof db.Orchestration>;
}): Promise<RunGraph> => {
  const version = args.run.orchestrationVersion;

  if (version === null || version === undefined) {
    log(
      'resolveRunGraph: run=%s has no pinned version, executing the live graph',
      args.run.publicId
    );
    return liveGraph(args.orchestration);
  }

  const archived = await findArchivedGraph({
    orchestrationDbId: args.orchestration.id as number,
    version,
  });

  if (!archived) {
    log(
      'resolveRunGraph: run=%s pinned to missing version=%d, executing the live graph',
      args.run.publicId,
      version
    );
    return liveGraph(args.orchestration);
  }

  log(
    'resolveRunGraph: run=%s executing version=%d',
    args.run.publicId,
    version
  );
  return archived;
};
