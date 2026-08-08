import createDebug from 'debug';

import { db } from '../db';
import type { TypedAgent } from './agentGenerationHelpers';
import {
  configKnowledgeConfig,
  configToolBindings,
} from './agentVersionSnapshot';
import {
  type ActiveRelease,
  assignReleaseVersion,
  parseActiveRelease,
} from './releaseAssignment';
import {
  configArray,
  configNumber,
  configObject,
  configString,
  configStringOrObject,
} from './resourceVersions';

const log = createDebug('soat:generation');

/**
 * Resolves which agent configuration a generation runs against
 * (docs/prd-agent-versions.md, Phase 2).
 *
 * While an agent carries an `active_release`, the served config is always read
 * from an archived `AgentVersion` — never from the live row. That makes the live
 * columns a **draft**: edits during a rollout create new versions but do not
 * disturb either side of the running split, which is what lets an operator keep
 * iterating while a canary is being observed.
 *
 * ## Scope
 *
 * The overlay governs the generation-time config surface (`TypedAgent`):
 * instructions, model, tool bindings, tool choice, step rules, boundary policy,
 * temperature, knowledge config, output schema, guardrails, and the loop limits.
 * Two agent fields are consumed outside this seam and therefore always read the
 * live row: `single_session_per_actor` (evaluated once, when a session is
 * created) and `max_context_messages` (applied by the conversation path before
 * it dispatches). Neither changes what the model is told to be, which is what a
 * canary is for.
 */

/** Builds the `{ publicId }` shape `TypedAgent` uses for a provider/route join. */
const joinRef = (publicId: string | null): { publicId: string } | null => {
  return publicId === null ? null : { publicId };
};

/**
 * Rebuilds a `TypedAgent` from an archived config.
 *
 * Fields are enumerated rather than spread: the live value is a Sequelize model
 * instance whose attributes live behind prototype getters, so spreading it would
 * silently produce an object with none of them.
 *
 * Identity is never versioned — the project join and the row id come from the
 * live agent, only behavior comes from the snapshot.
 */
const buildTypedAgentFromConfig = (args: {
  live: TypedAgent;
  config: Record<string, unknown>;
}): TypedAgent => {
  const { live, config } = args;

  return {
    instructions: configString(config.instructions),
    model: configString(config.model),
    // Canonical bindings only: the archived `tool_ids`/`tools` are derived views
    // of the same list, so replaying them too would double every tool.
    toolBindings: configToolBindings(config.tool_bindings),
    toolIds: null,
    tools: null,
    maxSteps: configNumber(config.max_steps),
    toolChoice: configStringOrObject(config.tool_choice),
    stopConditions: configArray<object>(config.stop_conditions),
    activeToolIds: configArray<string>(config.active_tool_ids),
    stepRules: configArray<object>(config.step_rules),
    boundaryPolicy: configObject(config.boundary_policy),
    temperature: configNumber(config.temperature),
    knowledgeConfig: configKnowledgeConfig(config.knowledge_config),
    outputSchema: configObject(config.output_schema),
    guardrailIds: configArray<string>(config.guardrail_ids),
    project: live.project,
    aiProvider: joinRef(configString(config.ai_provider_id)),
    modelRoute: joinRef(configString(config.model_route_id)),
    id: live.id,
    version: live.version,
    activeRelease: live.activeRelease,
  };
};

/**
 * The identity a rollout split is sticky on: the actor behind the session where
 * there is one, else the session itself, else nothing (an anonymous one-shot,
 * which `assignReleaseVersion` splits randomly).
 *
 * Preferring the actor over the session means a returning end user keeps the
 * same prompt across separate conversations, not just within one.
 */
const resolveAssignmentKey = async (args: {
  projectId: number;
  sessionId?: string | null;
}): Promise<string | null> => {
  if (!args.sessionId) return null;

  const session = await db.Session.findOne({
    where: { publicId: args.sessionId, projectId: args.projectId },
    include: [{ model: db.Actor, as: 'actor' }],
  });

  return session?.actor?.publicId ?? args.sessionId;
};

const loadArchivedConfig = async (args: {
  agentDbId: number;
  version: number;
}): Promise<Record<string, unknown> | null> => {
  const archived = await db.AgentVersion.findOne({
    where: { agentId: args.agentDbId, version: args.version },
  });

  if (!archived) return null;

  const config = archived.config;
  /* istanbul ignore next -- the column is JSONB NOT NULL and only ever written
     from buildAgentConfigSnapshot, so no entry point can produce a non-object
     here; the narrowing exists to keep the return type honest. */
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return null;
  }
  return config as Record<string, unknown>;
};

export type ServedAgentVersion = {
  /** The config the generation must run against. */
  typedAgent: TypedAgent;
  /** The version number that config came from, stamped on the generation. */
  agentVersion: number;
};

/**
 * Picks the version this request is assigned to and returns the config to run.
 *
 * Degrades to the live row — never to an error — when there is no release, when
 * the release is malformed, or when the assigned version's archive is missing.
 * A generation refusing to run because a rollout pointer is inconsistent would
 * turn a bookkeeping problem into an outage; the returned `agentVersion` always
 * names whatever config actually ran, so the record stays truthful either way.
 */
export const resolveServedAgentVersion = async (args: {
  agent: TypedAgent;
  sessionId?: string | null;
}): Promise<ServedAgentVersion> => {
  const agentDbId = args.agent.id;
  const version = args.agent.version ?? 1;

  const release: ActiveRelease | null = parseActiveRelease(
    args.agent.activeRelease
  );
  if (!release || agentDbId === undefined) {
    return { typedAgent: args.agent, agentVersion: version };
  }

  const key = await resolveAssignmentKey({
    projectId: args.agent.project.id as number,
    sessionId: args.sessionId,
  });

  const assignment = assignReleaseVersion({ release, key });

  // The live row already holds the assigned version's config, so there is
  // nothing to overlay and no archive read to pay for.
  if (assignment.version === version) {
    return { typedAgent: args.agent, agentVersion: version };
  }

  const config = await loadArchivedConfig({
    agentDbId,
    version: assignment.version,
  });

  /* istanbul ignore next -- unreachable through the API: setAgentRelease
     validates both versions exist, and archives are only deleted with their
     agent (which takes the release with it). Kept as a degradation path because
     the PRD's retention-pruning risk would make it reachable, and a generation
     must not fail on a bookkeeping inconsistency. */
  if (!config) {
    log(
      'resolveServedAgentVersion: missing archive for version=%d, serving live version=%d',
      assignment.version,
      version
    );
    return { typedAgent: args.agent, agentVersion: version };
  }

  log(
    'resolveServedAgentVersion: serving version=%d canary=%s',
    assignment.version,
    assignment.isCanary
  );

  return {
    typedAgent: buildTypedAgentFromConfig({ live: args.agent, config }),
    agentVersion: assignment.version,
  };
};
