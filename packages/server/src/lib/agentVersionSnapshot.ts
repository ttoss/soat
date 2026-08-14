import { db } from '../db';
import type { MappedAgent } from './agentAccessor';
import { normalizeKnowledgeConfig } from './agentKnowledge';
import {
  type AgentToolBinding,
  parseWireToolBindings,
} from './agentToolBindings';
import {
  type ConfigSnapshot,
  makeVersionStore,
  projectConfigSnapshot,
} from './resourceVersions';

/**
 * How an agent's configuration is projected into, and read back out of, the
 * shared version archive (`resourceVersions.ts`). Everything generic — the
 * projection mechanics, the scalar readers, the equality check — lives there;
 * what stays here is the part that is specifically an *agent's* config.
 *
 * This module holds the archive's **write side** so that `agents.ts` can reach
 * it without importing `agentVersions.ts`, which imports `agents.ts` back for
 * `updateAgent`.
 */

/** The write side of the agent config archive. */
export const agentVersionStore = makeVersionStore({
  resourceLabel: 'Agent',
  versionModel: () => {
    return db.AgentVersion;
  },
  foreignKey: 'agentId',
  // Loaded so a version response can name the eval run that promoted it
  // (the agents module doc — Versioning and Staged Rollout). The archive engine has no concept of
  // an eval run; it only carries the association through to `mapAgentVersion`.
  extraIncludes: () => {
    return [{ model: db.EvalRun, as: 'evalRun' }];
  },
});

/**
 * An agent's archived configuration, in the wire (snake_case) shape the agents
 * OpenAPI spec documents.
 */
export type AgentConfigSnapshot = ConfigSnapshot;

/**
 * The keys of an agent response that are **not** configuration: its identity,
 * its version bookkeeping, and its timestamps. Everything else in the response
 * is part of the mutable surface a version captures.
 *
 * Stated as an exclusion rather than an allowlist on purpose — see
 * `projectConfigSnapshot` for why. `agentVersions.test.ts` pins the exact key
 * set the projection produces, so adding an agent field forces a deliberate
 * choice here.
 */
const NON_CONFIG_AGENT_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'project_id',
  'version',
  'active_release',
  'created_at',
  'updated_at',
]);

/** Projects an agent response down to its configuration. */
export const buildAgentConfigSnapshot = (
  agent: MappedAgent
): AgentConfigSnapshot => {
  return projectConfigSnapshot({
    resource: agent,
    nonConfigFields: NON_CONFIG_AGENT_FIELDS,
  });
};

// ── Agent-specific snapshot readers ───────────────────────────────────────
//
// The scalar readers (`configString`, `configNumber`, …) are shared; these two
// are not, because they re-run agent-specific parsing over an archived value.

/**
 * Reads the archived `tool_bindings` as canonical bindings.
 *
 * Versions archived before the `tool_ids` / `tools` shorthands were removed
 * still carry them, but only `tool_bindings` is replayed: they were always
 * derived views of the same list, so replaying them too would duplicate a tool.
 */
export const configToolBindings = (
  value: unknown
): AgentToolBinding[] | null => {
  return parseWireToolBindings(value) ?? null;
};

/** Reads the archived `knowledge_config`, which is stored in its wire shape. */
export const configKnowledgeConfig = (value: unknown): object | null => {
  return normalizeKnowledgeConfig(value) ?? null;
};
