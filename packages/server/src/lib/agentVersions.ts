import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { getAgent, type MappedAgent, updateAgent } from './agents';
import {
  type AgentConfigSnapshot,
  agentVersionStore,
  configKnowledgeConfig,
  configToolBindings,
} from './agentVersionSnapshot';
import { type ActiveRelease, parseActiveRelease } from './releaseAssignment';
import {
  type ArchivedVersionRow,
  configArray,
  configBoolean,
  configNumber,
  configObject,
  configString,
  configStringOrObject,
  makeVersionArchive,
  mapArchivedVersionFields,
  type VersionedResourceRef,
} from './resourceVersions';

const log = createDebug('soat:agents');

/**
 * Agent version history and staged rollout operations
 * (docs/prd-agent-versions.md, Phases 1–2).
 *
 * The archive mechanics live in `resourceVersions.ts` and are shared with
 * guardrails; this module supplies the agent-specific adapters and owns the one
 * layer that is genuinely per resource — what a *release* means.
 *
 * Versions are never written from here — they are archived by the shared write
 * path in `agents.ts`. Restore, promote and abort all express themselves as an
 * ordinary agent update carrying an archived config, which is what keeps history
 * append-only: nothing in this module rewinds a counter or mutates a row.
 */

type AgentInstance = InstanceType<(typeof db)['Agent']>;

const CANARY_PERCENT_MAX = 100;

// ── Mapping ──────────────────────────────────────────────────────────────

export const mapAgentVersion = (
  version: ArchivedVersionRow,
  agentPublicId: string
) => {
  return {
    agent_id: agentPublicId,
    ...mapArchivedVersionFields(version),
  };
};

// ── Lookup helpers ───────────────────────────────────────────────────────

const findAgentInstance = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<AgentInstance> => {
  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds !== undefined) where.projectId = args.projectIds;

  const agent = await db.Agent.findOne({ where });
  // Cross-project access resolves here as "not found" rather than a 403, so an
  // agent's existence never leaks across a tenant boundary.
  if (!agent) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Agent '${args.id}' not found.`
    );
  }
  return agent as AgentInstance;
};

const agentDbId = (agent: AgentInstance): number => {
  return agent.id as number;
};

const toResourceRef = (agent: AgentInstance): VersionedResourceRef => {
  return {
    dbId: agentDbId(agent),
    publicId: agent.publicId,
    version: agent.version,
  };
};

// ── Applying an archived config ───────────────────────────────────────────

/**
 * Maps an archived config back to `updateAgent` arguments.
 *
 * Every field is passed explicitly, so applying an archived config is a *full
 * replacement*: a field the archived version left unset is written back as null
 * rather than inheriting whatever the live row happens to hold. That is what
 * makes a restore a real rollback instead of a merge.
 *
 * Only the canonical `tool_bindings` is replayed. The archived `tool_ids` /
 * `tools` are derived views of the same list and are mutually exclusive with it
 * on every write path, so replaying them as well would be rejected — and, if it
 * were not, would duplicate every tool.
 */
const archivedConfigToUpdateArgs = (config: AgentConfigSnapshot) => {
  return {
    aiProviderId: configString(config.ai_provider_id),
    modelRouteId: configString(config.model_route_id),
    name: configString(config.name),
    instructions: configString(config.instructions),
    model: configString(config.model),
    toolBindings: configToolBindings(config.tool_bindings),
    maxSteps: configNumber(config.max_steps),
    toolChoice: configStringOrObject(config.tool_choice),
    stopConditions: configArray<object>(config.stop_conditions),
    activeToolIds: configArray<string>(config.active_tool_ids),
    stepRules: configArray<object>(config.step_rules),
    boundaryPolicy: configObject(config.boundary_policy),
    temperature: configNumber(config.temperature),
    knowledgeConfig: configKnowledgeConfig(config.knowledge_config),
    outputSchema: configObject(config.output_schema),
    maxContextMessages: configNumber(config.max_context_messages),
    singleSessionPerActor: configBoolean(config.single_session_per_actor),
    guardrailIds: configArray<string>(config.guardrail_ids),
  };
};

/**
 * The agent adapter over the shared archive. `applyConfig` routes through
 * `updateAgent` rather than touching columns, so a restore is re-validated and
 * archived by the same choke point as any other edit.
 */
const agentVersionArchive = makeVersionArchive({
  store: agentVersionStore,
  loadResource: async (args) => {
    return toResourceRef(await findAgentInstance(args));
  },
  mapVersion: mapAgentVersion,
  applyConfig: async (args): Promise<MappedAgent> => {
    return updateAgent({
      projectIds: args.projectIds,
      id: args.id,
      ...archivedConfigToUpdateArgs(args.config),
      versionLabel: args.label,
      createdByUserId: args.createdByUserId,
    });
  },
});

// ── Read endpoints ───────────────────────────────────────────────────────

export const listAgentVersions = async (args: {
  projectIds?: number[];
  agentId: string;
  limit?: number;
  offset?: number;
}) => {
  log('listAgentVersions: agentId=%s', args.agentId);

  return agentVersionArchive.listVersions({
    projectIds: args.projectIds,
    resourceId: args.agentId,
    limit: args.limit,
    offset: args.offset,
  });
};

export const getAgentVersion = async (args: {
  projectIds?: number[];
  agentId: string;
  version: number;
}) => {
  log('getAgentVersion: agentId=%s version=%d', args.agentId, args.version);

  return agentVersionArchive.getVersion({
    projectIds: args.projectIds,
    resourceId: args.agentId,
    version: args.version,
  });
};

export const restoreAgentVersion = async (args: {
  projectIds?: number[];
  agentId: string;
  version: number;
  label?: string | null;
  createdByUserId?: number | null;
}): Promise<MappedAgent> => {
  log('restoreAgentVersion: agentId=%s version=%d', args.agentId, args.version);

  return agentVersionArchive.restoreVersion({
    projectIds: args.projectIds,
    resourceId: args.agentId,
    version: args.version,
    label: args.label,
    createdByUserId: args.createdByUserId,
  });
};

// ── Releases ─────────────────────────────────────────────────────────────

/**
 * The shape rules for a staged rollout, independent of transport. Returns an
 * error message, or null when the input is valid.
 */
export const validateReleaseInput = (args: {
  stableVersion: unknown;
  canaryVersion: unknown;
  canaryPercent: unknown;
}): string | null => {
  const isVersion = (value: unknown): boolean => {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1;
  };

  if (!isVersion(args.stableVersion)) {
    return 'stable_version must be a positive integer.';
  }
  if (!isVersion(args.canaryVersion)) {
    return 'canary_version must be a positive integer.';
  }
  if (args.stableVersion === args.canaryVersion) {
    // A canary identical to stable is not a split — it would report a rollout in
    // progress while every request served the same config.
    return 'canary_version must differ from stable_version.';
  }
  if (
    typeof args.canaryPercent !== 'number' ||
    !Number.isInteger(args.canaryPercent) ||
    args.canaryPercent < 0 ||
    args.canaryPercent > CANARY_PERCENT_MAX
  ) {
    return `canary_percent must be an integer between 0 and ${CANARY_PERCENT_MAX}.`;
  }
  return null;
};

/**
 * Sets or replaces an agent's staged rollout.
 *
 * Takes the three fields as `unknown` and validates them here rather than
 * trusting a handler to have narrowed them: this is the only writer of the
 * column that the generation path reads on every request, so a malformed
 * release must be impossible to store, not merely unlikely.
 */
export const setAgentRelease = async (args: {
  projectIds?: number[];
  agentId: string;
  stableVersion: unknown;
  canaryVersion: unknown;
  canaryPercent: unknown;
}): Promise<MappedAgent> => {
  log(
    'setAgentRelease: agentId=%s stable=%o canary=%o percent=%o',
    args.agentId,
    args.stableVersion,
    args.canaryVersion,
    args.canaryPercent
  );

  const message = validateReleaseInput({
    stableVersion: args.stableVersion,
    canaryVersion: args.canaryVersion,
    canaryPercent: args.canaryPercent,
  });
  if (message) throw new DomainError('VALIDATION_FAILED', message);

  // Validation above proved all three are integers, so these conversions are
  // identities that also satisfy the type checker without a cast.
  const release: ActiveRelease = {
    stable_version: Number(args.stableVersion),
    canary_version: Number(args.canaryVersion),
    canary_percent: Number(args.canaryPercent),
  };

  const agent = await findAgentInstance({
    projectIds: args.projectIds,
    id: args.agentId,
  });

  await agentVersionStore.assertVersionsExist({
    resource: toResourceRef(agent),
    versions: [release.stable_version, release.canary_version],
  });

  // `activeRelease` is a rollout pointer, not configuration: it is deliberately
  // outside the versioned surface, so setting one does not archive a version
  // (and cannot make the agent look edited).
  await agent.update({ activeRelease: release });

  return getAgent({ projectIds: args.projectIds, id: args.agentId });
};

const requireActiveRelease = (agent: AgentInstance): ActiveRelease => {
  const release = parseActiveRelease(agent.activeRelease);
  if (!release) {
    throw new DomainError(
      'NO_ACTIVE_RELEASE',
      `Agent '${agent.publicId}' has no active release.`
    );
  }
  return release;
};

/**
 * Ends a rollout by making one of its two versions the live config.
 *
 * The config is written **before** the release pointer is cleared, and the order
 * is load-bearing. While the release is set, traffic is served from archived
 * versions, so writing the winning config first is invisible to callers; the
 * moment the pointer clears, the live row already holds it. Clearing first would
 * open a window where every request served whatever draft the live row happened
 * to hold — which, during an abort, is the very config being rolled back.
 */
const settleRelease = async (args: {
  projectIds?: number[];
  agentId: string;
  version: number;
  label: string;
  createdByUserId?: number | null;
}): Promise<MappedAgent> => {
  await agentVersionArchive.applyArchivedVersion({
    projectIds: args.projectIds,
    resourceId: args.agentId,
    version: args.version,
    label: args.label,
    createdByUserId: args.createdByUserId,
  });

  // Re-read after the write: `applyArchivedVersion` goes through `updateAgent`,
  // so the instance loaded before it would hold a stale version counter.
  const agent = await findAgentInstance({
    projectIds: args.projectIds,
    id: args.agentId,
  });
  await agent.update({ activeRelease: null });

  return getAgent({ projectIds: args.projectIds, id: args.agentId });
};

export const promoteAgentRelease = async (args: {
  projectIds?: number[];
  agentId: string;
  createdByUserId?: number | null;
}): Promise<MappedAgent> => {
  const agent = await findAgentInstance({
    projectIds: args.projectIds,
    id: args.agentId,
  });
  const release = requireActiveRelease(agent);

  log(
    'promoteAgentRelease: agentId=%s canary=%d',
    args.agentId,
    release.canary_version
  );

  // Pins the canary explicitly instead of assuming the live row still holds it:
  // an edit landing mid-rollout would otherwise get promoted in its place.
  return settleRelease({
    projectIds: args.projectIds,
    agentId: args.agentId,
    version: release.canary_version,
    label: `promoted v${release.canary_version}`,
    createdByUserId: args.createdByUserId,
  });
};

export const abortAgentRelease = async (args: {
  projectIds?: number[];
  agentId: string;
  createdByUserId?: number | null;
}): Promise<MappedAgent> => {
  const agent = await findAgentInstance({
    projectIds: args.projectIds,
    id: args.agentId,
  });
  const release = requireActiveRelease(agent);

  log(
    'abortAgentRelease: agentId=%s stable=%d',
    args.agentId,
    release.stable_version
  );

  return settleRelease({
    projectIds: args.projectIds,
    agentId: args.agentId,
    version: release.stable_version,
    label: `aborted to v${release.stable_version}`,
    createdByUserId: args.createdByUserId,
  });
};
