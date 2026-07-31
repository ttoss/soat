import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import {
  type ActiveRelease,
  parseActiveRelease,
} from './agentReleaseAssignment';
import { getAgent, type MappedAgent, updateAgent } from './agents';
import {
  type AgentConfigSnapshot,
  configArray,
  configBoolean,
  configKnowledgeConfig,
  configNumber,
  configObject,
  configString,
  configStringOrObject,
  configToolBindings,
} from './agentVersionSnapshot';
import { paginatedList, type PaginatedResult } from './pagination';

const log = createDebug('soat:agents');

/**
 * Agent version history and staged rollout operations
 * (docs/prd-agent-versions.md, Phases 1–2).
 *
 * Versions are never written from here — they are archived by the shared write
 * path in `agents.ts`. Restore, promote and abort all express themselves as an
 * ordinary agent update carrying an archived config, which is what keeps history
 * append-only: nothing in this module rewinds a counter or mutates a row.
 */

type AgentInstance = InstanceType<(typeof db)['Agent']>;
type AgentVersionInstance = InstanceType<(typeof db)['AgentVersion']>;

const CANARY_PERCENT_MAX = 100;

// ── Mapping ──────────────────────────────────────────────────────────────

export const mapAgentVersion = (
  version: AgentVersionInstance,
  agentPublicId: string
) => {
  return {
    id: version.publicId,
    agent_id: agentPublicId,
    version: version.version,
    config: version.config,
    label: version.label,
    created_by: version.createdBy?.publicId ?? null,
    created_at: version.createdAt,
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

const findVersionRow = async (args: {
  agent: AgentInstance;
  version: number;
}): Promise<AgentVersionInstance> => {
  const row = await db.AgentVersion.findOne({
    where: { agentId: agentDbId(args.agent), version: args.version },
    include: [{ model: db.User, as: 'createdBy' }],
  });

  if (!row) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Agent '${args.agent.publicId}' has no version ${args.version}.`
    );
  }
  return row as AgentVersionInstance;
};

const readConfig = (row: AgentVersionInstance): AgentConfigSnapshot => {
  const config = row.config;
  /* istanbul ignore next -- the column is NOT NULL and only ever written from
     buildAgentConfigSnapshot, so a non-object here means the row was edited
     outside the application. */
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Agent '${row.publicId}' has an unreadable archived config.`
    );
  }
  return config as AgentConfigSnapshot;
};

// ── Read endpoints ───────────────────────────────────────────────────────

export const listAgentVersions = async (args: {
  projectIds?: number[];
  agentId: string;
  limit?: number;
  offset?: number;
}): Promise<PaginatedResult<ReturnType<typeof mapAgentVersion>>> => {
  log('listAgentVersions: agentId=%s', args.agentId);

  const agent = await findAgentInstance({
    projectIds: args.projectIds,
    id: args.agentId,
  });

  return paginatedList({
    limit: args.limit,
    offset: args.offset,
    query: ({ limit, offset }) => {
      return db.AgentVersion.findAndCountAll({
        where: { agentId: agentDbId(agent) },
        include: [{ model: db.User, as: 'createdBy' }],
        // Newest first, ordered by the version counter rather than a timestamp:
        // two versions can share a `createdAt` at timestamp resolution, and a
        // non-deterministic page boundary in history is worse than useless.
        order: [['version', 'DESC']],
        distinct: true,
        limit,
        offset,
      });
    },
    map: (row) => {
      return mapAgentVersion(row as AgentVersionInstance, agent.publicId);
    },
  });
};

export const getAgentVersion = async (args: {
  projectIds?: number[];
  agentId: string;
  version: number;
}): Promise<ReturnType<typeof mapAgentVersion>> => {
  log('getAgentVersion: agentId=%s version=%d', args.agentId, args.version);

  const agent = await findAgentInstance({
    projectIds: args.projectIds,
    id: args.agentId,
  });
  const row = await findVersionRow({ agent, version: args.version });

  return mapAgentVersion(row, agent.publicId);
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
 * Writes an archived config back through the ordinary agent update path.
 *
 * Going through `updateAgent` rather than touching columns directly buys three
 * things: the config is re-validated (a tool, provider or guardrail deleted
 * since the snapshot was taken fails loudly instead of writing a broken agent),
 * the resulting version is archived by the same choke point as any other edit,
 * and a config identical to the live one is recognised as a no-op.
 */
const applyArchivedConfig = async (args: {
  projectIds?: number[];
  agentId: string;
  config: AgentConfigSnapshot;
  label: string | null;
  createdByUserId?: number | null;
}): Promise<MappedAgent> => {
  return updateAgent({
    projectIds: args.projectIds,
    id: args.agentId,
    ...archivedConfigToUpdateArgs(args.config),
    versionLabel: args.label,
    createdByUserId: args.createdByUserId,
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

  const agent = await findAgentInstance({
    projectIds: args.projectIds,
    id: args.agentId,
  });
  const row = await findVersionRow({ agent, version: args.version });

  // Appends a new version rather than rewinding the counter, so audit
  // references to the versions in between never dangle and "undo the undo" is
  // just another restore.
  return applyArchivedConfig({
    projectIds: args.projectIds,
    agentId: args.agentId,
    config: readConfig(row),
    label: args.label ?? `restored from v${args.version}`,
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

const assertVersionsExist = async (args: {
  agent: AgentInstance;
  versions: number[];
}): Promise<void> => {
  const rows = await db.AgentVersion.findAll({
    where: { agentId: agentDbId(args.agent), version: args.versions },
    attributes: ['version'],
  });

  const found = new Set(
    rows.map((row) => {
      return row.version;
    })
  );
  const missing = args.versions.filter((version) => {
    return !found.has(version);
  });

  if (missing.length > 0) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `Agent '${args.agent.publicId}' has no version ${missing.join(', ')}.`,
      { missing }
    );
  }
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

  await assertVersionsExist({
    agent,
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
  const agent = await findAgentInstance({
    projectIds: args.projectIds,
    id: args.agentId,
  });
  const row = await findVersionRow({ agent, version: args.version });

  await applyArchivedConfig({
    projectIds: args.projectIds,
    agentId: args.agentId,
    config: readConfig(row),
    label: args.label,
    createdByUserId: args.createdByUserId,
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
