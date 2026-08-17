import createDebug from 'debug';

import { db } from '../db';
import { isPlainObject } from './plainObject';

const log = createDebug('soat:knowledge');

/**
 * One-time normalization of stored `knowledge_config` bags to snake_case.
 *
 * Agent rows persisted before single-casing hold the bag in camelCase: request
 * middleware camelCased it on the way in, and the read path un-camelCased it on
 * the way out. That read path is gone — `readKnowledgeConfig` maps the wire
 * casing field by field and nothing else — so those rows would resolve
 * `write_memory_id`, `memory_ids` and `extraction` as `undefined`, silently
 * disabling memory-scoped injection, the `write_memory` tool and extraction.
 * This rewrites them once, at boot, so the stored value matches the wire value
 * everywhere.
 *
 * It is idempotent (an already-snake_case bag is left untouched) and bounded (a
 * SQL prefilter means a converged database reads no rows at all), so it is safe
 * to leave wired into every boot.
 */

/**
 * The camelCase spellings that ever reached storage, and the snake_case key
 * each becomes. Enumerated rather than derived: this rewrites *keys*, so it
 * must only ever touch names the platform owns.
 */
const KNOWLEDGE_CONFIG_KEYS: Record<string, string> = {
  memoryIds: 'memory_ids',
  memoryTags: 'memory_tags',
  documentIds: 'document_ids',
  documentPaths: 'document_paths',
  minScore: 'min_score',
  writeMemoryId: 'write_memory_id',
};

/** The `extraction` object's own camelCase spelling. */
const EXTRACTION_KEYS: Record<string, string> = {
  aiProviderId: 'ai_provider_id',
};

const renameKeys = (args: {
  value: Record<string, unknown>;
  keys: Record<string, string>;
}): { value: Record<string, unknown>; changed: boolean } => {
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(args.value)) {
    const renamed = args.keys[key];
    if (renamed === undefined) {
      out[key] = val;
      continue;
    }
    changed = true;
    // A row that somehow carries both spellings keeps the snake_case value:
    // it is the one every current write produced.
    if (!(renamed in args.value)) out[renamed] = val;
  }
  return { value: out, changed };
};

/**
 * Returns the wire-shaped bag when `value` needed rewriting, `null` when it was
 * already in the wire casing (or is not a bag at all).
 */
export const toWireKnowledgeConfig = (
  value: unknown
): Record<string, unknown> | null => {
  if (!isPlainObject(value)) return null;

  const top = renameKeys({ value, keys: KNOWLEDGE_CONFIG_KEYS });
  let changed = top.changed;

  const extraction = top.value.extraction;
  if (isPlainObject(extraction)) {
    const nested = renameKeys({ value: extraction, keys: EXTRACTION_KEYS });
    if (nested.changed) {
      top.value.extraction = nested.value;
      changed = true;
    }
  }

  return changed ? top.value : null;
};

/**
 * Matches any string containing a `lowerUpper` boundary — the shape of every
 * camelCase key above. Applied to the whole bag as text, so it over-matches on
 * values (an instruction prompt, a path); that only costs the row a JS check.
 */
const CAMEL_CASE_LIKE = String.raw`[a-z][A-Z]`;

const backfillAgents = async (): Promise<number> => {
  const agents = await db.Agent.findAll({
    where: db.Agent.sequelize!.literal(
      `"knowledge_config" IS NOT NULL AND "knowledge_config"::text ~ '${CAMEL_CASE_LIKE}'`
    ),
  });

  let updated = 0;
  for (const agent of agents) {
    const wire = toWireKnowledgeConfig(agent.knowledgeConfig);
    if (!wire) continue;
    agent.knowledgeConfig = wire;
    await agent.save();
    updated += 1;
  }
  return updated;
};

const backfillAgentVersions = async (): Promise<number> => {
  const versions = await db.AgentVersion.findAll({
    where: db.AgentVersion.sequelize!.literal(
      `"config" -> 'knowledge_config' IS NOT NULL AND ("config" -> 'knowledge_config')::text ~ '${CAMEL_CASE_LIKE}'`
    ),
  });

  let updated = 0;
  for (const version of versions) {
    const config = version.config;
    if (!isPlainObject(config)) continue;
    const wire = toWireKnowledgeConfig(config.knowledge_config);
    if (!wire) continue;
    // Reassign the whole column: Sequelize does not track mutations inside a
    // JSONB value, so an in-place edit would never be written.
    version.config = { ...config, knowledge_config: wire };
    await version.save();
    updated += 1;
  }
  return updated;
};

export const backfillKnowledgeConfigCasing = async (): Promise<{
  agents: number;
  agentVersions: number;
}> => {
  const agents = await backfillAgents();
  const agentVersions = await backfillAgentVersions();
  log(
    'backfillKnowledgeConfigCasing: agents=%d agentVersions=%d',
    agents,
    agentVersions
  );
  return { agents, agentVersions };
};
