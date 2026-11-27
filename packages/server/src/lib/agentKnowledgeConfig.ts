import { isPlainObject } from './plainObject';

/** The binding a `write_memory_store_id` adds to a turn, and its one tool. */
export const KNOWLEDGE_BINDING_NAME = 'knowledge';
export const WRITE_MEMORY_TOOL_NAME = 'write_memory';

export type KnowledgeConfig = {
  memoryStoreIds?: string[];
  documentIds?: string[];
  documentPaths?: string[];
  /**
   * Key-value pairs a result's own `tags` must all contain (exact match).
   * Scopes documents and memories alike.
   */
  tags?: Record<string, string>;
  minScore?: number;
  /**
   * The `k` in RRF's `1 / (k + rank)`. Tuning, not scope: on its own it turns
   * no retrieval on, the way a filter does.
   */
  rrfK?: number;
  /** Half-life in days of the recency decay over memory results. `0` is off. */
  recencyHalfLifeDays?: number;
  limit?: number;
  /**
   * The store the `write_memory` tool may write to — a capability grant on the
   * agent, and all that is left here of memory writing. What a store *accepts*
   * from a finished turn is its own ingestion policy, a `memory_rules` row, so
   * `extraction` is gone rather than accepted and ignored.
   */
  writeMemoryStoreId?: string;
};

/**
 * Accepts a `knowledge_config` bag on a write path and returns it **verbatim**,
 * having only checked that it is a bag at all.
 *
 * `knowledge_config` is stored in the wire casing (snake_case), exactly as the
 * client sent it, so a write performs no transform: the value is copied, not
 * walked. `null` clears the config; anything that is not a plain object is
 * ignored (`strictFields` has already rejected unknown members of a bag that
 * *is* an object).
 */
export const toStoredKnowledgeConfig = (
  value: unknown
): Record<string, unknown> | null | undefined => {
  if (value === null) return null;
  if (!isPlainObject(value)) return undefined;
  return value;
};

const readStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => {
    return typeof item === 'string';
  });
};

const readStringRecord = (
  value: unknown
): Record<string, string> | undefined => {
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') out[key] = item;
  }
  return out;
};

const readString = (value: unknown): string | undefined => {
  return typeof value === 'string' ? value : undefined;
};

const readNumber = (value: unknown): number | undefined => {
  return typeof value === 'number' ? value : undefined;
};

/**
 * Reads a stored (or per-generation) `knowledge_config` bag — snake_case, the
 * wire casing — into the internal camelCase `KnowledgeConfig`, the inbound half
 * of the case convention applied at one boundary.
 *
 * Field by field on purpose: a recursive key transform is what
 * `.claude/rules/case-convention.md` bans. Only keys actually present are
 * assigned, so a per-generation override merges over the stored config without
 * an absent field clearing a set one.
 */
export const readKnowledgeConfig = (
  value: unknown
): KnowledgeConfig | null | undefined => {
  if (value === null) return null;
  if (!isPlainObject(value)) return undefined;

  const config: KnowledgeConfig = {};
  const set = <K extends keyof KnowledgeConfig>(
    key: K,
    read: KnowledgeConfig[K] | undefined
  ): void => {
    if (read !== undefined) config[key] = read;
  };

  set('memoryStoreIds', readStringArray(value.memory_store_ids));
  set('documentIds', readStringArray(value.document_ids));
  set('documentPaths', readStringArray(value.document_paths));
  set('tags', readStringRecord(value.tags));
  set('minScore', readNumber(value.min_score));
  set('rrfK', readNumber(value.rrf_k));
  set('recencyHalfLifeDays', readNumber(value.recency_half_life_days));
  set('limit', readNumber(value.limit));
  set('writeMemoryStoreId', readString(value.write_memory_store_id));

  return config;
};

const mergeRecords = (
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined
): Record<string, string> | undefined => {
  if (!a && !b) return undefined;
  return { ...(a ?? {}), ...(b ?? {}) };
};

const unionArrays = (
  a: string[] | undefined,
  b: string[] | undefined
): string[] | undefined => {
  if (!a && !b) return undefined;
  return Array.from(new Set([...(a ?? []), ...(b ?? [])]));
};

/**
 * Merges a per-generation `knowledge_config` override into the agent's
 * stored config. Array filters (memoryStoreIds, documentIds,
 * documentPaths) are unioned so a single call can extend, not replace, the
 * agent's retrieval scope; `tags` pairs are merged with the override winning
 * per key; scalar fields use the override value when present.
 */
export const mergeKnowledgeConfig = (args: {
  base: KnowledgeConfig | null | undefined;
  override: KnowledgeConfig | undefined;
}): KnowledgeConfig | null | undefined => {
  const { base, override } = args;
  if (!override) return base;
  if (!base) return override;
  return {
    ...base,
    ...override,
    memoryStoreIds: unionArrays(base.memoryStoreIds, override.memoryStoreIds),
    documentIds: unionArrays(base.documentIds, override.documentIds),
    documentPaths: unionArrays(base.documentPaths, override.documentPaths),
    tags: mergeRecords(base.tags, override.tags),
  };
};

/**
 * The outbound half of {@link readKnowledgeConfig}: the wire casing, field by
 * field, carrying only the fields that are set.
 */
export const writeKnowledgeConfig = (
  config: KnowledgeConfig
): Record<string, unknown> => {
  const wire: Record<string, unknown> = {
    memory_store_ids: config.memoryStoreIds,
    document_ids: config.documentIds,
    document_paths: config.documentPaths,
    tags: config.tags,
    min_score: config.minScore,
    rrf_k: config.rrfK,
    recency_half_life_days: config.recencyHalfLifeDays,
    limit: config.limit,
    write_memory_store_id: config.writeMemoryStoreId,
  };
  return Object.fromEntries(
    Object.entries(wire).filter(([, value]) => {
      return value !== undefined;
    })
  );
};
