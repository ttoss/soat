import { orchestrations } from './orchestrationAccessor';
import { parseOrchestrationGraph } from './orchestrationGraphWire';
import {
  type MappedOrchestration,
  updateOrchestration,
} from './orchestrations';
import { orchestrationVersionStore } from './orchestrationVersionSnapshot';
import { isPlainObject } from './plainObject';
import {
  type ArchivedVersionRow,
  configObject,
  makeVersionArchive,
  mapArchivedVersionFields,
  toResourceRef,
} from './resourceVersions';

/**
 * Orchestration graph version history.
 *
 * The archive mechanics live in `resourceVersions.ts` and are shared with agents
 * and guardrails; this module supplies the orchestration-specific adapters.
 * Versions are never written from here — they are archived by the shared write
 * path in `orchestrations.ts`, so a REST edit and a formation apply leave
 * identical history.
 *
 * Orchestrations have no release/canary layer: a run is pinned at
 * `start-orchestration-run` and stays on that version for its whole life, which
 * can be days. Splitting *new* runs across two graphs is a coherent idea but
 * nothing has asked for it, and the mechanism is already extracted and
 * pure in `releaseAssignment.ts` for when something does.
 */

// ── Mapping ──────────────────────────────────────────────────────────────

const mapOrchestrationVersion = (
  version: ArchivedVersionRow,
  orchestrationPublicId: string
) => {
  return {
    orchestration_id: orchestrationPublicId,
    ...mapArchivedVersionFields(version),
  };
};

// ── Lookup helpers ───────────────────────────────────────────────────────

/**
 * The orchestration adapter over the shared archive. `applyConfig` routes through
 * `updateOrchestration` rather than touching columns, so a restored graph goes
 * through the same static validation as an authored one and is archived by the
 * same choke point as any other edit — and a graph identical to the live one is
 * recognised as a no-op.
 *
 * Unlike a guardrail document, that validation cannot start failing over time:
 * `assertOrchestrationValid` is a pure check on the graph's shape, and a node's
 * resource references (`agent_id`, `tool_id`, `orchestration_id`) resolve when a
 * run reaches the node. A target deleted since the snapshot was taken therefore
 * restores cleanly and surfaces as a failed run — the same place it surfaces when
 * the graph is authored that way in the first place.
 */
const orchestrationVersionArchive = makeVersionArchive({
  store: orchestrationVersionStore,
  // Through the shared accessor rather than a hand-rolled `findOne` plus its
  // own `if (!row) throw`: the routes resolve and authorize the orchestration
  // before calling in, so that guard became a branch no request could reach,
  // and the accessor's is the one every other module already exercises.
  // Cross-project access still resolves as "not found" rather than a `403`, so
  // an orchestration's existence never leaks across a tenant boundary — that
  // decision lives in `scopedWhere`, which the accessor applies.
  loadResource: async (args) => {
    return toResourceRef(
      await orchestrations.getByPublicId({
        id: args.id,
        projectIds: args.projectIds,
      })
    );
  },
  mapVersion: mapOrchestrationVersion,
  applyConfig: async (args): Promise<MappedOrchestration> => {
    // The archived graph is wire-shaped, so it goes back through the same
    // snake_case → camelCase boundary an inbound request does.
    const graph = parseOrchestrationGraph({
      nodes: args.config.nodes,
      edges: args.config.edges,
    });

    return updateOrchestration({
      projectIds: args.projectIds,
      id: args.id,
      nodes: graph.nodes,
      edges: graph.edges,
      // A version replaces the whole graph, so an absent schema means "cleared",
      // never "leave as is".
      stateSchema: configObject(args.config.state_schema),
      inputSchema: configObject(args.config.input_schema),
      outputMapping: isPlainObject(args.config.output_mapping)
        ? args.config.output_mapping
        : null,
      versionLabel: args.label,
      createdByUserId: args.createdByUserId,
    });
  },
});

// ── Read endpoints ───────────────────────────────────────────────────────

export const listOrchestrationVersions = async (args: {
  projectIds?: number[];
  orchestrationId: string;
  limit?: number;
  offset?: number;
}) => {
  return orchestrationVersionArchive.listVersions({
    projectIds: args.projectIds,
    resourceId: args.orchestrationId,
    limit: args.limit,
    offset: args.offset,
  });
};

export const getOrchestrationVersion = async (args: {
  projectIds?: number[];
  orchestrationId: string;
  version: number;
}) => {
  return orchestrationVersionArchive.getVersion({
    projectIds: args.projectIds,
    resourceId: args.orchestrationId,
    version: args.version,
  });
};

export const restoreOrchestrationVersion = async (args: {
  projectIds?: number[];
  orchestrationId: string;
  version: number;
  label?: string | null;
  createdByUserId: number | null;
}): Promise<MappedOrchestration> => {
  // Appends rather than rewinding the counter, so a run pinned to any version
  // in between still resolves the graph it started on. A restore is an ordinary
  // graph edit; pinning is what keeps it from reaching runs in flight.
  return orchestrationVersionArchive.restoreVersion({
    projectIds: args.projectIds,
    resourceId: args.orchestrationId,
    version: args.version,
    label: args.label,
    createdByUserId: args.createdByUserId,
  });
};
