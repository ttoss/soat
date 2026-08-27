import createDebug from 'debug';

import { db } from '../db';
import { parseOrchestrationGraph } from './orchestrationGraphWire';
import type { OrchestrationEdge, OrchestrationNode } from './orchestrations';

const log = createDebug('soat:orchestrations');

/**
 * Resolves the graph a run executes (#872).
 *
 * A run is pinned to an orchestration version at start, and every later
 * execution — first drive, wake from `sleeping`, human or approval resume,
 * redrive after a lease expiry — resolves its topology here rather than reading
 * the live row, so `update-orchestration` can rewire freely and a run parked for
 * days still finishes on the graph it started on.
 *
 * The single seam matters as much as the pinning: before this, four call sites
 * each cast `orch.nodes`, so missing one would look correct in review and leave
 * the bug in the path a parked run takes.
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
 * row when there is no pinned version.
 *
 * The fallback covers one real case — a run created before pinning existed,
 * whose `orchestrationVersion` is null. The live row is the only graph those
 * runs ever had, and refusing to drive them would strand every run in flight
 * across the deploy.
 *
 * A pinned version whose archive row is missing degrades the same way. It is
 * unreachable through the API, so this guards an out-of-band deletion rather
 * than a supported state; failing the run instead would turn a bookkeeping
 * inconsistency into lost work. The log line names either case.
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
