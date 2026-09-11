import type { MemoryEntrySource } from '@soat/postgresdb';
import { MEMORY_ENTRY_SOURCES } from '@soat/postgresdb';

export type MemoryWriteInputs = {
  content: string;
  tags?: Record<string, string>;
  metadata?: Record<string, unknown>;
  sourceType: MemoryEntrySource;
};

const parseTags = (rawTags: unknown): Record<string, string> | undefined => {
  if (!rawTags || typeof rawTags !== 'object' || Array.isArray(rawTags)) {
    return undefined;
  }
  // Non-string values are coerced rather than dropped: an orchestration's
  // mapped input often arrives as a number or boolean from an upstream node,
  // and losing the pair silently would write an entry the author believed
  // was tagged.
  return Object.fromEntries(
    Object.entries(rawTags as Record<string, unknown>).map(([k, v]) => {
      return [k, String(v)];
    })
  );
};

const parseMetadata = (
  rawMetadata: unknown
): Record<string, unknown> | undefined => {
  return rawMetadata &&
    typeof rawMetadata === 'object' &&
    !Array.isArray(rawMetadata)
    ? (rawMetadata as Record<string, unknown>)
    : undefined;
};

const parseSourceType = (rawSourceType: unknown): MemoryEntrySource => {
  return MEMORY_ENTRY_SOURCES.includes(rawSourceType as MemoryEntrySource)
    ? (rawSourceType as MemoryEntrySource)
    : 'orchestration';
};

/**
 * Normalizes a `memory_write` node's mapped inputs into the shape
 * `writeMemoryEntry` expects: `content` is coerced to a string, `tags` must be
 * a `{ key: value }` mapping (values coerced to strings), `metadata` must be a
 * plain object, and `sourceType` defaults to `orchestration` when the mapping
 * does not supply a valid value.
 */
export const parseMemoryWriteInputs = (
  inputs: Record<string, unknown>
): MemoryWriteInputs => {
  const content =
    typeof inputs['content'] === 'string'
      ? inputs['content']
      : JSON.stringify(inputs['content'] ?? '');

  return {
    content,
    tags: parseTags(inputs['tags']),
    metadata: parseMetadata(inputs['metadata']),
    sourceType: parseSourceType(inputs['sourceType']),
  };
};
