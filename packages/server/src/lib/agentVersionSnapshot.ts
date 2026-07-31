import { isDeepStrictEqual } from 'node:util';

import createDebug from 'debug';

import { db } from '../db';
import { normalizeKnowledgeConfig } from './agentKnowledge';
import type { MappedAgent } from './agents';
import {
  type AgentToolBinding,
  parseWireToolBindings,
} from './agentToolBindings';

const log = createDebug('soat:agents');

/**
 * An agent's archived configuration, in the wire (snake_case) shape the agents
 * OpenAPI spec documents. Opaque to this module: it is produced from, and fed
 * back into, the agent write path as a value.
 */
export type AgentConfigSnapshot = Record<string, unknown>;

/**
 * The keys of an agent response that are **not** configuration: its identity,
 * its version bookkeeping, and its timestamps. Everything else in the response
 * is part of the mutable surface a version captures.
 *
 * Stated as an exclusion rather than an allowlist on purpose. A field added to
 * `mapAgent` and forgotten here lands in snapshots automatically, so `restore`
 * keeps working; the opposite arrangement would silently stop restoring the new
 * field, with nothing to notice. The failure mode of this direction is loud —
 * a non-config field leaking in would make every update look like a change and
 * spray spurious versions — and `agentVersions.test.ts` pins the exact key set
 * so adding an agent field forces a deliberate choice here.
 */
const NON_CONFIG_AGENT_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'project_id',
  'version',
  'active_release',
  'created_at',
  'updated_at',
]);

/**
 * Projects an agent response down to its configuration.
 *
 * Only top-level keys are inspected, and only to decide whether to copy them —
 * no key is ever rewritten and no value is descended into, so nested
 * caller-authored payloads (`boundary_policy`, `knowledge_config`,
 * `output_schema`, inline tool definitions) are copied as values and cannot be
 * mangled (see `.claude/rules/case-convention.md`).
 */
export const buildAgentConfigSnapshot = (
  agent: MappedAgent
): AgentConfigSnapshot => {
  const config: AgentConfigSnapshot = {};
  for (const [key, value] of Object.entries(agent)) {
    if (!NON_CONFIG_AGENT_FIELDS.has(key)) {
      config[key] = value;
    }
  }
  return config;
};

// ── Reading a snapshot back ───────────────────────────────────────────────
//
// An archived config is untyped JSON, and both consumers — `restore` and the
// served-version overlay — need every field as a definite value or `null` (they
// replace the whole config, so "absent" must mean "cleared", never "leave as
// is"). These readers express that once, instead of each call site pairing a
// `toNullableX` with a `?? null`.

export const configString = (value: unknown): string | null => {
  return typeof value === 'string' ? value : null;
};

export const configNumber = (value: unknown): number | null => {
  return typeof value === 'number' ? value : null;
};

export const configObject = (value: unknown): object | null => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value
    : null;
};

export const configArray = <T>(value: unknown): T[] | null => {
  return Array.isArray(value) ? (value as T[]) : null;
};

export const configStringOrObject = (
  value: unknown
): string | object | null => {
  return typeof value === 'string' ? value : configObject(value);
};

export const configBoolean = (value: unknown): boolean => {
  return value === true;
};

/**
 * Reads the archived `tool_bindings` as canonical bindings.
 *
 * Only this field is replayed — the archived `tool_ids` / `tools` are derived
 * views of the same list, mutually exclusive with it on every write path.
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

/** True when two snapshots describe the same configuration. */
export const isSameAgentConfig = (
  before: AgentConfigSnapshot,
  after: AgentConfigSnapshot
): boolean => {
  return isDeepStrictEqual(before, after);
};

/**
 * Archives one agent configuration. Called only from the shared lib write path
 * in `agents.ts`, which is what makes a REST edit and a formation apply
 * indistinguishable here — both leave identical history.
 */
export const writeAgentVersion = async (args: {
  agentDbId: number;
  version: number;
  config: AgentConfigSnapshot;
  label?: string | null;
  createdByUserId?: number | null;
}): Promise<void> => {
  log(
    'writeAgentVersion: agentDbId=%d version=%d label=%s',
    args.agentDbId,
    args.version,
    args.label ?? null
  );

  await db.AgentVersion.create({
    agentId: args.agentDbId,
    version: args.version,
    config: args.config,
    label: args.label ?? null,
    createdByUserId: args.createdByUserId ?? null,
  });
};
